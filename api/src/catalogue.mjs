// Yuzono catalogue loader: index with mirror failover + stale-cache fallback,
// and APK download/cache.
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { cfg } from './config.mjs';
import { failover } from './health.mjs';

const indexFile = () => path.join(cfg.dataDir, 'yuzono-index.json');
let memo = null;

export async function initStorage() {
  await mkdir(path.join(cfg.dataDir, 'extensions'), { recursive: true });
}

async function fetchJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export async function getIndex() {
  if (memo && Date.now() - memo.at < cfg.indexTtlMs) return memo.data;
  try {
    const s = await stat(indexFile());
    if (Date.now() - s.mtimeMs < cfg.indexTtlMs) {
      memo = { at: s.mtimeMs, data: JSON.parse(await readFile(indexFile(), 'utf8')) };
      return memo.data;
    }
  } catch { /* no fresh cache */ }
  try {
    const data = await failover('index', cfg.indexUrls, fetchJson);
    await writeFile(indexFile(), JSON.stringify(data));
    memo = { at: Date.now(), data };
    return data;
  } catch (e) {
    try { // a stale cache beats an outage; retry upstream in ~1 min
      const data = JSON.parse(await readFile(indexFile(), 'utf8'));
      memo = { at: Date.now() - cfg.indexTtlMs + 60_000, data };
      return data;
    } catch { throw e; }
  }
}

export function flattenSources(index) {
  return (Array.isArray(index) ? index : []).flatMap((e) =>
    (e.sources || []).map((s) => ({
      ...s,
      extension: { name: e.name, pkg: e.pkg, apk: e.apk, version: e.version, lang: e.lang, nsfw: e.nsfw }
    }))
  );
}

export async function findExtension(pkg) {
  const idx = await getIndex();
  return (Array.isArray(idx) ? idx : []).find((x) => x.pkg === pkg) || null;
}

export async function getApk(ext) {
  const key = createHash('sha256').update(`${ext.pkg}:${ext.version}:${ext.apk}`).digest('hex');
  const file = path.join(cfg.dataDir, 'extensions', `${key}.apk`);
  try { await stat(file); return file; } catch { /* download */ }
  await failover('apk', cfg.apkBases, async (base) => {
    const r = await fetch(base + encodeURIComponent(ext.apk), { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await writeFile(file, Buffer.from(await r.arrayBuffer()));
  });
  return file;
}
