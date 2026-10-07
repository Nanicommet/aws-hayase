// Turns the runtime's loopback video-proxy URLs into public /v/ URLs and serves them.
// The runtime's proxy already adds the headers/cookies an extension needs and rewrites
// HLS manifests; we only re-point it and forward Range requests so seeking works.
import { Readable } from 'node:stream';
import { cfg } from './config.mjs';

const PROXY_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/video\//g;

export function toPublic(value) {
  return JSON.parse(JSON.stringify(value).replace(PROXY_RE, '/v/'));
}

export async function proxyVideo(req, reply) {
  const rest = String(req.params['*'] || '');
  if (!rest || rest.includes('..') || rest.includes('\\')) return reply.code(400).send({ error: 'bad path' });

  const headers = {};
  if (req.headers.range) headers.range = req.headers.range;
  const up = await fetch(`${cfg.extensionUrl}/video/${rest}`, { headers, signal: AbortSignal.timeout(120_000) });

  const type = up.headers.get('content-type') || 'application/octet-stream';
  const isManifest = /mpegurl/i.test(type) || /\.m3u8$/i.test(rest);
  if (isManifest && up.ok) {
    const text = (await up.text()).replace(PROXY_RE, '/v/');
    return reply.code(up.status).type('application/vnd.apple.mpegurl').send(text);
  }

  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    const v = up.headers.get(h);
    if (v) reply.header(h, v);
  }
  reply.code(up.status);
  if (!up.body) return reply.send();
  const stream = Readable.fromWeb(up.body);
  reply.raw.on('close', () => stream.destroy());
  return reply.send(stream);
}
