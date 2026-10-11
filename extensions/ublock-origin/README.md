# uBlock Origin bundled extension

- Version: 1.75.0
- Firefox add-on id: `uBlock0@raymondhill.net`
- Source XPI: https://addons.mozilla.org/firefox/downloads/file/5034826/ublock_origin-1.75.0.xpi
- AMO version metadata: https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/versions/1.75.0/
- Upstream repository: https://github.com/gorhill/uBlock
- SHA-256: `5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287`
- License: `GPL-3.0-only`

## Update steps

1. Download the Firefox XPI for the target listed AMO version.
2. Verify the XPI SHA-256 against AMO metadata.
3. Unpack the XPI into this directory.
4. Keep `.bento-runtime-entries.json` aligned with uBO's required top-level runtime files and folders.
5. Confirm `manifest.json` still declares `uBlock0@raymondhill.net`.
6. Build Bento and verify uBO appears in `about:addons`, is enabled by default, can be disabled by the user, and works in private windows.

`META-INF/` from the downloaded XPI is not listed in `.bento-runtime-entries.json`;
Bento's built-in add-on installer packages the declared runtime entries into
Firefox's `builtin-addons/` jar layout.
