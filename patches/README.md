# patches/

Surgical Firefox patches applied by Surfer for changes that cannot be expressed
via prefs, branding, or bundled extensions.

Patch files are generated from the repo-owned commit stack described by
[`series.json`](./series.json). Keep the files under `patches/**/*.patch`:
Surfer still consumes that compatibility surface directly with `git apply`.

`series.json` is the source of truth for patch identity, subject, base Firefox
version, base tree, and repository patch order. The manifest order must match
Surfer's current `tiny-glob('**/*.patch', { cwd: 'patches' })` order; the helper
checks this instead of relying on a documented folder order.

Patch format: mail-style `git format-patch` output containing `diff --git`
sections. Surfer compatibility is validated by replaying the full manifest
series sequentially on a clean Firefox base with Surfer-equivalent
`git apply --ignore-space-change --ignore-whitespace --verbose` arguments.

Primary commands:

```sh
pnpm run firefox:patches:check
pnpm run firefox:patches:materialize
pnpm run firefox:patches:rebase
pnpm run firefox:patches:export
```

Patches are revalidated for every Firefox version bump
([config/firefox-versions.json](../config/firefox-versions.json)). If the
manifest base version does not match `surfer.json`, `pnpm run import` fails
before mutating `engine/`.

See [docs/firefox-patches.md](../docs/firefox-patches.md) for the full
developer workflow, including adding a new patch and syncing to the latest
upstream Firefox release with `pnpm run firefox:sync`.
