# uBlock Origin bundled extension

- Version: 1.72.2
- Firefox add-on id: `uBlock0@raymondhill.net`
- Source XPI: https://addons.mozilla.org/firefox/downloads/file/4888680/ublock_origin-1.72.2.xpi
- AMO version metadata: https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/versions/1.72.2/
- Upstream repository: https://github.com/gorhill/uBlock
- SHA-256: `40c315b0da7871868155ecfae7a50a58dfa0920aebd865e008214986f1b7c578`
- License: `GPL-3.0-only`

## Update steps

1. Download the Firefox XPI for the target listed AMO version.
2. Verify the XPI SHA-256 against AMO metadata.
3. Unpack the XPI into this directory.
4. Keep `.bento-runtime-entries.json` aligned with uBO's required top-level runtime files and folders.
5. Confirm `manifest.json` still declares `uBlock0@raymondhill.net`.
6. Build Bento and verify uBO appears in `about:addons`, is enabled by default, can be disabled by the user, and works in private windows.

`META-INF/` from the downloaded XPI is not listed in `.bento-runtime-entries.json`; Surfer repackages built-in add-ons into Firefox's `builtin-addons/` jar layout.
