#!/bin/sh
set -eu

DB=${1:?usage: table-counts.sh <database>}
for table in $(sqlite3 -readonly "$DB" "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"); do
  printf '%s %s\n' "$table" "$(sqlite3 -readonly "$DB" "SELECT count(*) FROM \"$table\"")"
done
