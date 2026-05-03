#!/usr/bin/env bash
# Force Surfer to regenerate branding from configs/branding/<brand>/ and
# surfer.json on the next build. Run after changing:
#   - brands.<brand>.backgroundColor in surfer.json
#   - brands.<brand>.brand{Shorter,Short,Full}Name in surfer.json
#   - brands.<brand>.release.displayVersion in surfer.json
#   - any *.svg/*.png in configs/branding/<brand>/content/
#
# Why: Surfer's patch-check skips branding regen when SHA1(logo.png) and
# SHA1(MacOSInstaller.svg) match .surfer/hashes.json AND the engine branding
# dir exists. Touching surfer.json alone doesn't bust either input. This script
# wipes both signals so the next `npm run build[:ui]` runs the branding apply.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRAND_FILE=".surfer/dynamicConfig.brand.json"
if [ ! -f "$BRAND_FILE" ]; then
  echo "error: $BRAND_FILE missing — set the active brand with 'npx surfer set brand <name>' first" >&2
  exit 1
fi

# dynamicConfig.brand.json contains a JSON string literal, e.g. "bento"
BRAND="$(node -p "require('./$BRAND_FILE')")"

ENGINE_BRAND_DIR="engine/browser/branding/$BRAND"
HASHES_FILE=".surfer/hashes.json"

if [ -d "$ENGINE_BRAND_DIR" ]; then
  rm -rf "$ENGINE_BRAND_DIR"
  echo "removed $ENGINE_BRAND_DIR"
fi
if [ -f "$HASHES_FILE" ]; then
  rm -f "$HASHES_FILE"
  echo "removed $HASHES_FILE"
fi

echo "branding cache cleared for brand '$BRAND'. Running 'surfer import' to regenerate..."

# `surfer build` only runs patchCheck (a count comparison), not the actual
# patch/branding apply. We have to invoke 'surfer import' explicitly to run
# importMelonPatches → brandingPatch.apply, which regenerates the engine
# branding folder from configs/branding/<brand>/ and surfer.json.
npx surfer import

# Append Bento default prefs to firefox-branding.js so they ship as branding
# defaults. Firefox loads this file automatically; appending avoids needing a
# separate pref file with its own moz.build entry.
PREFS_SRC="prefs/bento.js"
PREFS_DEST="$ENGINE_BRAND_DIR/pref/firefox-branding.js"
if [ -f "$PREFS_SRC" ] && [ -f "$PREFS_DEST" ]; then
  {
    echo ""
    echo "// === Bento defaults (appended from prefs/bento.js by regen-branding.sh) ==="
    cat "$PREFS_SRC"
  } >> "$PREFS_DEST"
  echo "appended $PREFS_SRC -> $PREFS_DEST"
fi

echo "branding regenerated."
