# Maintaining Surfer

Bento Browser is built with a small fork of
[zen-browser/surfer](https://github.com/zen-browser/surfer), hosted at
[Bento-Browser/surfer](https://github.com/Bento-Browser/surfer).

The active Bento pin is in [package.json](../package.json):

```json
"@bento-browser/surfer": "github:Bento-Browser/surfer#0c4bfd6dc8f865e71f789d4377d8ee589e28af84"
```

That commit is based on upstream Surfer `17d9a1577170880cdac13dca7c3d6871716fc046`.

## Ownership Split

Bento product policy stays in this repo:

- [surfer.json](../surfer.json): Bento brand, version, URLs, installer metadata.
- [prefs/bento.js](../prefs/bento.js) and [scripts/append-prefs.sh](../scripts/append-prefs.sh): Bento defaults.
- [scripts/import.sh](../scripts/import.sh): the authoritative Bento import wrapper.
- [scripts/build-release.sh](../scripts/build-release.sh): release-mode install/build/package policy.
- [.pnpmfile.cjs](../.pnpmfile.cjs): local Tale UI links in dev mode, npm pins in `BENTO_RELEASE=1`.
- [extensions/](../extensions): bundled built-in extension selection.
- [docs/firefox-core-touchpoints.md](firefox-core-touchpoints.md): Firefox surfaces Bento modifies or depends on.

The Surfer fork should contain only reusable build-orchestration mechanics:

- Generic brand URL and installer metadata templating.
- Optional `<repo>/extensions/` source copy.
- Runtime-entry filtering for built-in add-ons.
- Repo-local `patches/**/*.patch` import and patch-count consistency.
- Firefox built-in add-on `builtin-addons/` `jar.mn` generation.

## Generated `dist/`

Surfer commits do not track `dist/`. When pnpm installs the GitHub dependency,
the package `prepare` hook runs `npm run build` inside the downloaded Surfer
checkout, generates `dist/`, and links the `surfer` bin. Treat `dist/` as local
install/build output, not source that must be committed.

## Supported Bento Commands

Use Bento wrapper commands from this repo:

- `pnpm run import`: sync theme presets, generate chrome tokens, check/reset the
  Firefox patch stack, run `surfer import`, append prefs, and sync built-in
  add-on symlinks.
- `pnpm run build`: build bundled extensions, run the import wrapper, run
  `surfer build`, then sync built-in add-on symlinks.
- `pnpm run build:full`: download, bootstrap, build extensions, run the import
  wrapper, build, and package.
- `pnpm run build:release`: install with `BENTO_RELEASE=1`, build extensions,
  run the import wrapper, switch Surfer build mode to release, build, package,
  collect artifacts, then restore dev-mode dependencies.

Direct `surfer import` or `bash scripts/surfer-env.sh import` bypasses Bento's
theme, patch-stack, prefs, and built-in add-on symlink steps. Use it only while
debugging Surfer itself, then rerun `pnpm run import` before treating the engine
state as valid.

## Current Fork Inventory

The current Bento pin contains these fork commits on top of upstream
`17d9a15`:

| Commit    | Classification                        | Reason                                                                                            |
| --------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `8e87a8a` | Upstream candidate                    | Templates brand URLs and installer metadata from brand config while preserving upstream defaults. |
| `d32a343` | Upstream candidate if configurable    | Adds top-level extension source discovery/copy.                                                   |
| `506d05f` | Required while extensions are bundled | Filters copied extensions to runtime entries instead of source/dev files.                         |
| `7d14a8b` | Upstream candidate                    | Scans repo-local `patches/**/*.patch` during import.                                              |
| `a79620b` | Cleanup                               | Removes duplicate import from the fork patch stack.                                               |
| `39ad914` | Upstream candidate                    | Counts repo-local patches in patch-check to match import.                                         |
| `076d922` | Upstream candidate if generalized     | Emits `jar.mn` entries under Firefox `builtin-addons/`.                                           |
| `6818b4a` | Upstream candidate                    | Fixes duplicated path segments in generated `jar.mn`.                                             |
| `0c4bfd6` | Required while uBlock ships           | Supports per-extension `.bento-runtime-entries.json` lists for large packaged add-ons.            |

Runtime-entry support must stay until Bento removes bundled uBlock Origin or
Surfer has an equivalent generic config.

## Editing The Fork

The local clone lives at `/Users/admin/Projects/surfer` with:

- `origin`: `Bento-Browser/surfer`
- `upstream`: `zen-browser/surfer`

Typical workflow:

```sh
cd /Users/admin/Projects/surfer
git fetch origin --prune
git fetch upstream --prune
git switch -c bento/<topic> origin/main
git rebase upstream/main
# edit src/...
npm run build
git commit
git push -u origin bento/<topic>
git rev-parse HEAD
```

Then update Bento:

```sh
cd /Users/admin/Projects/bento-browser
# replace the SHA in package.json and pnpm-lock.yaml
BENTO_RELEASE=1 pnpm install --no-frozen-lockfile
pnpm install --no-frozen-lockfile
pnpm exec surfer --version
pnpm run import
```

Keep lockfile diffs focused on the Surfer SHA unless a real dependency change is
intended.

## Extension Copy Behavior

The fork scans `<repo>/extensions/` for top-level folders with `manifest.json`.
Folders starting with `_` and folders without a manifest are skipped.

For each extension, Surfer:

1. Reads the Gecko add-on id from `applications.gecko.id` or
   `browser_specific_settings.gecko.id`.
2. Removes any prior `engine/browser/extensions/<name>/` copy.
3. Copies only runtime entries.
4. Generates `jar.mn` mapping files into `builtin-addons/<name>/`.
5. Generates a per-extension `moz.build` that references the JAR manifest.
6. Appends the extension directory to `engine/browser/extensions/moz.build`.

Default runtime entries are `manifest.json`, `chrome.manifest`, `dist`,
`experiments`, `icons`, `_locales`, `background.html`, `background.js`,
`options.html`, and `popup.html`.

An extension can provide `.bento-runtime-entries.json` as a JSON string array to
replace that default list. Surfer always adds `manifest.json`. Bento uses this
for [extensions/ublock-origin/](../extensions/ublock-origin/) so uBlock Origin's
`js/`, `css/`, `lib/`, `assets/`, locale, and HTML runtime files ship without
copying unrelated source metadata.

## Upstreaming Order

Keep upstream PRs small and generic:

1. Brand URL templating.
2. Installer metadata templating.
3. Configurable patch import/check consistency.
4. Optional built-in extension source copy.
5. Runtime-entry config and deterministic built-in add-on packaging.

After each accepted upstream PR: rebase the Bento fork, drop the matching fork
commit, run `npm run build` in Surfer, bump Bento's SHA, run Bento verification,
and update this document.

If upstream rejects a change, keep the minimal fork commit and document why it
remains fork-only.

## Branding Regeneration

Surfer skips branding apply when its image hashes match `.surfer/hashes.json`
and `engine/browser/branding/<brand>/` already exists. Editing `surfer.json`
alone does not bust those signals.

Run:

```sh
pnpm run brand:regen
pnpm run build:ui
pnpm exec surfer run
```

`brand:regen` clears the branding cache and then runs `pnpm run import`, so the
same wrapper semantics apply.
