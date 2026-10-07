#!/usr/bin/env bash
# ./warp.sh on | off | status
# Routes the extension runtime (and FlareSolverr) through Cloudflare WARP, or back to direct.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Run ./install.sh first (no .env)"; exit 1; }

setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else echo "$1=$2" >> .env; fi; }
PROFILES=(); grep -qE '^DOMAIN=.+' .env && PROFILES+=(--profile https)
DC=(sudo docker compose "${PROFILES[@]}")

case "${1:-status}" in
  on)
    setenv JAVA_OPTS "-Dcom.sun.security.enableAIAcaIssuers=true -Dhttp.proxyHost=warp -Dhttp.proxyPort=1080 -Dhttps.proxyHost=warp -Dhttps.proxyPort=1080 -Dhttp.nonProxyHosts=localhost|127.*|flaresolverr|runtime|api|warp"
    setenv FLARE_PROXY "http://warp:1080"
    "${DC[@]}" --profile warp up -d --remove-orphans
    echo "Waiting for WARP to connect..."; sleep 20
    echo "--- WARP check (want warp=on) ---"
    "${DC[@]}" --profile warp exec -T warp curl -s --max-time 15 --socks5-hostname 127.0.0.1:1080 https://cloudflare.com/cdn-cgi/trace | grep -E '^(warp|ip|loc)=' || echo "WARP not connected yet - wait a minute and run: ./warp.sh status"
    ;;
  off)
    setenv JAVA_OPTS "-Dcom.sun.security.enableAIAcaIssuers=true"
    setenv FLARE_PROXY ""
    "${DC[@]}" up -d --remove-orphans
    echo "WARP is off: traffic goes out directly again."
    ;;
  status)
    if grep -q '^FLARE_PROXY=http' .env; then echo "WARP: ON"; else echo "WARP: OFF"; fi
    "${DC[@]}" --profile warp ps
    ;;
  *) echo "usage: ./warp.sh on|off|status"; exit 1 ;;
esac
