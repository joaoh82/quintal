#!/bin/sh
set -eu

DATA_ROOT="${QUINTAL_DATA_ROOT:-/data}"

# A development .env reaches the container through compose's env_file, and the
# paths in it are relative to a repo checkout. Inside the container they resolve
# under /app rather than the volume, so the database is recreated empty on the
# next `docker compose up` and the old one goes with the container — silently,
# which is the part that matters. Refuse instead, the way production refuses
# local object storage.
refuse_relative() {
  case "${2:-}" in
    '' | file:/*) return 0 ;;
    file:*)
      echo "$1=$2 is a relative path." >&2
      echo >&2
      echo "It resolves inside the container, not on $DATA_ROOT, so everything written" >&2
      echo "there is lost when the container is replaced. This usually means a" >&2
      echo "development .env reached the container through compose's env_file." >&2
      echo >&2
      echo "Drop $1 from .env, or make it absolute: $1=file:$DATA_ROOT/..." >&2
      exit 1
      ;;
  esac
}

refuse_relative DATABASE_URL "${DATABASE_URL:-}"
refuse_relative STORAGE_URL "${STORAGE_URL:-}"

# Persist the session-signing secret on the data volume so a restart does not
# sign everyone out. A fresh secret per boot would invalidate every cookie.
SECRET_FILE="$DATA_ROOT/auth-secret"

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
