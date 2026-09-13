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
- `validate-bento-artifacts.mjs` — verifies the packaged application, MAR
  contents, MAR digest and size, browser update XML, and artifact metadata.
  Run it with `pnpm run artifacts:check`; release builds run it before
  collecting `release-out/`.
- `firefox-patch-stack.mjs` — manages the repo-owned Firefox patch commit
  stack:
  - `pnpm run firefox:patches:check` validates `patches/series.json` and
    sequential `git apply` replay;
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
