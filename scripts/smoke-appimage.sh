#!/usr/bin/env bash
# Run inside xvfb-run on a fresh Linux runner, against the real AppImage.
set -euo pipefail
appimage=$(realpath "$1")
evidence=$(realpath "$2")
mkdir -p "$evidence"
scratch=$(mktemp -d)
app_pid=''
# Invoked indirectly by trap on every exit path.
# shellcheck disable=SC2329
cleanup() {
  if [[ -n "$app_pid" ]]; then kill "$app_pid" 2>/dev/null || true; wait "$app_pid" 2>/dev/null || true; fi
  rm -rf "$scratch"
}
trap cleanup EXIT
chmod +x "$appimage"
cd "$scratch"
"$appimage" --appimage-extract > "$evidence/extract.log"
sidecar=$(find squashfs-root -type f -name quintal-acp -print -quit)
[[ -n "$sidecar" ]]
env PATH=/usr/bin:/bin "$sidecar" --help > "$evidence/sidecar.log"
grep -q quintal-acp "$evidence/sidecar.log"
# AppImage intentionally depends on the host's D-Bus library.
if find squashfs-root -name 'libdbus-1.so*' | grep -q .; then
  echo 'AppImage unexpectedly bundles libdbus' >&2
  exit 1
fi
unset QUINTAL_SERVER_URL QUINTAL_OFFICE_URL
export XDG_DATA_HOME="$scratch/data" XDG_CONFIG_HOME="$scratch/config"
export QUINTAL_SECRETS_BACKEND=file QUINTAL_NO_LOGIN_PATH=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 LIBGL_ALWAYS_SOFTWARE=1
"$appimage" --appimage-extract-and-run > "$evidence/app.log" 2>&1 &
app_pid=$!
# Tesseract wants dark text on a light ground. The picker is the other way
# round — near-white on near-black — and reading it directly returns noise: the
# first run of this check rendered a perfect window and OCR'd its title as
# "DOT". Invert and upscale a copy to read, and keep the untouched screenshot as
# the evidence a human looks at.
magick=$(command -v magick || command -v convert)
for _ in $(seq 1 45); do
  kill -0 "$app_pid"
  import -window root "$evidence/server-picker.png"
  "$magick" "$evidence/server-picker.png" -colorspace Gray -negate -resize 200% "$scratch/ocr.png"
  tesseract "$scratch/ocr.png" "$evidence/server-picker" 2>/dev/null
  if grep -qi 'Which server' "$evidence/server-picker.txt"; then
    echo 'PASS: packaged AppImage rendered Which server?; bundled sidecar answered --help'
    exit 0
  fi
  sleep 2
done
cat "$evidence/app.log"
echo 'Server picker did not render within 90 seconds' >&2
exit 1
