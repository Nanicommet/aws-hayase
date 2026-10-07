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
  startProbe({ limit: Math.min(Number(req.query.limit) || 20, 500), langs: csv(req.query.lang) }));
app.get('/admin/probe/report', { preHandler: admin }, () => probeReport());

app.get('/resolve/video', { preHandler: admin }, (req, reply) =>
  reply.code(501).send({ error: 'provider adapter required' }));

app.setErrorHandler((err, req, reply) => {
  req.log.error(err);
  reply.code(err.statusCode && err.statusCode < 500 ? err.statusCode : 502).send({ error: String(err.message || err) });
});

app.listen({ port: cfg.port, host: '0.0.0.0' }).catch((e) => { app.log.error(e); process.exit(1); });
