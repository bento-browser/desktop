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
- Mozilla build prerequisites — installed by `npm run bootstrap` (calls
  `mach bootstrap` under the hood). Expect Python 3, Rust, clang, and several
  GB of disk space.
- ~30 GB free disk for the Firefox source tree and build artifacts.

### macOS extras

Surfer's `download` step shells out to GNU `tar` and `xz`, neither of which
ship with macOS. Install both before running `npm run download`:

```sh
brew install gnu-tar xz
```

Surfer detects `gtar` automatically once it's on `PATH`.

## Common commands

```sh
npm install            # install Surfer
npm run download       # fetch Firefox source (version configured in surfer.json)
npm run bootstrap      # install Mozilla build deps via mach
npm run build          # compile Bento Browser
npm run build:ui       # UI-only rebuild (faster iteration)
npm run package        # produce platform packages/installers
npm run build:release  # produce a release-mode artifact for the host platform
npm run lc             # Surfer license check
npm run build:full     # download → bootstrap → build → package
npm run brand:regen    # reinstall tracked branding/bento into the Firefox tree
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
