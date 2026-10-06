// Circuit breaker + failover helpers. A target that fails `threshold` times in a
// row is skipped for `cooldownMs`, then retried once (half-open).
const state = new Map();

function get(name) {
  if (!state.has(name)) state.set(name, { fails: 0, openUntil: 0, lastError: null, lastOk: null });
  return state.get(name);
}

export async function guarded(name, fn, { threshold = 3, cooldownMs = 30_000 } = {}) {
  const s = get(name);
  if (s.openUntil > Date.now()) throw new Error(`${name}: circuit open`);
  try {
    const out = await fn();
    s.fails = 0; s.openUntil = 0; s.lastOk = Date.now();
    return out;
  } catch (e) {
    s.fails += 1; s.lastError = String(e.message || e);
    if (s.fails >= threshold) s.openUntil = Date.now() + cooldownMs;
    throw e;
  }
}

// Try each candidate in order; first success wins.
export async function failover(prefix, candidates, fn) {
  let last = new Error(`${prefix}: no candidates`);
  for (const c of candidates) {
    try { return await guarded(`${prefix}:${c}`, () => fn(c)); }
    catch (e) { last = e; }
  }
  throw last;
}

export async function ping(url, timeoutMs = 4000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

export function snapshot() {
  const out = {};
  for (const [k, v] of state) out[k] = { ...v, open: v.openUntil > Date.now() };
  return out;
}
