# Bento Firefox branding

This is Bento Browser's canonical Firefox-facing branding tree. Its structure
and Mozilla-authored files are based on `browser/branding/unofficial` from
Mozilla Firefox 154.0 and retain their Mozilla Public License headers. Bento
maintains its product names, URLs, installer metadata, colors, and visual assets
directly in this directory.

The tree is selected by `--with-branding=browser/branding/bento` and includes:

- Application icons (`default16.png` through `default256.png`, `firefox.icns`,
  `firefox.ico`)
- About-dialog logo and background assets
- `configure.sh` for brand identifiers
- `pref/firefox-branding.js` for branding-specific default prefs
- `locales/en-US/brand.{ftl,properties}` for Bento Browser name strings

Surfer branding generation is intentionally disabled. `pnpm run import` copies
this tracked tree into `engine/browser/branding/bento`; it never regenerates the
canonical files. When updating Firefox, compare this directory with the new
upstream `browser/branding/unofficial` tree and review every upstream change.
