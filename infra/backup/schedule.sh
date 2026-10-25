#!/bin/sh
set -u
. /usr/local/bin/common.sh

BACKUP_TIME=${BACKUP_TIME:-03:30}
last_run_day=""

run_backup() {
  last_run_day=$(date +%F)
  backup.sh || true
}

[ -f "$LAST_SUCCESS_FILE" ] || run_backup
log "scheduled daily at $BACKUP_TIME ($TZ)"
while :; do
  if [ "$(date +%H:%M)" = "$BACKUP_TIME" ] && [ "$(date +%F)" != "$last_run_day" ]; then
    run_backup
  fi
  sleep 30
done
