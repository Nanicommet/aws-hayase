// Minimal bencode encoder (enough to write .torrent files).
export function bencode(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([Buffer.from(`${b.length}:`), b]);
  }
  if (typeof v === 'number') return Buffer.from(`i${Math.trunc(v)}e`);
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(bencode), Buffer.from('e')]);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined)
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [bencode(k), bencode(v[k])]), Buffer.from('e')]);
  }
  throw new Error('bencode: unsupported type');
}
