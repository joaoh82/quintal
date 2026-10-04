#!/usr/bin/env bash
# Replays QUIN-4 with Node v22.23.3's own code — lib/fs.js realpathSync, lib/path.js
# win32, and src/path.cc ToNamespacedPath compiled as its Windows branch — against
# the entry v0.6.4 handed Node and the entry the fix hands it. Needs curl, g++, node.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cp "$here"/{stubs.h,ns.cc,load.cjs,replay.cjs,run-replay.cjs} "$work"/
cd "$work"
for f in lib/path.js lib/fs.js src/path.cc; do
  curl -sfL -o "$(basename "$f")" "https://raw.githubusercontent.com/nodejs/node/v22.23.3/$f"
done
# path.cc verbatim minus Node's own includes, built as Windows against stubs.h.
{ echo '#define _WIN32 1'; echo '#include "stubs.h"'; grep -v '^#include' path.cc | sed -n '1,/^}  \/\/ namespace node/p'; } > path_win.cc
g++ -std=c++20 -w -o ns ns.cc
node run-replay.cjs
