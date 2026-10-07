// EXPERIMENTAL / NOT LISTED in index.json.
// The backend route (/hayase/subtitles) is ready, but I could not verify Hayase's
// subtitle-extension interface. Check Hayase's docs for the real shape before
// adding this to index.json; adjust the returned objects accordingly.
const API = 'https://mouadh-hayase.duckdns.org';
const KEY = '';
const headers = KEY ? { 'x-hayase-key': KEY } : {};

export default {
  async test() {
    return (await fetch(API + '/health')).ok;
  },
  async search(q) {
    const title = q?.titles?.[0] || '';
    const episode = q?.episode ?? 1;
    const language = q?.language || 'en';
    const r = await fetch(API + '/hayase/subtitles?' + new URLSearchParams({ title, episode, language }), { headers });
    if (!r.ok) throw new Error(`backend HTTP ${r.status}`);
    return (await r.json()).results || [];
  }
};
