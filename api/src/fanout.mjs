// Search across many sources at once, and probe which sources actually work.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { cfg } from './config.mjs';
import { getIndex, flattenSources } from './catalogue.mjs';
import { callProvider } from './providers.mjs';
import { isOpen } from './health.mjs';

const statusFile = () => path.join(cfg.dataDir, 'source-status.json');
let statusMemo = null;

export async function loadStatus() {
  if (statusMemo) return statusMemo;
  try { statusMemo = JSON.parse(await readFile(statusFile(), 'utf8')); } catch { statusMemo = {}; }
  return statusMemo;
}

async function saveStatus() {
  await writeFile(statusFile(), JSON.stringify(statusMemo || {}));
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

const withTimeout = (p, ms) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

// Extensions built on the newer "Hoster" API (extensions-lib v16+) can't run on this runtime yet.
export const isSupported = (s) => (parseInt(s.extension.version, 10) || 0) < 16;

const brief = (s) => ({ id: s.id, name: s.name, lang: s.lang, extension: s.extension.name });

export async function pickSources({ langs, ids, nsfw, limit = 30 } = {}) {
  const all = flattenSources(await getIndex());
  const status = await loadStatus();
  let list;
  if (ids?.size) {
    list = all.filter((s) => ids.has(String(s.id)));
  } else {
    const L = new Set((langs?.length ? langs : cfg.defaultLangs).map((x) => x.toLowerCase()));
    const wantNsfw = cfg.allowNsfw && nsfw;
    list = all.filter((s) =>
      isSupported(s) &&
      L.has(String(s.lang || '').toLowerCase()) &&
      (wantNsfw || Number(s.extension.nsfw) !== 1) &&
      status[s.id]?.ok !== false &&           // skip sources a probe found broken
      !isOpen(`provider:${s.id}`));           // skip sources currently tripping their breaker
  }
  const rank = (s) => (status[s.id]?.ok === true ? 0 : 1); // verified-working first
  return list.sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export async function listSources(opts) {
  const status = await loadStatus();
  return (await pickSources({ ...opts, limit: opts?.limit ?? 1000 })).map((s) => ({ ...brief(s), ok: status[s.id]?.ok ?? null }));
}

export async function unsupportedCount() {
  return flattenSources(await getIndex()).filter((s) => !isSupported(s)).length;
}

export async function searchAll(q, opts = {}) {
  const sources = await pickSources(opts);
  const errors = [];
  const results = (await pool(sources, cfg.searchConcurrency, async (s) => {
    try {
      const r = await withTimeout(callProvider(s, 'getSearchAnime', { page: 1, search: q }), 25_000);
      const items = (r.animes || []).slice(0, 12).map((a) => ({ url: a.url, title: a.title, thumbnail: a.thumbnail_url || null }));
      return items.length ? { source: brief(s), items } : null;
    } catch (e) {
      errors.push({ source: brief(s), error: String(e.message || e) });
      return null;
    }
  })).filter(Boolean);
  return { searched: sources.length, skippedUnsupported: await unsupportedCount(), results, errors };
}

// ---- background probe: which sources return results right now? ----
export const probeState = { running: false, done: 0, total: 0, ok: 0, bad: 0, startedAt: null };

export async function startProbe({ limit = 20, langs } = {}) {
  if (probeState.running) return probeState;
  const sources = await pickSources({ langs, limit });
  Object.assign(probeState, { running: true, done: 0, total: sources.length, ok: 0, bad: 0, startedAt: Date.now() });
  await loadStatus();
  (async () => {
    await pool(sources, 2, async (s) => {
      const t = Date.now();
      try {
        const r = await withTimeout(callProvider(s, 'getPopularAnime', { page: 1 }), 40_000);
        const count = (r.animes || []).length;
        statusMemo[s.id] = { ok: count > 0, count, ms: Date.now() - t, at: Date.now() };
        count > 0 ? probeState.ok++ : probeState.bad++;
      } catch (e) {
        statusMemo[s.id] = { ok: false, error: String(e.message || e), ms: Date.now() - t, at: Date.now() };
        probeState.bad++;
      }
      probeState.done++;
    });
    await saveStatus();
    probeState.running = false;
  })().catch(() => { probeState.running = false; });
  return probeState;
}

export async function probeReport() {
  const status = await loadStatus();
  const bad = Object.entries(status).filter(([, v]) => v.ok === false).map(([id, v]) => ({ id, error: v.error || 'no results' }));
  const why = {};
  for (const b of bad) {
    const k = String(b.error).replace(/eu\.kanade[\w.$]*/g, '<ext>').slice(0, 90);
    why[k] = (why[k] || 0) + 1;
  }
  const reasons = Object.entries(why).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([reason, count]) => ({ count, reason }));
  return { state: probeState, working: Object.values(status).filter((v) => v.ok).length, broken: bad.length, topReasons: reasons, unsupportedSkipped: await unsupportedCount() };
}
