#!/usr/bin/env bash
# Installs Docker + Compose + Buildx (Amazon Linux 2023 / Ubuntu / Debian), creates .env, starts the stack.
set -euo pipefail
cd "$(dirname "$0")"

case "$(uname -m)" in
  x86_64)  COMPOSE_ARCH=x86_64;  BUILDX_ARCH=amd64 ;;
  aarch64) COMPOSE_ARCH=aarch64; BUILDX_ARCH=arm64 ;;
  *) echo "Unsupported arch $(uname -m)"; exit 1 ;;
esac

if ! command -v docker >/dev/null; then
  if command -v dnf >/dev/null; then sudo dnf install -y docker git
  elif command -v yum >/dev/null; then sudo yum install -y docker git
  else sudo apt-get update && sudo apt-get install -y docker.io git curl; fi
fi
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER" || true

PLUGINS=/usr/local/lib/docker/cli-plugins
sudo mkdir -p "$PLUGINS"

if ! sudo docker compose version >/dev/null 2>&1; then
  sudo curl -fsSL "https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}" -o "$PLUGINS/docker-compose"
  sudo chmod +x "$PLUGINS/docker-compose"
fi

if ! sudo docker buildx version >/dev/null 2>&1; then
  # Resolve the latest tag from the redirect (no API rate limit), then fetch the matching binary.
  TAG="$(basename "$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/docker/buildx/releases/latest)")"
  sudo curl -fsSL "https://github.com/docker/buildx/releases/download/${TAG}/buildx-${TAG}.linux-${BUILDX_ARCH}" -o "$PLUGINS/docker-buildx"
  sudo chmod +x "$PLUGINS/docker-buildx"
fi

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s/^API_TOKEN=.*/API_TOKEN=$(openssl rand -hex 24)/" .env
  echo "Created .env with a new API_TOKEN."
fi

PROFILE=()
if grep -qE '^DOMAIN=.+' .env; then PROFILE=(--profile https); fi

sudo docker compose "${PROFILE[@]}" up -d --build
sleep 20
echo "=== STATUS ==="; sudo docker compose "${PROFILE[@]}" ps
echo "=== HEALTH ==="; curl -s "http://127.0.0.1:$(grep -E '^APP_PORT=' .env | cut -d= -f2 | head -n1)/health" || true
echo
echo "Admin token: $(grep -E '^API_TOKEN=' .env | cut -d= -f2)"
