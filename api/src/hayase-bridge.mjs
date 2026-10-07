// Hayase query -> best matching streams -> web-seeded torrents.
import { searchAll } from './fanout.mjs';
import { callProvider } from './providers.mjs';
import { toPublic } from './streams.mjs';
import { bestSimilarity, findEpisode, classify, qualityRank, searchTerms } from './match.mjs';
import { prepare, waitFor, getPublicUrl } from './torrents.mjs';
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

async function findMatches(titles, prefs, wide, dbg) {
  for (const term of searchTerms(titles)) {
    const found = await searchAll(term, {
      langs: prefs.lang ? [prefs.lang, 'all'] : undefined,
      limit: wide ? 80 : 30, all: wide
    });
    if (dbg) { dbg.searched = (dbg.searched || 0) + found.searched; (dbg.terms ||= []).push({ term, wide, sourcesWithResults: found.results.length, failed: found.errors.length }); }
    if (dbg && found.errors.length) {
      const why = {};
      for (const e of found.errors) { const k = String(e.error).replace(/eu\.kanade[\w.$]*/g, '<ext>').slice(0, 70); why[k] = (why[k] || 0) + 1; }
      (dbg.searchFailures ||= []).push(why);
    }
    const matches = [];
    for (const g of found.results) {
      let best = null;
      for (const it of g.items) {
        const score = bestSimilarity(it.title, titles);
        if (dbg && score >= 0.4) (dbg.near ||= []).push({ source: g.source.name, title: it.title, score: Number(score.toFixed(2)) });
        if (score >= 0.75 && (!best || score > best.score)) best = { ...it, score };
      }
      if (best) matches.push({ source: g.source, anime: best });
    }
    if (matches.length) return matches;
  }
  return [];
}

async function gatherCandidates(q, prefs, dbg) {
  const titles = q.titles.slice(0, 4);
  let matches = await findMatches(titles, prefs, false, dbg);
  if (!matches.length) matches = await findMatches(titles, prefs, true, dbg); // not in the proven sources: try them all
  matches.sort((a, b) => b.anime.score - a.anime.score);
  if (dbg) dbg.matched = matches.map((m) => ({ source: m.source.name, title: m.anime.title, score: Number(m.anime.score.toFixed(2)) }));

  const cands = [];
  await pool(matches.slice(0, 5), 3, async ({ source, anime }) => {
    try {
      const src = await resolveSource(source.id);
      const eps = await withTimeout(callProvider(src, 'getEpisodeList', { animeData: { url: anime.url } }), 40_000);
      const ep = findEpisode(eps, q.episode);
      if (!ep) { dbg?.noEpisode?.push(source.name) ?? (dbg && (dbg.noEpisode = [source.name])); return; }
      const videos = await withTimeout(callProvider(src, 'getVideoList', { episodeData: { url: ep.url } }), 60_000);
      for (const v of toPublic(videos || [])) {
        if (!v.videoUrl) continue;
        const { audio, res } = classify(v, `${source.name} ${anime.title} ${ep.name || ''}`);
        cands.push({ source, anime, ep, v, audio, res, hls: /m3u8/i.test(v.videoUrl), score: anime.score });
      }
    } catch (e) { if (dbg) (dbg.errors ||= []).push(`${source.name}: ${String(e.message || e).slice(0, 80)}`); }
  });
  if (dbg) dbg.candidates = cands.length;
  return cands;
}

export async function debugLookup(q, prefs) {
  const dbg = {};
  const t0 = Date.now();
  await gatherCandidates(q, prefs, dbg);
  dbg.seconds = Math.round((Date.now() - t0) / 1000);
  if (dbg.near) dbg.near = dbg.near.sort((a, b) => b.score - a.score).slice(0, 10);
  return dbg;
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const candCache = new Map(); // "title|episode|lang" -> { at, done, list, error, promise }

function getCands(q, prefs) {
  const key = [q.titles[0].toLowerCase(), q.episode ?? 'movie', prefs.lang].join('|');
  let e = candCache.get(key);
  if (!e || Date.now() - e.at > TTL) {
    e = { at: Date.now(), done: false, list: null, error: null };
    e.promise = gatherCandidates(q, prefs)
      .then((l) => { e.list = l; })
      .catch((err) => { e.error = String(err.message || err); })
      .finally(() => {
        e.done = true;
        if (e.error || !e.list?.length) e.at = Date.now() - TTL + 2 * 60_000; // retry empty/failed lookups after 2 min
      });
    candCache.set(key, e);
  }
  return e;
}

// Never blocks longer than the budget (Hayase gives extensions 10 s): returns what is ready,
// or { preparing: true } while the search / conversion keeps running in the background.
export async function findTorrents(q, prefs, budgetMs = cfg.budgetMs) {
  if (!q.titles?.length) return { results: [] };
  const t0 = Date.now();
  const e = getCands(q, prefs);
  await Promise.race([e.promise, sleep(budgetMs)]);
  if (!e.done) return { preparing: true, message: 'Searching sources for this episode. Try again in about a minute.' };
  if (e.error) return { results: [], message: 'Search failed: ' + e.error };
  if (!e.list.length) return { results: [], message: 'No working source has this episode yet.' };

  const picked = choose(e.list, q, prefs);
  const items = picked.map((c) => {
    const name = `[${c.source.name}] ${c.anime.title} - ${q.episode != null ? pad(q.episode) : 'Movie'} [${c.res ? c.res + 'p' : 'HD'}] [${c.audio.toUpperCase()}]${prefs.lang && prefs.lang !== 'en' && prefs.lang !== 'all' ? ` [${prefs.lang.toUpperCase()}]` : ''}`;
    const job = prepare({ key: `${c.source.id}|${c.ep.url}|${c.v.quality}`, name, videoPath: c.v.videoUrl, isHls: c.hls });
    return { c, name, job };
  });
  await waitFor(items.map((i) => i.job), Math.max(budgetMs - (Date.now() - t0), 0), 1);

  const pub = getPublicUrl();
  const results = items.filter((i) => i.job.status === 'ready').map(({ c, name, job }) => ({
    title: name,
    link: `${pub}/t/${job.id}.torrent`,
    hash: job.hash,
    size: job.size,
    seeders: 10, leechers: 0, downloads: 0,
    accuracy: c.score >= 0.9 ? 'high' : 'medium',
    date: new Date().toISOString()
  }));
  if (results.length) return { results };
  if (items.some((i) => !['ready', 'failed'].includes(i.job.status)))
    return { preparing: true, message: 'Converting this episode on the server. Try again in about a minute.' };
  return { results: [], message: 'Conversion failed: ' + (items[0]?.job.error || 'unknown error') };
}
