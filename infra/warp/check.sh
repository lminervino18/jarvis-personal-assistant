#!/usr/bin/env bash
# Usage: infra/warp/check.sh   gives YouTube downloads a new WARP identity when YouTube blocks the current one
set -euo pipefail

dir=${JARVIS_DIR:-/opt/jarvis}
warp_dir=${JARVIS_WARP_DIR:-/etc/jarvis/warp}
probe=https://www.youtube.com/watch?v=jNQXAC9IVRw

cd "$dir"
answer=$(docker compose exec -T server /opt/yt-dlp/yt-dlp_linux --js-runtimes node --no-warnings --proxy socks5h://warp:40000 --simulate --print id "$probe" 2>&1 || true)
case "$answer" in
  *"not a bot"*) ;;
  *) exit 0 ;;
esac

echo "warp: YouTube blocks the current identity, registering a new one"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"
wgcf register --accept-tos >/dev/null
wgcf generate >/dev/null
install -m 600 -o 10001 -g 10001 wgcf-account.toml wgcf-profile.conf "$warp_dir"/
cd "$dir"
docker compose restart warp
