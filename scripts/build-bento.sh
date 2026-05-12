#!/usr/bin/env bash
# Bento Browser — full pipeline wrapper.
# Runs the five Surfer phases in order:
#   download → bootstrap → import (patches + extensions-copy) → build → package.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

step "1/5 Fetching Firefox source (surfer download)"
bash scripts/surfer-env.sh download

step "2/5 Bootstrapping Mozilla build environment (surfer bootstrap)"
bash scripts/surfer-env.sh bootstrap

step "3/5 Applying branding patches, extensions-copy, and git patches (surfer import)"
bash scripts/surfer-env.sh import

step "4/5 Building Bento Browser (surfer build)"
bash scripts/surfer-env.sh build
bash scripts/sync-builtin-addon-symlinks.sh

step "5/5 Packaging artifacts (surfer package)"
bash scripts/surfer-env.sh package

step "Done. Artifacts in dist/."
