# Architecture summary

Part of the [technical notes index](../core-functionality-technical.md).

Bento's core browsing model is split across three layers:

- `bento-tools` is the source of truth for persisted state. It owns workspace
  metadata, tab assignment, panel layout, panel persistence, pinned panels,
  saved panels, settings, backups, and privacy actions.
- `bento-shell` is the React UI mirror. It renders sidebar controls, workspace
  switcher, tab list, pinned panels, settings, edit-workspace, and the
  panel-trailer React app. It does not directly mutate persisted state.
- `bento-shell-mount.js` is the chrome process reconciler. It receives
  title-IPC sentinels from the shell and mutates Firefox chrome UI, including
  `gBrowser`, `tabpanels.splitViewPanels`, panel headers, splitters, and chrome
  overlays. It is one of the supported chrome surfaces named in `CLAUDE.md`
  (with the other `src/browser/` overlays, the key actors, the experiments, and
  the patch stack). Every upstream-private or internal Firefox member it relies
  on is listed in the repo-only firefox-compat registry
  (`scripts/firefox-compat-registry.mjs`), which
  `scripts/check-firefox-compat.mjs` checks against a Firefox source tree; the
  table is in `docs/firefox-core-touchpoints.md`. The mount ships only a compact
  probe list of the runtime-probable members, which each window probes once.
- `bento-shell-mount.css` holds the chrome layout rules (panel strip, splitters,
  navigator, overlays, startup veil, fullscreen overrides). `injectChromeStyles()`
  in the mount script links it to the window root behind a paint gate; `jar.mn` (patch
  `chrome-layout/01-bento-shell-mount.patch`) ships it as
  `chrome://browser/content/bento-shell-mount.css`. See "Chrome layout
  stylesheet" under Chrome rendering pitfalls.

The state contract is declared in `extensions/_shared/protocol.ts`. UI code
dispatches `Action` messages through `extensions/bento-shell/src/bridge/useToolsPort.ts`.
`bento-tools` mutates stores and broadcasts `Event` payloads back. Shell Zustand
stores are mirrors only.

Port validation: `bento-tools` never trusts the `Action` type on the shell port.
After `isAuthorizedShellPort` and the targeted `shell-client/*` handshake, every
message goes through `createShellActionIntake`
(`extensions/bento-tools/src/messaging/shell-action-intake.ts`) and
`parseWireAction` (`extensions/_shared/wire-action.ts`):

- `ACTION_FIELDS` has one entry per `Action` type and one guard per field, typed
  so a new action type or field fails to compile until it has a validator. Keys
  are exact (plus the `__windowId` routing envelope); ids are safe integers
  (non-negative, except the negative placeholder ids of `pinnedPanel/*` and
  `pinnedPanels/reorder`); strings, arrays, and numeric ranges are bounded;
  URL-bearing actions accept only `http`, `https`, `file`, `ftp`, `about`,
  `view-source`, and `moz-extension` (favicons also `data`, `chrome`, and a few
  icon schemes), and never `javascript:`, `data:`, or `blob:` page URLs.
  `settings/update` reuses `isValidBentoSettingsPatch`; `backup/import` keeps
  `validateExportSchema` for the payload so the user still gets an import error.
- A message that claims a source window (`__windowId`, or the payload window of
  `shell/hello`) is dropped unless `browser.windows.get` confirms the window.
  Confirmed windows are cached until `windows.onRemoved`, and a removed id is
  remembered so a lookup still pending at removal cannot mark the closed window
  live again (a queued `shell/hello` would reassign workspace ownership to it).
  Messages queue behind a pending check so arrival order is kept.
- Invalid messages are logged by type only (never payloads) and dropped; the
  listener cannot throw. Mount-script dispatches (`dispatchShellAction`) and React
  dispatches (`useToolsPort.ts`) must send exactly the declared fields. Manual
  check: after any change to an action shape, exercise that UI path and watch the
  tools console for `dropped invalid shell message`.
- Page-controlled strings must fit the caps before they are dispatched, because
  one over-cap field drops the whole action. Save panel
  (`boundSavedPanelMetadata` in `bento-shell-mount.js`) cuts the page title to
  the title cap, drops a favicon over its cap, and skips a URL over the URL cap
  (a truncated URL would be a different address). The URL cap is
  `MAX_URL_LENGTH` in `extensions/_shared/export-schema.ts`, shared by the port
  validator and backup import; it mirrors Firefox's
  `network.standard-url.max-length` (1,048,576), so recheck it on Firefox
  updates. Pitfall: forwarding `contentTitle` untouched made Save panel fail
  silently on a page with a title over 4,096 characters. Keep the mount
  constants equal to the validator caps; `scripts/bento-privacy-security.test.mjs`
  compares them.
