# Implementing Firefox Patches

This guide covers two related workflows:

- adding or changing one Bento patch against Firefox core;
- syncing Bento to the latest upstream Firefox release and security patches.

Bento uses Surfer to download Firefox, copy Bento source into `engine/`, apply
`patches/**/*.patch`, and build the browser. Treat `engine/` as generated
working state. The durable Bento patch source is `patches/`, plus any matching
files under `src/`, `prefs/`, `configs/`, and `surfer.json`.

## Rules

1. Prefer `extensions/bento-shell`, `extensions/bento-tools`, or an existing
   `bentoChrome.*` bridge API before editing Firefox core.
2. Keep every Firefox patch small, single-purpose, and independently removable.
3. Put the patch in the narrowest folder:
   - `patches/core-ui/` for browser UI behavior and native chrome changes;
   - `patches/chrome-layout/` for browser window structure and panel hosts;
   - `patches/window-sync/` for Firefox window/tab state synchronization;
   - `patches/experiments/` for temporary or high-risk build/runtime patches.
4. Update [firefox-core-touchpoints.md](firefox-core-touchpoints.md) in the same
   change whenever a patch changes Firefox core behavior, depends on Firefox
   internals, changes prefs, or changes build/branding integration.
5. Do not land an upstream Firefox sync until all patch conflicts, build
   failures, and touchpoint regression checks have been addressed.

## One-Command Upstream Sync

Use this when the goal is to bring in the latest Firefox release and security
patches known to Surfer:

```sh
pnpm run firefox:sync
```

The command runs [scripts/sync-firefox-upstream.sh](../scripts/sync-firefox-upstream.sh).
It performs this sequence:

1. asks Surfer for Mozilla's latest Firefox release;
2. replaces `engine/` with that Firefox source when a newer version exists;
3. updates `surfer.json` through Surfer and syncs
   `config/firefox-versions.json`;
4. builds Bento's privileged extensions;
5. runs `pnpm run import`, which resets currently patched engine files,
   regenerates chrome tokens, applies Bento source and patches, appends prefs,
   and syncs built-in addon links;
6. runs a Firefox build.

If this command finishes successfully, the Firefox source compiles with Bento's
patch stack applied. That is necessary but not sufficient for landing: run the
manual regression checks listed in [firefox-core-touchpoints.md](firefox-core-touchpoints.md)
for every active touchpoint affected by upstream changes.

If the command fails, treat the failure as the upstream sync queue. Fix the
first failing patch, import, build, or runtime regression before moving on.

## Add A New Patch

1. Start from a clean imported engine:

   ```sh
   pnpm run import
   ```

2. Identify the smallest Firefox surface that must change. Prefer editing the
   matching file under `src/` when Bento already owns that copied source file.
   Edit `engine/` only when the target is vanilla Firefox source that must be
   represented as a patch.

3. Make the minimal change in `engine/`.

4. Build or run the narrowest useful check. Examples:

   ```sh
   pnpm run mach:build
   node --check src/browser/base/content/bento-shell-mount.js
   ```

5. Export the changed Firefox file to a Bento patch:

   ```sh
   git -C engine diff \
     --src-prefix=a/ \
     --dst-prefix=b/ \
     --full-index \
     -- path/from/engine/root \
     > patches/<area>/<number>-short-name.patch
   ```

   Use a path relative to `engine/`, for example
   `browser/base/content/browser.xhtml`. Keep one logical Firefox change per
   patch file. Surfer's generic `export-file` command writes patches under
   `src/`; do not use that as the final location for Bento's canonical
   `patches/` stack.

6. Re-import from the patch file, not from the edited engine state:

   ```sh
   pnpm run import
   ```

   `pnpm run import` calls [reset-engine-patches.sh](../scripts/reset-engine-patches.sh),
   which resets files touched by existing patches before Surfer re-applies the
   patch stack. This catches stale patch context and files accidentally left
   only in `engine/`.

7. Run the full build for Firefox core changes:

   ```sh
   pnpm run build
   ```

8. Update [firefox-core-touchpoints.md](firefox-core-touchpoints.md) with:
   - files or patches touched;
   - Bento functionality enabled by the change;
   - vanilla Firefox surface touched or depended on;
   - why the change cannot stay extension-only;
   - Firefox update risk;
   - future regression checks;
   - rollback or migration notes.

9. Check the final diff. The durable change should include the patch file,
   touchpoint docs, and any required Bento source/docs changes. Do not commit
   generated `engine/` churn unless the repo already tracks that exact file as
   durable Bento source.

## Change An Existing Patch

1. Edit the target Firefox file in `engine/`.
2. Regenerate or manually update the existing `.patch` file.
3. Run:

   ```sh
   pnpm run import
   pnpm run build
   ```

4. Update [firefox-core-touchpoints.md](firefox-core-touchpoints.md) if the
   touched surface, risk, behavior, or regression checks changed.

Do not rely on an already-patched `engine/` file as proof that the patch still
applies. Always re-import after changing a patch file.

## Resolve Upstream Sync Failures

Work failures in this order:

1. **Download/update failure**: rerun `pnpm run firefox:sync` after confirming
   Mozilla has a source tarball for the release Surfer selected. If Surfer
   selected a bad version, update the Surfer fork or pin `surfer.json` back to a
   known-good Firefox version before continuing.
2. **Patch apply failure**: inspect the rejected patch and the upstream Firefox
   file in `engine/`; update the patch to the new upstream structure; rerun
   `pnpm run import`.
3. **Build failure**: fix API, build-system, localization, actor registration,
   or pref/schema drift; rerun `pnpm run build`.
4. **Runtime regression**: use the relevant touchpoint checks in
   [firefox-core-touchpoints.md](firefox-core-touchpoints.md); fix the patch or
   remove it if upstream Firefox now provides the behavior directly.

When a patch becomes unnecessary, remove it from `patches/`, run
`pnpm run import && pnpm run build`, and mark the touchpoint as removed or
update the rollback notes.

## Landing Checklist

Before landing a Firefox patch or upstream sync:

1. `pnpm run import` succeeds.
2. `pnpm run build` or `pnpm run firefox:sync` succeeds.
3. `config/firefox-versions.json` matches `surfer.json` after an upstream sync.
4. [firefox-core-touchpoints.md](firefox-core-touchpoints.md) is current.
5. All regression checks listed for affected touchpoints have passed.
6. Each patch remains small, named, and independently skippable.
