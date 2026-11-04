# uBlock Origin distribution add-on

Bento installs uBlock Origin automatically on first run, and users can remove it
in `about:addons`. It is not a Bento built-in add-on: the build ships the
original signed XPI in the app's `distribution/extensions/` folder, and
Firefox installs it into the profile like any other add-on.

- Version: 1.75.0
- Firefox add-on id: `uBlock0@raymondhill.net`
- File: `uBlock0@raymondhill.net.xpi` (Firefox requires the file name to be the add-on id plus `.xpi`)
- Source XPI: https://addons.mozilla.org/firefox/downloads/file/5034826/ublock_origin-1.75.0.xpi
- AMO version metadata: https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/versions/1.75.0/
- Upstream repository (corresponding source): https://github.com/gorhill/uBlock
- SHA-256: `5b74415860456370644bd80f16125e865b0e6c356bb5dfcfb84069967eaa5287`
- License: `GPL-3.0-only`. The XPI is committed unmodified and carries upstream's `LICENSE.txt`.

`pnpm run security:check` hashes the XPI and fails if it differs from the
SHA-256 above, or if the XPI's manifest (read with `unzip`) does not match the
version and id above. The release checks compare the SHA-256 above with the XPI
inside the staged app and the collected DMG.

## Behavior

- Installed once per profile by Firefox's distribution mechanism. After the user
  removes it, nothing installs it again; they can get it back from addons.mozilla.org.
- Updates itself from addons.mozilla.org (Bento leaves `extensions.update.*` alone).
- Keeps running in private windows: bento-tools grants access once, on the first
  start with this add-on, and the user can turn it off in `about:addons`.
- The XPI must stay AMO-signed: Bento builds require add-on signatures.

## Update steps

1. Download the Firefox XPI for the target listed AMO version.
2. Verify the XPI SHA-256 against AMO metadata.
3. Replace `uBlock0@raymondhill.net.xpi` with it, byte for byte. Do not unpack or repack it.
4. Update the version, source URLs and SHA-256 in this file.
5. Run `pnpm run security:check`.
6. Build Bento on a fresh profile and verify uBO appears in `about:addons`, can be
   removed, and stays removed after a restart.
