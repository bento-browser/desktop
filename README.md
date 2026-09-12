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

Pre-v0.1.0 development. Builds and release tooling exist for maintainer
iteration across macOS, Linux, and Windows; public distribution is not enabled yet.

## Prerequisites

- Node.js 20+ (`nvm use` reads `.nvmrc`)
- A sibling Tale UI checkout at `../tale-ui/tale-ui`; the default `pnpm install`
  links Bento's Tale UI packages there, including the built React and themes
  packages.
- Mozilla build prerequisites — installed by `pnpm run bootstrap` (calls
  `mach bootstrap` under the hood). Expect Python 3, Rust, clang, and several
  GB of disk space.
- ~30 GB free disk for the Firefox source tree and build artifacts.

### macOS extras

Surfer's `download` step shells out to GNU `tar` and `xz`, neither of which
ship with macOS. Install both before running `pnpm run download`:

```sh
brew install gnu-tar xz
```

Surfer detects `gtar` automatically once it's on `PATH`.

## Common commands

```sh
pnpm install           # install the pinned build and extension dependencies
pnpm run download      # fetch Firefox source (version configured in surfer.json)
pnpm run bootstrap     # install Mozilla build deps via mach
pnpm run build         # compile Bento Browser
pnpm run build:ui      # incremental Firefox UI build
pnpm run package       # produce platform packages/installers
pnpm run build:release # produce a release-mode artifact for the host platform
pnpm run lc             # Surfer license check
pnpm run build:full    # download → bootstrap → build → package
pnpm run brand:regen   # reinstall tracked branding/bento into the Firefox tree
```

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
`engine/obj-*/dist/Bento.app` on macOS. It reuses `.bento-dev-profile` and preserves
browser data such as bookmarks, history, sessions, passwords, extension
storage, and window layout. Quit Bento before launching it again so the profile
lock is released.

The launcher currently auto-detects the macOS app bundle. On Linux or Windows,
set `BENTO_BIN` to the built executable path:

```sh
BENTO_BIN=/path/to/engine/obj-.../dist/bin/bento pnpm run dev
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

Changes under `patches/`, `src/browser/`, `prefs/`, or `surfer.json` require a
native rebuild followed by a quit and relaunch:

```sh
pnpm run build
pnpm run dev
```

## Layout

| Path                                                         | Purpose                                               |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| [surfer.json](surfer.json)                                   | Surfer config (Firefox version, branding identifiers) |
| [configs/](configs/)                                         | Per-platform `mozconfig` fragments                    |
| [branding/bento/](branding/bento/)                           | Canonical Mozilla-derived Bento branding              |
| [extensions/](extensions/)                                   | Bundled privileged extensions (Phase 3)               |
| [patches/](patches/)                                         | Surgical Firefox source patches (Phase 4)             |
| [prefs/](prefs/)                                             | Default pref overrides                                |
| [scripts/](scripts/)                                         | Build / release scripts                               |
| [config/firefox-versions.json](config/firefox-versions.json) | Tracked upstream versions                             |
| [.github/workflows/](.github/workflows/)                     | CI                                                    |

## License

MPL-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
