#!/bin/sh
set -eu

DATA_ROOT="${QUINTAL_DATA_ROOT:-/data}"

# A development .env reaches the container through compose's env_file, and the
# paths in it are relative to a repo checkout. Inside the container they resolve
# under /app rather than the volume, so the database would be recreated empty on
# the next `docker compose up` and the old one would leave with the container.
#
# Refusing to boot stops the data loss but leaves the container restarting
# forever against a config that cannot fix itself. Inside the container a
# relative path is never what anyone meant, and the right answer is known, so
# take it and say so.
relative_to_volume() {
  case "${2:-}" in
    '' | file:/*) return 0 ;;
    file:*)
      corrected="file:$DATA_ROOT/$(basename "${2#file:}")"
      echo "$1=$2 is relative, which inside the container resolves off the" >&2
      echo "$DATA_ROOT volume. Using $corrected instead." >&2
      echo "This usually means a development .env reached compose's env_file;" >&2
      echo "drop $1 from it to silence this." >&2
      export "$1=$corrected"
      ;;
  esac
}

relative_to_volume DATABASE_URL "${DATABASE_URL:-}"
relative_to_volume STORAGE_URL "${STORAGE_URL:-}"

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
