# AWS Hayase

Self-hosted backend for a Yuzono-compatible extension runtime, with a Hayase manifest.

```
api/          Fastify API: provider manager, Yuzono catalogue loader, extension bridge,
              subtitle + NZB adapters, health/failover (circuit breakers, mirror failover)
runtime/      M-Extension-Server (built from source)
flaresolverr/ private Cloudflare-solving service (pinned via FLARESOLVERR_TAG)
hayase/       index.json + backend extension (+ experimental subtitle extension, not listed)
```

## Deploy

```bash
./install.sh            # installs Docker/Compose/Buildx, creates .env, starts everything
curl http://127.0.0.1:8080/health
```

Only the API is published, and only on loopback by default. FlareSolverr and the runtime are never published.

## HTTPS (required by Hayase)

1. Point a DNS A record at the server; open ports 80/443 in the security group; close 8080/18080.
2. Set `DOMAIN=your.domain` in `.env`, then `docker compose --profile https up -d`.
3. Put `https://your.domain` in `API` inside `hayase/aws-hayase-backend.js`, commit, and import
   `https://raw.githubusercontent.com/Nanicommet/aws-hayase/main/hayase/index.json` in Hayase.

## Watching (web player)

Open `https://YOUR.DOMAIN/watch?key=YOUR_HAYASE_KEY` in any browser. Search runs across all enabled
Yuzono sources, then pick an episode and a quality. mp4 plays directly; HLS plays through hls.js.
Video bytes are streamed through the runtime's built-in video proxy (headers/cookies handled, Range/seek
supported). No transcoding is done.

Which sources work right now: `GET /admin/probe?limit=50` (background job), then `GET /admin/probe/report`.
Sources that fail a probe are skipped by search; ones that pass are searched first.

**Hayase limitation:** Hayase plays torrents. Yuzono extensions return http/HLS streams, which Hayase can't
play, so this stack serves them through `/watch` instead.

## Auth

- `API_TOKEN`: admin routes (`/extensions`, `/providers`, `/source/*`, `/health/details`). Empty = admin disabled.
- `HAYASE_KEY`: optional, for `/hayase/*`. Anything in a public JS file is public, so either leave it
  empty (rate-limited, 120 req/min/IP) or keep the key in a private fork.

## Routes

| Route | Auth |
|---|---|
| `GET /health` (503 if a dependency is down) | none |
| `GET /health/details`, `/extensions`, `/providers` | admin |
| `GET /source/:id/search?q=`, `/details?url=`, `/episodes?url=` | admin |
| `GET /hayase/nzb?title=&episode=&year=` | HAYASE_KEY (optional) |
| `GET /hayase/subtitles?title=&episode=&language=` | HAYASE_KEY (optional) |

`SUBTITLE_INDEXER_URL` / `NZB_INDEXER_URL` accept comma-separated URLs (tried in order). They must return
`{"results":[{"title":"...","url":"...","episode":1,"language":"en"}]}`. The backend does not hard-code
third-party stream extraction; plug in sources you are authorized to access.

## Pinning

After a successful build, set `M_EXT_REF` (M-Extension-Server tag/commit) and `FLARESOLVERR_TAG` in `.env`
so upgrades are deliberate.
