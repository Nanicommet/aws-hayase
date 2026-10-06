// Provider manager: resolves a source id and runs calls through a per-source
// circuit breaker so one broken extension can't stall the API.
import { getIndex, flattenSources } from './catalogue.mjs';
import { invoke } from './bridge.mjs';
import { guarded } from './health.mjs';

export async function listProviders() {
  return flattenSources(await getIndex()).map((s) => ({
    id: s.id, name: s.name, lang: s.lang, baseUrl: s.baseUrl, extension: s.extension
  }));
}

export async function getProvider(id) {
  return flattenSources(await getIndex()).find((s) => String(s.id) === String(id)) || null;
}

export function callProvider(source, method, extra) {
  return guarded(`provider:${source.id}`, () => invoke(source, method, extra));
}
