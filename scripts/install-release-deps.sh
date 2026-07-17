#!/usr/bin/env bash
# Install the registry-backed release dependency graph from its committed
# root-format lockfile. BENTO_RELEASE disables local Tale UI links;
# --frozen-lockfile makes dependency drift a hard failure. The developer lock
# is restored immediately after installation, while node_modules keeps the
# release graph for the caller's subsequent build steps.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

if [ ! -f pnpm-lock.release.yaml ]; then
  echo "install-release-deps: missing pnpm-lock.release.yaml" >&2
  exit 1
fi

LOCKFILE_BACKUP="$(mktemp)"
cp pnpm-lock.yaml "$LOCKFILE_BACKUP"
restore_lockfile() {
  cp "$LOCKFILE_BACKUP" pnpm-lock.yaml
  rm -f "$LOCKFILE_BACKUP"
}
trap restore_lockfile EXIT

cp pnpm-lock.release.yaml pnpm-lock.yaml
# --force is required when switching an existing developer checkout: pnpm can
# otherwise leave package-level link: symlinks in place after seeing a
# resolution-complete node_modules tree from the developer lock.
bash scripts/clear-tale-ui-links.sh
BENTO_RELEASE=1 pnpm install --force --frozen-lockfile
