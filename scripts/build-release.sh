#!/usr/bin/env bash
# Bento Browser — release build pipeline.
#
# Produces distributable packages (.dmg on macOS, .tar.xz/.tar.bz2 on
# Linux, .exe and .zip on Windows) into release-out/ at the repo root. Used
# locally (sanity-check before tagging) and by the release and PR workflows.
#
# What's different from `npm run build`:
#   1. Sets BENTO_RELEASE=1 so .pnpmfile.cjs's readPackage hook is a
#      no-op, pulling @tale-ui/* from npm at the pinned versions instead
#      of the local link target. Release artifacts must NOT depend on a
#      working tree outside the repo.
#   2. Installs from pnpm-lock.release.yaml with --frozen-lockfile.
#      The committed release graph contains registry-backed Tale UI packages
#      and cannot drift during CI or a later rebuild.
#   3. Runs Bento's package step to produce platform artifacts, MAR, locales,
#      and update metadata, not just the app bundle.
#   4. Restores the original lockfile + node_modules at the end so a dev
#      machine isn't left in release-mode after running this.
#
# Locally: run from the repo root. Requires the Firefox download +
# bootstrap to have been done at least once before (the same prerequisite
# `npm run build` has). CI invokes this script for tag releases and manual
# application test builds.
#
# Set BENTO_BUILD_JOBS to a positive integer to cap native build
# parallelism on memory-constrained builders.

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

# Read Bento's user-facing version from bento.json so the artifact filename
# matches what users see in About Bento. The Firefox engine version lives in
# bento.json.firefox.version; Bento's product version is kept separately.
VERSION="$(node -p "require('./bento.json').brands.bento.release.displayVersion")"
if [ -z "$VERSION" ]; then
  echo "build-release: missing brands.bento.release.displayVersion in bento.json" >&2
  exit 1
fi

OUT_DIR="$REPO_ROOT/release-out"
mkdir -p "$OUT_DIR"

# Restore dev state on exit so an interrupted release build doesn't
# leave the workspace in release-mode. trap fires on success and failure.
restore_dev_state() {
  step "Restoring dev state"
  # Re-install in dev mode (BENTO_RELEASE unset) so node_modules links
  # back to the local Tale UI checkout. Skip in CI — the runner is
  # ephemeral and re-installing is wasted time there.
  if [ -z "${CI:-}" ]; then
    bash scripts/clear-tale-ui-links.sh || true
    pnpm install --force >/dev/null 2>&1 || true
  fi
}
trap restore_dev_state EXIT

step "1/4 Installing dependencies in release mode (BENTO_RELEASE=1)"
bash scripts/install-release-deps.sh

step "2/4 Building Bento extensions and chrome (BENTO_RELEASE=1)"
BENTO_RELEASE=1 BENTO_BUILD_MODE=release pnpm run ext:build
BENTO_RELEASE=1 BENTO_BUILD_MODE=release pnpm run import
if [ -n "${BENTO_BUILD_JOBS:-}" ]; then
  if ! [[ "$BENTO_BUILD_JOBS" =~ ^[1-9][0-9]*$ ]]; then
    echo "build-release: BENTO_BUILD_JOBS must be a positive integer" >&2
    exit 1
  fi
  BENTO_RELEASE=1 BENTO_BUILD_MODE=release bash scripts/bento-env.sh build --jobs "$BENTO_BUILD_JOBS"
else
  BENTO_RELEASE=1 BENTO_BUILD_MODE=release bash scripts/bento-env.sh build
fi
bash scripts/sync-builtin-addon-symlinks.sh

step "3/4 Packaging artifact"
case "$PLATFORM" in
  macos)
    # Remove stale macOS packages before packaging so the collected artifact
    # always comes from this build's configured Bento release version.
    find engine/obj-*/dist -maxdepth 2 -name 'bento-*.dmg' -delete 2>/dev/null || true
    ;;
  linux)
    # Remove stale Linux packages before packaging so the collected artifact
    # always comes from this build's configured Bento release version.
    find engine/obj-*/dist -maxdepth 2 \
      \( -name 'bento-*.tar.bz2' -o -name 'bento-*.tar.xz' \) \
      -delete 2>/dev/null || true
    ;;
  windows)
    find engine/obj-*/dist -type f \
      \( -name "bento-$VERSION*.installer.exe" -o -name "bento-$VERSION*.zip" \) \
      -delete 2>/dev/null || true
    ;;
esac
BENTO_RELEASE=1 BENTO_BUILD_MODE=release bash scripts/bento-env.sh package

step "4/4 Collecting artifacts into $OUT_DIR"
# Mach drops platform-specific artifacts under engine/obj-*/dist/.
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
    # Keep both: the .exe is the normal installer, while the .zip gives
    # unsigned developer-preview users an extract-and-run option.
    EXE_LIST="$(find engine/obj-*/dist -type f -name "bento-$VERSION*.installer.exe" ! -name '*stub*' | sort)"
    EXE_COUNT="$(printf '%s\n' "$EXE_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$EXE_COUNT" = "0" ]; then
      echo "build-release: no version-matched Bento installer .exe found under engine/obj-*/dist" >&2
      exit 1
    fi
    if [ "$EXE_COUNT" != "1" ]; then
      echo "build-release: expected one version-matched Bento installer .exe, found $EXE_COUNT:" >&2
      printf '%s\n' "$EXE_LIST" >&2
      exit 1
    fi
    ZIP_LIST="$(find engine/obj-*/dist -type f -name "bento-$VERSION*.zip" ! -name '*.xpt_artifacts.zip' ! -name '*_xpt_artifacts.zip' | sort)"
    ZIP_COUNT="$(printf '%s\n' "$ZIP_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$ZIP_COUNT" = "0" ]; then
      echo "build-release: no version-matched Bento .zip found under engine/obj-*/dist" >&2
      exit 1
    fi
    if [ "$ZIP_COUNT" != "1" ]; then
      echo "build-release: expected one version-matched Bento .zip, found $ZIP_COUNT:" >&2
      printf '%s\n' "$ZIP_LIST" >&2
      exit 1
    fi
    EXE="$EXE_LIST"
    ZIP="$ZIP_LIST"
    EXE_OUT="$OUT_DIR/Bento-$VERSION-windows.exe"
    ZIP_OUT="$OUT_DIR/Bento-$VERSION-windows.zip"
    cp "$EXE" "$EXE_OUT"
    cp "$ZIP" "$ZIP_OUT"
    OUT="$EXE_OUT and $ZIP_OUT"
    echo "build-release: produced $EXE_OUT"
    echo "build-release: produced $ZIP_OUT"
    ;;
  linux)
    # Mach on Linux produces a .tar.bz2 (or .tar.xz on newer Firefox).
    TAR_LIST="$(
      find engine/obj-*/dist -maxdepth 2 \
        \( -name "bento-$VERSION*.tar.bz2" -o -name "bento-$VERSION*.tar.xz" \) |
        sort
    )"
    TAR_COUNT="$(printf '%s\n' "$TAR_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$TAR_COUNT" = "0" ]; then
      echo "build-release: no bento-$VERSION .tar.bz2 / .tar.xz found under engine/obj-*/dist" >&2
      exit 1
    fi
    if [ "$TAR_COUNT" != "1" ]; then
      echo "build-release: expected one bento-$VERSION Linux tarball, found $TAR_COUNT:" >&2
      printf '%s\n' "$TAR_LIST" >&2
      exit 1
    fi
    TAR="$TAR_LIST"
    EXT="${TAR##*.tar.}"
    OUT="$OUT_DIR/Bento-$VERSION-linux.tar.$EXT"
    cp "$TAR" "$OUT"
    echo "build-release: produced $OUT"
    ;;
esac

# MAR and update metadata are release artifacts with the same provenance as
# the application package. Keep names explicit so an unversioned output.mar
# cannot be published accidentally.
if [ ! -f "$REPO_ROOT/dist/output.mar" ]; then
  echo "build-release: package did not produce dist/output.mar" >&2
  exit 1
fi
ARTIFACT_METADATA="$REPO_ROOT/dist/bento-artifacts.json"
if [ ! -f "$ARTIFACT_METADATA" ]; then
  echo "build-release: package did not produce dist/bento-artifacts.json" >&2
  exit 1
fi
MAR_NAME="$(node -p "require('./dist/bento-artifacts.json').mar.name")"
if [ -z "$MAR_NAME" ] || [[ "$MAR_NAME" != Bento-*.mar ]]; then
  echo "build-release: invalid MAR name in dist/bento-artifacts.json: $MAR_NAME" >&2
  exit 1
fi
MAR_OUT="$OUT_DIR/$MAR_NAME"
cp "$REPO_ROOT/dist/output.mar" "$MAR_OUT"
echo "build-release: produced $MAR_OUT"

UPDATE_COUNT=0
while IFS= read -r UPDATE_FILE; do
  [ -f "$UPDATE_FILE" ] || continue
  TARGET="${UPDATE_FILE#"$REPO_ROOT/dist/update/browser/"}"
  TARGET="${TARGET//\//-}"
  cp "$UPDATE_FILE" "$OUT_DIR/Bento-$VERSION-$PLATFORM-$TARGET"
  UPDATE_COUNT=$((UPDATE_COUNT + 1))
done < <(find "$REPO_ROOT/dist/update/browser" -type f -name 'update.xml' -print 2>/dev/null | sort)
if [ "$UPDATE_COUNT" -eq 0 ]; then
  echo "build-release: package did not produce browser update metadata" >&2
  exit 1
fi
echo "build-release: collected $UPDATE_COUNT update metadata files"

node scripts/validate-bento-artifacts.mjs "$REPO_ROOT"

node scripts/check-product-identity.mjs "$OUT_DIR"
step "Done. Release artifact: $OUT"
