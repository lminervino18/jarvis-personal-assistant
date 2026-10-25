#!/usr/bin/env bash
# Backup and restore round trip against a synthetic database and a local restic repository.
# Usage: infra/scripts/restore-test.sh   (JARVIS_IMAGE and BACKUP_IMAGE override the image tags)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
app_image=${JARVIS_IMAGE:-jarvis:local}
backup_image=${BACKUP_IMAGE:-jarvis-backup:local}
run_id=restore-test-$$
data_volume=$run_id-data
repo_volume=$run_id-repo
cache_volume=$run_id-cache
server=$run_id-server
password=synthetic-owner-password-0001
origin=https://restore-test.invalid
restic_password=synthetic-restic-password-0001

cleanup() {
  docker rm -f "$server" >/dev/null 2>&1 || true
  docker volume rm -f "$data_volume" "$repo_volume" "$cache_volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT

log() { printf 'restore-test: %s\n' "$*"; }
fail() { log "FAILED: $*"; exit 1; }

ensure_image() {
  docker image inspect "$1" >/dev/null 2>&1 && return 0
  log "building $1"
  docker build -q -t "$1" "${@:2}" >/dev/null
}

sidecar() {
  docker run --rm --network none \
    -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD="$restic_password" \
    -v "$data_volume":/data -v "$repo_volume":/repo -v "$cache_volume":/cache \
    "$backup_image" "$@"
}

owner_hash() {
  docker run --rm -e PASSWORD="$password" "$app_image" node -e '
    const { randomBytes, scryptSync } = require("node:crypto");
    const salt = randomBytes(16);
    const key = scryptSync(process.env.PASSWORD, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    process.stdout.write(["scrypt", 32768, 8, 1, salt.toString("base64"), key.toString("base64")].join("$"));
  '
}

start_server() {
  docker run -d --name "$server" \
    -e RUNTIME=scripted -e LOG_LEVEL=warn -e PUBLIC_ORIGIN="$origin" -e OWNER_PASSWORD_HASH="$(owner_hash)" \
    -v "$data_volume":/data "$app_image" >/dev/null
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$server")" = healthy ] && return 0
    sleep 1
  done
  docker logs "$server" 2>&1 | tail -20
  fail "server did not become healthy"
}

server_login_status() {
  docker exec -e PASSWORD="$password" -e ORIGIN="$origin" "$server" node -e '
    fetch("http://127.0.0.1:8080/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: process.env.ORIGIN },
      body: JSON.stringify({ password: process.env.PASSWORD }),
    }).then((response) => console.log(response.status));
  '
}

table_counts() {
  docker run --rm --network none --entrypoint table-counts.sh -v "$data_volume":/data "$backup_image" /data/jarvis.db
}

ensure_image "$app_image" "$root"
ensure_image "$backup_image" "$root/infra/backup"

log "creating volumes and starting the server on an empty database"
docker volume create "$data_volume" >/dev/null
docker volume create "$repo_volume" >/dev/null
docker volume create "$cache_volume" >/dev/null
docker run --rm --user 0 --entrypoint chown -v "$repo_volume":/repo "$backup_image" 10001:10001 /repo
start_server

log "seeding synthetic rows while the server keeps the database open"
docker run --rm -v "$here/seed-synthetic.mjs":/app/seed-synthetic.mjs:ro -v "$data_volume":/data \
  --entrypoint node "$app_image" /app/seed-synthetic.mjs >/dev/null
before=$(table_counts)
[ "$(grep -c . <<<"$before")" -gt 10 ] || fail "unexpected table list"
grep -q '^messages 200$' <<<"$before" || fail "seed did not insert the expected rows"
profile_before=$(docker exec "$server" sha256sum /data/memory/loren.md)

log "backing up with the server still running"
sidecar backup.sh
sidecar backup.sh
[ "$(docker run --rm -e RESTIC_REPOSITORY=/repo -e RESTIC_PASSWORD="$restic_password" -v "$repo_volume":/repo --entrypoint restic "$backup_image" snapshots --json | grep -o '"short_id"' | wc -l)" -eq 2 ] \
  || fail "expected two snapshots"

log "wiping the data volume"
docker rm -f "$server" >/dev/null
docker volume rm "$data_volume" >/dev/null
docker volume create "$data_volume" >/dev/null

log "restoring"
sidecar restore.sh latest /data >/dev/null
after=$(table_counts)
[ "$before" = "$after" ] || { diff <(echo "$before") <(echo "$after") || true; fail "row counts differ after restore"; }

log "booting the server on the restored database"
start_server
[ "$(docker exec "$server" sha256sum /data/memory/loren.md)" = "$profile_before" ] || fail "private profile differs after restore"
[ "$(server_login_status)" = 200 ] || fail "login failed on the restored database"
[ "$(sidecar sh -c 'sqlite3 /data/jarvis.db "PRAGMA integrity_check"')" = ok ] || fail "integrity_check failed after boot"

log "passed: $(grep -c . <<<"$after") tables with identical row counts, integrity ok, server healthy on the restored database"
