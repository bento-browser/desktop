#!/usr/bin/env bash
# Run the import pipeline with named failure points. Keeping this out of
# package.json makes intermittent lifecycle failures actionable in terminal logs.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1
node "$REPO_ROOT/scripts/bento-build.mjs" preflight || exit 1

MUTATION_STARTED=0
# Ties the patched-file mtime snapshot to this run, so a snapshot an earlier,
# failed import left behind is never applied.
IMPORT_RUN_ID="$$-$(date +%s)-$RANDOM"

recover_partial_import() {
  local status=$?
  trap - EXIT
  rm -f "$REPO_ROOT/.bento/patched-mtimes.json"
  if [ "$status" -ne 0 ] && [ "$MUTATION_STARTED" -eq 1 ]; then
    echo "import: preserving the partial generated engine state for a safe retry" >&2
    if ! node scripts/bento-build.mjs record >&2; then
      echo "import: could not record partial state; preserve engine edits before retrying" >&2
    fi
  fi
  exit "$status"
}

trap recover_partial_import EXIT

run_step() {
  local name="$1"
  shift

  "$@"
  local status=$?
  if [ "$status" -ne 0 ]; then
    echo "import: $name failed with exit code $status" >&2
    exit "$status"
  fi
}

run_step "sync theme presets" node scripts/sync-theme-presets.mjs
run_step "generate chrome tokens" node scripts/generate-chrome-tokens.mjs
run_step "verify engine state" node scripts/bento-build.mjs verify
run_step "check Firefox patch stack" node scripts/firefox-patch-stack.mjs check --for-import
run_step "snapshot patched file mtimes" \
  node scripts/preserve-patched-mtimes.mjs snapshot "$IMPORT_RUN_ID"
MUTATION_STARTED=1
run_step "reset engine patches" bash scripts/reset-engine-patches.sh
run_step "import source overlays" node scripts/import-sources.mjs
run_step "install canonical branding" node scripts/install-branding.mjs
run_step "install built-in add-ons" node scripts/install-builtin-addons.mjs
run_step "apply Firefox patch stack" node scripts/firefox-patch-stack.mjs apply
run_step "append prefs" bash scripts/append-prefs.sh
# After the last step that writes patch-touched engine files (the reset and the
# patch apply; append-prefs would too if a patch ever touched a prefs file).
run_step "restore unchanged patched mtimes" \
  node scripts/preserve-patched-mtimes.mjs restore "$IMPORT_RUN_ID"
run_step "sync builtin addon symlinks" bash scripts/sync-builtin-addon-symlinks.sh
run_step "scan product identity" node scripts/check-product-identity.mjs \
  branding/bento engine/browser/branding/bento
run_step "record engine state" node scripts/bento-build.mjs record

echo "import: finished"
