# Bento build tooling

Bento owns the build driver around Mozilla's `mach` entry point. The canonical
configuration is [`bento.json`](../bento.json); it records the Firefox product,
version and source digest, Bento branding, build mode, locales, license policy,
and update channel. Bento's tooling does not generate or ship a second browser
identity.

[`scripts/bento-build.mjs`](../scripts/bento-build.mjs) provides the lifecycle
commands exposed through [`scripts/bento-env.sh`](../scripts/bento-env.sh):

- `download` downloads and verifies the configured Firefox source archive;
- `update` obtains the current Mozilla version, replaces the protected source
  checkout, and updates `bento.json` and `config/firefox-versions.json`;
- `bootstrap` invokes Firefox's Mozilla build dependency bootstrap;
- `build` and `build --ui` write the platform mozconfig and invoke `mach build`
  or `mach build faster`;
- `package` invokes the Firefox package and multi-locale package steps, creates
  a MAR, and writes browser and add-on update metadata;
- `updates-browser` and `updates-addons` regenerate update metadata from an
  existing package;
- `license-check` checks source-overlay headers; `verify` and `record` protect
  generated engine state.

The corresponding package commands are:

```sh
pnpm run download
bash scripts/bento-env.sh update
pnpm run bootstrap
pnpm run build
pnpm run build:ui
pnpm run package
pnpm run lc
pnpm run build:full
```

`pnpm run firefox:sync` is the maintained upstream-update entry point. It wraps
the update command with patch-stack validation, extension build, Bento import,
and a native build. `pnpm run build:full` runs the complete download,
bootstrap, extension build, import, build, and package sequence.

Firefox's Rust toolchain is pinned in the repository root by
[`rust-toolchain.toml`](../rust-toolchain.toml). Release CI resolves and verifies
that pin before Bento bootstrap or the native build. Linux and Windows release
mozconfigs opt into Bento's narrow `BENTO_RUST_LTO=thin` compatibility setting;
it changes only the top-level Rust release crate's LTO mode from Firefox's
default fat LTO to standard Rust ThinLTO, keeping embed-bitcode and release
codegen-unit settings unchanged. macOS keeps Firefox's default fat LTO because
its hosted release build completes within its existing memory budget.

All Bento-specific import behavior belongs in this repository. The authoritative
wrapper, [scripts/import.sh](../scripts/import.sh), installs
[branding/bento](../branding/bento), packages the built-in extensions, and
applies [patches/series.json](../patches/series.json) in manifest order.

Firefox source archives are stored by version at
`.bento/cache/source/<version>/firefox-<version>.source.tar.xz` and are checked
against the SHA-256 digest in `bento.json`. The extracted source is a Git
checkout in `engine/`; the baseline is recorded in `.bento/source-state.json`
and in `refs/bento/firefox-base/<version>`. Existing engine changes are
classified before an update, and an update keeps the previous source under
`.bento/backups/` until the operation succeeds.

Source overlays under `src/` are copied or linked into `engine/` by
[`scripts/import-sources.mjs`](../scripts/import-sources.mjs). Their exact
destinations, link targets, or copied-file digests are recorded in
`.bento/import-manifest.json`. This manifest lets repeated imports remove only
stale Bento-owned overlays and refuse to overwrite user changes.

## Supported commands

- `pnpm run download`: fetch and verify the Firefox source archive configured in
  `bento.json`.
- `bash scripts/bento-env.sh update`: update the protected source checkout and
  version metadata.
- `pnpm run bootstrap`: install Mozilla build dependencies through `mach`.
- `pnpm run import`: run the complete Bento import wrapper.
- `pnpm run build`: build extensions, import Bento sources, and compile Firefox.
- `pnpm run build:ui`: run the incremental Firefox UI build.
- `pnpm run package`: produce platform packages, MAR, locales, and update XML.
- `pnpm run artifacts:check`: verify the packaged application, MAR contents,
  and update XML against `dist/bento-artifacts.json`.
- `pnpm run build:full`: download, bootstrap, build, and package.
- `pnpm run build:release`: create a host-platform release-mode package.
- `pnpm run lc`: run Bento's source-overlay license check.
- `pnpm run brand:regen`: reinstall canonical tracked branding through the
  normal import pipeline.

Hosted release cache keys include `bento.json`, `config/**`, the patch and
overlay inputs, relevant Bento build scripts, `configs/**`, and
`rust-toolchain.toml` along with the package configuration. A change to the
source tooling, LTO policy, or Rust compiler therefore cannot reuse an object
cache produced under a different native build configuration.

Manual CI application builds use four workers on the existing 4 vCPU / 16 GiB
Linux runner, two workers on the 4 vCPU / 14 GiB Windows runner, and the
platform default on macOS. Each manual native job has a 120-minute bound. The
source cache excludes `engine/obj-*` and caches the paired
`.bento/source-state.json`, `.bento/import-manifest.json`, and
`.bento/engine-state.json` metadata with the engine checkout. Native objects
use a separate release-mode configuration key so source restores do not
duplicate the large object archive. Staging directories, backups, source
archives, and patch-stack worktrees are not cached. On Windows, CI verifies the
bootstrapped MSVC ATL/MFC headers and libraries, then prepends that compiler
directory with `GITHUB_PATH` before configure runs. Release jobs use the same
worker, cache, and toolchain selection policy, with their existing six-hour
cold-build bound.

## Reproducible release dependencies

Developer installs use `pnpm-lock.yaml`, where Bento's pnpm hook records local
Tale UI `link:` targets. Release and CI installs use the separate committed
`pnpm-lock.release.yaml`, which records the registry-backed Tale UI graph.
`scripts/install-release-deps.sh` temporarily swaps in that root-format lock,
sets `BENTO_RELEASE=1`, force-relinks with `--frozen-lockfile`, and restores the
developer lock. The relink prevents an existing developer `link:` symlink from
surviving into a release build; the cleanup helper deletes only verified Tale
UI symlinks and refuses real directories. Any manifest or transitive-resolution
drift fails the install instead of silently changing a release.

After changing a dependency, update both graphs:

```sh
pnpm install
bash scripts/update-release-lock.sh
bash scripts/install-release-deps.sh
```

## Release security and provenance

Repository release builds keep Firefox's release add-on signature enforcement
enabled. Bento Shell and Bento Tools are registered through Firefox's built-in
add-on packaging path; ordinary third-party XPIs remain subject to Firefox's
normal signing requirements.

Every tag release stays a draft prerelease and must pass
`pnpm run release:security-check`. The release job generates a CycloneDX SBOM,
`release-manifest.json`, and `SHA256SUMS`, then records GitHub artifact
provenance attestations for every checksummed file. Run
`pnpm run release:security-check:public` before changing a release to a public,
non-prerelease channel. That gate remains blocked until the non-secret
fingerprints and identities for MAR signing, Linux manifest signing, macOS
Developer ID, and Windows Authenticode are recorded in
`config/release-security.json`. Signing private keys never belong in the
repository.

`pnpm run security:check` protects repository-owned navigation, preference,
profile-import, icon-fetching, bundled-add-on, signing, and release invariants.
CI also audits the full dependency graph and runs CodeQL over Bento JavaScript
and TypeScript.

## Pull request test builds

Automatic `pull_request` and `push` CI runs perform static checks and one Linux
source-import check. The Linux job downloads Firefox source, imports Bento,
repeats the import to verify idempotence, and validates the generated output.
Opening, updating, reopening, or marking a PR ready for review, and pushing to
`main`, do not start native application builds for any platform. The routine
source-import job has a 20-minute bound.

To build an unsigned application for review, open **Actions → CI → Run
workflow**. Choose a branch in this repository and a platform: `linux-x64`
(the default), `macos-arm64`, `windows-x64`, or `all`. The `workflow_dispatch`
definition must first be present on the repository's default branch before the
Actions UI offers the manual workflow. Manual native jobs use the worker and
parallelism settings above, have a 120-minute bound, and consume hosted-runner
time. Each selected platform uploads an attempt-scoped artifact with
compression disabled and 14-day retention; the job summary links it
immediately. GitHub sign-in is required to download these public repository
artifacts. They are unsigned development builds, so macOS Gatekeeper and
Windows SmartScreen may warn or block installation. Linux receives an archive
to extract and run.

The comment workflow runs after a manual CI run completes and checks the exact
open PR, source repository, source commit, and newest manual run attempt before
writing. It runs trusted default-branch code and never downloads or executes a
PR artifact. Unselected or unstarted platforms are shown as `not run`. Because
`workflow_run` definitions come from the default branch, the notifier must be
merged before it can update the bot comment. Until then, downloads are
available in the manual run's job summaries and artifacts.

## Updating Firefox

Use the maintained upstream-update entry point after reviewing the target
Mozilla release. For the Firefox version already configured in `bento.json`,
the pinned `firefox.source.sha256` is used:

```sh
pnpm run firefox:sync
```

For a newer target, first read the target from Mozilla's
[`firefox_versions.json`](https://product-details.mozilla.org/1.0/firefox_versions.json)
and copy its source archive digest from the matching per-release
[`SHA256SUMS`](https://archive.mozilla.org/pub/firefox/releases/154.0/SHA256SUMS)
file at `https://archive.mozilla.org/pub/firefox/releases/<target-version>/SHA256SUMS`.
The entry is a 64-character hexadecimal SHA-256 followed by the relative
archive path `source/firefox-<target-version>.source.tar.xz`. Pass that digest
only for the update command:

```sh
BENTO_SOURCE_SHA256=<sha256-from-mozilla> pnpm run firefox:sync
```

This supplies the expected digest; it does not bypass archive verification. The
driver refuses a missing or mismatched digest, stages the replacement, and keeps
the previous source checkout under `.bento/backups/` after success. Before
starting, run `git -C engine worktree list --porcelain`. If it lists a linked
worktree, inspect it with `git -C <worktree> status`, finish or export any
patch/rebase work, remove it with `git -C engine worktree remove <worktree>`,
and then retry the update. For a patch rebase, finish the rebase and run
`pnpm run firefox:patches:export` before removing its worktree.

The command asks Mozilla for the latest release for the configured product,
uses `bento-build.mjs update` to download and verify it, updates `bento.json`
and `config/firefox-versions.json`, checks the patch-stack base, builds
extensions, imports Bento, and builds Firefox. If the patch stack is stale,
rebase it with `pnpm run firefox:patches:rebase`, export it, then rerun import
and build. Review every active entry in
[firefox-core-touchpoints.md](firefox-core-touchpoints.md) during the update.

The update is acceptable only after branding, built-in add-ons, patch
application, packaging, locales, installers, and MAR/update XML output have
been checked. Run the source and artifact identity scanners as part of that
review.

For Linux and Windows hosted-builder changes, also run the patch-stack checks,
verify `node scripts/check-rust-toolchain.mjs`, and confirm the release workflow
reaches the final Rust/Firefox link and package steps without linker-memory or
toolchain-version failures. Keep macOS on its existing default LTO path unless
its own build evidence requires a separate change.

## Built-in add-ons

[scripts/install-builtin-addons.mjs](../scripts/install-builtin-addons.mjs)
discovers top-level extension directories with a Gecko add-on ID, copies only
their declared runtime entries, generates deterministic `jar.mn` and `moz.build`
files, and registers one marker block in Firefox's `browser/extensions/moz.build`.
An extension may replace the default runtime list with a safe top-level string
array in `.bento-runtime-entries.json`; `manifest.json` is always included.

## Branding and patches

[branding/bento](../branding/bento) is based on Mozilla Firefox's unofficial
branding layout plus Bento-owned metadata and visual assets. The tracked tree is
copied into the engine by `pnpm run import`; it is never generated by the build
driver. Firefox upgrades must compare the canonical tree with the new upstream
branding layout. Mozilla-authored files retain their Mozilla Public License
headers, and the repository's [NOTICE](../NOTICE) records required third-party
attribution.

[patches/series.json](../patches/series.json) is the sole source of Firefox patch
order. `pnpm run firefox:patches:apply` applies it to the live engine without
committing. The import wrapper resets prior applications before replaying it.

Native Bento Settings lives in the dedicated
`patches/core-ui/15-bento-native-preferences.patch`. Its protocol artifacts are
generated from one canonical JSON contract; run `pnpm native-protocol:check:all`
against a materialized patch worktree before export. Patch 15 must not absorb
the large `bento-shell-mount.js` source overlay, and existing chrome-layout
patches must remain byte-identical when the native patch is updated.

## Settings rollback variants

The consolidated Settings rollback is built from the committed source snapshot in `rollback/legacy-source`; see [settings-consolidation-rollback.md](settings-consolidation-rollback.md). Transition r1 has build/update/release commands, while final r2 has build/package/release commands and deliberately has no automatic-update command.

`pnpm dev` launches Bento without opening Browser Toolbox. Set
`BENTO_JSDEBUGGER=1` when the launch should also start Browser Toolbox; Firefox
may display its remote-debugging connection prompt for that opt-in mode.
