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
- `archive-members.mjs` — checks a tar extraction against the archive listing and
  extracts members the tar left out once more. The build driver and
  `firefox-patch-stack.mjs` use it because Git Bash's tar drops `X.exe` when `X`
  follows it; see `docs/build-tooling.md`.
- `build-mode.mjs` — the one build-mode resolver: explicit mode, then
  `BENTO_RELEASE=1` (release), then `BENTO_BUILD_MODE`, then `bento.json`
  `build.mode`. The build driver's mozconfig, the shell background build, the
  add-on installer, the package guard, and the `MUXUI_LOCAL` guard all use it.
- `dev-reload.mjs` — strips and detects the shell's dev-only `dev-reload`
  command (Alt+Shift+R). The add-on installer drops it from release manifests,
  `pnpm run release:security-check:shell` fails if a release shell still has it,
  and a release `package` refuses an object directory whose shell add-on has it;
  see `docs/build-tooling.md`.
- `validate-bento-artifacts.mjs` — verifies the packaged application and artifact
  metadata and, while the updater is enabled, the MAR contents, MAR digest and
  size, and browser update XML. With the updater disabled (`bento.json`
  `updates.enabled`, the default) it expects no MAR or update metadata and fails
  if any exists. Run it with `pnpm run artifacts:check`; release builds run it
  before collecting `release-out/`.
- `update-readiness.mjs` — the inputs `config/release-security.json` must record
  before `updates.enabled` may be `true`, and the readers of the updater state a
  mozconfig and an object directory configure; shared by `check-release-security.mjs`,
  `bento-build.mjs` and `validate-bento-artifacts.mjs`. See `docs/build-tooling.md`,
  "Updater".
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
  Replaces a local engine that is older than `bento.json` through the protected
  path. Equivalent to `pnpm run firefox:sync`.

## Other scripts, by purpose

- Import pipeline (run by `pnpm run import`): `import.sh`, `import-sources.mjs`,
  `install-branding.mjs`, `install-builtin-addons.mjs`, `append-prefs.sh`,
  `reset-engine-patches.sh`, `snapshot-import-output.mjs`, `regen-branding.sh`.
- Local dev loop: `dev-launch.sh`, `dev-profile-clean.sh`, `sync-shell.sh`,
  `sync-builtin-addon-symlinks.sh`; `mach-env.sh` and `mach-raw.sh` run `mach`
  with the Python chosen by `BENTO_MACH_PYTHON` (see `docs/build-tooling.md`).
- Extension and theme builds: `build-extension-background.mjs`,
  `sync-theme-presets.mjs`, `import-theme.mjs`, `generate-chrome-tokens.mjs`,
  `mux-css.mjs`, `theme-selector.mjs`, `generate-native-preferences-protocol.mjs`;
  `muxui-source.mjs` and `muxui-regenerator.mjs` support `muxui-dev.mjs`.
- Checks (CLAUDE.md lists which ones CI runs): `check-security-invariants.mjs` (with
  `ci-build-guard.mjs`, which keeps native builds out of workflows and actions),
  `check-release-security.mjs`,
  `check-import-output.mjs`, `check-size-budgets.mjs` with `size-ratchet.mjs`,
  the competitor-reference boundary check, `check-firefox-compat.mjs` with
  `firefox-compat-registry.mjs`, `check-chrome-resize-guard.mjs`,
  `check-legacy-aliases.mjs` with `legacy-aliases.mjs`,
  `check-product-identity.mjs`, `check-rust-toolchain.mjs`.
- Release and rollback: `build-release.sh`, `generate-release-sbom.mjs`,
  `generate-release-metadata.mjs`,
  `build-rollback-variant.mjs` with `rollback-variants.mjs`
  (`pnpm run rollback:check` runs its read-only checks).
