# Implementing Firefox Patches

This guide covers two workflows:

- adding or changing one Bento patch against Firefox core;
- syncing Bento to a newer upstream Firefox release.

Bento uses Surfer to download Firefox, copy Bento source into `engine/`, apply
`patches/**/*.patch`, and build the browser. Treat `engine/` as generated
working state. The durable Firefox patch source is the commit stack described by
[`patches/series.json`](../patches/series.json), exported back to
`patches/**/*.patch` for Surfer compatibility.

## Rules

1. Prefer `extensions/bento-shell`, `extensions/bento-tools`, or an existing
   `bentoChrome.*` bridge API before editing Firefox core.
2. Keep every Firefox patch small, single-purpose, and independently removable.
3. Keep patch files under the narrowest folder:
   - `patches/core-ui/` for browser UI behavior and native chrome changes;
   - `patches/chrome-layout/` for browser window structure and panel hosts;
   - `patches/window-sync/` for Firefox window/tab state synchronization;
   - `patches/experiments/` for temporary or high-risk build/runtime patches.
4. Update [firefox-core-touchpoints.md](firefox-core-touchpoints.md) in the same
   change whenever a patch changes Firefox core behavior, depends on Firefox
   internals, changes prefs, or changes build/branding integration.
5. Do not land an upstream Firefox sync until all patch conflicts, build
   failures, and touchpoint regression checks have been addressed.

## Patch Stack Commands

```sh
pnpm run firefox:patches:check
pnpm run firefox:patches:materialize
pnpm run firefox:patches:rebase
pnpm run firefox:patches:export
pnpm run firefox:patches:test
```

`check` validates `patches/series.json`, confirms there are no unmanaged
`src/**/*.patch` files, confirms manifest order matches Surfer's repo patch
scan order, and replays the full series sequentially on a clean Firefox base
using Surfer-equivalent `git apply` arguments.

`materialize` creates or resets `bento/patch-stack` from the manifest base and
applies each patch as one commit. It uses isolated worktrees under `.surfer/` so
the live generated `engine/` checkout is not reset.

`rebase` materializes the stack from the old manifest base, rebases it onto the
Firefox version in `surfer.json`, and exports the result when the rebase
finishes cleanly. It does not run automatically during `firefox:sync`.

`export` writes each `bento/patch-stack` commit back to the existing manifest
path with `git format-patch`, updates `series.json` base metadata, and replays
the exported series sequentially for Surfer compatibility.

## Add Or Change A Patch

1. Materialize the stack:

   ```sh
   pnpm run firefox:patches:materialize
   ```

2. Create a worktree from the materialized branch and edit there:

   ```sh
   git -C engine worktree add ../.surfer/patch-stack-worktree bento/patch-stack
   ```

   Keep one logical Firefox change per commit.

3. Commit the change in that worktree:

   ```sh
   git -C .surfer/patch-stack-worktree status
   git -C .surfer/patch-stack-worktree add <files>
   git -C .surfer/patch-stack-worktree commit
   ```

4. If adding or removing a patch commit, update `patches/series.json` so
   `series` still matches the patch paths and intended order. For a new patch
   entry, create an empty placeholder at the intended
   `patches/<area>/<number>-name.patch` path before running export; export will
   replace it with `git format-patch` output.

5. Export and validate:

   ```sh
   pnpm run firefox:patches:export
   pnpm run firefox:patches:check
   pnpm run import
   pnpm run build
   ```

6. Remove the temporary stack worktree if you created one:

   ```sh
   git -C engine worktree remove ../.surfer/patch-stack-worktree
   ```

7. Update [firefox-core-touchpoints.md](firefox-core-touchpoints.md) with:
   - files or patches touched;
   - Bento functionality enabled by the change;
   - vanilla Firefox surface touched or depended on;
   - why the change cannot stay extension-only;
   - Firefox update risk;
   - future regression checks;
   - rollback or migration notes.

Do not edit generated `engine/` state and stop there. Always export to
`patches/**/*.patch`, re-import, and build.

## One-Command Upstream Sync

Use this when the goal is to bring in the latest Firefox release and security
patches known to Surfer:

```sh
pnpm run firefox:sync
```

The command runs [scripts/sync-firefox-upstream.sh](../scripts/sync-firefox-upstream.sh).
It performs this sequence:

1. asks Mozilla for the latest Firefox release;
2. updates `engine/` through Surfer when a newer version exists;
3. updates `surfer.json` and `config/firefox-versions.json`;
4. runs `node scripts/firefox-patch-stack.mjs check --for-import`;
5. builds Bento's privileged extensions;
6. runs `pnpm run import`;
7. runs a Firefox build.

If the patch stack base does not match the target Firefox version, the command
exits before extension build or import. It prints the current patch base, target
Firefox version, and the rebase commands to run.

## Resolve Upstream Sync Failures

1. Start the sync:

   ```sh
   pnpm run firefox:sync
   ```

2. If it reports a stale patch base, rebase the stack:

   ```sh
   pnpm run firefox:patches:rebase
   ```

3. If the rebase stops on conflicts, resolve files in the path printed by the
   helper, then continue:

   ```sh
   git -C <printed-worktree> status
   git -C <printed-worktree> add <files>
   git -C <printed-worktree> rebase --continue
   ```

4. Export, import, and build:

   ```sh
   pnpm run firefox:patches:export
   pnpm run import
   pnpm run build
   ```

Work remaining failures in this order:

1. **Download/update failure**: rerun `pnpm run firefox:sync` after confirming
   Mozilla has a source tarball for the release Surfer selected.
2. **Patch rebase or replay failure**: inspect the failing commit and upstream
   Firefox file, update the stack, export, and rerun `pnpm run import`.
3. **Build failure**: fix API, build-system, localization, actor registration,
   or pref/schema drift; rerun `pnpm run build`.
4. **Runtime regression**: use the relevant touchpoint checks in
   [firefox-core-touchpoints.md](firefox-core-touchpoints.md); fix the patch or
   remove it if upstream Firefox now provides the behavior directly.

When a patch becomes unnecessary, remove its commit from `bento/patch-stack`,
remove the matching manifest entry, run `pnpm run firefox:patches:export`,
`pnpm run import`, and `pnpm run build`, then update the touchpoint docs.

## Landing Checklist

Before landing a Firefox patch or upstream sync:

1. `pnpm run firefox:patches:check` succeeds.
2. `pnpm run import` succeeds.
3. `pnpm run build` or `pnpm run firefox:sync` succeeds.
4. `config/firefox-versions.json` matches `surfer.json` after an upstream sync.
5. [firefox-core-touchpoints.md](firefox-core-touchpoints.md) is current.
6. All regression checks listed for affected touchpoints have passed.
