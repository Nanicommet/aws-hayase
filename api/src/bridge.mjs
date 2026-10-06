// Extension runtime bridge: sends an APK + method call to M-Extension-Server.
import { readFile } from 'node:fs/promises';
import { cfg } from './config.mjs';
import { findExtension, getApk } from './catalogue.mjs';

export async function invoke(source, method, extra = {}) {
  const ext = await findExtension(source.extension.pkg);
  if (!ext) throw new Error('extension not found in catalogue');
  const data = (await readFile(await getApk(ext))).toString('base64');
  const r = await fetch(`${cfg.extensionUrl}/dalvik`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-proxy-url': cfg.flareUrl },
    body: JSON.stringify({
      data, method,
      sourceId: String(source.id ?? ''),
      sourceBaseUrl: source.baseUrl || '',
      lang: source.lang || ext.lang || '',
      ...extra
    }),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs)
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) throw new Error(body.error || `extension HTTP ${r.status}`);
  return body;
}
