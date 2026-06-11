# Firefox Core Touchpoints

This file records vanilla Firefox core surfaces Bento modifies or relies on for
core browser functionality. Keep it current so future Firefox security and
feature updates can review the affected upstream surfaces deliberately.

## Policy

- Prefer `bento-shell`, `bento-tools`, and existing `bentoChrome.*` bridge APIs
  over new Firefox core edits.
- Touch Firefox core only when Bento functionality cannot be implemented through
  the extension and bridge layers.
- Update this file in the same change as any Firefox core touchpoint is added,
  removed, or materially changed.
- During a Firefox version update, review every active touchpoint below against
  upstream changes. Call out and fix regressions before treating the update as
  complete.

## What Counts As Firefox Core

Record changes or dependencies involving:

- `src/browser/**` and other `src/**` Firefox source files.
- `patches/**` files applied to Firefox source.
- `prefs/**`, `surfer.json`, build config, or branding files when they alter
  Firefox behavior or core integration.
- Chrome XHTML/CSS/JS hooks that depend on Firefox internals such as `gBrowser`,
  `tabpanels`, split view, SessionStore, browser chrome events, key actors, or
  window tracking.

Do not record routine extension-only changes under `extensions/bento-shell` or
`extensions/bento-tools` unless they require a matching Firefox core behavior
change or depend on a Firefox core hook.

## Entry Template

Use this shape for new or changed touchpoints:

```md
### Short Name

- Status: Active | Removed | Needs review
- Last updated: YYYY-MM-DD
- Files or patches:
- Bento functionality:
- Vanilla Firefox surface touched or depended on:
- Why this cannot stay extension-only:
- Firefox update risk:
- Regression checks for future updates:
- Rollback or migration notes:
```

## Current Touchpoints

### Chrome Panel Shell Mount

- Status: Active
- Last updated: 2026-06-11
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js`
  - `src/browser/base/content/bento-chrome-theme.css`
  - `src/browser/base/content/bento-chrome-tokens.css`
  - `engine/toolkit/content/widgets/infobar.css`
  - `patches/core-ui/10-bento-infobar-accent-token.patch`
  - `patches/chrome-layout/**`
- Bento functionality: mounts the Bento chrome shell, coordinates panel browser
  visibility and geometry, renders chrome-side menu overlays for sidebar and
  panel actions, hands focus back to the sidebar frame for chrome-originated
  shell UI actions such as inline tab/folder rename, opens the floating
  address/search bar on `Cmd/Ctrl+L` and `Cmd/Ctrl+T`, routes submitted
  address/search text through Firefox URI fixup, mounts a shared modal toolbar
  scrim as a top-layer manual popover so native toolbar/urlbar controls do not
  paint above Bento modal scrims, opens Firefox DevTools toolboxes in trusted
  Bento panels from content context-menu inspect commands, and exposes the
  chrome-side container behavior that extension code cannot perform directly.
- Vanilla Firefox surface touched or depended on: browser chrome DOM,
  `gBrowser`, `gBrowser.tabpanels`, browser panel elements, split-view markers,
  chrome window events, frame focus, title/actor messaging paths,
  `gBrowser.addTrustedTab`, `DevToolsShim.on/off('toolbox-ready')`,
  `DevToolsShim.getToolboxes()`, the
  `about:devtools-toolbox?type=tab&id=<browserId>&tool=<tool>` URL contract,
  `gContextMenu.targetIdentifier`, `toolbox.commands.descriptorFront.browserId`,
  `toolbox.selectTool`, inspector front
  `getNodeActorFromContentDomReference`, inspector selection `setNodeFront`,
  accessibility-panel `selectAccessibleForNode`, and injected side-panel
  header/restore-handle chrome elements.
- Why this cannot stay extension-only: privileged extension UI cannot directly
  reparent, size, or reconcile Firefox browser panels inside the chrome document
  without a small chrome-side mount and bridge.
- Firefox update risk: upstream changes to `browser.xhtml`, tabbrowser panel
  structure, split-view implementation, browser actor messaging, URI fixup, or
  chrome event ordering can break panel layout, focus, inline sidebar rename,
  overlay shortcuts, address/search navigation, or visibility.
- Regression checks for future updates: run the flat panels manual checklist in
  `plans/flat-panels-browser-verification-checklist.md`, verify sidebar context
  menus still dispatch tab and workspace actions, verify `Cmd/Ctrl+L` and
  `Cmd/Ctrl+T` open the floating address bar instead of native urlbar/new-tab
  handling, verify `FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP` still resolves default
  search-engine submissions, verify native URL bar inset controls and the
  search-mode switcher popup inherit Bento token colors in light and dark modes,
  verify notification bars such as the popup-blocked banner inherit Bento token
  colors in light and dark modes,
  verify command palette, floating address bar, edit-workspace, confirm, and
  first-run welcome scrims cover the full chrome window including the address
  bar, verify sidebar tab and folder `Rename` context-menu actions focus the
  inline field and select its text for immediate typing, verify side-panel and
  sub-panel header hiding/restoration still works from the panel header menu and
  the restore handle while main-panel headers stay unavailable, verify
  `Inspect in Panel` and `Inspect Accessibility Properties in Panel` appear only
  when the corresponding stock Firefox context-menu item appears, open a
  page-hosted DevTools toolbox in an adjacent Bento panel, select the clicked
  node, coexist with the stock docked toolbox, reuse the existing pair for the
  same caller and inspected tab, replace the single main-content pair when a
  different main tab is inspected, verify a DevTools panel paired with a
  subdivided side panel shows a horizontal connector centered on that sub-panel
  while the full-height boundary remains draggable, verify dragging the DevTools
  panel beside a subdivided panel only offers root-level placement and does not
  leave the panel stuck, verify focusing a sibling panel in the same subdivision
  does not show the DevTools focus indicator for the linked sub-panel, verify
  DevTools panels cannot persist in the pinned panels rail after close or restart
  while normal pinned panels still can, and close ephemeral toolbox tabs on
  caller removal, inspected-tab closure, and restart, run
  `node --check src/browser/base/content/bento-shell-mount.js`, and the relevant
  extension typecheck/lint/build commands after any rebase.
- Rollback or migration notes: keep fallback behavior extension-driven where
  possible. If upstream Firefox grows a supported API for the needed panel
  operation, prefer migrating to that API and shrinking this mount.

### Core UI And Window Sync Patch Stack

- Status: Active
- Last updated: 2026-05-30
- Files or patches:
  - `patches/core-ui/**`
  - `patches/window-sync/**`
- Bento functionality: hides or adapts Firefox native tab UI, reserves Bento key
  handling, makes focus and inspection panel-aware, and keeps browser window/tab
  state synchronized for Bento's shell and tools extensions.
- Vanilla Firefox surface touched or depended on: tabbrowser behavior, native
  toolbar and tab strip UI, BrowserWindowTracker, split-view behavior, key actors,
  frame focus handling, and DevTools inspection behavior.
- Why this cannot stay extension-only: these behaviors affect Firefox chrome
  ownership, native tab/window state, or privileged event routing before the
  extension shell can fully mediate them.
- Firefox update risk: upstream tabbrowser, toolbar, BrowserWindowTracker,
  DevTools, focus, or key actor changes can cause duplicated UI, broken shortcuts,
  stale window state, or incorrect panel focus.
- Regression checks for future updates: run `npm run build`, verify native tabs
  remain hidden, verify Bento shortcuts still win where reserved, verify focus
  traversal skips or enters panel browsers correctly, and verify Browser Toolbox
  inspection works for panel browsers.
- Rollback or migration notes: keep each patch small and independently skippable;
  if a Firefox update makes a patch unnecessary, remove the patch and record the
  removal here.

### First-Run Browser Profile Import

- Status: Active
- Last updated: 2026-06-05
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js`
  - `src/browser/base/content/bento-migration-host.{html,css,js}`
  - `src/browser/base/content/bento-migration-wizard-bridge.css`
  - `patches/core-ui/09-bento-firefox-profile-first-run-import.patch`
- Bento functionality: the multi-step Bento onboarding overlay includes a
  browser-data import state. When the user chooses it, chrome code opens an
  embedded Bento chrome host that renders Firefox's reusable migration wizard for
  ordinary in-window imports and injects Bento/Tale styling into its open shadow
  root. Full Mozilla Firefox or macOS Zen Browser profile imports remain an
  explicit startup handoff because those migrators copy profile databases before
  the new Bento profile is initialized. When the user takes that explicit
  Firefox/Zen action, chrome sets the `BENTO_MIGRATION_SCOPE=firefox-zen`
  environment variable alongside `BENTO_RESTART_TO_MIGRATION` and carries the
  welcome resume step through `BENTO_WELCOME_STEP` before restarting;
  `MigrationWizardParent.#getMigratorAndProfiles` reads it (only while
  `MigrationUtils.isStartupMigration` is true) and returns null for any migrator
  key other than `firefox`/`zen`, so the post-restart startup wizard is scoped
  to Firefox/Zen and lands preselected on them instead of defaulting to Chrome
  and re-listing the runtime browsers. The generic fallback path (embedded
  runtime wizard unavailable) sets the scope empty so the startup wizard still
  offers every browser.
- Vanilla Firefox surface touched or depended on:
  `toolkit/xre/nsAppRunner.cpp`,
  `browser/components/migration/FirefoxProfileMigrator.sys.mjs`,
  `browser/components/migration/MigrationUtils.sys.mjs`,
  `browser/components/migration/MigrationWizardParent.sys.mjs`,
  `browser/locales/en-US/browser/migrationWizard.ftl`, and the native
  `ProfileMigrator` / `MigrationUtils` startup and in-window migration paths.
- Why this cannot stay extension-only: Firefox's Firefox-profile migrator is
  startup-only and copies profile databases before normal profile initialization;
  Bento's extension welcome overlay can offer the action, but chrome must restart
  into startup migration to safely perform that profile-copy migration. The
  embedded in-window wizard also needs Firefox's `MigrationWizard` JSWindowActor
  allowlist to include Bento's chrome host URL.
- Firefox update risk: upstream startup profile selection, `gDoMigration`
  handling, migration wizard actor matches, migration wizard options, Fluent
  string requirements, startup-only migrator filtering, the
  `#getMigratorAndProfiles` filtering structure (where the Bento scope check is
  inserted), the `firefox`/`zen` migrator key strings, or Firefox/Zen profile
  path conventions, chrome restart environment propagation, the welcome-frame
  hash URL convention, macOS app bundle locations, `moz-icon://` icon behavior,
  `zen-sessions.jsonlz4` structure, Firefox SessionStore JSON structure, or
  WebExtension sessions extData key encoding can stop the onboarding import
  action from opening migration, break the Firefox/Zen scoping, restart the
  welcome flow at the first step after import, make the Firefox-family migrators
  enumerate Bento profiles, use Bento's icon for source apps, or make Zen
  spaces/tabs restore without Bento workspace/panel ownership.
- Regression checks for future updates: launch Bento with no existing Bento
  profile while Mozilla Firefox and/or macOS Zen `profiles.ini` files exist,
  confirm Bento onboarding appears first, advance to the import state, click
  import, confirm the embedded import host appears without closing the Bento
  window, confirm non-startup migrators can populate in the embedded wizard, then
  use the Firefox/Zen action and confirm Bento restarts into the native startup
  migration wizard scoped to ONLY Firefox/Zen profiles (Chrome/Safari/CSV/HTML
  absent) and preselected on a Firefox/Zen entry rather than Chrome. Confirm
  empty Firefox/Zen registry entries with no migratable files are not offered as
  disabled picker choices. Import a disposable Zen profile with at least two
  spaces, one regular tab in each space, one pinned tab, and one essential tab;
  confirm onboarding resumes on the post-import privacy step, the picker shows
  installed Firefox/Zen app icons rather than Bento's icon or a blank icon, the
  success view includes the session resource without a warning icon, and clicking
  Done immediately shows the restored Zen tabs without requiring another restart.
  Confirm Bento creates
  matching workspaces, the Zen pinned tab appears as a pinned Bento tab, and the
  Zen essential tab appears as a pinned Bento panel. Also confirm copied
  bookmarks/history/password resources are present in the new
  Bento profile.
- Rollback or migration notes: removing the patch reverts Bento to vanilla
  Firefox 150 behavior, where the Bento chrome host cannot drive the migration
  actor and startup migration cannot be entered from Bento onboarding. The
  confirmed 2026-06-09 Zen import fix depends on keeping all of these pieces
  together: profile rows are filtered through `getMigrateData(profile)`, app
  icons use quoted `moz-icon://` CSS URLs built from installed macOS bundles,
  Zen session state is written with compressed `IOUtils.writeJSON()` instead of
  the non-exported `SessionMigration.writeState()`, and Bento Tools consumes the
  restored workspace/panel session markers after live `SessionStore` restore.
  Essential-tab pinning is part of the panel marker (`pinnedPanel: true`) and
  must also work from the boot-time marker scan, not only from `tabs.onCreated`,
  because imported tabs can already exist before the background listener is
  registered. The boot-time scan must retry marker reads in batches, not one tab
  at a time; serialized per-tab retries block the Bento Tools `bootReady`
  handshake and leave the sidebar at `Connecting...` on large Zen imports. The
  welcome resume fix is also part of this touchpoint: keep
  `BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>`, `BENTO_WELCOME_STEP`, and
  `#bentoWelcomeStep=<nextStep>` together. `browser.storage.local` is not enough
  for the native startup-migration path because profile import can invalidate
  extension-origin storage before the post-import welcome frame reloads.

### Bento Prefs, Branding, And Build Integration

- Status: Active
- Last updated: 2026-06-07
- Files or patches:
  - `prefs/bento.js`
  - `engine/services/settings/dumps/main/search-config-v2.json`
  - `engine/third_party/application-services/components/remote_settings/dumps/main/search-config-v2.json`
  - `surfer.json`
  - `configs/**`
  - `patches/experiments/**`
- Bento functionality: applies Bento defaults, DuckDuckGo fresh-profile search,
  Firefox-visible search options for Bento onboarding and Settings, branding,
  build configuration, and temporary Firefox-source build guards needed by the
  local Surfer-based fork. Privacy defaults include strict
  tracking protection, tracker-cookie partitioning, Global Privacy Control,
  query stripping, speculative networking off, remote search suggestions off,
  local Safe Browsing on, remote Safe Browsing download checks off, DoH disabled,
  and AI/remote suggestion surfaces disabled.
- Vanilla Firefox surface touched or depended on: Firefox profile defaults,
  search service Remote Settings dumps, branding import paths, build
  configuration, and patched build/runtime behavior covered by
  `patches/experiments`.
- Why this cannot stay extension-only: prefs, branding, and build behavior are
  consumed before or outside the privileged extension runtime. Fresh-profile
  default search is resolved by Firefox search configuration before Bento's
  extension UI can safely mutate it.
- Firefox update risk: upstream pref renames, search config schema changes,
  branding layout changes, build system changes, or obsolete temporary patches
  can silently stop applying or block security update rebases.
- Regression checks for future updates: run `npm run build`, confirm
  `scripts/append-prefs.sh` still appends `prefs/bento.js`, inspect branding in
  the built app, confirm fresh-profile omnibar search uses DuckDuckGo, inspect
  `about:config` for the Standard privacy defaults, confirm Firefox-visible
  search engines can be selected as default search in onboarding and Settings,
  and re-evaluate whether each experiment patch is still needed.
- Rollback or migration notes: remove temporary experiment patches as soon as
  upstream or Surfer no longer requires them.

### Built-In Extension Copy Surface

- Status: Active
- Last updated: 2026-06-07
- Files or patches:
  - `/Users/admin/Projects/surfer/src/commands/patches/extensions-copy.ts`
  - `extensions/ublock-origin/.bento-runtime-entries.json`
  - `extensions/bento-tools/experiments/bento-privacy/**`
- Bento functionality: packages Bento's privileged built-in extensions and the
  bundled uBlock Origin extension into Firefox's `builtin-addons/` runtime
  location. The Surfer copy step now lets an extension declare a per-extension
  runtime entry list so uBlock Origin keeps its required `js/`, `css/`, `lib/`,
  `assets/`, locale, and HTML entry files without broadening the copy surface of
  Bento's own source-based extensions.
- Vanilla Firefox surface touched or depended on: Firefox built-in add-on
  loading from `browser/extensions`, generated `jar.mn`, generated per-extension
  `moz.build`, and `browser/extensions/moz.build` registration.
- Why this cannot stay extension-only: built-in add-ons must be copied into
  Firefox's source tree before the Firefox build packages them; normal runtime
  WebExtension installation cannot provide Bento's bundled default add-ons.
- Firefox update risk: upstream changes to built-in add-on packaging, jar
  manifest handling, add-on manifest validation, or Firefox's extension
  bootstrap rules can stop bento-tools, bento-shell, or uBlock Origin from
  loading.
- Regression checks for future updates: run `pnpm run ext:build` and
  `pnpm run import`, confirm `engine/browser/extensions/bento-tools/jar.mn`
  includes `experiments/bento-privacy`, confirm
  `engine/browser/extensions/ublock-origin/jar.mn` includes uBO's `js/`, `css/`,
  `lib/`, and `assets/` folders, launch a fresh build, and verify `about:addons`
  shows Bento Tools, Bento Shell, and uBlock Origin.
- Rollback or migration notes: if uBlock Origin is removed, remove
  `extensions/ublock-origin/` and its runtime-entry file. If Surfer upstream
  adopts a native equivalent, migrate to that and remove Bento-specific copy
  handling.
