#!/usr/bin/env bash
# Remove only pnpm-created @tale-ui symlinks from Bento workspace node_modules.
# This is required when switching between the developer link graph and the
# registry-backed release graph because pnpm preserves existing direct links.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$REPO_ROOT"

for scope_dir in extensions/bento-shell/node_modules/@tale-ui extensions/bento-tools/node_modules/@tale-ui; do
  if [ ! -d "$scope_dir" ]; then
    continue
  fi
  if [ -L "$scope_dir" ]; then
    echo "clear-tale-ui-links: refusing symlinked scope directory: $scope_dir" >&2
    exit 1
  fi
  resolved_scope="$(cd "$scope_dir" && pwd -P)"
  case "$resolved_scope" in
    "$REPO_ROOT"/*) ;;
    *)
      echo "clear-tale-ui-links: refusing scope outside repository: $resolved_scope" >&2
      exit 1
      ;;
  esac
  unexpected="$(find "$scope_dir" -mindepth 1 -maxdepth 1 ! -type l -print -quit)"
  if [ -n "$unexpected" ]; then
    echo "clear-tale-ui-links: refusing to remove non-symlink entry: $unexpected" >&2
    exit 1
  fi
  find "$scope_dir" -mindepth 1 -maxdepth 1 -type l -delete
  rmdir "$scope_dir"
done
