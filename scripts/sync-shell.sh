#!/usr/bin/env bash
# Fast dev loop: copy bento-shell built dist directly into the compiled app
# bundle, bypassing the full surfer build. Run after
# `pnpm --filter @bento/shell build` (or use `npm run shell:sync`).
#
# After running this, reload the extension in the Browser Toolbox console:
#   AddonManager.getAddonByID('bento-shell@bento.app').then(a => a.reload())
# If that errors on a built-in addon, quit and relaunch Bento.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Use `find -maxdepth 1` instead of `ls -d` so non-alphanumeric paths
# don't bite (ShellCheck SC2012). `engine/obj-*` is a single
# platform-suffixed dir in practice (obj-aarch64-apple-darwin25.4.0
# locally) — head -n1 picks the first match.
OBJ_DIR="$(find "$REPO/engine" -maxdepth 1 -name 'obj-*' -type d 2>/dev/null | head -n1)"
if [ -z "$OBJ_DIR" ]; then
  echo "error: no engine/obj-* directory found — run \`npm run build\` first." >&2
  exit 1
fi

DEST="$OBJ_DIR/dist/Bento.app/Contents/Resources/browser/chrome/browser/builtin-addons/bento-shell"
if [ ! -d "$DEST" ]; then
  echo "error: $DEST not found — run \`npm run build\` first." >&2
  exit 1
fi

SRC="$REPO/extensions/bento-shell/dist"
if [ ! -d "$SRC" ]; then
  echo "error: $SRC not found — run \`pnpm --filter @bento/shell build\` first." >&2
  exit 1
fi

cp -r "$SRC/" "$DEST/dist/"
echo "synced: extensions/bento-shell/dist → builtin-addons/bento-shell/dist"
