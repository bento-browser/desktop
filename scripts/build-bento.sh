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
npx surfer download

step "2/5 Bootstrapping Mozilla build environment (surfer bootstrap)"
npx surfer bootstrap

step "3/5 Applying branding patches, extensions-copy, and git patches (surfer import)"
npx surfer import

step "4/5 Building Bento Browser (surfer build)"
npx surfer build

step "5/5 Packaging artifacts (surfer package)"
npx surfer package

step "Done. Artifacts in dist/."
