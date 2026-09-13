#!/usr/bin/env bash
# Reinstall the tracked canonical branding and run the normal import pipeline.
# Branding metadata and assets are maintained directly under branding/bento.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

CONFIG_FILE="bento.json"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "error: $CONFIG_FILE missing" >&2
  exit 1
fi

BRAND="$(node -p "require('./$CONFIG_FILE').brand")"
if [ "$BRAND" != "bento" ]; then
  echo "error: active brand must be 'bento', found '$BRAND'" >&2
  exit 1
fi

echo "reinstalling canonical branding/bento through the normal import pipeline..."
pnpm run import
echo "branding reinstalled."
