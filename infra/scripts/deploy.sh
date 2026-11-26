#!/usr/bin/env bash
# Usage: infra/scripts/deploy.sh <tag>    snapshot, build the tag and start it
#        infra/scripts/deploy.sh rollback restart the previous tag (see docs/runbook.md for the database)
set -euo pipefail

dir=${JARVIS_DIR:-/opt/jarvis}
env_file=$dir/.env
cd "$dir"
touch "$env_file"

die() { printf 'deploy: %s\n' "$*" >&2; exit 1; }

read_var() { grep -E "^$1=" "$env_file" | tail -1 | cut -d= -f2- || true; }

write_var() {
  if grep -qE "^$1=" "$env_file"; then sed -i "s|^$1=.*|$1=$2|" "$env_file"; else echo "$1=$2" >> "$env_file"; fi
}

host_runner_installer=/usr/local/sbin/jarvis-agent-runner-install
build_cache_limit=${JARVIS_BUILD_CACHE_LIMIT:-10GB}

switch_tag() {
  write_var JARVIS_PREVIOUS_TAG "$(read_var JARVIS_TAG)"
  write_var JARVIS_TAG "$1"
  docker compose up -d --wait
  if [ -x "$host_runner_installer" ]; then sudo -n "$host_runner_installer" "$1"; fi
}

prune() {
  local current previous image
  current=$(read_var JARVIS_TAG)
  previous=$(read_var JARVIS_PREVIOUS_TAG)
  for image in $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^jarvis(-[a-z-]+)?:' || true); do
    case "${image##*:}" in "$current" | "$previous") continue ;; esac
    docker image rm "$image" >/dev/null 2>&1 || printf 'deploy: kept %s (in use)\n' "$image" >&2
  done
  docker image prune -f >/dev/null || printf 'deploy: could not prune dangling images\n' >&2
  docker builder prune -f --max-used-space "$build_cache_limit" >/dev/null || printf 'deploy: could not trim the build cache\n' >&2
}

deploy() {
  local tag=$1
  if [ -n "$(read_var JARVIS_TAG)" ]; then docker compose run --rm backup backup.sh; fi
  JARVIS_TAG=$tag docker compose build
  if [ -x "$host_runner_installer" ]; then JARVIS_TAG=$tag docker compose --profile agents build agent-runner; fi
  switch_tag "$tag"
  prune
}

rollback() {
  local previous
  previous=$(read_var JARVIS_PREVIOUS_TAG)
  [ -n "$previous" ] || die "no previous tag recorded"
  switch_tag "$previous"
}

case "${1:-}" in
  "") die "usage: deploy.sh <tag> | rollback" ;;
  rollback) rollback ;;
  *) deploy "$1" ;;
esac
