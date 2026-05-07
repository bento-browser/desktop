#!/usr/bin/env bash
# Append prefs/bento.js to the engine's regenerated branding file. Idempotent.
# Surfer's import step rewrites engine/browser/branding/<brand>/pref/firefox-
# branding.js from scratch each time, so any Bento defaults we appended via
# brand:regen disappear on the next build. Run this AFTER every surfer import
# (the npm scripts do this automatically — see package.json).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BRAND_FILE=".surfer/dynamicConfig.brand.json"
if [ ! -f "$BRAND_FILE" ]; then
  echo "append-prefs: $BRAND_FILE missing — skipping" >&2
  exit 0
fi
BRAND="$(node -p "require('./$BRAND_FILE')")"

PREFS_SRC="prefs/bento.js"
MARKER="// === Bento defaults (appended from prefs/bento.js)"

if [ ! -f "$PREFS_SRC" ]; then
  echo "append-prefs: $PREFS_SRC missing — skipping" >&2
  exit 0
fi

append_to() {
  local dest="$1"
  if [ ! -f "$dest" ]; then
    echo "append-prefs: $dest missing — skipping that target" >&2
    return
  fi
  local tmp
  tmp="$(mktemp)"
  if grep -qF "$MARKER" "$dest"; then
    awk -v marker="$MARKER" 'index($0, marker) == 1 { exit } { print }' "$dest" > "$tmp"
  else
    cp "$dest" "$tmp"
  fi
  {
    echo ""
    echo "$MARKER ==="
    cat "$PREFS_SRC"
  } >> "$tmp"
  cp "$tmp" "$dest"
  rm -f "$tmp"
  echo "append-prefs: refreshed $PREFS_SRC -> $dest"
}

# Two targets, both deployed as defaults/preferences/*.js. Firefox loads
# them alphabetically, so anything in firefox-branding.js gets overridden
# by the same pref in firefox.js (which sorts later). To win, our prefs
# need to land in firefox.js itself.
append_to "engine/browser/branding/$BRAND/pref/firefox-branding.js"
append_to "engine/browser/app/profile/firefox.js"
