# Maintaining Surfer (the build orchestrator fork)

Bento Browser's build is driven by a fork of [zen-browser/surfer](https://github.com/zen-browser/surfer),
hosted at [Bento-Browser/surfer](https://github.com/Bento-Browser/surfer) on
`main`.

## Why the fork exists

Upstream Surfer hardcodes `zen-browser.app` URLs and Mozilla Corporation
certificate values into the generated branding artifacts (`firefox-branding.js`,
`branding.nsi`). The fork extends each brand entry in `surfer.json` with
optional `urls` and `installer` blocks, then templates those strings into the
generated files so Bento's `bentobrowser.app` URLs ship instead.

Defaults in the fork still resolve to upstream's `zen-browser.app` values,
so the patch is upstream-friendly — it could be PR'd back to
`zen-browser/surfer` without breaking Zen.

## How it's wired in

[package.json](../package.json) pins the fork by github SHA:

```json
"@bento-browser/surfer": "github:Bento-Browser/surfer#<sha>"
```

`npm install` clones the repo at that SHA, runs the `prepare` hook
(`npm run build`) inside it to produce `dist/`, and links the `surfer` bin.

## Editing the fork

The local clone lives outside this repo at `/Users/admin/Projects/surfer`,
with two remotes:

- `origin` → `Bento-Browser/surfer` (the fork)
- `upstream` → `zen-browser/surfer` (the source)

Edit → build → commit → push → bump SHA:

```sh
cd /Users/admin/Projects/surfer
# edit src/...
npm run build              # tsc -> dist/
git commit -am "..."
git push origin main
git rev-parse HEAD         # copy SHA

cd /Users/admin/Projects/bento-browser
# replace the SHA in package.json's @bento-browser/surfer line
npm install                # re-clones at new SHA, rebuilds dist/
```

## Pulling upstream Zen changes

```sh
cd /Users/admin/Projects/surfer
git fetch upstream
git checkout main
git rebase upstream/main
# Resolve conflicts. The Bento patch touches:
#   - src/utils/config.ts
#   - src/commands/patches/branding-patch.ts
npm run build
git push --force-with-lease origin main
# Then bump the SHA in bento-browser/package.json as above.
```

## Adding a new templated brand field

When a new hardcoded string surfaces in upstream branding code:

1. In the fork's `src/utils/config.ts`, extend `BrandUrls` or `BrandInstaller`
   (or add a new interface) and add a default to `defaultBrandUrls` /
   `defaultBrandInstaller` so existing surfer.json files keep working.
2. In `src/commands/patches/branding-patch.ts`, replace the literal with
   `${u.<field>}` (urls) or `${inst.<field>}` (installer). Update the
   parameter type for `configureBrandingNsis` / `configureProfileBranding`
   if you added a new block.
3. Build, commit, push, bump the SHA in [package.json](../package.json),
   reinstall.
4. Set the new field under `brands.bento.urls` (or `.installer`) in
   [surfer.json](../surfer.json).
5. `npm run brand:regen && npm run build:ui` to verify the value lands in
   `engine/browser/branding/bento/`.

## How extensions get bundled (the `extensions-copy` step)

Upstream Surfer only copies `<repo>/src/` into the engine — it has no concept
of an `<repo>/extensions/` folder. The Bento fork adds a patch step that runs
between `importFolders` and `importGitPatch` in
[src/commands/patches/command.ts](https://github.com/Bento-Browser/surfer/blob/main/src/commands/patches/command.ts):

1. Scans `<repo>/extensions/` for top-level folders.
2. Skips folders whose names start with `_` (e.g. `_shared` shared TS sources).
3. Skips folders without a `manifest.json`.
4. Reads each remaining folder's `manifest.json` `applications.gecko.id`
   (or `browser_specific_settings.gecko.id`); skips with a warning if absent.
5. Wipes `engine/browser/extensions/<name>/`, copies the folder in,
   generates `moz.build` mirroring the addon-mozbuild format
   (`FINAL_TARGET_FILES.features["<gecko-id>"]...`).
6. Appends `DIRS += [...]` to `engine/browser/extensions/moz.build` after
   discarding any prior changes (so the line is rewritten on every build).

For a folder under `extensions/` to ship as a built-in extension, it must:

- Have a top-level `manifest.json` with `applications.gecko.id` (or the MV3
  equivalent `browser_specific_settings.gecko.id`).
- Have its built artifacts present at copy time — Surfer copies whatever is
  on disk, so run the extension's own build (`pnpm --filter @bento/shell build`)
  before `surfer build` if the extension is JS-bundled.

See [src/commands/patches/extensions-copy.ts](https://github.com/Bento-Browser/surfer/blob/main/src/commands/patches/extensions-copy.ts)
in the fork.

## `brand:regen` — when and why

Surfer skips the branding apply step when *all three* of these are true:

1. SHA1(`configs/branding/<brand>/logo.png`) matches `.surfer/hashes.json`
2. SHA1(`configs/branding/<brand>/MacOSInstaller.svg`) matches the stored hash
3. `engine/browser/branding/<brand>/` exists

Editing `surfer.json` (colors, strings, URLs, version) doesn't bust any of
those signals — so the old generated files stay in `engine/` and the next
build silently uses stale values.

[scripts/regen-branding.sh](../scripts/regen-branding.sh) (npm script:
`brand:regen`) wipes `engine/browser/branding/<brand>/` and
`.surfer/hashes.json`, then runs `npx surfer import` to re-apply. Run it
after changing:

- `surfer.json` `brands.<brand>.{backgroundColor, brand*Name, urls, installer, release.displayVersion}`
- Any file in `configs/branding/<brand>/`

Then:

```sh
npm run brand:regen
npm run build:ui     # picks up the regenerated branding
npx surfer run       # launch
```
