#!/usr/bin/env bash
# Run the import pipeline with named failure points. Keeping this out of
# package.json makes intermittent lifecycle failures actionable in terminal logs.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

MUTATION_STARTED=0

recover_partial_import() {
  local status=$?
  trap - EXIT
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
MUTATION_STARTED=1
run_step "reset engine patches" bash scripts/reset-engine-patches.sh
run_step "import source overlays" node scripts/import-sources.mjs
run_step "install canonical branding" node scripts/install-branding.mjs
run_step "install built-in add-ons" node scripts/install-builtin-addons.mjs
run_step "apply Firefox patch stack" node scripts/firefox-patch-stack.mjs apply
run_step "append prefs" bash scripts/append-prefs.sh
run_step "sync builtin addon symlinks" bash scripts/sync-builtin-addon-symlinks.sh
run_step "scan product identity" node scripts/check-product-identity.mjs \
  branding/bento engine/browser/branding/bento
run_step "record engine state" node scripts/bento-build.mjs record

echo "import: finished"
