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
- Last updated: 2026-07-11
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js`
  - `src/browser/base/content/bento-chrome-theme.css`
  - `src/browser/base/content/bento-chrome-tokens.css`
  - `engine/browser/base/content/browser-fullScreenAndPointerLock.js`
  - `engine/toolkit/content/widgets/infobar.css`
  - `patches/core-ui/10-bento-infobar-accent-token.patch`
  - `patches/core-ui/11-dom-fullscreen-splitview-browser.patch`
  - `patches/chrome-layout/**`
- Bento functionality: mounts the Bento chrome shell, coordinates panel browser
  visibility and geometry, renders chrome-side menu overlays for sidebar and
  panel actions, hands focus back to the sidebar frame for chrome-originated
  shell UI actions such as inline tab/folder rename, routes `Cmd/Ctrl+L`,
  `Cmd/Ctrl+E`, `Cmd/Ctrl+T`, sidebar `New tab`, and native top-urlbar fallback
  opens to the centered address/search overlay, routes direct expanded-sidebar
  URL row activation to the same overlay with a sidebar anchor, routes submitted
  address/search text through Firefox URI fixup, resolves one-shot
  address-palette non-default search-engine submissions through Firefox
  `SearchService` without changing the default engine, handles `Cmd/Ctrl+S`
  sidebar minimization according to Bento Settings, opens privileged
  new-tab address submissions such as `about:preferences` through
  `gBrowser.addTrustedTab` when WebExtension tab creation would reject them,
  reveals the main content slot after committed address/search submissions,
  updates panel focus rings, navigator active markers, and strip reveal from
  chrome `focusin` plus a reconciled `.browserContainer` / `<browser>` click
  fallback for privileged `about:*` documents that do not reliably emit
  chrome-side focus,
  emits scoped sidebar address
  snapshots for active URL/title/loading/security/bookmark state, opens
  Firefox's native identity popup from the sidebar security button, toggles
  regular Firefox bookmarks from the sidebar address star with stale
  tab/URL/snapshot guards, copies the current sidebar URL through Firefox's
  native clipboard helper with the same stale tab/URL/snapshot guards, lets
  direct sidebar URL row editing overhang the sidebar without resizing the
  sidebar frame or moving content, caps the sidebar-anchored address overlay
  below the centered overlay size,
  keeps the collapsed sidebar host width at one collapsed control plus
  symmetric collapsed-sidebar inline padding through the generated chrome token
  and suppresses host width transitions during live
  sidebar/window resize,
  leaves the collapsed workspace-switcher section unpadded so its centered
  avatar trigger remains the same square size as the other collapsed rail
  controls,
  hides the native top URL/search field under a Bento
  chrome attribute while keeping toolbar and window controls visible on the
  sidebar-matched background in no-panel view, and on the sidebar-matched
  background on the sidebar side of the divider plus neutral-14 on the
  main-content side when panels are visible, and without Firefox's toolbox
  bottom separator,
  extends the sidebar right divider through the native top toolbar,
  aligns Firefox's native Back/Forward/Reload control cluster with the Bento
  sidebar's right edge as the sidebar is resized, mounts a shared modal
  toolbar scrim as a top-layer manual popover so native toolbar/urlbar controls
  do not paint above Bento modal scrims, leaves that toolbar scrim disabled for
  the floating address bar, keeps the address palette on an opaque neutral
  CommandPalette surface without content scrim or chrome-side frost capture,
  reads global clipboard text for empty new-tab address opens and forwards only
  validated `http`/`https` clipboard URL specs into the extension frame,
  keeps the floating address bar below the workspace manager, suppresses
  address-bar autofocus when an empty workspace created from that manager
  triggers native urlbar focus, opens the manual browser-session merge palette from the sidebar
  footer in a persistent
  chrome-hosted overlay frame, delivers open/close lifecycle nonces into that
  extension frame, opens Firefox's native app menu from a sidebar footer button
  by anchoring `PanelUI.panel` to a temporary chrome-side element with left-edge
  footer alignment and temporary native panel animation suppression, opens
  Firefox's native downloads panel from a sidebar footer button by anchoring
  `DownloadsPanel.panel` to a temporary chrome-side element with the same
  left-edge footer alignment and animation suppression, patches
  `DownloadsButton.getAnchor()`/`releaseAnchor()` so automatic native downloads
  panel opens use a sidebar fallback anchor, hides the stock toolbar
  `#PanelUI-button`, `#downloads-button`, and `#fxa-toolbar-menu-button`,
  collapses native nav-bar `toolbarspring` gaps while Bento's sidebar
  addressbar mode is active, and right-aligns the browser extension toolbar
  buttons with a marked first extension child while hiding the native post-tabs
  titlebar spacer, and aligns Firefox's native bookmarks toolbar with Bento's
  panel-strip start edge without pushing Bento or Firefox-native sidebar content
  down, maps Firefox's native Customize Toolbar screen surfaces, buttons, links,
  palette items, and overflow-panel preview through the same generated Tale
  UI/Bento chrome tokens, themes Firefox's Passwords `about:logins` documents,
  shared shadow-component stylesheet, and sidebar megalist surface through the
  generated Tale UI/Bento chrome tokens,
  opens Firefox DevTools toolboxes in trusted Bento panels from content
  context-menu inspect commands, renders panel-scoped
  Back/Forward session-history popups from panel headers, preserves DOM
  fullscreen by hiding Bento-owned chrome, panel headers/loading overlays, flat
  panel controls, and focus-ring pseudo-elements while removing rounded panel
  clipping when Firefox's `inDOMFullscreen` attribute is set, permits visible
  split-view panel browsers to request DOM fullscreen through Firefox's
  active-browser check and pre-marks the exact requesting browser before
  fullscreen CSS applies, overrides Firefox's visual hiding of non-`.deck-selected`
  split-view panels for that requester, and exposes the chrome-side container
  behavior that extension code cannot perform directly.
- Vanilla Firefox surface touched or depended on: browser chrome DOM,
  `gBrowser`, `gBrowser.tabpanels`, browser panel elements, split-view markers,
  `gBrowser.selectedBrowsers`, `FullScreen.enterDomFullscreen`, chrome window
  events, native `#urlbar-input` pointer/focus events,
  `#urlbar-container` and `#search-container` chrome CSS,
  `#nav-bar`, `#navigator-toolbox`, `#nav-bar-customization-target`,
  `#PersonalToolbar`, `#customization-container`,
  `#customization-palette`, `#customization-footer`,
  `#customization-panelWrapper`, `#bento-strip-container`, native `#sidebar-title`,
  native `#sidebar-box`, native `#sidebar-splitter`, native Bookmarks sidebar
  `moz-input-search`, native History and Synced Tabs sidebar component shadow
  roots and `moz-input-search` fields, Passwords `about:logins` documents,
  shared component stylesheets, and `chrome://global/content/megalist` sidebar
  document/component stylesheet,
  `#unified-extensions-button`, `#fxa-toolbar-menu-button`, native toolbar
  springs, extension browser-action toolbar children, `#back-button`,
  `#forward-button`, `#stop-reload-button`, toolbar geometry,
  `#bento-sidebar-chrome-divider`, and chrome `ResizeObserver`,
  `#bento-shell-frame` geometry for anchored address-overlay placement,
  native identity
  chrome (`gIdentityHandler`, `#identity-box`, `#identity-icon-box`,
  `#identity-popup`, `PanelMultiView.openPopup`), Firefox app-menu chrome
  (`PanelUI`, `#appMenu-popup`, `#PanelUI-button`), Places bookmark APIs and
  Places observer events, `gURLBar.view.close()`, frame focus, title/actor messaging paths,
  chrome-hosted extension frame lifecycle messaging through `messageManager`,
  split-view `.browserContainer` click events and `<browser>` focus/click
  events,
  chrome `<browser>.loadURI()` with system principals for Bento extension-frame
  entries,
  `SearchService.sys.mjs`, `SearchService.promiseInitialized`,
  `SearchService.getEngineById`, search-engine `getSubmission().uri.spec`,
  `gBrowser.addTrustedTab` for privileged address-entry new-tab submissions
  and DevTools panel tabs,
  `browsingContext.sessionHistory`, `SessionStore.getSessionHistory`,
  browser `gotoIndex()`,
  `DevToolsShim.on/off('toolbox-ready')`,
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
  overlay shortcuts, merge-palette lifecycle dispatch, address/search
  navigation, one-shot search-engine resolution, panel focus detection on
  privileged `about:*` pages, sidebar address scoping,
  native identity/app-menu popup anchoring, bookmark state, native URL-bar and
  toolbar app-menu hiding, native toolbar surface/separator/sidebar-divider styling,
  native Customize Toolbar markup and token variable names, Passwords
  `about:logins` and megalist stylesheet load order and semantic color variable
  names, native navigation-button alignment, or visibility.
- Regression checks for future updates: run the flat panels manual checklist in
  `plans/flat-panels-browser-verification-checklist.md`, verify a workspace
  with no side panels clips page content inside the rounded main content frame
  corners during normal browsing without a square tabbox/tabpanels backing
  corner showing behind the rounded clip, uses neutral-5 behind the main slot,
  hides the sidebar right border and top-toolbar divider, keeps live window,
  Bento sidebar, and panel-splitter resize smooth, including when a panel is
  showing `about:preferences` or `about:settings`, while chrome resize observers
  are deferred, settings about-page browsers in the resized panel/group are
  layer-preserved and docshell-paused only for the live panel drag, panel-view
  frames keep normal shadows during the live gesture, and only the
  no-side-panels `.browserSidebarContainer` frame has a direct outline-only live
  window/sidebar resize override, run
  `pnpm run chrome:resize-check` after chrome token changes, and removes that
  frame during DOM fullscreen,
  verify sidebar context menus still dispatch tab, folder, and
  workspace actions including moving a
  folder to another workspace, verify `Cmd/Ctrl+L`, `Cmd/Ctrl+E`, and
  `Cmd/Ctrl+T` open the centered address/search overlay with current/new-tab
  mode, verify clicking the expanded-sidebar URL row opens the address/search
  overlay anchored below that row,
  verify clicking or programmatic focus into Firefox's hidden native top address
  input opens Bento's centered address entry and does not leave the native urlbar
  suggestions dropdown open, verify the native top URL/search field, stock
  toolbar app-menu button, stock toolbar downloads button, and stock toolbar
  Account menu are hidden while
  the sidebar footer Firefox-menu button opens the native app menu with
  submenus, Settings, More Tools, Help, update/sign-in banners, and keyboard
  shortcuts intact and grows rightward from the trigger when space allows,
  without sliding in from the top or bottom, verify the sidebar footer Downloads
  button opens Firefox's native downloads panel with recent download actions and
  download history intact while using the same footer-side alignment and no
  top/bottom slide, verify the native top toolbar matches the sidebar
  background with no divider in no-panel view, matches the sidebar background
  on the sidebar side of the divider in panel view, switches to the panel-strip
  neutral-14 backdrop on the main-content side across `#navigator-toolbox`,
  `#TabsToolbar`, and `#nav-bar` when panels are present, uses neutral-5 behind
  the main content with no panels, and matches neutral-14 behind the panel strip
  when panels are present, including clipped/native-titlebar fallback pixels from `body`,
  `body::after`, `#browser`, and `#appcontent`, and the
  `#bento-toolbar-main-backdrop` layer behind the panel navigator/extension
  buttons, with split-view panel frame backplates resolving to the same
  neutral-14 value rather than neutral-5, and has no bottom separator line,
  verify the sidebar right divider
  reaches the top of the window, verify the native Back/Forward/Reload control
  group stays on the sidebar side of that divider and moves continuously while
  dragging the sidebar splitter without width-transition smoothing or XUL/native
  splitter competition, using pointer capture and cached drag geometry instead
  of live rect reads while still animating collapsed/expanded sidebar state,
  verify the panel navigator sits flush with the sidebar divider after the
  native Reload/Stop control, verify browser extension toolbar buttons align to
  the right side of the top bar without a post-tabs spacer gap, and verify that
  the native bookmarks toolbar starts at the panel-strip edge and tracks
  sidebar resize/collapse without creating a gap above Bento's sidebar address
  field or Firefox's native Bookmarks sidebar search field, verify Cmd+Shift+B
  show/hide does not visibly push sidebar contents before correcting, and verify
  that the native Bookmarks sidebar can be resized from its own right edge
  independently of the Bento sidebar handle, and that the navigator follows the
  sidebar divider continuously during
  sidebar-handle drag instead of jumping on mouseup while extensions remain
  right-aligned,
  verify dragging a side-panel favicon button reorders panels rather than
  moving the window, while dragging unused top-bar space still moves the
  window, verify rapid clicks on the panel navigator's previous/next controls
  cycle panels without maximizing or restoring the window, and verify hovering
  each navigator button opens its Tale UI tooltip at that button without
  blocking clicks or drag reorder, with the main slot showing the selected
  page title,
  verify Customize Toolbar mode uses Tale UI/Bento token surfaces for the main
  palette, bottom footer, Restore Defaults/Done buttons, Manage Themes link,
  and overflow-menu preview in light and dark modes,
  verify the expanded sidebar cannot be dragged narrower than the
  width where Back/Forward/Reload stop moving left so the divider never appears
  behind those buttons, while the panel-strip scrollbar remains in the bottom
  inset of the panel strip with splitter-matched thickness and equal top/bottom
  clearance, verify remaining toolbar buttons, extension buttons, toolbar
  customization, titlebar controls, and window dragging still work, verify two
  Bento windows do not leak sidebar address URL/title/security/bookmark
  snapshots across windows, verify clicking the sidebar
  security control opens Firefox's native identity popup with native content,
  verify the expanded-sidebar address overlay can extend over the panel
  strip/main content while editing, stays smaller than the centered shortcut
  overlay, and closes after Escape, submit, and outside
  click,
  verify the native Bookmarks sidebar title uses Tale UI `label-l` typography,
  its icon/title/chevron are vertically centered, and its search field matches
  the Bento sidebar address field in light and dark modes, verify History and
  Synced Tabs sidebar search fields use the same search field colors and that
  the sidebar switcher dropdown text is consistent across Bookmarks, History,
  Synced Tabs, and Passwords, verify the Passwords sidebar megalist search
  field, cards, actions, alerts, and the full-page Passwords page/import report
  resolve through forced light neutral Tale UI token colors instead of OS
  dark/native defaults,
  verify regular bookmarks outside the "Saved panels" folder fill the sidebar
  star while saved-panel-only bookmarks do not, verify rapid navigation or tab
  switching during a sidebar star toggle does not mutate the stale page, verify
  the sidebar Copy URL button writes the current selected main-tab URL to the
  global clipboard and shows a `Copied` tooltip after the write succeeds, verify
  `Cmd/Ctrl+ArrowLeft` and `Cmd/Ctrl+ArrowRight` inside side-panel content
  navigate that panel's own history without moving panel focus and without
  stealing cursor movement from editable fields, verify
  `Cmd/Ctrl+Shift+ArrowLeft` and `Cmd/Ctrl+Shift+ArrowRight` cycle panels while
  plain Left/Right arrows still reach side-panel content such as videos, verify
  `Cmd/Ctrl+S` follows Bento Settings by either collapsing the sidebar to the
  rail or hiding it from layout, verify left-edge hover reveals the collapsed
  rail over content without pushing content, and verify pressing the shortcut
  again restores it, verify
  `Cmd/Ctrl+W` from a focused side panel showing `about:preferences` or
  `about:settings` closes that panel rather than the main content tab, verify
  right-clicking a side
  panel or sub-panel header Back or Forward button shows that panel's own
  previous, current, and next session-history entries and selecting an entry
  navigates that panel rather than the main tab, verify
  `FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP` still resolves default search-engine
  submissions, verify selecting a non-default engine in the floating address
  palette sends only that submitted non-URL search to the selected engine,
  verify URL-like input ignores the selected one-shot engine, verify the picker
  resets to Firefox's current default on the next open and does not mutate Bento
  Settings/default search, verify engine lookup/submission failures fall back to
  URI fixup, verify submitting `about:preferences` from both current-tab and
  new-tab address-entry mode opens the native preferences page, verify
  submitting a floating-address search while the panel strip
  is scrolled to side panels reveals the main content slot, verify clicking into
  `about:preferences` and `about:addons` in the main content slot also updates
  the focus ring/navigator marker and scrolls the strip back to main without
  stealing focus from clicked controls, verify Shift-wheel cycling from the
  first side panel back to main clears the side-panel focus ring and keeps the
  main-slot ring visible, verify tabbing through controls inside those
  `about:*` main-slot pages keeps the main-slot focus ring visible, verify native URL bar
  inset controls and the
  search-mode switcher popup inherit Bento token colors in light and dark modes,
  verify notification bars such as the popup-blocked banner inherit Bento token
  colors in light and dark modes,
  verify command palette, manual browser-session merge, edit-workspace, confirm,
  and first-run welcome scrims cover the full chrome window including the address
  bar, verify the sidebar footer merge action opens the merge palette, refreshes
  sources on every open, closes on Esc or close action, and never leaves the
  command palette and merge palette visible at the same time, verify the floating
  address bar does not dim the native toolbar/address bar, sidebar, or page
  content and opens as an opaque neutral CommandPalette surface without waiting
  for a frost snapshot, verify copying `https://example.com/` and pressing
  `Cmd/Ctrl+T` shows the clipboard URL as the first new-tab address result,
  verify creating a workspace from the workspace manager
  keeps that manager above and focused if the address palette opens underneath,
  verify sidebar tab and folder
  `Rename` context-menu actions focus the inline field and select its text for
  immediate typing, verify side-panel and
  sub-panel headers stay on their neutral-5 surface and header
  hiding/restoration still works from the panel header menu and the restore
  handle while main-panel headers stay unavailable, verify video
  fullscreen from the main content slot and from a side panel hides the sidebar,
  panel navigator, strip scrollbar, panel trailer, panel header/loading overlay,
  non-requesting side-panel slots, rounded panel framing, and Bento focus rings
  in both side-panel and no-side-panel workspaces, and does not show a neutral
  chrome background in place of the side-panel video, verify
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
  while normal pinned panels still can, verify dragging a pinned panel favicon
  reorders the global sidebar rail with the same dimmed source, accent insertion
  marker, and settle animation as the top panel navigator while a normal click
  still opens the pin, and close ephemeral toolbox tabs on
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
- Regression checks for future updates: run `pnpm run build`, verify native tabs
  remain hidden, verify Bento shortcuts still win where reserved, verify focus
  traversal skips or enters panel browsers correctly, and verify Browser Toolbox
  inspection works for panel browsers.
- Rollback or migration notes: keep each patch small and independently skippable;
  if a Firefox update makes a patch unnecessary, remove the patch and record the
  removal here.

### Native Preferences Layout

- Status: Active
- Last updated: 2026-07-04
- Files or patches:
  - `engine/browser/components/preferences/preferences.xhtml`
  - `engine/browser/themes/shared/preferences/preferences.css`
  - `src/browser/base/content/bento-chrome-tokens.css`
- Bento functionality: centers Firefox's native `about:preferences` content pane
  and category navigation as one unit in the available browser content area, so
  the settings controls do not sit flush against the side nav on wide windows.
  The native preferences page also loads Bento's generated Tale UI token sheet
  and maps Firefox in-content semantic variables for surfaces, text, borders,
  buttons, fields, panels, and focus rings onto Tale UI/Bento tokens while
  rendering preferences cards and box groups as borderless neutral-5 tiles.
- Vanilla Firefox surface touched or depended on: the native preferences XHTML
  layout and in-content theme cascade, including `#categories`,
  `.main-content`, `.pane-container`, `chrome://global/skin/in-content/common.css`,
  and the generated `chrome://browser/content/bento-chrome-tokens.css`.
- Why this cannot stay extension-only: `about:preferences` is a privileged
  built-in Firefox page; extension CSS cannot reliably restyle its chrome-loaded
  layout or define its in-content semantic theme variables.
- Firefox update risk: upstream preferences markup, XUL box alignment behavior,
  settings redesign layout changes, in-content variable names, or preferences
  widget token dependencies can reintroduce left alignment, alter the content
  pane width, or disconnect preferences controls from Bento's Tale UI palette.
- Regression checks for future updates: open `about:preferences` in a wide
  Bento window and confirm the search field and settings pane are centered in
  the area beside the category nav; narrow the window and confirm the pane still
  fits without horizontal clipping, category navigation works, and the main
  preferences area still scrolls. Check light and dark appearances for the
  neutral-10 page background, borderless neutral-5 cards/tiles without box
  shadows, search field, switches, buttons, selected category, links, dialogs,
  warning/info boxes, and QR/AI promo surfaces; confirm forced colors still
  follows Firefox/system colors.
- Rollback or migration notes: remove the `pack="center"` XHTML override and
  the `.main-content` width bound if upstream Firefox adopts a centered
  preferences layout. Remove the `bento-chrome-tokens.css` link and preferences
  semantic-token bridge if this customization conflicts with a future redesign
  or Firefox exposes a supported shared theme-token hook for in-content pages.

### Hidden Native Tabs And Titlebar Controls

- Status: Active
- Last updated: 2026-06-27
- Files or patches:
  - `patches/core-ui/02-hide-native-tabs.patch`
  - `browser/components/tabbrowser/content/tabbrowser.js`
  - `browser/base/content/navigator-toolbox.inc.xhtml`
  - `browser/base/content/titlebar-items.inc.xhtml`
  - `browser/themes/shared/browser-shared.css`
  - `prefs/bento.js`
- Bento functionality: hides Firefox's native horizontal tab strip while keeping
  the operating system's native window controls visible in the top chrome. The
  visible tab UI remains owned by `bento-shell`.
- Vanilla Firefox surface touched or depended on: `TabBarVisibility.update()`,
  `#navigator-toolbox[tabs-hidden]`, `#nav-bar.browser-titlebar`, the nav-bar
  titlebar spacer/buttonbox copy, and the native titlebar commands in
  `titlebar-items.inc.xhtml`.
- Why this cannot stay extension-only: only Firefox chrome can collapse
  `#TabsToolbar`, mark the toolbox `tabs-hidden`, and promote the nav bar into
  Firefox's native titlebar/window-control state before the shell extension
  renders.
- Firefox update risk: upstream changes to `TabBarVisibility.update()`,
  titlebar-control markup, titlebar CSS, or nav-bar drag-region behavior can
  re-expose the native tab strip, hide the native window controls, or make
  toolbar controls draggable/clickable in the wrong places.
- Regression checks for future updates: verify native window controls are
  visible and clickable, Firefox's native horizontal tab strip stays hidden,
  `sidebar.verticalTabs` remains false and no native Firefox vertical-tabs/sidebar
  UI appears, popup windows keep Firefox's existing single-tab popup behavior,
  fullscreen/maximized/restored states swap native controls correctly, empty
  titlebar/nav-bar space drags the window, and URL bar or toolbar button
  interaction does not drag the window.
- Rollback or migration notes: for one profile, set
  `bento.chrome.hideNativeTabs` to `false` and relaunch. For source rollback,
  remove the default pref from `prefs/bento.js`, revert the Bento-specific
  `TabBarVisibility.update()` condition in the existing patch-stack commit, then
  export, check, import, and build. If restoring the old hidden-tab behavior
  instead of removing native-tab hiding entirely, restore the old
  `#TabsToolbar { visibility: collapse !important; }` rule in
  `patches/core-ui/02-hide-native-tabs.patch` and revalidate native controls.

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
  Firefox behavior for this migration surface, where the Bento chrome host
  cannot drive the migration actor and startup migration cannot be entered from
  Bento onboarding. The
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
- Regression checks for future updates: run `pnpm run build`, confirm
  `scripts/append-prefs.sh` still appends `prefs/bento.js`, inspect branding in
  the built app, confirm fresh-profile omnibar search uses DuckDuckGo, inspect
  `about:config` for the Standard privacy defaults, confirm Firefox-visible
  search engines can be selected as default search in onboarding and Settings,
  and re-evaluate whether each experiment patch is still needed.
- Rollback or migration notes: remove temporary experiment patches as soon as
  upstream or Surfer no longer requires them.

### Built-In Extension Copy Surface

- Status: Active
- Last updated: 2026-07-04
- Files or patches:
  - `/Users/admin/Projects/surfer/src/commands/patches/extensions-copy.ts`
  - `package.json`
  - `pnpm-lock.yaml`
  - `scripts/import.sh`
  - `scripts/build-bento.sh`
  - `scripts/sync-builtin-addon-symlinks.sh`
  - `extensions/ublock-origin/.bento-runtime-entries.json`
  - `extensions/bento-tools/experiments/bento-privacy/**`
- Bento functionality: packages Bento's privileged built-in extensions and the
  bundled uBlock Origin extension into Firefox's `builtin-addons/` runtime
  location. The Surfer pin
  `0c4bfd6dc8f865e71f789d4377d8ee589e28af84` is rebased onto upstream Surfer
  `17d9a1577170880cdac13dca7c3d6871716fc046` and keeps Bento's extension copy,
  runtime-entry filtering, repo-local patch import, patch-check consistency, and
  generated `jar.mn` behavior. The copy step lets an extension declare a
  per-extension runtime entry list so uBlock Origin keeps its required `js/`,
  `css/`, `lib/`, `assets/`, locale, and HTML entry files without broadening the
  copy surface of Bento's own source-based extensions.
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
  shows Bento Tools, Bento Shell, and uBlock Origin. Direct `surfer import`
  does not prove this surface is valid because it bypasses Bento's import
  wrapper and built-in add-on symlink sync.
- Rollback or migration notes: if uBlock Origin is removed, remove
  `extensions/ublock-origin/` and its runtime-entry file. If Surfer upstream
  adopts a native equivalent, migrate to that and remove Bento-specific copy
  handling.
