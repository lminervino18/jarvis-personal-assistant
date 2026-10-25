DATA_DIR=${DATA_DIR:-/data}
CACHE_DIR=${CACHE_DIR:-/cache}
STAGE_DIR=$CACHE_DIR/stage
BACKUP_HOST=${BACKUP_HOST:-jarvis}
BACKUP_TAG=jarvis
LAST_SUCCESS_FILE=$CACHE_DIR/last-success

log() {
  printf '%s %s: %s\n' "$(date -u +%FT%TZ)" "${0##*/}" "$*"
}
