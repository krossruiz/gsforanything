#!/usr/bin/env bash
# Copies the browser assets from site-source/ into worker/public/ (the Worker's
# static assets). Only client files: never server.js, package files or certs.
set -euo pipefail
cd "$(dirname "$0")"
SRC=../site-source
rm -rf public && mkdir -p public
for f in index.html main.js version.js versions.json syntaxHighlight.js htmlInCanvas.js menuSystem.js exporter.js creationContext.js p5Import.js communityMerge.js twinSticks.js cameraControls.js chatPrompt.js; do
  cp "$SRC/$f" public/
done
cp -a "$SRC/threejsAddons" "$SRC/vendor_modules" public/
test -f public/vendor_modules/three/build/three.module.js || { echo "missing vendor_modules/three/build/three.module.js" >&2; exit 1; }
echo "public/ synced: $(find public -type f | wc -l) files"
