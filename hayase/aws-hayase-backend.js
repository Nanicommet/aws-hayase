// Static fallback (open mode, no access key). Recommended: import the generated link instead:
//   https://YOUR.DOMAIN/hayase/index.json?key=YOUR_KEY&audio=sub&lang=en&quality=1080
const API = 'https://mouadh-hayase.duckdns.org';
const KEY = '';
const PREFS = { audio: 'sub', lang: 'en', quality: '1080', k: '3' };
const headers = KEY ? { 'x-hayase-key': KEY } : {};

async function find(q) {
  const p = new URLSearchParams();
  (q.titles || []).slice(0, 3).forEach((t) => p.append('title', t));
  if (q.episode != null && q.episode !== '') p.set('episode', q.episode);
  if (q.resolution) p.set('resolution', q.resolution);
  for (const [k, v] of Object.entries(PREFS)) p.set(k, v);
  const r = await fetch(API + '/hayase/torrents?' + p, { headers });
  if (!r.ok) throw new Error('AWS Hayase backend: HTTP ' + r.status);
  const d = await r.json();
  if (d.preparing) throw new Error(d.message || 'Preparing on the server, try again in a minute.');
  if (!(d.results || []).length && d.message) throw new Error(d.message);
  return (d.results || []).map((x) => ({ ...x, date: new Date(x.date) }));
}

export default {
  async test() {
    const r = await fetch(API + '/health');
    if (!r.ok) throw new Error('AWS Hayase backend is unreachable');
    return true;
  },
  single: find,
  batch: async () => [],
  async movie(q) { return find({ ...q, episode: undefined }); }
};
