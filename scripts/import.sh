#!/usr/bin/env bash
# Run the import pipeline with named failure points. Keeping this out of
# package.json makes intermittent lifecycle failures actionable in terminal logs.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

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
run_step "check Firefox patch stack" node scripts/firefox-patch-stack.mjs check --for-import
run_step "reset engine patches" bash scripts/reset-engine-patches.sh
run_step "surfer import" env SURFER_NO_BRANDING_PATCH=true bash scripts/surfer-env.sh import
run_step "install canonical branding" node scripts/install-branding.mjs
run_step "install built-in add-ons" node scripts/install-builtin-addons.mjs
run_step "apply Firefox patch stack" node scripts/firefox-patch-stack.mjs apply
run_step "append prefs" bash scripts/append-prefs.sh
run_step "sync builtin addon symlinks" bash scripts/sync-builtin-addon-symlinks.sh
run_step "scan product identity" node scripts/check-product-identity.mjs \
  branding/bento engine/browser/branding/bento

echo "import: finished"
