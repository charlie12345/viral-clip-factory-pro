#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../webui"
node ./node_modules/typescript/lib/tsc.js -b
node --no-opt ./node_modules/vite/bin/vite.js build --sourcemap false --minify false
