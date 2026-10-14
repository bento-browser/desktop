#!/usr/bin/env bash
# Bento Browser — release build pipeline.
#
# Produces distributable packages (.dmg on macOS, .tar.xz/.tar.bz2 on
# Linux, .exe and .zip on Windows) into release-out/ at the repo root. Run it
# locally on the maintainer's Mac (sanity-check before tagging); CI never builds
# the application. Bento targets macOS only for now, and the Linux and Windows
# branches stay for when those platforms return.
#
# What's different from `npm run build`:
#   1. Installs from pnpm-lock.yaml with --frozen-lockfile (the one lock, shared
#      with developer builds, so the pinned npm Mux release cannot drift during
#      a later rebuild). It is a no-op when node_modules is current.
#   2. Runs the release gate before compiling: the security invariants, the
#      preview release gate and its tests, the dependency audit, and the pinned
#      Rust toolchain check.
#   3. Runs Bento's package step to produce platform artifacts and locales,
#      not just the app bundle. MAR and update metadata are produced and
#      collected only when bento.json updates.enabled is true; the updater is
#      compiled out until Bento owns a signed update path.
#   4. Writes the SBOM, release manifest, and SHA256SUMS next to the artifacts.
#
# CI no longer builds or publishes releases, so nothing GitHub-only runs here:
# no provenance attestation, no artifact upload, no draft GitHub Release.
#
# Locally: run from the repo root. Requires the Firefox download +
# bootstrap to have been done at least once before (the same prerequisite
# `npm run build` has).
#
# Set BENTO_BUILD_JOBS to a positive integer to cap native build
# parallelism on memory-constrained builders.
#
# Set BENTO_RELEASE_PREPARED=1 when the caller already ran
# `pnpm install --frozen-lockfile`, `pnpm run ext:build`, and
# `pnpm run import` with BENTO_RELEASE=1 in this checkout. The install and the
# extension build and import are then skipped; the release gate still runs.

set -euo pipefail

# Local Mux development (MUXUI_LOCAL) never reaches a release.
if [ -n "${MUXUI_LOCAL:-}" ]; then
  echo "build-release: MUXUI_LOCAL is set; releases use only the published npm @muxui/react. Unset it and retry." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step() {
  printf '\n\033[1;34m==>\033[0m %s\n' "$1"
}

# Detect platform for output naming. The mach build produces different
# package shapes per OS; we name our release artifacts by platform so they can
# be attached to a GitHub Release without renaming.
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
# The manifest and SHA256SUMS cover every file in $OUT_DIR, so an artifact
# left from an earlier release would be listed as part of this one.
rm -f "$OUT_DIR/.DS_Store"
if [ -n "$(find "$OUT_DIR" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "build-release: $OUT_DIR is not empty; move earlier release files out before building" >&2
  exit 1
fi

if [ -n "${BENTO_RELEASE_PREPARED:-}" ]; then
  step "1/5 Skipping install (BENTO_RELEASE_PREPARED is set)"
else
  step "1/5 Installing dependencies (frozen lockfile)"
  pnpm install --frozen-lockfile
fi

# The checks the release workflow ran before any native build. The release
# security test parses the lockfile and imports from node_modules, so this
# follows the install.
step "2/5 Release gate (security invariants, release gate, audit, Rust toolchain)"
pnpm run security:check
pnpm run release:security-check
node --test scripts/release-security.test.mjs
pnpm audit --audit-level high
node scripts/check-rust-toolchain.mjs

if [ -n "${BENTO_RELEASE_PREPARED:-}" ]; then
  step "3/5 Skipping extension build and import (BENTO_RELEASE_PREPARED is set)"
else
  step "3/5 Building Bento extensions and chrome (BENTO_RELEASE=1)"
  BENTO_RELEASE=1 BENTO_BUILD_MODE=release pnpm run ext:build
  BENTO_RELEASE=1 BENTO_BUILD_MODE=release pnpm run import
fi
# Fail before the native build if the shell still carries the dev-only reload
# command. Runs whether or not the caller prepared the build itself.
pnpm run release:security-check:shell
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

# Packaging reads exactly the directory mach built into (engine/obj-bento unless
# BENTO_OBJDIR chose another name); the driver fails if it does not exist.
OBJ_DIR="$(node scripts/bento-build.mjs objdir)"
if command -v cygpath >/dev/null 2>&1; then
  OBJ_DIR="$(cygpath -u "$OBJ_DIR")"
fi
OBJ_DIST="$OBJ_DIR/dist"

step "4/5 Packaging artifact"
case "$PLATFORM" in
  macos)
    # Remove stale macOS packages before packaging so the collected artifact
    # always comes from this build's configured Bento release version. A dev
    # package (.mac.tar) left in the same object dir would also fail
    # artifacts:check, which binds every TAR to the current BuildID.
    find "$OBJ_DIST" -maxdepth 2 \
      \( -name 'bento-*.dmg' -o -name 'bento-*.mac.tar' \) \
      -delete 2>/dev/null || true
    ;;
  linux)
    # Remove stale Linux packages before packaging so the collected artifact
    # always comes from this build's configured Bento release version.
    find "$OBJ_DIST" -maxdepth 2 \
      \( -name 'bento-*.tar.bz2' -o -name 'bento-*.tar.xz' \) \
      -delete 2>/dev/null || true
    ;;
  windows)
    find "$OBJ_DIST" -type f \
      \( -name "bento-$VERSION*.installer.exe" -o -name "bento-$VERSION*.zip" \) \
      -delete 2>/dev/null || true
    ;;
esac
# The driver's package command refuses to package an object directory whose shell
# add-on still has the dev-only reload command (docs/build-tooling.md).
BENTO_RELEASE=1 BENTO_BUILD_MODE=release bash scripts/bento-env.sh package

step "5/5 Collecting artifacts into $OUT_DIR"
# Mach drops platform-specific artifacts under $OBJ_DIST/.
# Hunt for them by extension and copy with a versioned name. The exact
# subpath varies per platform — find handles that without hard-coding.
case "$PLATFORM" in
  macos)
    # Apple Silicon (aarch64) and Intel (x86_64) both end up under the object directory's dist.
    # mach package on macOS produces a .dmg directly.
    DMG_LIST="$(find "$OBJ_DIST" -maxdepth 2 -name "bento-$VERSION.*.dmg" | sort)"
    DMG_COUNT="$(printf '%s\n' "$DMG_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$DMG_COUNT" = "0" ]; then
      echo "build-release: no bento-$VERSION .dmg found under $OBJ_DIST" >&2
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
    EXE_LIST="$(find "$OBJ_DIST" -type f -name "bento-$VERSION*.installer.exe" ! -name '*stub*' | sort)"
    EXE_COUNT="$(printf '%s\n' "$EXE_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$EXE_COUNT" = "0" ]; then
      echo "build-release: no version-matched Bento installer .exe found under $OBJ_DIST" >&2
      exit 1
    fi
    if [ "$EXE_COUNT" != "1" ]; then
      echo "build-release: expected one version-matched Bento installer .exe, found $EXE_COUNT:" >&2
      printf '%s\n' "$EXE_LIST" >&2
      exit 1
    fi
    ZIP_LIST="$(find "$OBJ_DIST" -type f -name "bento-$VERSION*.zip" ! -name '*.xpt_artifacts.zip' ! -name '*_xpt_artifacts.zip' | sort)"
    ZIP_COUNT="$(printf '%s\n' "$ZIP_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$ZIP_COUNT" = "0" ]; then
      echo "build-release: no version-matched Bento .zip found under $OBJ_DIST" >&2
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
      find "$OBJ_DIST" -maxdepth 2 \
        \( -name "bento-$VERSION*.tar.bz2" -o -name "bento-$VERSION*.tar.xz" \) |
        sort
    )"
    TAR_COUNT="$(printf '%s\n' "$TAR_LIST" | sed '/^$/d' | wc -l | tr -d ' ')"
    if [ "$TAR_COUNT" = "0" ]; then
      echo "build-release: no bento-$VERSION .tar.bz2 / .tar.xz found under $OBJ_DIST" >&2
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

# The package step records whether the updater was compiled in. A build that
# cannot update must not carry or publish a MAR or update metadata.
ARTIFACT_METADATA="$REPO_ROOT/dist/bento-artifacts.json"
if [ ! -f "$ARTIFACT_METADATA" ]; then
  echo "build-release: package did not produce dist/bento-artifacts.json" >&2
  exit 1
fi
UPDATES_ENABLED="$(node -p "require('./dist/bento-artifacts.json').updates?.enabled === true")"
if [ "$UPDATES_ENABLED" != "true" ]; then
  STALE_UPDATES="$(find "$OUT_DIR" -maxdepth 1 -type f \( -name '*.mar' -o -name '*-update.xml' \) -print -quit)"
  if [ -e "$REPO_ROOT/dist/output.mar" ] || [ -e "$REPO_ROOT/dist/update" ] || [ -n "$STALE_UPDATES" ]; then
    echo "build-release: the updater is disabled but a MAR or update metadata exists in dist/ or $OUT_DIR; remove it before collecting artifacts" >&2
    exit 1
  fi
  echo "build-release: the updater is disabled (bento.json updates.enabled); collecting no MAR or update metadata"
else
  # MAR and update metadata are release artifacts with the same provenance as
  # the application package. Keep names explicit so an unversioned output.mar
  # cannot be published accidentally.
  if [ ! -f "$REPO_ROOT/dist/output.mar" ]; then
    echo "build-release: package did not produce dist/output.mar" >&2
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
fi

node scripts/validate-bento-artifacts.mjs "$REPO_ROOT"

node scripts/check-product-identity.mjs "$OUT_DIR"

# Last, so the manifest and checksums cover everything collected above.
step "Release metadata (SBOM, manifest, SHA256SUMS)"
node scripts/generate-release-sbom.mjs "$OUT_DIR"
node scripts/generate-release-metadata.mjs "$OUT_DIR"

step "Done. Release artifact: $OUT (metadata in $OUT_DIR)"
