#!/bin/sh
set -eu

# Persist the session-signing secret on the data volume so a restart does not
# sign everyone out. A fresh secret per boot would invalidate every cookie.
SECRET_FILE="${QUINTAL_DATA_ROOT:-/data}/auth-secret"

if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  if [ -s "$SECRET_FILE" ]; then
    BETTER_AUTH_SECRET=$(tr -d '\n' < "$SECRET_FILE")
  else
    BETTER_AUTH_SECRET=$(openssl rand -base64 32)
    umask 077
    printf '%s\n' "$BETTER_AUTH_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
  fi
  export BETTER_AUTH_SECRET
fi

exec node apps/server/dist/index.js
