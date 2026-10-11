# scripts/

Build, packaging, and release helper scripts.

- `build-bento.sh` — runs the full supported Bento pipeline (download →
  bootstrap → extension build → `pnpm run import` → build → package).
  Equivalent to `pnpm run build:full`.
- `bento-env.sh` and `bento-build.mjs` — the Bento-owned build driver around
  Mozilla's `mach` entry point. It provides `download`, `update`, `bootstrap`,
  `build`, `package`, `updates-browser`, `updates-addons`, `license-check`,
  `verify`, and `record` commands. `bento.json` is the canonical configuration;
  source archives are cached under `.bento/cache/source/`, with source state in
  `.bento/source-state.json` and overlay state in `.bento/import-manifest.json`.
- `bento-build.mjs objdir` — prints the one Firefox object directory mach builds
  into: the `MOZ_OBJDIR` in `engine/mozconfig`, `engine/obj-bento` unless
  `BENTO_OBJDIR=obj-<name>` chose another name at generation. It fails when that
  directory does not exist (`--allow-missing` prints nothing instead).
  `--allow-legacy` also accepts a single old `engine/obj-*` build, announced on
  stderr, and errors on several. `dev-launch.sh`, `sync-shell.sh` and
  `sync-builtin-addon-symlinks.sh` pass `--allow-legacy`; `build-release.sh`,
  `package` and `updates-browser` do not.
- `write-if-changed.mjs` — helpers the build driver and the add-on and branding
  installers use to leave unchanged files, and their mtimes, alone.
- `validate-bento-artifacts.mjs` — verifies the packaged application and artifact
  metadata and, while the updater is enabled, the MAR contents, MAR digest and
  size, and browser update XML. With the updater disabled (`bento.json`
  `updates.enabled`, the default) it expects no MAR or update metadata and fails
  if any exists. Run it with `pnpm run artifacts:check`; release builds run it
  before collecting `release-out/`.
- `update-readiness.mjs` — the inputs `config/release-security.json` must record
  before `updates.enabled` may be `true`; shared by `check-release-security.mjs`
  and `bento-build.mjs`. See `docs/build-tooling.md`, "Updater".
- `muxui-dev.mjs` — local Mux UI dev loops (`pnpm run shell:ladle:mux`,
  `shell:dev:mux`, `shell:import:mux`); see `docs/build-tooling.md`.
- `firefox-patch-stack.mjs` — manages the repo-owned Firefox patch commit
  stack:
  - `pnpm run firefox:patches:check` validates `patches/series.json` and
    replays the series in a scratch Git index (`git read-tree` plus
    `git apply --cached`, no worktree, whitespace and line-ending settings pinned
    with `git -c`), skipping the replay while `patches/**`, the base commit and
    those settings match the last pass recorded in `.bento/patch-check.json`;
    `--force` replays anyway;
  - `pnpm run firefox:patches:apply` applies the manifest to the live engine in
    its declared order without committing;
  - `pnpm run firefox:patches:materialize` recreates `bento/patch-stack` from
    the manifest;
  - `pnpm run firefox:patches:rebase` rebases the stack to the Firefox version
    in `bento.json`;
  - `pnpm run firefox:patches:export` writes the stack back to
    `patches/**/*.patch`;
  - `pnpm run firefox:patches:test` runs the helper's fixture tests.
- `sync-firefox-upstream.sh` — updates the Firefox engine to Mozilla's latest
  release, syncs `bento.json` and `config/firefox-versions.json`, checks that
  the patch stack base is current, imports Bento patches, and runs a build.
  Equivalent to `pnpm run firefox:sync`.

Future additions: release-channel scripts, version bump helpers, signing/notarization wrappers.
