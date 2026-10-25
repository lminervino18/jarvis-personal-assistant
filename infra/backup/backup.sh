#!/bin/sh
set -eu
. /usr/local/bin/common.sh

RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}

ping_monitor() {
  [ -n "${BACKUP_PING_URL:-}" ] || return 0
  wget -q -T 10 -O /dev/null "$BACKUP_PING_URL$1" || log "monitor ping failed"
}

finish() {
  status=$?
  rm -rf "$STAGE_DIR"
  if [ "$status" -eq 0 ]; then
    ping_monitor ""
  else
    log "backup failed with status $status"
    ping_monitor "/fail"
  fi
}
trap finish EXIT

snapshot_database() {
  sqlite3 "$DATA_DIR/jarvis.db" ".timeout 10000" ".backup '$STAGE_DIR/jarvis.db'"
  [ "$(sqlite3 "$STAGE_DIR/jarvis.db" "PRAGMA integrity_check")" = "ok" ] || { log "snapshot failed integrity_check"; return 1; }
  [ -z "$(sqlite3 "$STAGE_DIR/jarvis.db" "PRAGMA foreign_key_check")" ] || { log "snapshot failed foreign_key_check"; return 1; }
}

ensure_repository() {
  restic cat config >/dev/null 2>&1 || restic init
}

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
[ -n "${RESTIC_PASSWORD:-}${RESTIC_PASSWORD_FILE:-}" ] || { log "RESTIC_PASSWORD is required"; exit 1; }

rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
snapshot_database
if [ -d "$DATA_DIR/memory" ]; then cp -a "$DATA_DIR/memory" "$STAGE_DIR/memory"; fi

ensure_repository
restic backup "$STAGE_DIR" --host "$BACKUP_HOST" --tag "$BACKUP_TAG" --quiet
restic forget --host "$BACKUP_HOST" --tag "$BACKUP_TAG" --group-by host,tags --keep-within "${RETENTION_DAYS}d" --prune --quiet
restic check --read-data-subset=5% --quiet

date +%s > "$LAST_SUCCESS_FILE"
log "backup finished"
