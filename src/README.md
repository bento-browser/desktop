# src/

Source overlays: Bento code that lives in the repo and is copied into the
Firefox tree at build time (`pnpm run import`) rather than applied as a patch.
New files in the Firefox tree go here; changes to existing Firefox files are
patches under `patches/`.

- `browser/base/content/`: the chrome mount script `bento-shell-mount.js` (which
  also carries the compact firefox-compat probe list), its stylesheets
  (`bento-shell-mount.css` for chrome layout, `bento-chrome-theme.css`, and the generated
  tokens and theme sheets), and the embedded import host. A new file here also needs a
  `browser/base/jar.mn` line in `patches/chrome-layout/01-bento-shell-mount.patch`;
  `scripts/check-import-output.mjs` fails without it.
- `browser/actors/`: the `BentoKey` JSWindowActor pair.

The supported chrome surfaces are listed in [CLAUDE.md](../CLAUDE.md), and each
Firefox core touchpoint is logged in
[docs/firefox-core-touchpoints.md](../docs/firefox-core-touchpoints.md).
