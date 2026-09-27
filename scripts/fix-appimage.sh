#!/usr/bin/env bash
# Keep libdbus on the host for the sync-secret-service backend, and install the
# harness the AppImage was deliberately bundled without.
set -euo pipefail
[[ $# -eq 3 || $# -eq 4 ]] || { echo 'Usage: fix-appimage.sh <AppImage> <appimagetool> <sidecar> [node-runtime]' >&2; exit 1; }
appimage=$(realpath "$1")
appimagetool=$(realpath "$2")
sidecar=$(realpath "$3")
node_runtime=${4:+$(realpath "$4")}
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
# linuxdeploy aborts on the Bun-compiled harness — see build-desktop-release.mjs
# — so it is bundled here instead, under the name the app spawns and beside the
# executable that spawns it.
[[ ! -e squashfs-root/usr/bin/quintal-acp ]] || { echo 'Harness already in the AppDir; linuxdeploy has seen it' >&2; exit 1; }
install -m 755 "$sidecar" squashfs-root/usr/bin/quintal-acp
# The personal office's Node runtime travels the same way, for the same
# reason: it is an external binary the AppImage was bundled without. The
# payload itself is a resource, which linuxdeploy handles, and is already in
# the AppDir.
if [[ -n "$node_runtime" ]]; then
  [[ ! -e squashfs-root/usr/bin/quintal-node ]] || { echo 'Node runtime already in the AppDir; linuxdeploy has seen it' >&2; exit 1; }
  install -m 755 "$node_runtime" squashfs-root/usr/bin/quintal-node
fi
APPIMAGE_EXTRACT_AND_RUN=1 ARCH=x86_64 "$appimagetool" \
  --runtime-file "$scratch/runtime" "$scratch/squashfs-root" "$scratch/fixed.AppImage"
chmod +x fixed.AppImage
mv fixed.AppImage "$appimage"
