#!/bin/bash
set -euo pipefail

# Production release build:
# - bundles content/background with __DEV__ flags disabled
# - verifies no dev relay artifacts leak into prod output
# - packages only runtime extension files

npm run release

VERSION=$(grep -o '"version": "[^"]*"' manifest.json | cut -d'"' -f4)
OUTPUT="serializd-plex-v${VERSION}.zip"

echo ""
echo "Release artifact contents:"
unzip -l "$OUTPUT"
