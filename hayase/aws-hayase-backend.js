// Set these two before publishing/importing. Keep KEY out of public repos
// (use a private fork, or leave HAYASE_KEY empty on the server).
const API = 'https://mouadh-hayase.duckdns.org';
const KEY = '';

const headers = KEY ? { 'x-hayase-key': KEY } : {};

async function getJson(url) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`backend HTTP ${r.status}`);
  return r.json();
}

export default {
  async test() {
    return (await fetch(API + '/health')).ok;
  },
  async single(q) {
    const title = q?.titles?.[0] || '';
    const episode = q?.episode ?? 1;
    const x = await getJson(API + '/hayase/nzb?' + new URLSearchParams({ title, episode }));
    return (x.results || []).map((r) => ({ title: r.title, link: r.url, size: r.size || 0, type: 'http' }));
  },
  async batch() { return []; },
  async movie() { return []; }
};
