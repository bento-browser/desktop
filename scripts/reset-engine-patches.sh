#!/usr/bin/env bash
# Revert any engine source files modified by Bento patches back to pristine
# Firefox state, so `surfer import` can re-apply patches cleanly even after
# a patch's content has changed between runs.
#
# Surfer's import doesn't reset target files before applying patches — if
# you edit a .patch file and re-run import, the engine still has the OLD
# patch applied and the new patch fails on context mismatch.
#
# Idempotent — safe to re-run. Skips silently if engine isn't a git repo
# (CI / pre-download state).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_DIR="$REPO_ROOT/engine"

if [ ! -d "$ENGINE_DIR/.git" ]; then
  echo "reset-engine-patches: engine/ is not a git repo — skipping"
  exit 0
fi

# List of files touched by any patch in patches/. Extracted by parsing patch
# headers ("diff --git a/X b/Y") rather than maintained manually so adding a
# new patch automatically updates this list. Using a tmp file instead of
# bash 4's mapfile so this runs on macOS's stock bash 3.2.
patch_files_list="$(mktemp)"
trap 'rm -f "$patch_files_list"' EXIT

find "$REPO_ROOT/patches" -name '*.patch' -print0 \
  | xargs -0 grep -h '^diff --git' 2>/dev/null \
  | awk '{print $3}' \
  | sed 's|^a/||' \
  | sort -u \
  > "$patch_files_list"

if [ ! -s "$patch_files_list" ]; then
  echo "reset-engine-patches: no patched files found"
  exit 0
fi

cd "$ENGINE_DIR"

# Only revert files that are actually modified — git checkout on an
# unmodified path is a no-op but git complains if the path doesn't exist.
revert_count=0
to_revert_list="$(mktemp)"
trap 'rm -f "$patch_files_list" "$to_revert_list"' EXIT

while IFS= read -r f; do
  [ -z "$f" ] && continue
  if [ -e "$f" ] && ! git diff --quiet -- "$f" 2>/dev/null; then
    echo "$f" >> "$to_revert_list"
    revert_count=$((revert_count + 1))
  fi
done < "$patch_files_list"

if [ "$revert_count" -eq 0 ]; then
  echo "reset-engine-patches: no modified patched files to revert"
  exit 0
fi

echo "reset-engine-patches: reverting $revert_count file(s) to pristine"
xargs git checkout -- < "$to_revert_list"
