import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { cfg } from './config.mjs';
import { initStorage, getIndex } from './catalogue.mjs';
import { listProviders, getProvider, callProvider } from './providers.mjs';
import { searchSubtitles, searchNzb } from './adapters.mjs';
import { ping, snapshot } from './health.mjs';
import { readFileSync } from 'node:fs';
import { toPublic, proxyVideo } from './streams.mjs';
import { searchAll, listSources, startProbe, probeReport } from './fanout.mjs';
import { findTorrents, debugLookup } from './hayase-bridge.mjs';
import { parsePrefs, buildIndex, buildExtensionCode } from './hayase-ext.mjs';
import { getJob, listJobs, setPublicUrl, waitFor } from './torrents.mjs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

const WATCH_HTML = readFileSync(new URL('./watch.html', import.meta.url), 'utf8');

const app = Fastify({ logger: true, trustProxy: true });
await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
await initStorage();

// CORS: Hayase calls this API from its own origin, so browsers need these headers.
app.addHook('onRequest', async (req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'x-hayase-key, authorization, content-type');
  if (req.method === 'OPTIONS') return reply.code(204).send();
});


function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// Admin routes need API_TOKEN (Authorization: Bearer ...). No token configured = admin disabled.
async function admin(req, reply) {
  if (!cfg.adminToken) return reply.code(403).send({ error: 'admin disabled: set API_TOKEN' });
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEq(t, cfg.adminToken)) return reply.code(401).send({ error: 'unauthorized' });
}

// Hayase routes: optional HAYASE_KEY (header x-hayase-key or ?key=).
async function hayase(req, reply) {
  if (!cfg.hayaseKey) return;
  const k = req.headers['x-hayase-key'] || req.query.key || '';
  if (!safeEq(k, cfg.hayaseKey)) return reply.code(401).send({ error: 'unauthorized' });
}

app.get('/health', async (req, reply) => {
  const [extensionServer, flareSolverr] = await Promise.all([ping(cfg.extensionUrl + '/'), ping(cfg.flareUrl + '/')]);
  const ok = extensionServer && flareSolverr;
  return reply.code(ok ? 200 : 503).send({
    ok, api: 'up',
    extensionServer: extensionServer ? 'up' : 'down',
    flareSolverr: flareSolverr ? 'up' : 'down'
  });
});

app.get('/health/details', { preHandler: admin }, async () => ({ breakers: snapshot() }));
app.get('/extensions', { preHandler: admin }, async () => getIndex());
app.get('/providers', { preHandler: admin }, async () => ({ sources: await listProviders() }));

async function withSource(req, reply, fn) {
  const s = await getProvider(req.params.id);
  if (!s) return reply.code(404).send({ error: 'source not found' });
  return fn(s);
}

app.get('/source/:id/search', { preHandler: admin }, (req, reply) => {
  const q = String(req.query.q || '').trim();
  if (!q) return reply.code(400).send({ error: 'q required' });
  return withSource(req, reply, (s) => callProvider(s, 'getSearchAnime', { page: Number(req.query.page) || 1, search: q }));
});

app.get('/source/:id/details', { preHandler: admin }, (req, reply) => {
  if (!req.query.url) return reply.code(400).send({ error: 'url required' });
  return withSource(req, reply, (s) => callProvider(s, 'getDetailsAnime', { animeData: { url: String(req.query.url) } }));
});

app.get('/source/:id/episodes', { preHandler: admin }, (req, reply) => {
  if (!req.query.url) return reply.code(400).send({ error: 'url required' });
  return withSource(req, reply, (s) => callProvider(s, 'getEpisodeList', { animeData: { url: String(req.query.url) } }));
});

app.get('/hayase/nzb', { preHandler: hayase }, (req) => searchNzb(req.query));
app.get('/hayase/subtitles', { preHandler: hayase }, (req) => searchSubtitles(req.query));


// ---- user API (guarded by HAYASE_KEY when set) ----
const csv = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

app.get('/api/sources', { preHandler: hayase }, (req) =>
  listSources({ langs: csv(req.query.lang), nsfw: req.query.nsfw === '1' }));

app.get('/api/search', { preHandler: hayase }, (req, reply) => {
  const q = String(req.query.q || '').trim();
  if (!q) return reply.code(400).send({ error: 'q required' });
  return searchAll(q, {
    langs: csv(req.query.lang),
    ids: new Set(csv(req.query.sources)),
    nsfw: req.query.nsfw === '1',
    all: req.query.all === '1',
    limit: Math.min(Number(req.query.limit) || 30, 100)
  });
});

app.get('/api/source/:id/episodes', { preHandler: hayase }, (req, reply) => {
  if (!req.query.url) return reply.code(400).send({ error: 'url required' });
  return withSource(req, reply, (s) => callProvider(s, 'getEpisodeList', { animeData: { url: String(req.query.url) } }));
});

app.get('/api/source/:id/videos', { preHandler: hayase }, (req, reply) => {
  if (!req.query.url) return reply.code(400).send({ error: 'url required' });
  return withSource(req, reply, async (s) =>
    toPublic(await callProvider(s, 'getVideoList', { episodeData: { url: String(req.query.url) } })));
});

// Video bytes/manifests. The unguessable token from the runtime is the capability; no rate limit (HLS = many requests).
app.get('/v/*', { config: { rateLimit: false } }, proxyVideo);

app.get('/watch', async (req, reply) => reply.type('text/html; charset=utf-8').send(WATCH_HTML));

// ---- admin: which sources actually work? ----
app.get('/admin/probe', { preHandler: admin }, async (req) =>
  startProbe({ limit: Math.min(Number(req.query.limit) || 20, 500), langs: csv(req.query.lang), deep: req.query.deep !== '0' }));
app.get('/admin/probe/report', { preHandler: admin }, () => probeReport());

// ---- Hayase torrent bridge ----
function rememberPublic(req) { setPublicUrl(`${req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`); }

app.get('/hayase/torrents', { preHandler: hayase }, async (req) => {
  rememberPublic(req);
  const t = req.query.title ?? req.query.titles ?? [];
  const titles = (Array.isArray(t) ? t : [t]).map(String).filter(Boolean);
  const ep = req.query.episode;
  return findTorrents(
    { titles, episode: ep === undefined || ep === '' ? undefined : Number(ep), resolution: Number(req.query.resolution) || undefined },
    {
      audio: ['sub', 'dub', 'any'].includes(req.query.audio) ? req.query.audio : 'sub',
      lang: String(req.query.lang || 'en'),
      quality: String(req.query.quality || '1080'),
      k: Math.min(Math.max(Number(req.query.k) || 3, 1), 6)
    });
});

// Repository + extension code for Hayase, generated per user (key and choices live in the import link).
const apiBase = (req) => `${req.protocol}://${req.headers['x-forwarded-host'] || req.headers.host}`;
app.get('/hayase/index.json', { preHandler: hayase }, async (req, reply) => {
  rememberPublic(req);
  return reply.header('cache-control', 'no-store').send(buildIndex(apiBase(req), String(req.query.key || ''), parsePrefs(req.query)));
});
app.get('/hayase/ext.js', { preHandler: hayase }, async (req, reply) => {
  rememberPublic(req);
  return reply.header('cache-control', 'no-store').type('text/javascript; charset=utf-8')
    .send(buildExtensionCode(apiBase(req), String(req.query.key || ''), parsePrefs(req.query)));
});

// .torrent (waits for the conversion to finish, up to ~3 min)
app.get('/t/:file', { config: { rateLimit: false } }, async (req, reply) => {
  rememberPublic(req);
  const id = String(req.params.file).replace(/\.torrent$/, '');
  const job = await getJob(id);
  if (!job) return reply.code(404).send({ error: 'unknown torrent' });
  await waitFor([job], 180_000, 1);
  if (job.status === 'failed') return reply.code(502).send({ error: job.error });
  if (job.status !== 'ready') return reply.code(503).header('retry-after', '10').send({ error: 'still preparing: ' + job.status });
  return reply.type('application/x-bittorrent').send(job.torrent);
});

// the web seed: the converted mp4 with Range support
app.get('/f/:id/*', { config: { rateLimit: false } }, async (req, reply) => {
  const job = await getJob(req.params.id);
  if (!job || job.status !== 'ready') return reply.code(404).send({ error: 'not ready' });
  const { size } = await stat(job.file);
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0, end = size - 1, code = 200;
  if (m && (m[1] || m[2])) {
    if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), size - 1); }
    else { start = Math.max(size - Number(m[2]), 0); }
    if (start > end || start >= size) return reply.code(416).header('content-range', `bytes */${size}`).send();
    code = 206;
    reply.header('content-range', `bytes ${start}-${end}/${size}`);
  }
  reply.header('accept-ranges', 'bytes').header('content-length', end - start + 1).type('video/mp4').code(code);
  const stream = createReadStream(job.file, { start, end });
  reply.raw.on('close', () => stream.destroy());
  return reply.send(stream);
});

app.get('/admin/lookup', { preHandler: admin }, async (req) => {
  const t = req.query.title ?? [];
  const titles = (Array.isArray(t) ? t : [t]).map(String).filter(Boolean);
  const ep = req.query.episode;
  return debugLookup({ titles, episode: ep === undefined || ep === '' ? undefined : Number(ep) }, { lang: String(req.query.lang || 'en') });
});

app.get('/admin/jobs', { preHandler: admin }, async () => listJobs());

app.get('/resolve/video', { preHandler: admin }, (req, reply) =>
  reply.code(501).send({ error: 'provider adapter required' }));

app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  let msg = String(err.message || err);
  if (/does not define or inherit an implementation/.test(msg)) msg = 'This source uses a newer extension format (Hoster API) that the runtime does not support yet.';
  reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 502).send({ error: msg });
});

app.listen({ port: cfg.port, host: '0.0.0.0' }).catch((e) => { app.log.error(e); process.exit(1); });
