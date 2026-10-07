// Title matching and stream classification (quality / sub vs dub).
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'no', 'wa', 'to', 'season', 'part', 'tv']);

export const tokens = (s) =>
  String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((t) => t && !STOP.has(t));

export function similarity(a, b) {
  const A = new Set(tokens(a)), B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  let score = (2 * hit) / (A.size + B.size);
  // one title is a long, fully-contained version of the other ("Reborn as a Goblin" in the full English title)
  if (Math.min(A.size, B.size) >= 3 && hit === Math.min(A.size, B.size)) score = Math.max(score, 0.85);
  // "Title 2" vs "Title 3": different numbers = probably a different season
  const nums = (S) => [...S].filter((t) => /^\d+$/.test(t)).sort().join(',');
  if (nums(A) !== nums(B) && (nums(A) || nums(B))) score *= 0.6;
  return score;
}

export const bestSimilarity = (title, targets) => Math.max(0, ...targets.map((t) => similarity(title, t)));

export function findEpisode(eps, n) {
  if (!Array.isArray(eps) || !eps.length) return null;
  if (n == null || Number.isNaN(n)) return eps.length === 1 ? eps[0] : null; // movies
  const byNum = eps.find((e) => Number(e.episode_number) >= 0 && Math.round(Number(e.episode_number)) === n);
  if (byNum) return byNum;
  const re = new RegExp(`(?:^|[^\\d])0*${n}(?:[^\\d]|$)`);
  return eps.find((e) => re.test(String(e.name || ''))) || null;
}

export function classify(video, ctx = '') {
  const text = `${video.quality || ''} ${ctx}`;
  const audio = /\b(dub|dubbed|english dub)\b|مدبلج|دبلجة/i.test(text) ? 'dub' : 'sub';
  let res = 0;
  const m = /(\d{3,4})\s*p/i.exec(text);
  if (m) res = Number(m[1]);
  else if (/\b(4k|uhd|2160)\b/i.test(text)) res = 2160;
  else if (/\b(fhd|full ?hd)\b/i.test(text)) res = 1080;
  else if (/\bhd\b/i.test(text)) res = 720;
  return { audio, res };
}

// wanted: 'best' or a number. Closest-at-or-below first, then above; unknown resolution last.
export function qualityRank(res, wanted) {
  if (!res) return 1e6;
  if (wanted === 'best' || !wanted) return -res;
  return res <= wanted ? wanted - res : 10000 + (res - wanted);
}

// Search terms for a source's search box: Latin-script titles only, cleaned, plus a shortened variant.
export function searchTerms(titles) {
  const clean = (t) => String(t).replace(/\b(\d+(st|nd|rd|th) season|season \d+|part \d+|\(tv\))\b/gi, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const latin = titles.filter((t) => (String(t).match(/[A-Za-z]/g) || []).length >= 3);
  const terms = [];
  for (const t of latin.length ? latin : titles) {
    const c = clean(t);
    if (c && !terms.includes(c)) terms.push(c);
  }
  for (const c of [...terms]) {
    const short = c.split(' ').slice(0, 5).join(' ');
    if (c.split(' ').length > 6 && !terms.includes(short)) terms.push(short);
  }
  return terms.slice(0, 4);
}
