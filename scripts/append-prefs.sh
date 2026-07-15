#!/usr/bin/env bash
# Append prefs/bento.js only to Firefox engine copies. Idempotent.
# Branding is installed from the tracked canonical branding/bento directory;
# this script never modifies that canonical source. Run it after each import.

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
  # Remove the previous managed block and trim blank lines before it so
  # repeated imports do not grow the file by one empty line each time.
  awk -v marker="$MARKER" '
    index($0, marker) == 1 { exit }
    { lines[NR] = $0 }
    END {
      last = NR
      while (last > 0 && lines[last] == "") last--
      for (i = 1; i <= last; i++) print lines[i]
    }
  ' "$dest" > "$tmp"
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
