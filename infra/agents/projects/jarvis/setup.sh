#!/bin/sh
# Installs the dependencies of a fresh JARVIS checkout, before any agent touches it.
set -eu
CI=true pnpm install --frozen-lockfile --prefer-offline --reporter=append-only
