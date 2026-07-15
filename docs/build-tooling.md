# Firefox build tooling

Bento pins the exact npm release `@zen-browser/surfer@1.14.6` as replaceable,
build-time infrastructure. It is not part of Bento's runtime, branding, product
identity, or ancestry, and no generated branding or tool source ships in Bento.

Surfer remains responsible for generic Firefox orchestration:

- downloading and updating the configured Firefox source;
- bootstrapping Mozilla build dependencies;
- source-overlay import;
- builds, runs, packages, locales, and MAR/update generation;
- license checking.

All Bento-specific import behavior belongs in this repository. The authoritative
wrapper, [scripts/import.sh](../scripts/import.sh), disables Surfer branding
generation, installs [branding/bento](../branding/bento), packages the built-in
extensions, and applies [patches/series.json](../patches/series.json) in manifest
order. Bento scripts do not import Surfer modules.

## Supported commands

- `pnpm run import`: run the complete Bento import wrapper.
- `pnpm run build`: build extensions, import Bento sources, and compile Firefox.
- `pnpm run build:full`: download, bootstrap, build, and package.
- `pnpm run build:release`: create a host-platform release-mode package.
- `pnpm run brand:regen`: reinstall canonical tracked branding through the
  normal import pipeline.

Direct `surfer import` bypasses Bento's branding, add-on, patch, preference, and
symlink steps. Use `pnpm run import` whenever the resulting engine state matters.

## Upgrading Surfer

No Surfer update is auto-merged. Do not create another Bento-maintained fork.
Review the upstream release, then upgrade the immutable exact pin:

```sh
pnpm up --save-exact @zen-browser/surfer@<version>
pnpm exec surfer --version
pnpm run import
pnpm run build
pnpm run build:release
```

The upgrade is acceptable only after branding, built-in add-ons, manifest patch
application, packaging, locales, installers, and MAR/update output have been
checked. Run the source and artifact identity scanners as part of that review.

## Built-in add-ons

[scripts/install-builtin-addons.mjs](../scripts/install-builtin-addons.mjs)
discovers top-level extension directories with a Gecko add-on ID, copies only
their declared runtime entries, generates deterministic `jar.mn` and `moz.build`
files, and registers one marker block in Firefox's `browser/extensions/moz.build`.
An extension may replace the default runtime list with a safe top-level string
array in `.bento-runtime-entries.json`; `manifest.json` is always included.

## Branding and patches

[branding/bento](../branding/bento) is based on Mozilla Firefox's unofficial
branding layout plus Bento-owned metadata and visual assets. Surfer's branding
generator is disabled. Firefox upgrades must compare the canonical tree with the
new upstream branding layout.

[patches/series.json](../patches/series.json) is the sole source of Firefox patch
order. `pnpm run firefox:patches:apply` applies it to the live engine without
committing. The import wrapper resets prior applications before replaying it.
