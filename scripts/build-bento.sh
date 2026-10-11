#!/usr/bin/env bash
# Bento Browser — full pipeline wrapper.
# Runs the full supported pipeline in order:
#   download → bootstrap → extension build → Bento import wrapper → build → package.

set -euo pipefail

# Fail before the native build: packaging rejects a local-Mux shell.
if [ -n "${MUXUI_LOCAL:-}" ]; then
  echo "build-bento: MUXUI_LOCAL is set; the full pipeline packages the published npm @muxui/react only. Unset it and retry." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

step "1/6 Fetching Firefox source"
bash scripts/bento-env.sh download

step "2/6 Bootstrapping Mozilla build environment"
bash scripts/bento-env.sh bootstrap

step "3/6 Building bundled extensions"
pnpm run ext:build

step "4/6 Applying Bento import wrapper"
pnpm run import

step "5/6 Building Bento Browser"
bash scripts/bento-env.sh build
bash scripts/sync-builtin-addon-symlinks.sh

step "6/6 Packaging artifacts"
bash scripts/bento-env.sh package

step "Done. Artifacts in dist/."
