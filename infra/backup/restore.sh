#!/bin/sh
set -eu
. /usr/local/bin/common.sh

SNAPSHOT=${1:-latest}
TARGET=${2:-$DATA_DIR}
WORK_DIR=$CACHE_DIR/restore
trap 'rm -rf "$WORK_DIR"' EXIT

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"

move_aside() {
  if [ -e "$1" ]; then mv "$1" "$1.pre-restore-$STAMP"; fi
}

rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR" "$TARGET"
restic restore "$SNAPSHOT:$STAGE_DIR" --host "$BACKUP_HOST" --tag "$BACKUP_TAG" --target "$WORK_DIR" --quiet

[ "$(sqlite3 "$WORK_DIR/jarvis.db" "PRAGMA integrity_check")" = "ok" ] || { log "restored database failed integrity_check"; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
move_aside "$TARGET/jarvis.db"
move_aside "$TARGET/jarvis.db-wal"
move_aside "$TARGET/jarvis.db-shm"
mv "$WORK_DIR/jarvis.db" "$TARGET/jarvis.db"
if [ -d "$WORK_DIR/memory" ]; then
  move_aside "$TARGET/memory"
  mv "$WORK_DIR/memory" "$TARGET/memory"
fi

log "restored $SNAPSHOT into $TARGET"
table-counts.sh "$TARGET/jarvis.db"
