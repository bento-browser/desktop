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
- `build` and `build --ui` write the platform mozconfig (rewriting `engine/mozconfig`
  and the version files only when their content changes) and invoke `mach build`
  or `mach build faster`;
- `package` invokes the Firefox package and multi-locale package steps and
  writes `dist/bento-artifacts.json`. While the updater is enabled it also
  creates a MAR and writes browser and add-on update metadata; with the updater
  disabled (the default) it writes none and removes any left in `dist/`;
- `updates-browser` and `updates-addons` regenerate update metadata from an
  existing package; they refuse to run while the updater is disabled;
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

`scripts/mach-env.sh` chooses the Python that mach runs under: the binary (or
directory) in `BENTO_MACH_PYTHON` if set, else `python3.12` from `PATH` if
present, else the `python3` that `PATH` resolves (mach needs Python 3.9 or newer).

Firefox's Rust toolchain is pinned in the repository root by
[`rust-toolchain.toml`](../rust-toolchain.toml). Release CI resolves and verifies
that pin before Bento bootstrap or the native build. Linux and Windows release
mozconfigs opt into Bento's narrow `BENTO_RUST_LTO=thin` compatibility setting;
it changes only the top-level Rust release crate's LTO mode from Firefox's
default fat LTO to standard Rust ThinLTO, keeping embed-bitcode and release
codegen-unit settings unchanged. macOS keeps Firefox's default fat LTO because
its hosted release build completes within its existing memory budget. This
applies to release mode only; dev and debug builds skip the final-crate LTO (see
[Build modes and configure flags](#build-modes-and-configure-flags)).

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
- `pnpm run build:ui`: write the mozconfig and run `mach build faster`, the
  incremental Firefox UI build. It does not run `pnpm run import`.
- `pnpm run package`: produce platform packages and locales, plus the MAR and
  update XML when the updater is enabled (see [Updater](#updater)). A release
  build first refuses an object directory whose shell still has the dev-only
  reload command (see [Dev-only reload command](#dev-only-reload-command)).
- `pnpm run artifacts:check`: verify the packaged application against
  `dist/bento-artifacts.json`, and the MAR contents and update XML when the
  updater is enabled. With the updater disabled it fails if a MAR or update
  metadata exists.
- `pnpm run build:full`: download, bootstrap, build, and package.
- `pnpm run build:release`: create a host-platform release-mode package.
- `pnpm run lc`: run Bento's source-overlay license check.
- `pnpm run release:security-check:shell`: fail when a release shell still has the
  dev-only reload command (see [Dev-only reload command](#dev-only-reload-command)).
- `pnpm run brand:regen`: reinstall canonical tracked branding through the
  normal import pipeline.
- `pnpm run size:check`: report graph-aware JavaScript and direct-file size
  ceilings and fail when an entry grows past its baseline in
  `.size-baseline.json` by more than max(1%, 1 KB); missing or malformed
  built assets also fail the check.
- `pnpm run size:baseline`: rebuild the extensions with `BENTO_RELEASE=1` (the
  mode CI builds) and refresh `.size-baseline.json`. It lowers entries that
  shrank and adds new ones, but refuses to raise an existing entry, prints
  what it refused, and exits 1. Accept intended growth by naming the entry:
  `pnpm run size:baseline -- --accept-growth <entry path>` (repeatable). Commit
  the refreshed file.

## CI jobs and caches

Routine pushes and pull requests run on the free `ubuntu-24.04` runner only.
macOS and Windows builds run through `workflow_dispatch` and `release.yml`.

`ci.yml` jobs and what they wait for:

| Job (check name)                                               | Needs                                          | Runs                                                                                                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `security-gate` (Security gate)                                | none                                           | `pnpm run security:check`, `pnpm run release:security-check`, `pnpm audit --audit-level high`; selects the build platforms. Installs no dependencies.       |
| `static-checks` (JSON, shell, prefs sanity)                    | none                                           | Syntax, lint, generated-file and test suites outside the extensions, the competitor-reference boundary, the build driver config check, and `pnpm run lc`.   |
| `extensions` (Extensions — typecheck, lint, build, size-limit) | none                                           | Typecheck, lint, `pnpm run lint:aliases`, Vitest, extension build, `pnpm run release:security-check:shell`, `pnpm run size:check`, `pnpm run rollback:check`. |
| `build` (Source import or Build, per platform)                 | `security-gate`, `static-checks`, `extensions` | Pristine Firefox source, `ext:build`, `import` twice with a snapshot comparison, `check-import-output`, `pnpm run release:security-check:shell`. Manual runs go on to bootstrap, build, and package. |

The checks run in parallel and the build starts only after all of them pass,
so a failing tree never starts a native build. `release.yml` runs its own
`security-gate` (security invariants, release gate, the release security test,
and `pnpm audit`) before the three native builds; the `release` job repeats the
two release checks next to the artifacts it publishes.

Each job installs its own dependencies, because each job is a separate machine.
A manual build calls `scripts/build-release.sh` with `BENTO_RELEASE_PREPARED=1`:
the workflow already installed, built the extensions, and imported them with
`BENTO_RELEASE=1`, so the script skips those steps (the variable is documented
in the script header; local runs leave it unset). The script still runs
`pnpm run release:security-check:shell` before the native build on both paths.

Hosted caches use three keys. Their definitions live in
`.github/actions/engine-source` and `.github/actions/native-cache-keys`, so
`ci.yml` and `release.yml` cannot drift:

| Cache              | Key                                                                                                                               | Restore keys                                                                                                | Saved                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Firefox source     | `bento-engine-source-v2-<OS>-<firefox.version>-<firefox.source.sha256>`                                                           | none                                                                                                        | Right after `pnpm run download` on a miss; never overwritten                    |
| Mozilla toolchains | `bento-mozbuild-v1-<OS>-<arch>-<firefox.version>`                                                                                 | none                                                                                                        | Right after a successful `bootstrap` on a miss                                  |
| Native objects     | `bento-obj-v1-<OS>-<arch>-<firefox.version>-<hash of patches/**>-<hash of configs/** and rust-toolchain.toml>-<run id>-<attempt>` | The same prefix without the run id, then `bento-obj-v1-<OS>-<arch>-<firefox.version>-<hash of patches/**>-` | After every manual or release native build, including a failed or timed-out one |

- **Source.** The cache holds `engine/` (without `obj-*`) and
  `.bento/source-state.json` exactly as `pnpm run download` leaves them, before
  any import. `import` resets the patched files and copies every overlay, so
  edits to the UI, patches, scripts, prefs, or branding never invalidate it. A
  Firefox bump or a new source digest does. Imported state (`import-manifest.json`,
  `engine-state.json`) is not cached.
- **Toolchains.** `~/.mozbuild` is cached without `srcdirs`, whose mach virtual
  environments hold absolute paths and are rebuilt in seconds. There is no
  restore key: a version bump bootstraps from scratch.
- **Native objects.** Every run saves a new `engine/obj-bento` entry (the key
  holds the run id), and restore takes the newest entry that matches the prefix
  with the same mozconfig inputs, otherwise the newest for the same Firefox
  version and patch stack. mach rebuilds only what changed. Objects never cross
  Firefox versions, so the first build after a bump is the cold build that
  proves the tree compiles from scratch. The hash of `patches/**` (every file
  there except Markdown, so `series.json` counts) is part of every restore
  prefix, so objects also never cross patch stacks. Without it, removing a patch
  restores the pristine source file with an older mtime than the object
  compiled from the patched file; `import` does not refresh that timestamp and
  mach keeps unchanged build-file timestamps, so the stale object would be
  reused and the binary would keep the removed patch's behaviour. A patch
  change is therefore a cold native build; patches change rarely. The object
  tree is saved even when the build fails. The build step stops at 320 minutes,
  inside the 360-minute job bound, so the save still runs and the next run
  resumes from the partial tree.
- **Scope.** GitHub lets a run read caches from its own ref and the default
  branch. Pushes to `main` seed the source cache for every pull request. A
  manual run on `main` seeds the toolchain and object caches for every branch
  and for release tags. Tag runs restore but never save, because a cache written
  under a tag ref is invisible to the next tag and would only evict useful
  entries. Run CI manually on `main` after a Firefox bump, before tagging.
- **Size.** Linux entries are about 2 GB (source) and a few GB (objects, which
  superseded runs leave behind until GitHub evicts the least recently used
  entry at the 10 GB repository cap). Building all three platforms in one
  run exceeds the cap, so expect macOS and Windows caches to be evicted between
  runs. The job summary of every build lists which caches hit.
- **Forcing a cold build.** Delete the `bento-obj-*` entries with
  `gh cache delete`, or change the `v1` prefix in
  `.github/actions/native-cache-keys` to discard every object and toolchain
  entry at once.

Manual CI application builds use four workers on the public
`ubuntu-24.04` runner (4 CPUs / 16 GiB), two workers on the public
`windows-2025` runner (4 CPUs / 16 GiB), and one worker on the standard
`macos-26` Apple Silicon runner (3 M1 CPUs / 7 GiB). Each manual native job
has a 360-minute bound for a cold Firefox build. Staging directories, backups,
source archives, and patch-stack worktrees are not cached. On Windows, CI
verifies the bootstrapped MSVC ATL/MFC headers and libraries
(`.github/actions/select-windows-toolchain`), then prepends that compiler
directory with `GITHUB_PATH` before configure runs. Release jobs use the same
worker, cache, and toolchain selection policy, with their existing six-hour
cold-build bound.

## Build modes and configure flags

`build.mode` in `bento.json` selects the compiler policy, and `BENTO_BUILD_MODE`
or `BENTO_RELEASE=1` override it; `scripts/build-mode.mjs` is the one resolver (see
[Dev-only reload command](#dev-only-reload-command) for the precedence).
`configs/common/mozconfig` and the platform fragments hold only
options that do not depend on the mode; `bento-build.mjs` appends the mode's
options when it writes `engine/mozconfig`:

| Mode            | Options appended                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `dev` (default) | `--disable-debug --disable-release`, and on macOS `--enable-macos-target=11.0`                   |
| `debug`         | `--enable-debug --disable-optimize --disable-release`, and on macOS `--enable-macos-target=11.0` |
| `release`       | `--disable-debug --enable-optimize --enable-rust-simd --enable-release`                          |

Every mode also gets the branding, the `bento` update channel, `--disable-updater`
(see [Updater](#updater)), and the `MOZ_OBJDIR` line described under
[Object directory](#object-directory).

`--disable-release` turns on Firefox's developer options. Compared with
`--enable-release` that skips the final-crate Rust LTO link (a serial tail that
was 56% of one cold build the audit measured on an 18-core host), allows incremental Rust
builds, and drops release-only compiler settings such as per-function sections.
Firefox's macOS deployment target default also falls from 11.0 to 10.15 under
developer options, so dev and debug pin `--enable-macos-target=11.0`, the value
release builds use. The trade-off is accepted: dev and debug binaries do not
exercise release codegen (no fat or thin LTO, different identical-code folding).
Release behavior is checked by release mode, which `scripts/build-release.sh`
always selects (CI manual builds and tag releases), or locally with
`BENTO_BUILD_MODE=release`.

All modes share `engine/obj-bento`, so switching modes there makes mach re-run
configure and recompile whatever the changed options affect; expect a rebuild
close to a full one, and `BENTO_OBJDIR=obj-<name>` to keep a second tree if you
alternate. The first build after pulling this split also reconfigures, because
the generated mozconfig changed (`--disable-release`, `--disable-updater`).
Hosted CI object caches (`.github/actions/native-cache-keys`) key on the
platform, `bento.json` `firefox.version`, the non-Markdown blobs under
`patches/`, and the git tree of `configs/` plus the blob of `rust-toolchain.toml`
(the "mozconfig inputs"). A change under `configs/` or to `rust-toolchain.toml`
misses the first restore prefix and falls back to the second: the newest entry
for the same platform, version and patch stack, so mach reconfigures and
recompiles what the changed options affect. A patch change or a Firefox bump
misses both restore prefixes and starts cold. `scripts/bento-build.mjs` and the rest
of `bento.json` (including `updates.enabled`) are not key inputs: a change to the
generator alone, such as the mode options it appends, leaves every key unchanged,
restores the cached tree as is, and relies on mach detecting the changed
`engine/mozconfig`, the same as a local mode switch. This split changes both
`configs/` and the patch stack, so its first run starts cold.

## Updater

The updater is compiled out. The generated `engine/mozconfig` contains
`--disable-updater` because `updates.enabled` in `bento.json` is `false`, and the
release tooling treats a build as unable to update:

- `package` writes no MAR, update XML, or add-on update XML, deletes any
  `dist/output.mar` and `dist/update/` an earlier package left, and records
  `"updates": { "enabled": false }` in `dist/bento-artifacts.json`. It records the
  updater state the build was configured with, and refuses to package when that
  disagrees with `updates.enabled` (run `pnpm run build`), so an object directory
  configured with a different updater setting is never described by the wrong
  metadata. Two sources are read: the last `--enable-updater` or `--disable-updater`
  (or `--with` and `--without`) in `engine/mozconfig`, because configure keeps the
  last occurrence of an option and a first-match scan would miss a later flag, and
  `MOZ_UPDATER` in the object directory's `config.status.json`, which is what
  configure actually built and cannot be disguised by how a mozconfig spells a flag.
  It also refuses a `config.status.json` whose `MOZ_UPDATE_CHANNEL` is not
  `updates.channel` (configure lowercases it).
- `updates-browser` and `updates-addons` fail with a message naming the switch.
- `pnpm run artifacts:check` expects the primary packages and a matching
  `bento-artifacts.json`, still requires the application's `precomplete` file
  (Firefox's packager writes it whether or not the updater is built, and the
  Windows installer and uninstaller read it to remove files), checks that the
  object directory's `config.status.json` agrees with `updates.enabled` and
  `updates.channel`, and fails if a MAR or update metadata exists in `dist/` or
  the manifest.
- `configs/common/mozconfig`, the platform fragment and the root `mozconfig`
  are appended to `engine/mozconfig` after Bento's options, so they may not set
  the updater, MAR signature verification or the update channel: any active line
  that mentions one (`--enable-updater`, `--disable-updater`, `--with-updater`,
  `--without-updater`, the same four spellings of `unverified-updates` and of
  `update-channel`, a `MOZ_UPDATER`, `MOZ_VERIFY_MAR_SIGNATURE` or
  `MOZ_UPDATE_CHANNEL` export, `MAR_CHANNEL_ID`, `ACCEPTED_MAR_CHANNEL_IDS`) makes
  the mozconfig writer fail, the same way a `MOZ_OBJDIR` line does. Full-line and
  trailing `#` comments are ignored first, so a note that names an option is
  fine. `updates.enabled` and `updates.channel` are the only switches: unverified
  updates would bypass MAR signature checks if the updater were re-enabled, and a
  channel such as `release` compiles Mozilla's certificates into the updater.
- `scripts/build-release.sh` collects no MAR or update XML and fails if
  `release-out/` or `dist/` holds one; the release workflow checks the same
  before uploading.

The update channel (`--enable-update-channel=bento`), the MAR channel exports,
`MOZ_APPUPDATE_HOST`, and all update tooling (`createMar`, update XML writers,
the MAR checks in `validate-bento-artifacts.mjs`) stay in place for when the
updater returns.

Why it is off (2026-10-12 audit, findings S-02, S-03, F-18): any channel other
than Mozilla's release, beta, esr, nightly and aurora ones compiles Mozilla's
`dep1.der` and `dep2.der` certificates into the updater as MAR trust anchors, so
`bento` is not a trust boundary of its own;
nothing signs Bento's MARs; `MOZ_APPUPDATE_HOST` has no consumer in stock Firefox,
so an updater-enabled build asks `aus5.mozilla.org`; and the release gate checked
configuration rather than artifacts.

### Re-enabling the updater

`updates.enabled` is a single switch that three places refuse to turn on until
`config/release-security.json` records every input below: the release gate
(`pnpm run release:security-check`, run by CI and the release workflow), the
mozconfig writer (so `pnpm run build` fails before compiling), and `package` and
the `updates-*` commands. The checks live in
[`scripts/update-readiness.mjs`](../scripts/update-readiness.mjs).

| Input in `config/release-security.json` `updateService` | Means                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `marSigningKeyFingerprint`                              | SHA-256 fingerprint of the real MAR signing key (private key kept outside the repository)                                                |
| `updaterCertificateFingerprint`                         | Fingerprint of the certificate compiled into the updater; it must equal the signing key's, so the compiled certificate verifies the MARs |
| `hostCompiledIn`                                        | `true` once `updates.hostname` reaches configure and `application.ini` before compilation                                                |
| `isolatedRoundTripVerified`                             | `true` once a signed update installed from one build to the next against an isolated update host                                         |

`bento.json` `updates.channel` must also be a Bento-owned name; `release`, `beta`,
`esr`, `nightly*`, `aurora` and `default` select Mozilla's certificates and are
refused. configure lowercases the channel before choosing certificates, so the
check compares the lowercased, trimmed name (`Release`, `NIGHTLY` and `nightly`
with padding are refused), and a channel that is not already lowercase and
trimmed is refused as well. A public release additionally requires `updates.enabled`
(`pnpm run release:security-check:public`).

These fields are recorded attestations. Nothing yet checks them against a built
artifact, and the work they stand for does not exist in the repository: patching
`toolkit/mozapps/update/updater/moz.build` to compile Bento's certificate for the
`bento` channel, wiring the update host, adding a `signmar` step to `package`, and
extending `artifacts:check` to verify the MAR signature against the committed
certificate. Do that work, log every Firefox core surface it touches in
[firefox-core-touchpoints.md](firefox-core-touchpoints.md), run the isolated round
trip, record the inputs, and only then set `updates.enabled` to `true`. The next
build reconfigures with the updater compiled in.

## Object directory

The generated mozconfig sets `mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/obj-bento` in
every build mode. Firefox's default name embeds the host OS version
(`obj-aarch64-apple-darwin25.5.0`), so an OS update started a cold build in a new
directory and left two behind. `obj-bento` still matches the `engine/obj-*`
cache paths in CI.

Generation and resolution come from one place in `bento-build.mjs`. The mozconfig
names `obj-bento`, or `BENTO_OBJDIR=obj-<name>` when that is set during the build
(it must be an `obj-*` directory directly under `engine/`). `resolveObjDir` reads
the `MOZ_OBJDIR` back out of `engine/mozconfig`, so every tool uses the directory
mach builds into even if `BENTO_OBJDIR` is unset or changed later. A `BENTO_OBJDIR`
that disagrees with the mozconfig fails `package` and `updates-browser`
(rebuild with the same value or unset it). Three things would send mach somewhere
else, so they are rejected up front: a `MOZ_OBJDIR` line in `configs/common/mozconfig`,
the platform mozconfig or the root `mozconfig` (when the mozconfig is written), and a
`MOZCONFIG` environment variable naming a file other than `engine/mozconfig` (before
`build` or `package` run mach).

`package`, `updates-browser` and `build-release.sh` use only that directory and fail
if it does not exist. The launch and sync scripts (`dev-launch.sh`, `sync-shell.sh`,
`sync-builtin-addon-symlinks.sh`) call `node scripts/bento-build.mjs objdir
--allow-legacy`: while the configured directory does not exist they accept a single
legacy platform-named `engine/obj-*` build from an older checkout (or an existing
directory named by `BENTO_OBJDIR`), print which one on stderr, and fail when several
legacy directories exist. `sync-builtin-addon-symlinks.sh` also passes
`--allow-missing`, so an import before any build still succeeds.
`package` and `updates-browser` read the target architecture from the object
directory's `mozinfo.json` (`processor`), because `obj-bento` carries no target
triple in its name. A checkout built before this change keeps its old directory
untouched; the first build compiles from scratch into `obj-bento`, and the old
directory can be deleted by hand.

## Import cost and mtimes

`pnpm run import` is part of the UI loop, so its fixed costs are kept small:

- **Patch check.** `firefox-patch-stack.mjs check` (with or without
  `--for-import`) reads the base commit into a temporary Git index
  (`GIT_INDEX_FILE` and `git read-tree`) and runs `git apply --cached` for each
  patch in manifest order, with the same whitespace arguments as `apply`. The
  settings that can change an outcome (`apply.whitespace=warn`,
  `core.autocrlf=false`, `core.safecrlf=false`) are pinned with `git -c` for the
  replay and the live `apply`, so user or system git configuration cannot make
  one pass and the other fail, and the replay also pins `core.splitIndex=false`
  so nothing is written into the engine's git directory. No
  worktree is checked out, and the engine's index, working tree and object
  store are untouched: blobs the patches create are written to a scratch object
  directory that reads the engine's objects as an alternate. A failure names
  the manifest entry (`failed to apply patches/<area>/<name>.patch (<id>)`) and
  includes Git's output. After a pass, the SHA-256 of every file under
  `patches/` (including `series.json`), the resolved base commit, and the apply
  arguments and the pinned git settings is stored in `.bento/patch-check.json`; while
  it still matches, the replay is skipped. `check --force` ignores the record, and `export` always
  replays. Measured on the Firefox 154.0 tree (471,508 files): 5.0 to 7.3 s over nine runs for a
  replay and 0.5 to 0.65 s when skipped. Because the replay never
  checks anything out, `check` and `apply` refuse to run when the engine repository
  has `core.symlinks=false` and a patch changes a tracked symlink (the checkout
  holds a plain file, so `apply` would fail with "wrong type" after the import has
  already started); series that touch no symlink are unaffected.
- **Materialized trees are unchanged.** `materialize` and `rebase` still create
  a real checkout in `.bento/patch-stack-worktree`, and
  `pnpm native-protocol:check:all` still reads it. The old replay used its own
  temporary worktree outside `.bento/`, so nothing that needs a materialized
  tree depended on it.
- **Hashing.** `bento-build.mjs` hashes with streaming `node:crypto` SHA-256 in
  process instead of spawning `shasum`, `sha256sum` or `certutil` per file.
  Hashing the 871 files in `.bento/engine-state.json` took 0.095 s against 8.5 s
  with `shasum`, with identical digests.
- **Write-if-changed.** `engine/mozconfig`, `browser/config/version.txt`,
  `version_display.txt`, built-in add-on files, their `jar.mn` and `moz.build`,
  `browser/extensions/moz.build`, the branding tree, and the prefs files are
  rewritten only when their bytes differ, and add-on and branding trees are
  synced in place (stale files are removed) instead of deleted and copied.
  Mach decides what to reconfigure and rebuild from mtimes, so inputs that are
  not rewritten no longer look changed. The patch reset (`reset-engine-patches.sh`) and `apply` still
  rewrite every patched file on each import.
- **Regenerated files in verification.** `engine/mozconfig` and the two version
  files are rewritten from `bento.json` and `configs/` by every build, in
  whichever mode that build uses. Recorded-state verification therefore
  accepts freshly generated content (any build mode, any `obj-*` name, with or
  without the object directory line, the format written before the dev/release
  split and the updater switch, or the legacy format) or the exact bytes
  recorded at the last import, which is what the file still holds when
  `configs/` or `bento.json` changed and the build has not regenerated it yet.
  Any other content, such as a hand edit, still fails. `engine/mozconfig` is
  validated whenever it exists, even though Firefox ignores it in Git and an
  import before the first build records nothing for it; a version file is
  validated once it differs from Git. The bytes recorded at import also count as
  owned, so a `displayVersion` bump does not fail the next import before the
  build rewrites the files. Every other recorded file keeps the hash comparison.

## Reproducible release dependencies

`pnpm-lock.yaml` is the only lockfile, for developer, CI, and release installs.
It consumes the exact published npm package `@muxui/react@0.1.0-rc.1` and records
its registry integrity. The package exposes public `./themes` and `./themes.css`
entries alongside the root React renderer; consumers use those exports rather
than generated-file paths. Bento has no committed Mux tarball or local
provenance sidecar.

CI and release builds run `pnpm install --frozen-lockfile` (the
`.github/actions/setup` composite action, and `scripts/build-release.sh`, where
it does nothing when `node_modules` is current). Manifest or transitive-resolution
drift fails the install. The install is the full graph, dev tooling included,
because the extension build needs it. pnpm owns the lockfile's format, so it is
excluded from Prettier (`.prettierignore`, `.lintstagedrc.json`). The release
SBOM reads the same file and requires the approved shell runtime dependency set,
exact published Mux version, and verified npm integrity; it rejects a substituted
tarball or digest. Mux is reported like other npm components with its registry
SHA-512 integrity digest.

Bento's `react` and `react-dom` ranges (`^19.2.0`) sit inside Mux's peer range
(`>=19.2.0 <20`).

Bento keeps one React Aria substrate graph for menu context identity and pins
Tiptap's core and peer family to `3.31.4`, matching the published Mux manifest.
This is later than the patch for
[GHSA-j95f-988m-3j2f](https://github.com/advisories/GHSA-j95f-988m-3j2f).
React Aria remains an internal Mux dependency; Bento composites use the public
Mux API, with shared Bento primitives for layout and icons.

To change the graph, pass a frozen install and the release-security checks
first, then regenerate the lock and verify it again:

```sh
pnpm install
pnpm install --frozen-lockfile
```

### Dependabot

`.github/dependabot.yml` has one `npm` entry for the repository root, which
Dependabot reads as the whole pnpm workspace (the root manifest and both
extensions) and updates in the one lock. Updates are weekly, capped at two open
PRs, and grouped into one minor-and-patch PR for production dependencies and one
for development dependencies. Major versions are ignored. The strategy is
`lockfile-only`, so a PR never edits a manifest specifier: the approved shell
runtime dependency set that the SBOM generator pins stays intact, and exact pins
(for example `vite`, `@ladle/react`, `emojibase-data`) are left for manual
updates. `@muxui/react`, the React Aria family, and the Tiptap family are
ignored, because their pins and overrides move together through the Mux release
procedure below.

## Local Mux UI

To develop Mux and Bento together, point Bento at a local Mux checkout instead
of the pinned npm `@muxui/react`. Each loop is one command; the default checkout
is `~/Projects/muxui/packages/react`, overridable with an absolute `MUXUI_LOCAL`. The scripts run [`scripts/muxui-dev.mjs`](../scripts/muxui-dev.mjs)
and set `MUXUI_LOCAL` only for the processes they start.

| Script                      | Loop                                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run shell:ladle:mux`  | Mux generate, then Ladle. Re-runs generate when a Mux input changes.                                                                                 |
| `pnpm run shell:dev:mux`    | The same with the shell Vite dev server.                                                                                                             |
| `pnpm run shell:import:mux` | One shot for real Bento: Mux generate, type check against local Mux, shell and background build, `pnpm run import`. Then press Alt+Shift+R in Bento. |

Mux generate here is `packages/schema/src/generate.mjs` followed by
`packages/react/src/generate.mjs` (react generate imports the schema package's
generated contract). Mux's own `generate` script also writes an advisory status
file that Bento does not read, so it is skipped. Mux's react generate rewrites
the tracked `packages/react/README.md` whenever Mux sources change; that is Mux's
own behavior, expected, and belongs in the Mux commit. The watch covers
`packages/react/{src,package.json}`, `packages/{tokens,schema}/src`,
`packages/schema/schemas`, `strategy/platform-safety-contract.json`, the
repository-policy files schema generate reads, and the catalog files react
generate reads (`catalog/tokens`, `catalog/react-r1-*`, each component's
`artifact.json`), never `generated/`. Runs are debounced and serialized: a change
during a run queues exactly one rerun.

How the checkout is used:

- [`extensions/bento-shell/muxui-local.mjs`](../extensions/bento-shell/muxui-local.mjs)
  serves both Vite configs. It validates `MUXUI_LOCAL` (absolute path, package
  name `@muxui/react`, `generated/index.mjs` present) and aliases every public
  export by exact match, derived from the local `package.json` exports map. A
  prefix alias would break subpaths and the `@import`s in `src/theme/muxui.css`.
- React and React DOM resolve from Bento (`resolve.dedupe`), and the existing
  React Aria aliases stay, so Mux and Bento share one React and one React Aria.
  Mux's own `lucide-react`, `motion`, Tiptap, and `shiki` resolve from the Mux
  checkout; they are intentionally not aliased (Mux uses a newer lucide than the
  shell).
- `server.fs.allow` lists the workspace root and the local package root, since
  Mux's CSS loads fonts from its `assets/`.
- `shell:import:mux` writes the gitignored
  `extensions/bento-shell/tsconfig.muxui-local.json`, which maps the public
  declarations to the local `generated/*.d.ts`. The default `tsc -b` and the
  shell `build` script keep using the npm declarations.
- Theme preset sync and chrome token generation stay on the npm package, so
  changes to Mux tokens or themes reach Bento's presets and chrome tokens only
  after Mux is published and pinned.

Guards keep local Mux out of releases:

- The Vite configs and `muxui-dev.mjs` (through `muxui-local.mjs`) throw when
  `MUXUI_LOCAL` is set during a release build: `BENTO_RELEASE=1`,
  `BENTO_BUILD_MODE=release`, or `build.mode: "release"` in `bento.json`, resolved by
  `scripts/build-mode.mjs` like the build driver does (see
  [Dev-only reload command](#dev-only-reload-command)). `shell:*:mux` still work
  while the mode is `dev`. `scripts/build-rollback-variant.mjs` refuses
  `MUXUI_LOCAL` in every action;
  `scripts/build-release.sh` and `scripts/build-bento.sh` exit if it is set.
- The shell build writes `dist/muxui-source.json`: `{"source":"npm","version":...}`
  or `{"source":"local"}`. Packaging (`bento-build.mjs package`, which backs
  `pnpm run package`, `build:full`, `build:release`, CI, and release builds) reads
  that stamp where Firefox ships it, not from the imported
  `engine/browser/extensions/bento-shell/dist`: `mach build` copies the shell into
  the objdir (symlinks in dev builds, real copies elsewhere), so rebuilding and
  re-importing the shell does not refresh native resources that were already
  built. It checks two places, both at
  `chrome/browser/builtin-addons/bento-shell/dist/muxui-source.json`:
  1. the packager's input, `engine/obj-bento/dist/bin/browser/`, before `mach package`,
     only to fail fast on the common mistake instead of after the long package step;
  2. the staged application after `mach package` and `package-multi-locale`,
     before the distributables are collected or the MAR is made. This is the
     authoritative check: it reads inside `omni.ja`
     (`engine/obj-bento/dist/bento/Bento.app/Contents/Resources/browser/omni.ja` on
     macOS, `engine/obj-bento/dist/bento/browser/omni.ja` elsewhere), or the loose `chrome/` tree when
     there is no `omni.ja`.

  A missing or `local` stamp is rejected, so a local build packaged after
  unsetting the variable fails until `pnpm run build` (extension build, import,
  and native build) has refreshed the objdir. An objdir built before this check
  has no stamp and needs `pnpm run build` once. `pnpm run build` never packages and
  is unaffected.

- Rollback variants replace the shell `vite.config.ts` with the archived one in
  `rollback/legacy-source`, which has no local Mux support and cannot stamp its
  own build. `scripts/build-rollback-variant.mjs` stages
  `{"source":"rollback","variant":"<name>"}` into the shell's `public/`, which Vite
  copies into `dist/`. When `BENTO_RELEASE_VARIANT` is set, packaging accepts only
  the stamp of that exact variant, and the name must be one of `ROLLBACK_VARIANTS`
  in `scripts/rollback-variants.mjs`; when it is unset, only `npm`. The
  `rollback:package-*` actions import the archived shell without a native build, so
  they package only if the objdir already carries that variant's stamp (a symlinked
  dev objdir follows the import; otherwise run the variant's `build` action).

### Publishing a new Mux release

1. In the Mux repository, run `pnpm release:prepare` with
   `MUXUI_RELEASE_CANDIDATE_VERSION` set to the candidate version, then publish
   through the npm-publish workflow (registry preflight, dry run, publish).
2. Baseline, before changing anything: `pnpm install --frozen-lockfile` and
   `pnpm run release:security-check` against the current pin and lock must pass.
3. Update the inputs the new graph is checked against: the exact pin in
   `extensions/bento-shell/package.json`; the root `pnpm.overrides` (React Aria,
   Tiptap) if Mux's dependencies changed; the `react`/`react-dom` ranges (inside
   Mux's `peerDependencies`) in `extensions/bento-shell/package.json`; and the
   expected release metadata, the version and registry integrity in
   `scripts/generate-release-sbom.mjs` (`muxuiVersion`, `muxuiIntegrity`, and the
   approved runtime dependency specifiers) and `scripts/release-security.test.mjs`.
4. Regenerate the lock: `pnpm install`. (Frozen installs fail between steps 3
   and 4 by design.)
5. Verify the new graph: `pnpm install --frozen-lockfile`,
   `node --test scripts/release-security.test.mjs`, and
   `pnpm run release:security-check`.
6. Update the version mentions in `CLAUDE.md`, `README.md`, and the docs
   (`docs/build-tooling.md`, `docs/mux-ui-component-customisations.md`,
   `docs/core-functionality-technical.md`).

## Release security and provenance

Repository release builds keep Firefox's release add-on signature enforcement
enabled. Bento Shell and Bento Tools are registered through Firefox's built-in
add-on packaging path; ordinary third-party XPIs remain subject to Firefox's
normal signing requirements.

Every tag release stays a draft prerelease and must pass
`pnpm run release:security-check`, which also refuses `updates.enabled: true`
while the updater readiness inputs are missing (see [Updater](#updater)). The release job generates a CycloneDX SBOM,
`release-manifest.json`, and `SHA256SUMS`, then records GitHub artifact
provenance attestations for every checksummed file. Run
`pnpm run release:security-check:public` before changing a release to a public,
non-prerelease channel. That gate remains blocked until the non-secret
fingerprints and identities for MAR signing, Linux manifest signing, macOS
Developer ID, and Windows Authenticode are recorded in
`config/release-security.json` and `bento.json` has `updates.enabled: true`.
Signing private keys never belong in the repository.

`pnpm run security:check` protects repository-owned navigation, preference,
profile-import, icon-fetching, bundled-add-on, signing, and release invariants.
CI also audits the full dependency graph and runs CodeQL over Bento JavaScript
and TypeScript.

The CI `pnpm audit --audit-level high` step audits `pnpm-lock.yaml`, the same
lock that release builds install. Fix vulnerable transitive packages with
`pnpm.overrides` in `package.json`, then refresh the lock.

Audit exceptions live in `pnpm.auditConfig.ignoreGhsas` in `package.json`. Each
entry needs a reason here and must be removed once a patched release is
reachable:

- `GHSA-vfj7-8cjw-p6xm` (`braces` <= 3.0.3, stack exhaustion on deeply nested
  brace patterns; no patched `braces` release exists). Dev-only: it is reached
  through `lint-staged` and `@ladle/react` (via `globby` and `fast-glob`),
  both devDependencies, and does not appear in the built extension bundles.
  The only patterns it expands come from repository-owned config
  (`.lintstagedrc.json` and the Ladle `stories` glob), never from untrusted
  input. Upgrading `lint-staged` would not remove the path, because the latest
  `@ladle/react` still depends on `globby` and `fast-glob`.

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
parallelism settings above, have a 360-minute bound, and consume hosted-runner
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
[`SHA256SUMS`](https://archive.mozilla.org/pub/firefox/releases/)
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
application, packaging, locales, installers, and (while the updater is enabled)
MAR/update XML output have been checked. Re-run the configure-flag checks
recorded under "Build Configure Flags And Updater" in
[firefox-core-touchpoints.md](firefox-core-touchpoints.md). Run the source and
artifact identity scanners as part of that review.

For Linux and Windows hosted-builder changes, also run the patch-stack checks,
verify `node scripts/check-rust-toolchain.mjs`, and confirm the release workflow
reaches the final Rust/Firefox link and package steps without linker-memory or
toolchain-version failures. Keep macOS on its existing default LTO path unless
its own build evidence requires a separate change.

## Shell stylesheets, themes and fonts

`pnpm run ext:build`, `pnpm run import` and `pnpm run lc` all start from the
generated theme files, so none of them needs a separate step.

- **Theme sheets.** `pnpm run theme:sync` ([`scripts/sync-theme-presets.mjs`](../scripts/sync-theme-presets.mjs))
  writes `extensions/bento-shell/src/theme/presets/index.{css,ts}` (Default, the
  legacy token bridge, and the registry) and one tracked sheet per other theme in
  `extensions/bento-shell/public/themes/<id>.css`. Vite copies `public/` into
  `dist/`, so every shell page can link `./themes/<id>.css` and the archived
  rollback build resolves the same files. `theme:sync` removes sheets for themes that no longer
  exist; commit the result. [`scripts/generate-chrome-tokens.mjs`](../scripts/generate-chrome-tokens.mjs)
  reads the same sheets and writes `bento-chrome-tokens.css` (shared tokens and
  Default) plus `bento-chrome-themes/<id>.css` beside it. Both outputs are
  gitignored. `--monolithic`, or `BENTO_RELEASE_VARIANT=rollback-final-r2`, folds
  every theme into the base file because the archived mount script links only that
  file. [`scripts/sync-builtin-addon-symlinks.sh`](../scripts/sync-builtin-addon-symlinks.sh)
  links the `bento-chrome-themes/` directory into the app bundle so a dev build
  sees regenerated sheets without a native rebuild; a new theme file in a packaged
  or CI build comes from the `jar.mn` wildcard in
  `patches/chrome-layout/01-bento-shell-mount.patch`.
  [`scripts/theme-sheets.test.mjs`](../scripts/theme-sheets.test.mjs) covers the
  generator and runs in CI.
- **Mux CSS shape.** Both generators read Mux's `styles.css`, `themes.css` and
  `@muxui/react/themes` through one module,
  [`scripts/mux-css.mjs`](../scripts/mux-css.mjs) (tests in
  [`scripts/mux-css.test.mjs`](../scripts/mux-css.test.mjs)). It matches each
  public block by its whole top-level selector list, derives the theme list from the
  package instead of a fixed count, and stops the build with a message that names
  the file and block when Mux changes the shape: a missing, repeated or non-flat
  block, a missing required token, a `themes.css` rule it cannot assign to one
  theme, or a theme without both a light and a dark rule. A Mux upgrade that adds
  themes needs no generator change; one that reshapes the CSS needs a change in that
  module only.
- **Fonts.** [`extensions/bento-shell/woff2-fonts.ts`](../extensions/bento-shell/woff2-fonts.ts)
  rewrites the TrueType fonts the package stylesheet references to WOFF2 at the
  end of the shell build, with no extra dependency: it Brotli-compresses the
  font tables with Node's `zlib`. Output is cached in
  `extensions/bento-shell/node_modules/.cache/bento-woff2/`. The build fails if a
  `.ttf` reference remains. `panel-newtab-css.ts` marks the panel's Inter file
  external and requires the emitted `assets/<file>` to exist.
- **Mux CSS prune.** [`extensions/bento-shell/mux-css-prune.ts`](../extensions/bento-shell/mux-css-prune.ts)
  drops rules for the component families listed in `MUX_UNUSED_COMPONENT_CLASSES`
  when the finished bundle never names the family, and fails the build if a
  `muxui-*` class a script names lost every rule. It reads the public
  `styles.css` only. The archived rollback config registers the WOFF2 plugin and
  not the prune.

## Built-in add-ons

[scripts/install-builtin-addons.mjs](../scripts/install-builtin-addons.mjs)
discovers top-level extension directories with a Gecko add-on ID, syncs only
their declared runtime entries into `engine/browser/extensions/<name>` (changed
files are copied, stale files removed), generates deterministic `jar.mn` and
`moz.build` files, and registers one marker block in Firefox's
`browser/extensions/moz.build`. Files whose content is unchanged are not touched.
An extension may replace the default runtime list with a safe top-level string
array in `.bento-runtime-entries.json`; `manifest.json` is always included. In a
release build (see [Dev-only reload command](#dev-only-reload-command)) the installer
drops the `dev-reload` command from the manifest it copies, so an imported release
manifest differs from its source.

### Dev-only reload command

`extensions/bento-shell/manifest.json` declares `dev-reload` (Alt+Shift+R), and
`src/background.ts` answers it with `browser.runtime.reload()`. That is the
dev-loop reload in `CLAUDE.md`; it must not ship.

**What counts as a release build.** `scripts/build-mode.mjs` is the one resolver:
the build driver uses it for the mode in `engine/mozconfig`, and the shell
background build, the installer, the package guard, and the `MUXUI_LOCAL` guard use
it to ask whether the build is a release. Precedence: an explicit mode argument
(internal callers), then `BENTO_RELEASE=1` (release), then `BENTO_BUILD_MODE`, then
`build.mode` in `bento.json`. So `build.mode: "release"` in `bento.json` alone makes
a release build everywhere, native build included, and `BENTO_BUILD_MODE=dev` turns
a release config back into a dev build everywhere. `BENTO_RELEASE=1` also selects
release everywhere, so `BENTO_RELEASE=1 pnpm run build` builds a release native
build; it does not build the dev mode that earlier drivers did. `BENTO_RELEASE=1`
with `BENTO_BUILD_MODE=dev` (or `debug`) is contradictory and resolves to release,
the mode that ships fewer dev-only affordances; an unknown `BENTO_BUILD_MODE` still
fails. `BENTO_RELEASE=1 pnpm run ext:build`, which `size` and CI use, builds only
the extensions and is unaffected. `scripts/bento-build.test.mjs` checks that the
native build, the background bundle, and `isReleaseBuild` agree for every
combination.
`scripts/build-release.sh` sets both variables.

Dev builds keep both halves of the feature; release builds remove each one at the
step that produces it:

- Bundle: `scripts/build-extension-background.mjs` defines `__BENTO_DEV_RELOAD__`,
  and `background.ts` registers the handler only `if (__BENTO_DEV_RELOAD__)`.
  Release bundles define it `false`, so esbuild drops the handler and the
  `dev-reload` string. The script reads `bento.json` from the repository that holds
  it (`BENTO_REPO_ROOT` overrides, as for the installer).
- Manifest: `scripts/install-builtin-addons.mjs` writes the manifest into
  `engine/browser/extensions/<name>/` without the command (and without an empty
  `commands` block). The source manifest is never modified.
- Staged guard: `pnpm run release:security-check:shell` scans
  `extensions/bento-shell/dist` and, when present,
  `engine/browser/extensions/bento-shell` for the string and fails if it finds
  one. CI runs it after the release extension build and after the release import,
  and `build-release.sh` runs it right after its import. It checks the staged
  inputs only, whatever the mode, so it cannot see what an earlier build left in
  the object directory.
- Packaging guard: in a release build, `bento-build.mjs package` scans the shell
  built-in add-on that `mach package` will ship from the object directory
  (`engine/obj-bento/dist/bin/browser/chrome/browser/builtin-addons/bento-shell`
  and, from the app bundle, `engine/obj-bento/dist/<App>.app/Contents/Resources/browser/chrome/browser/builtin-addons/bento-shell`
  on macOS; the object directory comes from the same resolver as the rest of the
  driver, so `BENTO_OBJDIR` is honored). It follows symlinks and reads the real
  files, because a dev build links the add-on's `dist/` to the imported engine copy
  while other builds (and Mozilla's copy fallback in `mozpack/files.py`) leave real
  copies that rebuilding and re-importing the shell does not refresh. It runs
  right after the Mux stamp check and before `mach package`, and fails the
  package if `dev-reload` appears in a file or if no shell add-on is found to
  check. Dev packages are not checked. Every release packaging path goes through
  it: `pnpm run package`, `build-release.sh` (its `bento-env.sh package` step),
  and the rollback `package` and `release` actions (see below).

The transform and scans live in `scripts/dev-reload.mjs` and the mode in
`scripts/build-mode.mjs`; `scripts/dev-reload.test.mjs` (mode, background bundle,
object-directory scan), `scripts/install-builtin-addons.test.mjs` (installer), and
`scripts/bento-build.test.mjs` (package refusal over a stale object directory) cover
them. The rollback variants use the same build script, installer, and package
command, and their archived `background.ts` carries the same guard;
`node scripts/build-rollback-variant.mjs <variant> check` builds in release mode
and fails if the archived bundle still has the handler.

Firefox caches built-in add-on metadata, including commands, by manifest
`version`. After a local release import, run `pnpm run import` again for the dev
loop; if Alt+Shift+R is still missing in a reused profile, start with a fresh one
(`pnpm run dev:fresh`).

## Branding and patches

[branding/bento](../branding/bento) is based on Mozilla Firefox's unofficial
branding layout plus Bento-owned metadata and visual assets. The tracked tree is
synced into the engine by `pnpm run import` (unchanged files keep their
mtimes); it is never generated by the build driver. Firefox upgrades must compare the canonical tree with the new upstream
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

The consolidated Settings rollback is built from the committed source snapshot in `rollback/legacy-source`; see [settings-consolidation-rollback.md](settings-consolidation-rollback.md). Transition r1 has build/update/release commands, while final r2 has build/package/release commands and deliberately has no automatic-update command. CI runs `pnpm run rollback:check` (ESLint over the archived extension sources plus the read-only `check` action for both variants), so the archive cannot silently stop building against the current dependency graph.

`pnpm dev` launches Bento without opening Browser Toolbox. Set
`BENTO_JSDEBUGGER=1` when the launch should also start Browser Toolbox; Firefox
may display its remote-debugging connection prompt for that opt-in mode.
