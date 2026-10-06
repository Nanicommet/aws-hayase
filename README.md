# AWS Hayase

Deployable AWS backend for a Yuzono-compatible extension runtime.

## Stack

- Fastify API
- Yuzono published extension index/cache
- M-Extension-Server runtime
- FlareSolverr kept private on the Docker network
- Hayase manifest
- Separate subtitle/NZB adapter endpoints

Yuzono publishes its Aniyomi/Anikku catalogue at the `anime-repo` `index.min.json`. M-Extension-Server exposes `/dalvik` and accepts a per-request `cf-proxy-url` header.

## Deploy

```bash
cp .env.example .env
# edit .env

docker compose up -d --build
curl http://127.0.0.1:8080/health
```

Only publish the API/reverse-proxy port. Never publish FlareSolverr or the extension server directly.

## Hayase

After putting the API behind HTTPS, replace `CHANGE-ME.example.com` in `hayase/aws-hayase-backend.js`, then import:

`https://raw.githubusercontent.com/Nanicommet/aws-hayase/main/hayase/index.json`

## Adapters

`SUBTITLE_INDEXER_URL` and `NZB_INDEXER_URL` are independent adapters. They should return:

```json
{"results":[{"title":"...","url":"...","episode":1,"language":"en"}]}
```

The backend intentionally does not hard-code third-party stream extraction. Plug in sources you are authorized to access.
