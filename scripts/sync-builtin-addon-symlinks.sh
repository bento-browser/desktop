#!/usr/bin/env bash
# Refresh deployed app-bundle resources that Surfer/mach leave stale during
# local iteration.
#
# Built-in addon dist/ directories and chrome-process support files are safe
# as symlinks. Content-process actor modules are copied as real files because
# macOS content sandboxing refuses app-bundle symlinks that point back into
# the source checkout.
#
# Surfer's extension-copy step generates a static moz.build with explicit
# per-FILE listings at first build. Files emitted between builds (Vite shared
# chunks with renamed names, new HTML entries, new code-split chunks) don't
# get installed unless mach build re-runs. Directory symlinks bypass the
# moz.build's file list entirely — anything Vite writes is immediately
# visible to Firefox.
#
# Idempotent — safe to re-run. Skips silently if the deployed app bundle
# isn't present (CI / pre-build state).
#
# Wired into `pnpm import` and post-build scripts. Direct `surfer import` /
# `surfer build` invocations bypass this — use the package scripts instead.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Locate the deployed app bundle. macOS layout — Linux/Windows would need
# a different path; out of scope for M1.
APP_DIST_ROOT="engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/Resources/browser/chrome/browser/builtin-addons"
ENGINE_EXT_ROOT="engine/browser/extensions"

if [ ! -d "$APP_DIST_ROOT" ]; then
  echo "sync-symlinks: $APP_DIST_ROOT missing — nothing to do (run a full build first)"
  exit 0
fi

sync_addon() {
  local addon="$1"
  local source_dist="$REPO_ROOT/$ENGINE_EXT_ROOT/$addon/dist"
  local target_dist="$APP_DIST_ROOT/$addon/dist"
  local target_addon_dir="$APP_DIST_ROOT/$addon"

  if [ ! -d "$source_dist" ]; then
    echo "sync-symlinks: $source_dist missing — skipping $addon"
    return
  fi
  if [ ! -d "$target_addon_dir" ]; then
    echo "sync-symlinks: $target_addon_dir missing — skipping $addon (built-in not registered yet)"
    return
  fi

  # If target_dist is already a symlink pointing to source_dist, no-op.
  if [ -L "$target_dist" ]; then
    local current
    current="$(readlink "$target_dist")"
    if [ "$current" = "$source_dist" ]; then
      echo "sync-symlinks: $addon already linked"
      return
    fi
  fi

  # Replace the directory (whether real dir with per-file symlinks, or a
  # stale symlink to a different path) with a fresh symlink to source_dist.
  rm -rf "$target_dist"
  ln -s "$source_dist" "$target_dist"
  echo "sync-symlinks: $addon dist/ linked -> $source_dist"
}

sync_addon bento-shell
sync_addon bento-tools

# Bento chrome content files (registered in patches/chrome-layout/01-bento-
# shell-mount.patch's jar.mn entry). The first full mach build creates the
# install-time symlinks under chrome/browser/content/browser/; new chrome
# files added between full builds (like bento-chrome-tokens.css after we
# wired up the Tale UI token bridge) won't appear in the deployed app
# until either a full rebuild OR we symlink them ourselves. Same approach
# the addon-dist sync above uses.
APP_CHROME_ROOT="engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/Resources/browser/chrome/browser/content/browser"
SRC_CHROME_ROOT="engine/browser/base/content"

sync_chrome_file() {
  local filename="$1"
  local source="$REPO_ROOT/$SRC_CHROME_ROOT/$filename"
  local target="$APP_CHROME_ROOT/$filename"

  if [ ! -e "$source" ]; then
    echo "sync-symlinks: chrome source $source missing — skipping $filename"
    return
  fi
  if [ ! -d "$APP_CHROME_ROOT" ]; then
    echo "sync-symlinks: $APP_CHROME_ROOT missing — skipping chrome files"
    return
  fi
  if [ -L "$target" ]; then
    local current
    current="$(readlink "$target")"
    if [ "$current" = "$source" ]; then
      echo "sync-symlinks: chrome/$filename already linked"
      return
    fi
  fi
  rm -f "$target"
  ln -s "$source" "$target"
  echo "sync-symlinks: chrome/$filename linked -> $source"
}

sync_chrome_file bento-chrome-tokens.css
sync_chrome_file bento-chrome-theme.css

APP_ACTORS_ROOT="engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/Resources/browser/actors"
BIN_ACTORS_ROOT="engine/obj-aarch64-apple-darwin25.4.0/dist/bin/browser/actors"
SRC_ACTORS_ROOT="src/browser/actors"

copy_content_actor() {
  local filename="$1"
  local source="$REPO_ROOT/$SRC_ACTORS_ROOT/$filename"
  local copied=0

  if [ ! -f "$source" ]; then
    echo "sync-symlinks: actor source $source missing — skipping $filename"
    return
  fi

  for target_root in "$BIN_ACTORS_ROOT" "$APP_ACTORS_ROOT"; do
    local target="$REPO_ROOT/$target_root/$filename"
    if [ ! -d "$REPO_ROOT/$target_root" ]; then
      continue
    fi
    rm -f "$target"
    cp "$source" "$target"
    copied=1
    echo "sync-symlinks: actor/$filename copied -> $target_root"
  done

  if [ "$copied" -eq 0 ]; then
    echo "sync-symlinks: actor targets missing — skipping $filename"
  fi
}

copy_content_actor BentoKeyChild.sys.mjs
copy_content_actor BentoKeyParent.sys.mjs
