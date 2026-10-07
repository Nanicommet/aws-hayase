// Extension runtime bridge: sends an APK + method call to M-Extension-Server.
// The runtime returns a handle (X-Mangayomi-Extension-Id) for each loaded APK;
// we reuse it so the multi-MB APK isn't re-sent on every call.
import { readFile } from 'node:fs/promises';
import { cfg } from './config.mjs';
import { findExtension, getApk } from './catalogue.mjs';

const handles = new Map(); // "pkg:version" -> extensionId

async function post(body) {
  const r = await fetch(`${cfg.extensionUrl}/dalvik`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-proxy-url': cfg.flareUrl },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.requestTimeoutMs)
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, ok: r.ok, headers: r.headers, json };
}

export async function invoke(source, method, extra = {}) {
  const ext = await findExtension(source.extension.pkg);
  if (!ext) throw new Error('extension not found in catalogue');
  const hkey = `${ext.pkg}:${ext.version}`;
  const base = {
    method,
    sourceId: String(source.id ?? ''),
    sourceBaseUrl: source.baseUrl || '',
    lang: source.lang || ext.lang || '',
    ...extra
  };

  let res = null;
  const id = handles.get(hkey);
  if (id) {
    res = await post({ ...base, extensionId: id });
    if (res.status === 409) { handles.delete(hkey); res = null; } // runtime restarted: resend the APK
  }
  if (!res) {
    const data = (await readFile(await getApk(ext))).toString('base64');
    res = await post({ ...base, data });
    const newId = res.headers.get('x-mangayomi-extension-id');
    if (newId) handles.set(hkey, newId);
  }
  if (!res.ok) throw new Error(res.json?.error || `extension HTTP ${res.status}`);
  return res.json;
}
