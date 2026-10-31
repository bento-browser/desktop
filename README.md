# Bento Browser

An independent browser derived from Mozilla Firefox, with a Bento-maintained UI
and privileged extensions built around workspaces and side-by-side panels.
Bento tracks upstream Firefox releases while keeping its product code and
identity in this repository.

See [docs/core-functionality.md](docs/core-functionality.md) for the
product-facing core functionality model and
[docs/core-functionality-technical.md](docs/core-functionality-technical.md)
for the implementation map.

## Status

Pre-v0.1.0 development. Pull requests receive automatic source-import and
static checks. CI builds no application packages: Bento currently targets macOS
only, and application builds run locally on the maintainer's Mac. Stable public
distribution is not enabled yet.

## Prerequisites

- Node.js 24.19.0 (`nvm use` reads `.nvmrc`)
- Mux UI React is installed from npm as the exact published version
  `@muxui/react@0.1.0-rc.4`. The frozen lockfile records its registry
  integrity. No local Mux archive is required.
- Mozilla build prerequisites — installed by `pnpm run bootstrap` (calls
  `mach bootstrap` under the hood). Expect Python 3, Rust, clang, and several
  GB of disk space.
- ~30 GB free disk for the Firefox source tree and build artifacts.

### macOS extras

Bento's source downloader tries `gtar` first and falls back to the system
`tar`. If the system tar cannot unpack the Firefox `.tar.xz` archive, install
GNU tar and xz before running `pnpm run download`:

```sh
brew install gnu-tar xz
```

## Common commands

```sh
pnpm install           # install the pinned build and extension dependencies
pnpm run download      # fetch Firefox source (version configured in bento.json)
pnpm run bootstrap     # install Mozilla build deps via mach
pnpm run build         # compile Bento Browser
pnpm run build:ui      # incremental Firefox UI build
pnpm run package       # produce platform packages/installers (MAR and update XML only if the updater is enabled)
pnpm run artifacts:check # verify package outputs (and MAR and update XML if the updater is enabled)
pnpm run build:release # release gate, then a release-mode artifact, SBOM, and checksums for the host platform
pnpm run lc             # Bento source license check
pnpm run build:full    # download → bootstrap → build → package
pnpm run brand:regen   # reinstall tracked branding/bento into the Firefox tree
```

The build driver also supports `update` for a protected Firefox source update:

```sh
bash scripts/bento-env.sh update
```

For the currently configured Firefox version, `pnpm run firefox:sync` wraps that
update with patch-stack validation, import, and a build. A newer version needs a
trusted Mozilla source digest first. Mozilla publishes the target version in
[`firefox_versions.json`](https://product-details.mozilla.org/1.0/firefox_versions.json)
and the archive digest in the per-release
[`SHA256SUMS`](https://archive.mozilla.org/pub/firefox/releases/)
file at `https://archive.mozilla.org/pub/firefox/releases/<target-version>/SHA256SUMS`;
copy the 64-character value from the line for
`source/firefox-<target-version>.source.tar.xz`, then run:

```sh
BENTO_SOURCE_SHA256=<sha256-from-mozilla> pnpm run firefox:sync
```

The driver verifies the downloaded archive against that value and fails when it
is missing or mismatched. Before an update, inspect linked engine worktrees with
`git -C engine worktree list --porcelain`; finish or export any patch work,
then remove the linked worktree with `git -C engine worktree remove <worktree>`
before retrying. The previous source checkout is kept under `.bento/backups/`
after a successful replacement.

## Local development

Run `pnpm run download` and `pnpm run bootstrap` once, then run `pnpm run build`
to create the native Bento app. The build is required before the development
launch scripts can find an executable. See [docs/build-tooling.md](docs/build-tooling.md)
for the import and native build details.

Use the persistent development profile for normal iteration:

```sh
pnpm run dev
```

This rebuilds the extensions, imports Bento into the Firefox tree, clears
runtime caches, and launches the newest native build with
`engine/obj-bento/dist/Bento.app` on macOS. It reuses `.bento-dev-profile` and preserves
browser data such as bookmarks, history, sessions, passwords, extension
storage, and window layout. Quit Bento before launching it again so the profile
lock is released.

The launcher currently auto-detects the macOS app bundle. On Linux or Windows,
set `BENTO_BIN` to the built executable path:

```sh
BENTO_BIN=/path/to/engine/obj-bento/dist/bin/bento pnpm run dev
```

Use a new temporary profile when testing first-run or clean-profile behavior:

```sh
pnpm run dev:fresh
```

This rebuilds and imports the extensions, then launches with a new temporary
profile. It does not reuse `.bento-dev-profile`, so each run starts without its
previous tabs, workspaces, or browser data.

To keep separate development profiles inside the checkout, set
`BENTO_DEV_PROFILE`:

```sh
BENTO_DEV_PROFILE=.bento-dev-profile-alt pnpm run dev
```

`pnpm run dev` deletes most of the profile directory's contents on each launch,
so it only accepts a directory that does not exist yet, is empty, or is already
a dev profile (it holds `.bento-dev-profile-marker`, `times.json`, or
`prefs.js`). It refuses any directory with git-tracked files, such as `src` or
`extensions`.

To open Browser Toolbox while launching either workflow, set
`BENTO_JSDEBUGGER=1`:

```sh
BENTO_JSDEBUGGER=1 pnpm run dev       # persistent profile
BENTO_JSDEBUGGER=1 pnpm run dev:fresh  # temporary fresh profile
```

For faster extension-only iteration, use a standalone preview or component
workbench:

```sh
pnpm run shell:dev      # full shell preview at http://localhost:5179
pnpm run shell:ladle   # component stories at http://localhost:5180
```

These previews run outside Firefox, so `shell:dev` currently renders the empty
or connecting state until the browser API bridge is mocked. Ladle stories use
fixtures and are the fastest way to inspect component states.

For shell UI changes that need the real Bento browser, rebuild the shell, import
it, and press **Alt+Shift+R** in Bento to reload the extension. Changes to
`bento-shell/src/background.ts` or `bento-tools` need a quit and relaunch
because background scripts are evaluated once:

```sh
pnpm run shell:build && pnpm run import   # bento-shell UI: Alt+Shift+R; background: quit/relaunch
pnpm run tools:build && pnpm run import   # bento-tools: quit/relaunch
```

Changes under `patches/`, `src/browser/`, `prefs/`, or `bento.json` require a
native rebuild followed by a quit and relaunch:

```sh
pnpm run build
pnpm run dev
```

## Layout

| Path                                                                             | Purpose                                                                       |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [bento.json](bento.json)                                                         | Canonical Firefox, branding, build, locale, and update configuration          |
| [Bento generated state](docs/build-tooling.md)                                   | Local source cache, source state, import manifest, and generated engine state |
| [configs/](configs/)                                                             | Per-platform `mozconfig` fragments                                            |
| [config/](config/)                                                               | Tracked upstream versions, release security inputs, reference allowlist       |
| [branding/bento/](branding/bento/)                                               | Canonical Mozilla-derived Bento branding                                      |
| [extensions/](extensions/)                                                       | Bundled privileged extensions (`bento-shell`, `bento-tools`, uBlock Origin)   |
| [src/](src/)                                                                     | Source overlays copied into the Firefox tree at import                        |
| [patches/](patches/)                                                             | Surgical Firefox source patches                                               |
| [prefs/](prefs/)                                                                 | Default pref overrides                                                        |
| [locales/](locales/)                                                             | Shipped locale list                                                           |
| [scripts/](scripts/)                                                             | Build, import, check, and release scripts                                     |
| [docs/](docs/)                                                                   | Product, technical, and contributor documentation                             |
| [bentobrowser-site/](bentobrowser-site/)                                         | Static landing page                                                           |
| [.github/workflows/](.github/workflows/)                                         | CI checks (no application builds) and CodeQL                                  |

## License

MPL-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
