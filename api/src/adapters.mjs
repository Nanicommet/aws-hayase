// Subtitle / NZB adapters. Each accepts a comma-separated list of indexer URLs
// that are tried in order (failover). Indexers must return {"results":[...]}.
import { cfg } from './config.mjs';
import { failover } from './health.mjs';

async function query(prefix, bases, params) {
  if (!bases.length) return { configured: false, results: [] };
  const body = await failover(prefix, bases, async (base) => {
    const u = new URL(base);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    const r = await fetch(u, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
  return { configured: true, results: Array.isArray(body?.results) ? body.results : [] };
}

export const searchSubtitles = ({ title, episode, language }) =>
  query('subtitles', cfg.subtitleUrls, { title, episode, language: language || 'en' });

export const searchNzb = ({ title, episode, year }) =>
  query('nzb', cfg.nzbUrls, { title, episode, year });
