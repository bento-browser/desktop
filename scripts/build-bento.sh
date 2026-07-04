#!/usr/bin/env bash
# Bento Browser — full pipeline wrapper.
# Runs the full supported pipeline in order:
#   download → bootstrap → extension build → Bento import wrapper → build → package.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

step "1/6 Fetching Firefox source (surfer download)"
bash scripts/surfer-env.sh download

step "2/6 Bootstrapping Mozilla build environment (surfer bootstrap)"
bash scripts/surfer-env.sh bootstrap

step "3/6 Building bundled extensions"
pnpm run ext:build

step "4/6 Applying Bento import wrapper"
pnpm run import

step "5/6 Building Bento Browser (surfer build)"
bash scripts/surfer-env.sh build
bash scripts/sync-builtin-addon-symlinks.sh

step "6/6 Packaging artifacts (surfer package)"
bash scripts/surfer-env.sh package

step "Done. Artifacts in dist/."
