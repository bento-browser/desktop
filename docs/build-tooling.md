# Firefox build tooling

Bento pins the exact npm release `@zen-browser/surfer@1.14.7` as replaceable,
build-time infrastructure. It is not part of Bento's runtime, branding, product
identity, or ancestry, and no generated branding or tool source ships in Bento.

Surfer remains responsible for generic Firefox orchestration:

- downloading and updating the configured Firefox source;
- bootstrapping Mozilla build dependencies;
- source-overlay import;
- builds, runs, packages, locales, and MAR/update generation;
- license checking.

Firefox's Rust toolchain is pinned in the repository root by
[`rust-toolchain.toml`](../rust-toolchain.toml). Release CI resolves and verifies
that pin before Surfer bootstrap or the native build. Linux and Windows release
mozconfigs opt into Bento's narrow `BENTO_RUST_LTO=thin` compatibility setting;
it changes only the top-level Rust release crate's LTO mode from Firefox's
default fat LTO to standard Rust ThinLTO, keeping embed-bitcode and release
codegen-unit settings unchanged. macOS keeps Firefox's default fat LTO because
its hosted release build completes within its existing memory budget.

All Bento-specific import behavior belongs in this repository. The authoritative
wrapper, [scripts/import.sh](../scripts/import.sh), disables Surfer branding
generation, installs [branding/bento](../branding/bento), packages the built-in
extensions, and applies [patches/series.json](../patches/series.json) in manifest
order. Bento scripts do not import Surfer modules.

## Supported commands

- `pnpm run import`: run the complete Bento import wrapper.
- `pnpm run build`: build extensions, import Bento sources, and compile Firefox.
- `pnpm run build:full`: download, bootstrap, build, and package.
- `pnpm run build:release`: create a host-platform release-mode package.
- `pnpm run brand:regen`: reinstall canonical tracked branding through the
  normal import pipeline.

Hosted release cache keys include `configs/**` and `rust-toolchain.toml` along
with the Firefox source, patch stack, and package configuration. A change to
the LTO policy or Rust compiler therefore cannot reuse an object cache produced
under a different native build configuration.

Manual CI application builds use four workers on the existing 4 vCPU / 16 GiB
Linux runner, two workers on the 4 vCPU / 14 GiB Windows runner, and the
platform default on macOS. Each manual native job has a 120-minute bound. The
source cache excludes `engine/obj-*`; native objects use a separate
configuration key so source restores do not duplicate the large object
archive. On Windows, CI verifies the bootstrapped MSVC ATL/MFC headers and
libraries, then prepends that compiler directory with `GITHUB_PATH` before
configure runs. Release jobs use the same worker, cache, and toolchain
selection policy, with their existing six-hour cold-build bound.

Direct `surfer import` bypasses Bento's branding, add-on, patch, preference, and
symlink steps. Use `pnpm run import` whenever the resulting engine state matters.

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

## Upgrading Surfer

No Surfer update is auto-merged. Do not create another Bento-maintained fork.
Review the upstream release, then upgrade the immutable exact pin:

```sh
pnpm up --save-exact @zen-browser/surfer@<version>
pnpm exec surfer --version
pnpm run import
pnpm run build
pnpm run build:release
```

The upgrade is acceptable only after branding, built-in add-ons, manifest patch
application, packaging, locales, installers, and MAR/update output have been
checked. Run the source and artifact identity scanners as part of that review.

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
branding layout plus Bento-owned metadata and visual assets. Surfer's branding
generator is disabled. Firefox upgrades must compare the canonical tree with the
new upstream branding layout.

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
