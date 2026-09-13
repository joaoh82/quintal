#!/usr/bin/env bash
# Keep libdbus on the host for the sync-secret-service backend.
set -euo pipefail
[[ $# -eq 2 ]] || { echo 'Usage: fix-appimage.sh <AppImage> <appimagetool>' >&2; exit 1; }
appimage=$(realpath "$1")
appimagetool=$(realpath "$2")
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
chmod +x "$appimage"
cd "$scratch"
"$appimage" --appimage-extract >/dev/null
# Preserve the original runtime rather than downloading another at repack time.
offset=$("$appimage" --appimage-offset)
[[ "$offset" =~ ^[0-9]+$ && "$offset" -gt 0 ]]
head -c "$offset" "$appimage" > runtime
find squashfs-root -name 'libdbus-1.so*' -print -delete
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$appimagetool" \
  --runtime-file "$scratch/runtime" "$scratch/squashfs-root" "$scratch/fixed.AppImage"
chmod +x fixed.AppImage
mv fixed.AppImage "$appimage"
