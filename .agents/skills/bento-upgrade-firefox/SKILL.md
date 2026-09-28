---
name: bento-upgrade-firefox
description: Upgrade Bento Browser to a newer Mozilla Firefox engine release through Bento's protected source, patch, branding, build, and release validation workflow. Use for Firefox security updates, version bumps, compatibility assessment, incomplete upgrade repair, or patch drift caused by an upstream release.
---

# Upgrade Bento Firefox

Use Bento's checked-in build driver and patch-stack tools to update the Firefox
engine while preserving Bento behavior, Mozilla notices, profile-import
interoperability, and recoverable Git state. Keep the browser UX and product
identity unchanged unless the developer explicitly chooses a behavior change.

## Establish scope and repository state

For an assessment or compatibility question, stay read-only. Do not run a
mutating `verify` that adopts an engine, `import`, `install`, `download`,
`update`, or source synchronization merely to answer the question.

For an implementation request:

1. Work from the repository root; every command below uses repo-relative paths.
2. Read the canonical `CLAUDE.md` completely (`agents.md` points to it).
3. Read these current sources before changing the engine:
   - `bento.json`
   - `docs/firefox-patches.md`
   - `docs/firefox-core-touchpoints.md`
   - `docs/build-tooling.md`
   - `branding/bento/README.md`
   - `scripts/sync-firefox-upstream.sh`
   - `scripts/bento-build.mjs`
   - `scripts/firefox-patch-stack.mjs`
   - `scripts/import.sh`
4. Inspect `git status --short --branch` and preserve unrelated changes.
5. Keep Firefox's configured product and Bento's single-brand model. Do not add
   a second browser brand or copy another project's source or branding.

Treat `engine/` as generated working state. The durable inputs are `bento.json`,
the ordered `patches/series.json` stack, `src/` overlays, `prefs/`, canonical
branding, built-in extensions, and the checked-in build configuration.

## Resolve the target without mutation

If the developer did not name a target, resolve the latest release for the
configured `bento.json.firefox.product` without changing the checkout:

```sh
node .agents/skills/bento-upgrade-firefox/scripts/latest-firefox-version.mjs
```

The helper reads `bento.json` and Mozilla's official
`firefox_versions.json` endpoint. It supports read-only lookup for the
configured Firefox release, beta, ESR, and nightly channels and fails for a
missing or unsupported product or an incomplete response. A failed lookup is a
blocker; do not create a branch or substitute a guessed version. A nightly
lookup does not make the release archive URL or its `SHA256SUMS` procedure
valid for a nightly snapshot.

The maintained `pnpm run firefox:sync` and
`bash scripts/bento-env.sh update` commands select the latest release for the
configured product. They do not accept an exact target through an ignored
`--version` argument. Do not describe that argument as exact targeting or
silently replace a developer's requested version with the latest version. A
source-only `download <version>` can acquire a specifically named archive, but
it is not a complete version upgrade and does not update the canonical
configuration. If an exact target is requested and the current wrapper cannot
select it, report that limitation and preserve the request until an explicit,
protected target procedure is available.

## Record the baseline

Before a source mutation, record the working-tree values for:

- `bento.json.firefox.product`, `version`, `candidate`, `candidateBuild`, and
  `source.sha256`;
- the patch base version, tree, and content tree in `patches/series.json`;
- the Firefox base named in `branding/bento/README.md`;
- the current commit, branch, patch-stack status, and relevant build mode.

Read committed values with `git show HEAD:<path>` when comparing an existing
upgrade, but do not let an older committed value override a coherent
target-aligned working tree. Classify the state as:

1. already current, when the committed and working-tree configuration, patch
   base, branding base, candidate, and baseline gates all agree;
2. a new update, when the working-tree Firefox version differs from the target;
3. an incomplete repair, when the working tree is inconsistent across those
   surfaces;
4. an existing aligned upgrade, when its pending diff is coherent and already
   targets the requested release.

Stop without a branch or PR for an already-current assessment or an
already-current implementation request that does not ask for a rebuild. For a
new update or repair, use a dedicated branch such as
`firefox-<target>-<YYYY-MM-DD>`. Reuse an existing dedicated branch only
when its diff is clearly for this upgrade. An existing aligned upgrade skips
sync, source replacement, and patch rebase phases: inspect its relevant diff
and resume from the first unverified checkpoint gate. A stale committed `HEAD`
alone does not justify sync or rebase.

Run cheap baseline gates before source mutation and record pre-existing
failures separately:

```sh
pnpm install
pnpm run firefox:patches:test
pnpm run firefox:patches:check
pnpm run check:zen-boundary
pnpm run check:product-identity
```

The patch check must validate the recorded base tree/content tree and force-add
upstream-ignored files when reconstructing a source baseline. Do not discard a
failure that predates the upgrade.

## Obtain and verify the source

Before any source mutation, inspect linked worktrees:

```sh
git -C engine worktree list --porcelain
```

Finish or export any patch/rebase work and remove linked worktrees
(`git -C engine worktree remove <worktree>`) before retrying. The driver refuses
to replace an engine with a linked worktree and preserves unknown or dirty user
edits. Successful replacement keeps recoverable source and patch refs under
`.bento/backups/`, carries forward the relevant Bento refs so patch rebase can
recover the old base, and updates `bento.json` and
`config/firefox-versions.json`.

When the target is the version already configured in `bento.json`, use its
recorded `firefox.source.sha256`; do not refetch a digest for an unchanged
source. For a newer release, beta, or ESR target, obtain the matching row from
Mozilla's official per-release `SHA256SUMS` before source mutation. The row must
name `source/firefox-<target>.source.tar.xz`; do not use a digest for an
installer, partial archive, another version, or a nightly snapshot. When
network tools are available, read it directly rather than asking the developer
to copy a value manually:

```sh
target=<target-version>
base=https://archive.mozilla.org/pub/firefox/releases/$target
digest="$(curl -fsSL "$base/SHA256SUMS" | awk '$2 == "source/firefox-'"$target"'.source.tar.xz" { print $1; exit }')"
test "${#digest}" -eq 64
BENTO_SOURCE_SHA256="$digest" pnpm run firefox:sync
```

`BENTO_SOURCE_SHA256` is scoped to this synchronization process. The driver
still verifies the downloaded archive, records the verified digest in
`bento.json.firefox.source.sha256`, and refuses a missing or mismatched digest.
For nightly, use a separately verified Mozilla snapshot procedure that provides
the exact archive and checksum for that snapshot before mutation; do not pass a
nightly version to the per-release `releases/<target>/SHA256SUMS` URL or claim
that a release row verifies it. Do not weaken archive verification or overwrite
`engine/version.txt` as source identity.

For a newer release, beta, or ESR implementation update, run the single
digest-scoped synchronization command above after the worktree preflight. When
the configured source is already current, run the same sync entry point without
refetching its existing digest:

```sh
pnpm run firefox:sync
```

The wrapper obtains the latest configured-product version, invokes Bento's
protected update path, checks the patch stack, builds extensions, imports
Bento, and builds Firefox. It may stop with a stale patch base after source
replacement. Preserve the staged source and rebase the patch stack before
retrying. Do not use direct source replacement or direct Mozilla build-system
commands as a workaround.

## Analyze upstream impact

Compare the verified old Firefox base with the verified target base before
resolving semantic conflicts. Inspect upstream `--name-status`, `--stat`, and
focused diffs for:

- every path named by the ordered patch series;
- Firefox destinations of tracked `src/` overlays;
- canonical branding, mozconfigs, installers, locales, update/MAR files, and
  built-in add-on registration;
- APIs, chrome DOM, actors, SessionStore, DevTools, search, Places, and other
  dependencies recorded in `docs/firefox-core-touchpoints.md`.

Review official Mozilla release notes and security advisories for intent and
risk. Classify the change as a low-risk fast path, targeted review,
feature-impact review, or broad review according to the actual intersections,
patch conflicts, build failures, and runtime evidence. Do not infer safety only
from a clean patch application.

For confirmed feature impact, report the exact upstream change, affected Bento
surface, evidence, security relevance, and applicable choices before changing
user-visible behavior, stored data, or the core patch surface. Mechanical
conflict resolution that preserves behavior can proceed and must still be
reported.

## Rebase the ordered patch stack

Use the Bento patch-stack helper:

```sh
pnpm run firefox:patches:rebase
```

Resolve conflicts in the isolated `.bento/patch-stack-worktree` according to
the patch purpose and touchpoint documentation. Preserve the worktree when a
rebase conflicts; do not remove it or discard edits automatically. After a
successful rebase:

```sh
pnpm run firefox:patches:export
pnpm run firefox:patches:test
pnpm run firefox:patches:check
```

Require the manifest base version/tree and every exported patch to match the
verified target. Compare the old and new patch payloads semantically, ignoring
only generated mail hashes, hunk offsets, diffstat wrapping, and format-patch
footers.

## Reconcile branding and integration

Compare `branding/bento/` with the target Firefox branding layout and preserve
Bento names, URLs, identifiers, colors, icons, and assets. Keep Mozilla MPL
headers and applicable third-party notices. Update the Firefox base recorded in
`branding/bento/README.md` only when the source upgrade is complete.

Use the wrapper for all engine integration:

```sh
pnpm run import
```

It verifies the recorded engine snapshot before reset, imports overlays with
the manifest, installs canonical branding and built-in extensions, applies the
ordered patch stack, appends preferences, and records generated state. A failed
post-mutation step preserves recoverable state for retry. A preflight failure
must leave the prior snapshot and user edits unchanged. Preserve Zen profile
import interoperability and its boundary guard while removing obsolete
references.

Review every affected entry in `docs/firefox-core-touchpoints.md`, including
rollback notes and future regression checks, as `CLAUDE.md` ("What this project
is") requires for every Firefox update.

## Reuse validation checkpoints

The checkpoint lives at `plans/firefox-upgrade-validation.json`, which stays
gitignored (see `CLAUDE.md` "Plan files"). It is valid only for the exact
current source fingerprint:

```sh
node .agents/skills/bento-upgrade-firefox/scripts/validation-checkpoint.mjs status . <target>
node .agents/skills/bento-upgrade-firefox/scripts/validation-checkpoint.mjs has . <target> build package release-build headless-smoke
```

The checkpoint schema is fail-closed. It fingerprints `bento.json`, package
and both lock files, `config/`, `configs/`, patches, overlays, branding,
extensions, preferences, build scripts, `rust-toolchain.toml`, `.nvmrc`, and
the native CI and release workflow inputs. It excludes `plans/` and unrelated
documentation. A source change invalidates every recorded gate.

After each successful gate, record one of `patch-stack`, `static`,
`import-idempotence`, `build`, `package`, `release-build`, `headless-smoke`, or
`final-review`:

```sh
node .agents/skills/bento-upgrade-firefox/scripts/validation-checkpoint.mjs record . <target> build "pnpm run build"
```

## Validate the upgrade

Run the required gates for the affected surfaces:

```sh
pnpm run firefox:patches:test
pnpm run firefox:patches:check
node --test scripts/install-branding.test.mjs scripts/install-builtin-addons.test.mjs
pnpm run check:zen-boundary
pnpm run check:product-identity
pnpm --filter @bento/shell typecheck
pnpm --filter @bento/tools typecheck
pnpm --filter @bento/shell lint
pnpm --filter @bento/tools lint
pnpm run ext:build
pnpm run import
pnpm run build
pnpm run package
pnpm run artifacts:check
```

Verify import idempotence with the repository snapshot helpers:

```sh
node scripts/snapshot-import-output.mjs > /tmp/bento-import-first.sha256
pnpm run import
node scripts/snapshot-import-output.mjs > /tmp/bento-import-second.sha256
cmp /tmp/bento-import-first.sha256 /tmp/bento-import-second.sha256
node scripts/check-import-output.mjs
```

Run `pnpm run build:release` on the current host when the release build is in
scope. Inspect actual application packages, built-in extensions, installer
metadata, locales, channel IDs, MAR contents, and update XML. `pnpm run
artifacts:check` binds the MAR and XML to the packaged application's
`application.ini` `[App] BuildID`, checks the primary application package, and
checks the configured release URL. The application BuildID is authoritative;
`platform.ini` may contain a different build timestamp.

Use GitHub-hosted, non-publishing validation for other operating systems when
available. It must inspect application packages, MAR contents, build IDs,
hashes, sizes, and update asset URLs. Keep public release and signing gates
disabled; `CLAUDE.md` "Versioning policy" owns release rules. Run
`pnpm run release:security-check` for preview artifacts; the public gate remains
blocked until the required signing identities are provisioned.

Run the bundled headless smoke against the built binary:

```sh
bash .agents/skills/bento-upgrade-firefox/scripts/headless-smoke.sh <path-to-built-bento-binary>
```

Require a zero exit and a non-empty PNG. Treat isolated-profile network
diagnostics as warnings only when startup and rendering succeed. Run focused
manual checks for every affected Firefox touchpoint before declaring completion.

## Land the upgrade

Before handoff, inspect the diff and run:

```sh
git diff --check -- . ':(exclude)patches/**/*.patch'
pnpm run firefox:patches:check
```

An implemented upgrade authorizes a dedicated branch, commit, push, and pull
request after validation unless the developer explicitly opts out. Open a
ready PR by default. Use a draft only when a repository workflow explicitly
defers a build or paid validation step, and mark it ready before requesting
review coverage. Do not merge, tag, publish, or enable public release signing;
this skill never grants that authority.

Report the old and new Firefox versions, upstream impact classification,
affected touchpoints, patch conflicts and resolutions, branding/core changes,
validation by platform, and any unverified surface. Preserve checkpoint files,
source backups, and patch worktrees when they contain recoverable state.
