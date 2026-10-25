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

switch_tag() {
  write_var JARVIS_PREVIOUS_TAG "$(read_var JARVIS_TAG)"
  write_var JARVIS_TAG "$1"
  docker compose up -d --wait
}

deploy() {
  local tag=$1
  if [ -n "$(read_var JARVIS_TAG)" ]; then docker compose run --rm backup backup.sh; fi
  JARVIS_TAG=$tag docker compose build
  switch_tag "$tag"
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
