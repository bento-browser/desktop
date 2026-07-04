# scripts/

Build, packaging, and release helper scripts.

- `build-bento.sh` — runs the full supported Bento pipeline (download →
  bootstrap → extension build → `pnpm run import` → build → package).
  Equivalent to `pnpm run build:full`.
- `firefox-patch-stack.mjs` — manages the repo-owned Firefox patch commit
  stack:
  - `pnpm run firefox:patches:check` validates `patches/series.json`, Surfer
    patch order, and sequential `git apply` replay;
  - `pnpm run firefox:patches:materialize` recreates `bento/patch-stack` from
    the manifest;
  - `pnpm run firefox:patches:rebase` rebases the stack to the Firefox version
    in `surfer.json`;
  - `pnpm run firefox:patches:export` writes the stack back to
    `patches/**/*.patch`;
  - `pnpm run firefox:patches:test` runs the helper's fixture tests.
- `sync-firefox-upstream.sh` — updates the Firefox engine to Mozilla's latest
  release known to Surfer, syncs version metadata, checks that the patch stack
  base is current, imports Bento patches, and runs a build. Equivalent to
  `pnpm run firefox:sync`.

Future additions: release-channel scripts, version bump helpers, signing/notarization wrappers.
