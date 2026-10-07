// Turns a video stream into a web-seeded .torrent:
//   stream -> mp4 (ffmpeg copy, faststart) -> piece hashes -> .torrent with url-list (BEP 19) -> served from this API.
import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat, rename, readdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { cfg } from './config.mjs';
import { bencode } from './bencode.mjs';

const jobs = new Map();
let publicUrl = cfg.publicUrl;
export const setPublicUrl = (u) => { if (!publicUrl && u) publicUrl = u.replace(/\/$/, ''); };
export const getPublicUrl = () => publicUrl;

const secret = () => cfg.hayaseKey || cfg.adminToken || 'aws-hayase';
export const jobId = (key) => createHmac('sha1', secret()).update(key).digest('hex').slice(0, 20);
const slug = (s) => String(s).replace(/[^A-Za-z0-9._()\[\] -]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110) || 'video';
const f = (id, ext) => path.join(cfg.cacheDir, `${id}${ext}`);

let ffmpegOk = null;
function hasFfmpeg() {
  if (ffmpegOk !== null) return Promise.resolve(ffmpegOk);
  return new Promise((res) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => res((ffmpegOk = false)));
    p.on('close', (c) => res((ffmpegOk = c === 0)));
  });
}

let active = 0;
const waiters = [];
async function limited(fn) {
  if (active >= 2) await new Promise((r) => waiters.push(r));
  active++;
  try { return await fn(); } finally { active--; waiters.shift()?.(); }
}

function ffmpegRemux(input, out) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto', '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', out]);
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-600); });
    const t = setTimeout(() => p.kill('SIGKILL'), 15 * 60_000);
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.trim())); });
  });
}

async function toMp4(spec, out) {
  const input = spec.videoPath.startsWith('/v/') ? `http://127.0.0.1:${cfg.port}${spec.videoPath}` : spec.videoPath;
  const ffmpeg = await hasFfmpeg();
  if (spec.isHls) {
    if (!ffmpeg) throw new Error('ffmpeg is not installed (needed for HLS streams)');
    await ffmpegRemux(input, out); // HLS segments are sequential: stream straight through
  } else {
    // Plain files: download first (an mp4 whose index is at the end can't be remuxed from a pipe), then remux locally.
    const src = out + '.src';
    const r = await fetch(input);
    if (!r.ok || !r.body) throw new Error(`download HTTP ${r.status}`);
    await pipeline(Readable.fromWeb(r.body), createWriteStream(src));
    try {
      if (ffmpeg) { await ffmpegRemux(src, out); } else { await rename(src, out); }
    } finally {
      await unlink(src).catch(() => {});
    }
  }
  const { size } = await stat(out);
  if (size < 10_000) throw new Error(`conversion produced an empty/too-small file (${size} bytes)`);
}

function pieceLength(size) {
  let pl = 1 << 18; // 256 KiB
  while (size / pl > 4000 && pl < (1 << 22)) pl *= 2;
  return pl;
}

async function hashPieces(file, pl) {
  const out = [];
  let h = createHash('sha1'), n = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    let off = 0;
    while (off < chunk.length) {
      const take = Math.min(pl - n, chunk.length - off);
      h.update(chunk.subarray(off, off + take));
      n += take; off += take;
      if (n === pl) { out.push(h.digest()); h = createHash('sha1'); n = 0; }
    }
  }
  if (n > 0) out.push(h.digest());
  return Buffer.concat(out);
}

async function loadFromDisk(job) {
  try {
    const meta = JSON.parse(await readFile(f(job.id, '.json'), 'utf8'));
    await stat(f(job.id, '.mp4'));
    const torrent = await readFile(f(job.id, '.torrent'));
    Object.assign(job, { status: 'ready', ...meta, file: f(job.id, '.mp4'), torrent });
    return true;
  } catch { return false; }
}

async function build(job, spec) {
  if (!publicUrl) throw new Error('public URL unknown yet');
  await mkdir(cfg.cacheDir, { recursive: true });
  const tmp = f(job.id, '.part.mp4'), out = f(job.id, '.mp4');
  job.status = 'converting';
  await toMp4(spec, tmp);
  await rename(tmp, out);
  job.status = 'hashing';
  const { size } = await stat(out);
  const pl = pieceLength(size);
  const info = { length: size, name: `${slug(spec.name)}.mp4`, 'piece length': pl, pieces: await hashPieces(out, pl) };
  const hash = createHash('sha1').update(bencode(info)).digest('hex');
  const torrent = bencode({
    info,
    'url-list': [`${publicUrl}/f/${job.id}/${encodeURIComponent(info.name)}`],
    'created by': 'aws-hayase',
    'creation date': Math.floor(Date.now() / 1000),
    comment: spec.name
  });
  await writeFile(f(job.id, '.torrent'), torrent);
  await writeFile(f(job.id, '.json'), JSON.stringify({ name: info.name, size, hash }));
  Object.assign(job, { status: 'ready', name: info.name, size, hash, file: out, torrent });
  evict(job.id).catch(() => {});
}

export function prepare(spec) {
  const id = jobId(spec.key);
  let job = jobs.get(id);
  if (job && job.status !== 'failed') return job;
  job = { id, status: 'queued', name: spec.name, size: 0, hash: null, error: null, at: Date.now() };
  jobs.set(id, job);
  job.done = (async () => {
    try {
      if (await loadFromDisk(job)) return;
      await limited(() => build(job, spec));
    } catch (e) {
      job.status = 'failed'; job.error = String(e.message || e);
    }
  })();
  return job;
}

export async function getJob(id) {
  let job = jobs.get(id);
  if (!job) {
    job = { id, status: 'queued', error: null, at: Date.now() };
    if (!(await loadFromDisk(job))) return null;
    jobs.set(id, job);
  }
  return job;
}

export const provisionalHash = (id) => createHash('sha1').update('prov:' + id).digest('hex');
export const listJobs = () => [...jobs.values()].map(({ id, status, name, size, hash, error, at }) => ({ id, status, name, size, hash, error, at }));

export async function waitFor(jobs_, ms, atLeast = 1) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ready = jobs_.filter((j) => j.status === 'ready').length;
    const pending = jobs_.filter((j) => !['ready', 'failed'].includes(j.status)).length;
    if (ready >= atLeast || (!pending)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function evict(keepId) {
  const files = (await readdir(cfg.cacheDir)).filter((n) => n.endsWith('.mp4') && !n.includes('.part'));
  const stats = await Promise.all(files.map(async (n) => ({ n, ...(await stat(path.join(cfg.cacheDir, n))) })));
  let total = stats.reduce((a, s) => a + s.size, 0);
  for (const s of stats.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (total <= cfg.cacheMaxBytes) break;
    const id = s.n.replace(/\.mp4$/, '');
    if (id === keepId) continue;
    for (const ext of ['.mp4', '.torrent', '.json']) await unlink(f(id, ext)).catch(() => {});
    jobs.delete(id);
    total -= s.size;
  }
}
