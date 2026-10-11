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
- `pnpm run build:ui`: write the mozconfig and run `mach build faster`, the
  incremental Firefox UI build. It does not run `pnpm run import`.
- `pnpm run package`: produce platform packages, MAR, locales, and update XML.
- `pnpm run artifacts:check`: verify the packaged application, MAR contents,
  and update XML against `dist/bento-artifacts.json`.
- `pnpm run build:full`: download, bootstrap, build, and package.
- `pnpm run build:release`: create a host-platform release-mode package.
- `pnpm run lc`: run Bento's source-overlay license check.
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
| `extensions` (Extensions — typecheck, lint, build, size-limit) | none                                           | Typecheck, lint, Vitest, extension build, `pnpm run size:check`.                                                                                            |
| `build` (Source import or Build, per platform)                 | `security-gate`, `static-checks`, `extensions` | Pristine Firefox source, `ext:build`, `import` twice with a snapshot comparison, `check-import-output`. Manual runs go on to bootstrap, build, and package. |

The checks run in parallel and the build starts only after all of them pass,
so a failing tree never starts a native build. `release.yml` runs its own
`security-gate` (security invariants, release gate, the release security test,
and `pnpm audit`) before the three native builds; the `release` job repeats the
two release checks next to the artifacts it publishes.

Each job installs its own dependencies, because each job is a separate machine.
A manual build calls `scripts/build-release.sh` with `BENTO_RELEASE_PREPARED=1`:
the workflow already installed, built the extensions, and imported them with
`BENTO_RELEASE=1`, so the script skips those steps (the variable is documented
in the script header; local runs leave it unset).

Hosted caches use three keys. Their definitions live in
`.github/actions/engine-source` and `.github/actions/native-cache-keys`, so
`ci.yml` and `release.yml` cannot drift:

| Cache              | Key                                                                                                          | Restore keys                                                                           | Saved                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Firefox source     | `bento-engine-source-v2-<OS>-<firefox.version>-<firefox.source.sha256>`                                      | none                                                                                   | Right after `pnpm run download` on a miss; never overwritten                    |
| Mozilla toolchains | `bento-mozbuild-v1-<OS>-<arch>-<firefox.version>`                                                            | none                                                                                   | Right after a successful `bootstrap` on a miss                                  |
| Native objects     | `bento-obj-v1-<OS>-<arch>-<firefox.version>-<hash of configs/** and rust-toolchain.toml>-<run id>-<attempt>` | The same prefix without the run id, then `bento-obj-v1-<OS>-<arch>-<firefox.version>-` | After every manual or release native build, including a failed or timed-out one |

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
  version. mach rebuilds only what changed. Objects never cross Firefox
  versions, so the first build after a bump is the cold build that proves the
  tree compiles from scratch. The object tree is saved even when the build
  fails. The build step stops at 320 minutes, inside the 360-minute job bound,
  so the save still runs and the next run resumes from the partial tree.
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
  without the object directory line, or the legacy format) or the exact bytes
  recorded at the last import, which is what the file still holds when
  `configs/` or `bento.json` changed and the build has not regenerated it yet.
  Any other content, such as a hand edit, still fails. `engine/mozconfig` is
  validated whenever it exists, even though Firefox ignores it in Git and an
  import before the first build records nothing for it; a version file is
  validated once it differs from Git. The bytes recorded at import also count as
  owned, so a `displayVersion` bump does not fail the next import before the
  build rewrites the files. Every other recorded file keeps the hash comparison.

## Reproducible release dependencies

Developer installs use `pnpm-lock.yaml`. Release and CI installs use the
separate committed `pnpm-lock.release.yaml`; both graphs consume the exact
published npm package `@muxui/react@0.1.0-rc.1` and record its registry integrity.
The package exposes public `./themes` and `./themes.css` entries alongside the
root React renderer; consumers use those exports rather than generated-file
paths. Bento has no committed Mux tarball or local provenance sidecar.

`scripts/install-release-deps.sh` temporarily swaps in the root-format release
lock, force-relinks with `--frozen-lockfile`, and restores the developer lock.
Manifest or transitive-resolution drift fails the install. The release SBOM
requires the approved shell runtime dependency set, exact published Mux version,
and verified npm integrity; it rejects a substituted tarball or digest. Mux is
reported like other npm components with its registry SHA-512 integrity digest.

Bento keeps one React Aria substrate graph for menu context identity and pins
Tiptap's core and peer family to `3.31.4`, matching the published Mux manifest.
This is later than the patch for
[GHSA-j95f-988m-3j2f](https://github.com/advisories/GHSA-j95f-988m-3j2f).
React Aria remains an internal Mux dependency; Bento composites use the public
Mux API, with shared Bento primitives for layout and icons.

Run frozen developer/release installs and release-security checks before
regenerating locks, then verify the updated graphs. In an isolated source copy:

After the baseline checks, update both graphs:

```sh
pnpm install
bash scripts/update-release-lock.sh
bash scripts/install-release-deps.sh
```

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

- The Vite configs, `muxui-dev.mjs`, and `scripts/build-rollback-variant.mjs`
  throw when `MUXUI_LOCAL` is set during `BENTO_RELEASE=1` or
  `BENTO_BUILD_MODE=release` (the rollback script refuses it in every action);
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
2. Baseline, before changing anything: `pnpm install --frozen-lockfile`,
   `bash scripts/install-release-deps.sh`, and `pnpm run release:security-check`
   against the current pin and locks must pass.
3. Update the inputs the new graph is checked against: the exact pin in
   `extensions/bento-shell/package.json`; the root `pnpm.overrides` (React Aria,
   Tiptap) if Mux's dependencies changed; and the expected release metadata, the
   version and registry integrity in `scripts/generate-release-sbom.mjs`
   (`muxuiVersion`, `muxuiIntegrity`) and `scripts/release-security.test.mjs`.
4. Regenerate both locks: `pnpm install`, `bash scripts/update-release-lock.sh`,
   `bash scripts/install-release-deps.sh`. (Frozen installs fail between steps 3
   and 4 by design.)
5. Verify the new graphs: `pnpm install --frozen-lockfile`,
   `bash scripts/install-release-deps.sh`, `node --test scripts/release-security.test.mjs`,
   and `pnpm run release:security-check`.
6. Update the version mentions in `CLAUDE.md`, `README.md`, and the docs
   (`docs/build-tooling.md`, `docs/mux-ui-component-customisations.md`,
   `docs/core-functionality-technical.md`).

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

The CI `pnpm audit --audit-level high` step reads the developer lock, because
`scripts/install-release-deps.sh` restores it after installing. Keep the release
lock at the same bar by swapping it in with `BENTO_RELEASE=1` and auditing it
the same way. Fix vulnerable transitive packages with `pnpm.overrides` in
`package.json`, then refresh both locks.

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
discovers top-level extension directories with a Gecko add-on ID, syncs only
their declared runtime entries into `engine/browser/extensions/<name>` (changed
files are copied, stale files removed), generates deterministic `jar.mn` and
`moz.build` files, and registers one marker block in Firefox's
`browser/extensions/moz.build`. Files whose content is unchanged are not touched.
An extension may replace the default runtime list with a safe top-level string
array in `.bento-runtime-entries.json`; `manifest.json` is always included.

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

The consolidated Settings rollback is built from the committed source snapshot in `rollback/legacy-source`; see [settings-consolidation-rollback.md](settings-consolidation-rollback.md). Transition r1 has build/update/release commands, while final r2 has build/package/release commands and deliberately has no automatic-update command.

`pnpm dev` launches Bento without opening Browser Toolbox. Set
`BENTO_JSDEBUGGER=1` when the launch should also start Browser Toolbox; Firefox
may display its remote-debugging connection prompt for that opt-in mode.
