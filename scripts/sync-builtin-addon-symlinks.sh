#!/usr/bin/env bash
# Refresh deployed app-bundle resources that mach can leave stale during
# local iteration.
#
# Built-in addon dist/ directories and chrome-process support files are safe
# as symlinks. Content-process actor modules are copied as real files because
# macOS content sandboxing refuses app-bundle symlinks that point back into
# the source checkout.
#
# The extension-copy step generates a static moz.build with explicit
# per-FILE listings at first build. Files emitted between builds (Vite shared
# chunks with renamed names, new HTML entries, new code-split chunks) don't
# get installed unless mach build re-runs. Directory symlinks bypass the
# moz.build's file list entirely — anything Vite writes is immediately
# visible to Firefox.
#
# Idempotent — safe to re-run. Skips silently if the deployed app bundle
# isn't present (CI / pre-build state).
#
# Wired into `pnpm run import` and post-build scripts. Direct mach invocations
# bypass this, so use the package scripts for the complete pipeline.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
node "$REPO_ROOT/scripts/bento-build.mjs" preflight

ENGINE_EXT_ROOT="engine/browser/extensions"

sync_addon() {
  local addon="$1"
  local source_dist="$REPO_ROOT/$ENGINE_EXT_ROOT/$addon/dist"
  local target_dist="$APP_DIST_ROOT/$addon/dist"
  local target_addon_dir="$APP_DIST_ROOT/$addon"

  if [ ! -d "$source_dist" ]; then
    echo "sync-symlinks: $source_dist missing — skipping $addon"
    return 0
  fi
  if [ ! -d "$target_addon_dir" ]; then
    echo "sync-symlinks: $target_addon_dir missing — skipping $addon (built-in not registered yet)"
    return 0
  fi

  # If target_dist is already a symlink pointing to source_dist, no-op.
  local dist_linked=0
  if [ -L "$target_dist" ]; then
    local current
    current="$(readlink "$target_dist")"
    if [ "$current" = "$source_dist" ]; then
      echo "sync-symlinks: $addon dist/ already linked"
      dist_linked=1
    fi
  fi

  if [ "$dist_linked" -eq 0 ]; then
    # Replace the directory (whether real dir with per-file symlinks, or a
    # stale symlink to a different path) with a fresh symlink to source_dist.
    rm -rf "$target_dist"
    ln -s "$source_dist" "$target_dist"
    echo "sync-symlinks: $addon dist/ linked -> $source_dist"
  fi

  local source_experiments="$REPO_ROOT/$ENGINE_EXT_ROOT/$addon/experiments"
  local target_experiments="$target_addon_dir/experiments"
  if [ -d "$source_experiments" ]; then
    if [ -L "$target_experiments" ]; then
      local current_experiments
      current_experiments="$(readlink "$target_experiments")"
      if [ "$current_experiments" = "$source_experiments" ]; then
        echo "sync-symlinks: $addon experiments/ already linked"
        return 0
      fi
    fi
    rm -rf "$target_experiments"
    ln -s "$source_experiments" "$target_experiments"
    echo "sync-symlinks: $addon experiments/ linked -> $source_experiments"
  fi
  return 0
}

# Bento chrome content files (registered in patches/chrome-layout/01-bento-
# shell-mount.patch's jar.mn entry). The first full mach build creates the
# install-time symlinks under chrome/browser/content/browser/; new chrome
# files added between full builds (like bento-chrome-tokens.css after we
# wired up the Mux/Bento token bridge) won't appear in the deployed app
# until either a full rebuild OR we symlink them ourselves. Same approach
# the addon-dist sync above uses.
SRC_CHROME_ROOT="engine/browser/base/content"

sync_chrome_file() {
  local filename="$1"
  local source="$REPO_ROOT/$SRC_CHROME_ROOT/$filename"
  local target="$APP_CHROME_ROOT/$filename"

  if [ ! -e "$source" ]; then
    echo "sync-symlinks: chrome source $source missing — skipping $filename"
    return 0
  fi
  if [ ! -d "$APP_CHROME_ROOT" ]; then
    echo "sync-symlinks: $APP_CHROME_ROOT missing — skipping chrome files"
    return 0
  fi
  if [ -L "$target" ]; then
    local current
    current="$(readlink "$target")"
    if [ "$current" = "$source" ]; then
      echo "sync-symlinks: chrome/$filename already linked"
      return 0
    fi
  fi
  rm -f "$target"
  ln -s "$source" "$target"
  echo "sync-symlinks: chrome/$filename linked -> $source"
  return 0
}

# A chrome directory registered in jar.mn by wildcard (bento-chrome-themes/): the build
# lists its files once, so themes added between full builds only appear if the whole
# directory is linked, like the add-on dist/ directories above.
sync_chrome_dir() {
  local name="$1"
  local source="$REPO_ROOT/$SRC_CHROME_ROOT/$name"
  local target="$APP_CHROME_ROOT/$name"

  if [ ! -d "$source" ]; then
    echo "sync-symlinks: chrome source dir $source missing — skipping $name/"
    return 0
  fi
  if [ ! -d "$APP_CHROME_ROOT" ]; then
    echo "sync-symlinks: $APP_CHROME_ROOT missing — skipping chrome files"
    return 0
  fi
  if [ -L "$target" ] && [ "$(readlink "$target")" = "$source" ]; then
    echo "sync-symlinks: chrome/$name/ already linked"
    return 0
  fi
  rm -rf "$target"
  ln -s "$source" "$target"
  echo "sync-symlinks: chrome/$name/ linked -> $source"
  return 0
}

SRC_ACTORS_ROOT="src/browser/actors"

copy_content_actor() {
  local filename="$1"
  local source="$REPO_ROOT/$SRC_ACTORS_ROOT/$filename"
  local copied=0

  if [ ! -f "$source" ]; then
    echo "sync-symlinks: actor source $source missing — skipping $filename"
    return 0
  fi

  for target_root in "$BIN_ACTORS_ROOT" "$APP_ACTORS_ROOT"; do
    local target="$target_root/$filename"
    if [ ! -d "$target_root" ]; then
      continue
    fi
    rm -f "$target" || {
      echo "sync-symlinks: failed to remove $target" >&2
      return 1
    }
    cp "$source" "$target" || {
      echo "sync-symlinks: failed to copy $source -> $target" >&2
      return 1
    }
    copied=1
    echo "sync-symlinks: actor/$filename copied -> $target_root"
  done

  if [ "$copied" -eq 0 ]; then
    echo "sync-symlinks: actor targets missing — skipping $filename"
  fi
  return 0
}

# The object directory mach builds into (engine/obj-bento unless BENTO_OBJDIR chose
# another name). Before it exists, a single old engine/obj-* build is synced and the
# driver says so; several old ones is an error. With no object directory yet there
# is nothing to sync.
OBJ_DIR="$(node "$REPO_ROOT/scripts/bento-build.mjs" objdir --allow-legacy --allow-missing)"

if [ -z "$OBJ_DIR" ]; then
  echo "sync-symlinks: no engine object directory found — nothing to do (run a full build first)"
else
  APP_DIST_ROOT="$OBJ_DIR/dist/Bento.app/Contents/Resources/browser/chrome/browser/builtin-addons"
  if [ ! -d "$APP_DIST_ROOT" ]; then
    echo "sync-symlinks: $APP_DIST_ROOT missing — skipping add-ons"
  else
    sync_addon bento-shell
    sync_addon bento-tools
  fi

  APP_CHROME_ROOT="$OBJ_DIR/dist/Bento.app/Contents/Resources/browser/chrome/browser/content/browser"
  sync_chrome_file bento-chrome-tokens.css
  sync_chrome_file bento-chrome-theme.css
  sync_chrome_dir bento-chrome-themes
  sync_chrome_file bento-migration-host.css
  sync_chrome_file bento-migration-host.html
  sync_chrome_file bento-migration-host.js
  sync_chrome_file bento-migration-wizard-bridge.css
  sync_chrome_file bento-shell-mount.js
  sync_chrome_file bento-shell-mount.css

  APP_ACTORS_ROOT="$OBJ_DIR/dist/Bento.app/Contents/Resources/browser/actors"
  BIN_ACTORS_ROOT="$OBJ_DIR/dist/bin/browser/actors"
  # Content-process actors are real files, never symlinks: the content sandbox cannot follow a
  # link out of the app bundle into src/browser/actors. One line per file in src/browser/actors.
  copy_content_actor BentoKeyChild.sys.mjs
  copy_content_actor BentoKeyParent.sys.mjs
  copy_content_actor BentoModePresentation.sys.mjs
  copy_content_actor BentoShellBusChild.sys.mjs
  copy_content_actor BentoShellBusParent.sys.mjs
fi

echo "sync-symlinks: finished"
exit 0
