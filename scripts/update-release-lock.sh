#!/usr/bin/env bash
# Regenerate pnpm-lock.release.yaml without replacing the developer lock.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

LOCKFILE_BACKUP="$(mktemp)"
cp pnpm-lock.yaml "$LOCKFILE_BACKUP"
restore_dev_lock() {
  cp "$LOCKFILE_BACKUP" pnpm-lock.yaml
  rm -f "$LOCKFILE_BACKUP"
}
trap restore_dev_lock EXIT

pnpm install --lockfile-only --no-frozen-lockfile
cp pnpm-lock.yaml pnpm-lock.release.yaml
