#!/usr/bin/env bash
# Revert any engine source files modified by Bento patches back to pristine
# Firefox state, so the Bento import pipeline can re-apply patches cleanly even after
# a patch's content has changed between runs.
#
# The import pipeline resets target files before applying patches. If you edit
# a .patch file and re-run import, the engine still has the old
# patch applied and the new patch fails on context mismatch.
#
# Idempotent — safe to re-run. Skips silently if engine isn't a git repo
# (CI / pre-download state).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$REPO_ROOT/scripts/bento-build.mjs" preflight
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
work_dir="$(mktemp -d)"
trap 'rm -rf "$patch_files_list" "$work_dir"' EXIT

find "$REPO_ROOT/patches" -name '*.patch' -print0 \
  | xargs -0 grep -h '^diff --git' 2>/dev/null \
  | awk '{print $3}' \
  | sed 's|^a/||' \
  | sort -u \
  > "$patch_files_list"

# Also reset paths an earlier import patched that the current series no longer
# names. The recorded state lists them (edited files, symlinks, and deletions), and
# verify has matched every one to the record by now, so resetting discards only
# Bento's own output.
recorded_state="$REPO_ROOT/.bento/engine-state.json"
if [ -f "$recorded_state" ]; then
  node -e '
    const state = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const entry of state.entries || []) {
      if (entry.kind === "patch") console.log(entry.path);
    }
  ' "$recorded_state" >> "$patch_files_list"
  sort -u -o "$patch_files_list" "$patch_files_list"
fi

if [ ! -s "$patch_files_list" ]; then
  echo "reset-engine-patches: no patched files found"
  exit 0
fi

cd "$ENGINE_DIR"
# Patch paths are literal file names, never globs or pathspec magic.
export GIT_LITERAL_PATHSPECS=1

# Tracked + changed (edited, retyped, a symlink retargeted, or deleted by a
# patch) → git checkout. Untracked (created by new-file patches, including
# symlinks, even dangling ones) → rm. Both classes block re-applying patches:
# modified content rejects context, existing files reject "new file mode", and a
# deleted file rejects a patch that edits it.
#
# One git call per question rather than one per path: every git call loads the
# engine index (tens of MB), so a hundred calls cost seconds. Git reports file
# names, so the answers are mapped back to patch paths with their parent
# directories included: a directory holding a listed file counts as listed, like a
# directory pathspec does. xargs gets -r everywhere because git diff with no paths
# would compare the whole tree.
to_revert_list="$work_dir/to-revert"
to_remove_list="$work_dir/to-remove"
: > "$to_remove_list"

# Prints each line and every parent directory of it.
with_parents() {
  awk '{ print; path = $0; while (sub(/\/[^\/]*$/, "", path)) print path }' "$1"
}

# Prints the lines of $2 that are (keep) or are not (drop) lines of $1.
keep_listed() {
  awk 'FILENAME == ARGV[1] { listed[$0] = 1; next } $0 in listed' "$1" "$2"
}
drop_listed() {
  awk 'FILENAME == ARGV[1] { listed[$0] = 1; next } !($0 in listed)' "$1" "$2"
}

sed '/^$/d' "$patch_files_list" > "$work_dir/patch-paths"
tr '\n' '\0' < "$work_dir/patch-paths" > "$work_dir/patch-paths.z"

xargs -0 -r git ls-files -z -- < "$work_dir/patch-paths.z" | tr '\0' '\n' > "$work_dir/tracked-files"
with_parents "$work_dir/tracked-files" > "$work_dir/tracked-set"
keep_listed "$work_dir/tracked-set" "$work_dir/patch-paths" > "$work_dir/tracked-paths"

# A tracked path that is gone also differs, so its deletion is restored here.
tr '\n' '\0' < "$work_dir/tracked-paths" \
  | xargs -0 -r git diff --name-only --no-renames -z -- \
  | tr '\0' '\n' > "$work_dir/changed-files"
with_parents "$work_dir/changed-files" > "$work_dir/changed-set"
keep_listed "$work_dir/changed-set" "$work_dir/tracked-paths" > "$to_revert_list"
revert_count="$(awk 'END { print NR }' "$to_revert_list")"

drop_listed "$work_dir/tracked-set" "$work_dir/patch-paths" > "$work_dir/untracked-paths"
remove_count=0
while IFS= read -r f; do
  if [ -e "$f" ] || [ -L "$f" ]; then
    echo "$f" >> "$to_remove_list"
    remove_count=$((remove_count + 1))
  fi
done < "$work_dir/untracked-paths"

if [ "$revert_count" -eq 0 ] && [ "$remove_count" -eq 0 ]; then
  echo "reset-engine-patches: nothing to do"
  exit 0
fi

if [ "$revert_count" -gt 0 ]; then
  echo "reset-engine-patches: reverting $revert_count tracked file(s) to pristine"
  tr '\n' '\0' < "$to_revert_list" | xargs -0 git checkout --
fi

if [ "$remove_count" -gt 0 ]; then
  echo "reset-engine-patches: removing $remove_count untracked file(s) added by patches"
  tr '\n' '\0' < "$to_remove_list" | xargs -0 rm -f
  # Prune empty parent dirs so subsequent patches that re-add the directory
  # tree don't trip over a stale empty shell. rmdir fails on non-empty,
  # which is what we want.
  while IFS= read -r f; do
    d="$(dirname "$f")"
    while [ "$d" != "." ] && [ "$d" != "/" ]; do
      rmdir "$d" 2>/dev/null || break
      d="$(dirname "$d")"
    done
  done < "$to_remove_list"
fi
