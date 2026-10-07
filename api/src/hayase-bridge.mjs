// Hayase query -> best matching streams -> web-seeded torrents.
import { searchAll } from './fanout.mjs';
import { callProvider } from './providers.mjs';
import { toPublic } from './streams.mjs';
import { bestSimilarity, findEpisode, classify, qualityRank } from './match.mjs';
import { prepare, waitFor, provisionalHash, getPublicUrl } from './torrents.mjs';
import { cfg } from './config.mjs';

const cache = new Map(); // query key -> { at, cands }
const TTL = 10 * 60_000;
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const pad = (n) => String(n).padStart(2, '0');

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

async function gatherCandidates(q, prefs) {
  const titles = q.titles.slice(0, 3);
  const found = await searchAll(titles[0].replace(/[^\p{L}\p{N} ]+/gu, ' '), {
    langs: prefs.lang ? [prefs.lang, 'all'] : undefined, limit: 40
  });
  // best matching anime per source, keep the strongest few sources
  const matches = [];
  for (const g of found.results) {
    let best = null;
    for (const it of g.items) {
      const score = bestSimilarity(it.title, titles);
      if (score >= 0.75 && (!best || score > best.score)) best = { ...it, score };
    }
    if (best) matches.push({ source: g.source, anime: best });
  }
  matches.sort((a, b) => b.anime.score - a.anime.score);

  const cands = [];
  await pool(matches.slice(0, 5), 3, async ({ source, anime }) => {
    try {
      const eps = await withTimeout(callProvider(await resolveSource(source.id), 'getEpisodeList', { animeData: { url: anime.url } }), 40_000);
      const ep = findEpisode(eps, q.episode);
      if (!ep) return;
      const videos = await withTimeout(callProvider(await resolveSource(source.id), 'getVideoList', { episodeData: { url: ep.url } }), 60_000);
      for (const v of toPublic(videos || [])) {
        if (!v.videoUrl) continue;
        const { audio, res } = classify(v, `${source.name} ${anime.title} ${ep.name || ''}`);
        cands.push({ source, anime, ep, v, audio, res, hls: /m3u8/i.test(v.videoUrl), score: anime.score });
      }
    } catch { /* this source failed; others may still work */ }
  });
  return cands;
}

async function resolveSource(id) {
  const { getProvider } = await import('./providers.mjs');
  return getProvider(id);
}

function choose(cands, q, prefs) {
  let list = cands;
  if (prefs.audio === 'sub' || prefs.audio === 'dub') {
    const only = cands.filter((c) => c.audio === prefs.audio);
    if (only.length) list = only; // else fall back to what exists (titles show the real audio)
  }
  const wanted = prefs.quality === 'best' ? 'best' : Number(prefs.quality) || Number(q.resolution) || 1080;
  list = [...list].sort((a, b) =>
    qualityRank(a.res, wanted) - qualityRank(b.res, wanted) || Number(a.hls) - Number(b.hls) || b.score - a.score);
  const seen = new Set(), out = [];
  for (const c of list) {
    const k = `${c.source.id}|${c.audio}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(c);
    if (out.length >= prefs.k) break;
  }
  return out;
}

export async function findTorrents(q, prefs) {
  if (!q.titles?.length) return [];
  const key = JSON.stringify([q.titles, q.episode, prefs.lang]);
  let hit = cache.get(key);
  if (!hit || Date.now() - hit.at > TTL) {
    hit = { at: Date.now(), cands: await gatherCandidates(q, prefs) };
    cache.set(key, hit);
  }
  const picked = choose(hit.cands, q, prefs);

  const items = picked.map((c) => {
    const name = `[${c.source.name}] ${c.anime.title} - ${q.episode != null ? pad(q.episode) : 'Movie'} [${c.res ? c.res + 'p' : 'HD'}] [${c.audio.toUpperCase()}]`;
    const job = prepare({ key: `${c.source.id}|${c.ep.url}|${c.v.quality}`, name, videoPath: c.v.videoUrl, isHls: c.hls });
    return { c, name, job };
  });
  await waitFor(items.map((i) => i.job), cfg.prepareWaitMs, 1);

  const pub = getPublicUrl();
  return items.filter((i) => i.job.status !== 'failed').map(({ c, name, job }) => ({
    title: name,
    link: `${pub}/t/${job.id}.torrent`,
    hash: job.hash || provisionalHash(job.id),
    size: job.size || 0,
    seeders: 10, leechers: 0, downloads: 0,
    accuracy: c.score >= 0.9 ? 'high' : 'medium',
    date: new Date().toISOString(),
    ready: job.status === 'ready',
    status: job.status
  }));
}
