#!/usr/bin/env bash
# Fast dev loop: copy bento-shell built dist directly into the compiled app
# bundle, bypassing the full Firefox build. Run after
# `pnpm --filter @bento/shell build` (or use `npm run shell:sync`).
#
# After running this, reload the extension in the Browser Toolbox console:
#   AddonManager.getAddonByID('bento-shell@bento.app').then(a => a.reload())
# If that errors on a built-in addon, quit and relaunch Bento.
#
# After an import, the destination dist/ is a symlink to
# engine/browser/extensions/bento-shell/dist, so this writes into the engine tree.
# It only adds and overwrites; the next `pnpm run import` replaces that directory
# with the repository build. Engine-state verification ignores add-on dist/ for
# that reason (docs/build-tooling.md, "Build output and shell:sync").
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
node "$REPO/scripts/bento-build.mjs" preflight

# The object directory mach builds into (engine/obj-bento unless BENTO_OBJDIR chose
# another name). Before it exists, a single old engine/obj-* build is used and the
# driver says so; several old ones, or none, is an error.
OBJ_DIR="$(node "$REPO/scripts/bento-build.mjs" objdir --allow-legacy)"

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

cp -R "$SRC/." "$DEST/dist/"
echo "synced: extensions/bento-shell/dist → builtin-addons/bento-shell/dist"
