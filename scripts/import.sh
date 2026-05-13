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

run_step "generate chrome tokens" node scripts/generate-chrome-tokens.mjs
run_step "reset engine patches" bash scripts/reset-engine-patches.sh
run_step "surfer import" bash scripts/surfer-env.sh import
run_step "append prefs" bash scripts/append-prefs.sh
run_step "sync builtin addon symlinks" bash scripts/sync-builtin-addon-symlinks.sh

echo "import: finished"
