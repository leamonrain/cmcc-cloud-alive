#!/bin/bash
set -euo pipefail

# Build CMCCCloudAlive.fpk for FNOS
# Usage: ./scripts/build-fpk.sh [output-path]

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FPK_DIR="$REPO_ROOT/fpk"
OUTPUT="${1:-$REPO_ROOT/CMCCCloudAlive-1.0.1.fpk}"
APPNAME="CMCCCloudAlive"

cd "$FPK_DIR"

# 1) Create app.tgz from app/ contents (NOT the app/ dir itself)
#    FNOS expects entries like src/ and ui/ at the root of app.tgz
echo "==> Creating app.tgz (correct structure)..."
tar czf app.tgz -C app/ .

# 2) Build .fpk = tar.gz containing manifest + app.tgz + lifecycle dirs + icons
echo "==> Building $APPNAME.fpk ..."
tar czf "$OUTPUT" \
  manifest app.tgz cmd/ config/ wizard/ ICON_256.PNG ICON.PNG

# 3) Cleanup temp
rm -f app.tgz

echo "==> Done: $(ls -lh "$OUTPUT" | awk '{print $5, $NF}')"
