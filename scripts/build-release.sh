#!/usr/bin/env bash
# Bento Browser — release build pipeline.
#
# Produces a distributable installer (.dmg on macOS, .zip of installer on
# Windows) into release-out/ at the repo root. Used both locally
# (sanity-check before tagging) and by .github/workflows/release.yml.
#
# What's different from `npm run build`:
#   1. Sets BENTO_RELEASE=1 so .pnpmfile.cjs's readPackage hook is a
#      no-op, pulling @tale-ui/* from npm at the pinned versions instead
#      of the local link target. Release artifacts must NOT depend on a
#      working tree outside the repo.
#   2. Runs `pnpm install --no-frozen-lockfile` to update the lockfile
#      against the npm-pinned versions for the duration of the build.
#      The lockfile change is intentional and ephemeral — see
#      "restore dev state" below.
#   3. Runs `surfer package` to produce platform installers, not just the
#      app bundle.
#   4. Restores the original lockfile + node_modules at the end so a dev
#      machine isn't left in release-mode after running this.
#
# Locally: run from the repo root. Requires the surfer download +
# bootstrap to have been done at least once before (the same prerequisite
# `npm run build` has).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

# Detect platform for output naming. The mach build produces different
# package shapes per OS; we name our release artifacts by platform so the
# CI workflow can attach them to the GitHub Release without renaming.
case "$(uname -s)" in
  Darwin) PLATFORM="macos" ;;
  Linux)  PLATFORM="linux" ;;
  CYGWIN*|MINGW*|MSYS*) PLATFORM="windows" ;;
  *)
    echo "build-release: unsupported platform $(uname -s)" >&2
    exit 1
    ;;
esac

# Read Bento's user-facing version from surfer.json so the artifact
# filename matches what users see in About Bento. Avoids drift between
# branding and release. Note: surfer.json's top-level .version is the
# Firefox engine version (an object with product/version/candidate);
# Bento's product version lives at brands.bento.release.displayVersion.
VERSION="$(node -p "require('./surfer.json').brands.bento.release.displayVersion")"
if [ -z "$VERSION" ]; then
  echo "build-release: missing brands.bento.release.displayVersion in surfer.json" >&2
  exit 1
fi

OUT_DIR="$REPO_ROOT/release-out"
mkdir -p "$OUT_DIR"

# Stash dev state so we can restore at end. Using a backup file rather
# than `git stash` because the user may have intentional uncommitted
# changes and we shouldn't conflate them with pnpm's lockfile churn.
LOCKFILE_BACKUP=""
if [ -f pnpm-lock.yaml ]; then
  LOCKFILE_BACKUP="$(mktemp)"
  cp pnpm-lock.yaml "$LOCKFILE_BACKUP"
fi

# Restore dev state on exit so an interrupted release build doesn't
# leave the workspace in release-mode. trap fires on success and failure.
restore_dev_state() {
  step "Restoring dev state"
  if [ -n "$LOCKFILE_BACKUP" ]; then
    cp "$LOCKFILE_BACKUP" pnpm-lock.yaml
    rm -f "$LOCKFILE_BACKUP"
  fi
  # Re-install in dev mode (BENTO_RELEASE unset) so node_modules links
  # back to the local Tale UI checkout. Skip in CI — the runner is
  # ephemeral and re-installing is wasted time there.
  if [ -z "${CI:-}" ]; then
    pnpm install >/dev/null 2>&1 || true
  fi
}
trap restore_dev_state EXIT

step "1/4 Installing dependencies in release mode (BENTO_RELEASE=1)"
# --no-frozen-lockfile lets pnpm update the lock when the .pnpmfile.cjs
# stops rewriting @tale-ui/* to link:. Without this the install would
# error because the lockfile records link: paths and the package.json
# now resolves to npm versions.
BENTO_RELEASE=1 pnpm install --no-frozen-lockfile

step "2/4 Building Bento extensions and chrome (BENTO_RELEASE=1)"
BENTO_RELEASE=1 pnpm run ext:build
BENTO_RELEASE=1 pnpm run import
BENTO_RELEASE=1 npx surfer build

step "3/4 Packaging installer (surfer package)"
case "$PLATFORM" in
  macos)
    # Remove stale macOS packages before packaging so the collected artifact
    # always comes from this build's configured Bento release version.
    find engine/obj-*/dist -maxdepth 2 -name 'bento-*.dmg' -delete 2>/dev/null || true
    ;;
esac
npx surfer package

step "4/4 Collecting artifacts into $OUT_DIR"
# Mach drops platform-specific installers under engine/obj-*/dist/.
# Hunt for them by extension and copy with a versioned name. The exact
# subpath varies per platform — find handles that without hard-coding.
case "$PLATFORM" in
  macos)
    # Apple Silicon (aarch64) and Intel (x86_64) both end up under obj-*/dist.
    # mach package on macOS produces a .dmg directly.
    DMG_LIST="$(find engine/obj-*/dist -maxdepth 2 -name "bento-$VERSION.*.dmg" | sort)"
    DMG_COUNT="$(printf '%s\n' "$DMG_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$DMG_COUNT" = "0" ]; then
      echo "build-release: no bento-$VERSION .dmg found under engine/obj-*/dist" >&2
      exit 1
    fi
    if [ "$DMG_COUNT" != "1" ]; then
      echo "build-release: expected one bento-$VERSION .dmg, found $DMG_COUNT:" >&2
      printf '%s\n' "$DMG_LIST" >&2
      exit 1
    fi
    DMG="$DMG_LIST"
    OUT="$OUT_DIR/Bento-$VERSION-macos.dmg"
    cp "$DMG" "$OUT"
    echo "build-release: produced $OUT"
    ;;
  windows)
    # On Windows mach package produces an installer .exe and a .zip.
    # Prefer .zip for the unsigned developer-preview path — users who
    # trust the source can extract and run without installer-trust prompts.
    ZIP="$(find engine/obj-*/dist/install -name '*.zip' 2>/dev/null | head -n1)"
    if [ -z "$ZIP" ]; then
      ZIP="$(find engine/obj-*/dist -name 'bento-*.zip' 2>/dev/null | head -n1)"
    fi
    if [ -z "$ZIP" ]; then
      echo "build-release: no .zip found under engine/obj-*/dist" >&2
      exit 1
    fi
    OUT="$OUT_DIR/Bento-$VERSION-windows.zip"
    cp "$ZIP" "$OUT"
    echo "build-release: produced $OUT"
    ;;
  linux)
    # Mach on Linux produces a .tar.bz2 (or .tar.xz on newer Firefox).
    # Linux isn't an M1 release target but the script handles it for
    # local-build experimentation.
    TAR="$(find engine/obj-*/dist -maxdepth 2 \( -name '*.tar.bz2' -o -name '*.tar.xz' \) | head -n1)"
    if [ -z "$TAR" ]; then
      echo "build-release: no .tar.bz2 / .tar.xz found under engine/obj-*/dist" >&2
      exit 1
    fi
    EXT="${TAR##*.tar.}"
    OUT="$OUT_DIR/Bento-$VERSION-linux.tar.$EXT"
    cp "$TAR" "$OUT"
    echo "build-release: produced $OUT"
    ;;
esac

step "Done. Release artifact: $OUT"
