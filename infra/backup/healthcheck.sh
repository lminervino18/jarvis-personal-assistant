#!/bin/sh
. /usr/local/bin/common.sh
[ -n "$(find "$LAST_SUCCESS_FILE" -mmin -2160 2>/dev/null)" ]
