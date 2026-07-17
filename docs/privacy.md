# Bento Privacy

Bento exposes three selectable privacy levels and one computed state.

## Levels

- Standard: balanced default. Uses strict Firefox tracking
  protection, tracker-cookie partitioning, Global Privacy Control, query
  stripping, remote search suggestions off, speculative networking off, local
  Safe Browsing checks on, HTTPS-only mode, DoH disabled, and uBlock Origin
  enabled.
- Enhanced: Standard plus resist fingerprinting and WebRTC IP handling set to
  disable non-proxied UDP.
- Hardened: Enhanced plus letterboxing, WebRTC peer connections off, DRM off,
  disk cache off, WebGL/WebGPU off, password/form saving off, local Safe
  Browsing retained, and cookies/site data/cache cleared on shutdown.
- Custom: detected when live browser settings diverge from every preset. It is
  not selectable.

Settings shows the benefits and caveats for all three selectable levels.
Onboarding shows a compact explanation for the currently selected level before
the user continues.

Remote Safe Browsing download reputation is an independent advanced setting,
not part of preset matching. It is off by default. When enabled, Firefox may
send eligible-download and redirect URLs, the original referrer when available,
file name, size, SHA-256, locale, and signing or certificate metadata to Google
Safe Browsing when a local verdict is unavailable. Changing a protection preset
does not reset this setting or change the displayed preset to Custom.

## Search

Fresh profiles default to DuckDuckGo. Bento Settings can switch the default
search engine among Firefox's currently visible search engines. Bento does not
maintain a separate provider list; ids, names, icons, ordering, and availability
come from Firefox `SearchService.getVisibleEngines()`. Provider icons are
converted to renderable data URLs before reaching the shell UI. During
onboarding, Bento adds supporting text that identifies visible privacy-oriented
engines when they are present, without filtering the Firefox-provided list.

The runtime search setter is privileged because `browser.search` cannot set the
default engine. Bento uses a bento-tools WebExtension experiment that calls
Firefox `SearchService` by engine id.

The floating address/search palette may use a selected engine for one submitted
non-URL search. That picker does not call the default search setter and does not
change Settings or Firefox's default engine.

## Runtime Control

The shared preset model lives in `extensions/_shared/privacy-levels.ts`.
`bento-tools` applies and reads the live browser state through
`extensions/bento-tools/src/privacy/ProtectionLevels.ts`.

The only privileged API is `browser.bentoPrivacy`, registered from
`extensions/bento-tools/experiments/bento-privacy/`. It exposes allowlisted pref
reads/writes/clears and default search engine operations. It rejects prefs
outside the static allowlist.

Settings and onboarding both dispatch the same protocol actions:

- `privacy/setProtectionLevel`
- `privacy/setAdvanced`
- `privacy/setDefaultSearchEngine`
- `privacy/requestSnapshot`

## uBlock Origin

Bento bundles uBlock Origin enabled by default and leaves it disableable or
removable by the user. Provenance for the bundled version is recorded in
`extensions/ublock-origin/README.md`.

## Update Checklist

1. Update `extensions/_shared/privacy-levels.ts` for preset or allowlist changes.
2. Mirror any new allowlisted pref in
   `extensions/bento-tools/experiments/bento-privacy/api.js`.
3. Update `prefs/bento.js` when Standard fresh-profile defaults change.
4. Update both Firefox search config dump copies when the fresh-profile search
   default changes.
5. Run `pnpm --filter @bento/tools test`, both extension typechecks, and
   `pnpm run ext:build`.
6. Run `pnpm run import` and confirm generated `jar.mn` files include
   bento-tools experiments and uBlock Origin runtime folders.
