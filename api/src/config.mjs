const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const cfg = {
  port: Number(process.env.PORT || 8080),
  dataDir: process.env.DATA_DIR || '/data',
  indexUrls: list(process.env.YUZONO_INDEX_URL || 'https://raw.githubusercontent.com/yuzono/anime-repo/repo/index.min.json,https://cdn.jsdelivr.net/gh/yuzono/anime-repo@repo/index.min.json'),
  apkBases: list(process.env.YUZONO_APK_BASES || 'https://raw.githubusercontent.com/yuzono/anime-repo/repo/apk/,https://cdn.jsdelivr.net/gh/yuzono/anime-repo@repo/apk/'),
  extensionUrl: process.env.EXTENSION_SERVER_URL || 'http://runtime:8080',
  flareUrl: process.env.FLARESOLVERR_URL || 'http://flaresolverr:8191',
  adminToken: process.env.API_TOKEN || '',
  hayaseKey: process.env.HAYASE_KEY || '',
  subtitleUrls: list(process.env.SUBTITLE_INDEXER_URL),
  nzbUrls: list(process.env.NZB_INDEXER_URL),
  defaultLangs: list(process.env.DEFAULT_LANGS || 'en,all'),
  allowNsfw: process.env.ALLOW_NSFW === '1',
  searchConcurrency: Number(process.env.SEARCH_CONCURRENCY || 4),
  cacheDir: (process.env.DATA_DIR || '/data') + '/cache',
  cacheMaxBytes: Number(process.env.CACHE_MAX_GB || 5) * 1e9,
  prepareWaitMs: Number(process.env.PREPARE_WAIT_SEC || 90) * 1000,
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  indexTtlMs: 6 * 60 * 60 * 1000,
  requestTimeoutMs: 60_000
};
