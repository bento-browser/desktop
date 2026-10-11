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
- Every upstream-private or upstream-internal Firefox member a touchpoint
  relies on (underscore and `on_*` methods, prototype patches, lazy chrome
  globals, module URLs, chrome DOM ids, event and markup contracts) has an
  entry in the firefox-compat registry. The table under
  [Private And Internal Firefox Members](#private-and-internal-firefox-members)
  is generated from it and is the source of truth for those members; the
  touchpoint entries below describe behavior and regression checks.

## What Counts As Firefox Core

Record changes or dependencies involving:

- `src/browser/**` and other `src/**` Firefox source files.
- `patches/**` files applied to Firefox source.
- `prefs/**`, `bento.json`, build config, or branding files when they alter
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
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): `tabbrowser.js` is now the ES module
  `Tabbrowser.sys.mjs` and its tab-closing method is the private
  `#beginRemoveTab`, so Bento no longer wraps it. Closing the selected tab runs
  Firefox's `#blurTab` (TabSelect and the tabpanels `select` event) before it
  sets `tab.closing`, with no await between them. Every selection signal
  therefore queues one microtask (`reconcile` and `runReconcile`) that reads the
  final `selectedTab` and `tab.closing` after `#beginRemoveTab` returns; no
  Firefox patch is needed. `insertBrowser` is public (was `_insertBrowser`),
  `UrlbarUtils.sanitizeTextFromClipboard` moved to `UrlbarShared`, the
  SessionStore import uses the `moz-src:///browser/components/sessionstore/`
  URL, `_getTabProgressFilter` is gone, so the progress filter re-attach is
  removed, and the megalist hand-rolled search rules are gone. In-process
  `about:` pages (Settings) deliver `resize` events to the chrome window's
  bubbling `resize` listener, so `attachWindowResizePerfMode` ignores events
  whose target is not the chrome window; without that guard the Settings
  freeze and thaw cycle re-triggered itself every 300 ms and closed open
  Settings dropdowns. Added regression checks: close the selected tab, a
  multi-selection, and the last tab and confirm no ghost strip panel appears
  (reconcile after `TabClose` lists no closing tab); with a Settings tab open,
  confirm no `bento-settings-about-live-resize-frozen` mutations while idle and
  that a Settings `moz-select` opens by mouse and keyboard.
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js`
  - `src/browser/base/content/bento-chrome-theme.css`
  - `src/browser/base/content/bento-chrome-tokens.css`
  - `src/browser/base/content/bento-chrome-themes/*.css` (see Chrome Theme Sheets)
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
  rejects script-like address schemes and performs content loads with
  `LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL` plus an explicit triggering
  principal,
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
  reads global clipboard text for empty new-tab address opens, only while
  Firefox's `browser.urlbar.suggest.clipboard` pref is true, and forwards only
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
  palette items, and overflow-panel preview through the same generated Mux UI/Bento
  chrome tokens, themes Firefox's Passwords `about:logins` documents,
  shared shadow-component stylesheet, and sidebar megalist surface through the
  generated Mux UI/Bento chrome tokens,
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
  Places observer events, `gURLBar.view.close()`, the `browser.urlbar.suggest.clipboard`
  pref (default true in `browser/app/profile/firefox.js`), frame focus, title/actor messaging paths,
  process-wide listener registries that outlive a chrome window and must be
  released on the window `unload` event:
  `AddonManager.addAddonListener` / `removeAddonListener` (a strong `Set` in
  `AddonManager.sys.mjs`), `PlacesUtils.observers` (`PlacesObservers`)
  `addListener` / `removeListener` (strong JS listener list; removal matches the
  same callback and event-type list), and the `Services.obs` observer service
  (`enumerateObservers` / `addObserver` for the ExtensionsUI permission-prompt
  topics, added once per process for the shared ExtensionsUI singleton, never
  per window),
  the chrome-only, bubbling `pagetitlechanged` event that
  `WindowGlobalParent::RecvUpdateDocumentTitle` (`dom/ipc/WindowGlobalParent.cpp`)
  dispatches on a top-level document's embedding `<browser>`, and the
  `<browser>.contentTitle` and `<browser>.currentURI` getters
  (`toolkit/content/widgets/browser-custom-element.mjs`),
  which the mount script's one delegated `window` listener uses to receive every
  `BENTO_*` title-IPC sentinel from the shell and overlay frames (the same event
  and getter `Tabbrowser.sys.mjs` uses for tab labels),
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
  accessibility-panel `selectAccessibleForNode`, Tabbrowser's per-tab progress
  filter (the private `#tabFilters` map in `Tabbrowser.sys.mjs`, which Firefox
  157 no longer exposes through an accessor, so Bento cannot re-attach it),
  `BrowsingContextWebProgress` (which reports an already-attached listener as
  `NS_ERROR_FAILURE`), `Element.moveBefore`
  (`ParentNode.webidl`, no pref) for the startup `#tabbrowser-tabbox` and
  `#bento-side-panel-host` relocations, the frameloader preservation
  `XULFrameElement` (`BindToTree` / `UnbindFromTree` `IsMove()`) and
  `MozBrowser.connectedMoveCallback` provide on a move (an
  `insertBefore` / `appendChild` move recreates it), the duplicate
  `ChromeUtils.registerWindowActor` `NotSupportedError` from `JSActorService`,
  and injected side-panel header/restore-handle chrome elements.
- Why this cannot stay extension-only: privileged extension UI cannot directly
  reparent, size, or reconcile Firefox browser panels inside the chrome document
  without a small chrome-side mount and bridge.
- Firefox update risk: upstream changes to `browser.xhtml`, tabbrowser panel
  structure, split-view implementation, browser actor messaging, URI fixup, or
  chrome event ordering can break panel layout, focus, inline sidebar rename,
  title-IPC delivery (if `pagetitlechanged` is renamed, stops firing for
  extension-process or in-process `<browser>` elements, stops being dispatched
  synchronously with an updated `contentTitle`, or stops bubbling to the chrome
  window, every shell and overlay message is lost because nothing polls; if
  `currentURI` lags the first title event of a new document or stops matching
  the extension host, the document check ignores legitimate titles; the shell's
  `sendChromeTitle` writer also assumes the content process reports a title from
  a runnable queued by the first write (`Document::NotifyPossibleTitleChange` and
  `DoNotifyPossibleTitleChange` in `dom/base/Document.cpp`) and that a
  `MessagePort` message posted afterwards (`MessagePort::Dispatch`,
  `dom/messagechannel/MessagePort.cpp`) runs after it, both being Normal-priority
  main-thread dispatches ordered by creation (`ThreadEventTarget::Dispatch` in
  `xpcom/threads/ThreadEventTarget.cpp`, `Task::PriorityCompare` in
  `xpcom/threads/TaskController.h`). If either runnable gains a different
  priority or event queue, or the report starts reading the title earlier, a sent
  title is lost again. Timers cannot replace the port because
  `TimeoutManager::RunTimeout` (`dom/base/TimeoutManager.cpp`) batches every
  expired timeout into one task. Rerun the sidebar-reload check in
  `docs/core-functionality-technical.md` ("Shell to chrome bridge") on a profile
  with `welcomeSeen` false after any change to document title reporting),
  overlay shortcuts, merge-palette lifecycle dispatch, address/search
  navigation, one-shot search-engine resolution, panel focus detection on
  privileged `about:*` pages, sidebar address scoping,
  native identity/app-menu popup anchoring, bookmark state, native URL-bar and
  toolbar app-menu hiding, native toolbar surface/separator/sidebar-divider styling,
  native Customize Toolbar markup and token variable names, Passwords
  `about:logins` and megalist stylesheet load order and semantic color variable
  names, native navigation-button alignment, or visibility. A rename or
  semantic change to AddonManager listener removal, `PlacesObservers.removeListener`,
  or the chrome window `unload` event silently brings back per-window leaks:
  closed Bento windows stay alive until quit. If `moveBefore` stops preserving a
  `<browser>`'s frameloader (`XULFrameElement` move handling or
  `MozBrowser.connectedMoveCallback` changes), the first tab silently gets a new
  BrowsingContext on every window open and, with no re-attach since Firefox 157,
  the first tab loses its progress events for good while `Tabbrowser.destroy()`
  throws on window close. If a future Tabbrowser exposes its filters again, a
  re-attach safety net can return. Hooks guarded by `typeof` skip silently when a private member is renamed; the
  firefox-compat registry lists those members and reports the missing ones
  (below).
- Regression checks for future updates: run `pnpm run firefox:compat:engine`
  against the target source before anything else and fix or remove every hook it
  reports missing, confirm the Browser Console shows
  `[bento-compat] probed N members` with no `[bento-compat] missing` errors in a
  built app, run the flat panels manual checklist in
  `plans/flat-panels-browser-verification-checklist.md`, verify a workspace
  with no side panels clips page content inside the rounded main content frame
  corners during normal browsing without a square tabbox/tabpanels backing
  corner showing behind the rounded clip, uses neutral-5 behind the main slot,
  hides the sidebar right border and top-toolbar divider, keeps live window,
  Bento sidebar, and panel-splitter resize smooth when `about:preferences` or
  `about:settings` is open in any foreground or background tab, while chrome
  resize observers are deferred, every settings about-page browser is
  held at its pre-gesture viewport geometry, layer-preserved, and docshell-paused
  only for the live gesture then restored to its previous inline geometry and
  active state, panel-view and no-side-panels main frames keep their full
  configured shadows throughout the live gesture without a resize-only outline
  override, run
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
  each navigator button opens its Mux UI tooltip at that button without
  blocking clicks or drag reorder, with the main slot showing the selected
  page title,
  verify Customize Toolbar mode uses Mux UI/Bento token surfaces for the main
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
  verify the native Bookmarks sidebar title uses Mux UI `label-l` typography,
  its icon/title/chevron are vertically centered, and its search field matches
  the Bento sidebar address field in light and dark modes, verify History and
  Synced Tabs sidebar search fields use the same search field colors and that
  the sidebar switcher dropdown text is consistent across Bookmarks, History,
  Synced Tabs, and Passwords, verify the Passwords sidebar megalist search
  field, cards, actions, alerts, and the full-page Passwords page/import report
  resolve through forced light neutral Mux UI token colors instead of OS
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
  `Cmd/Ctrl+T` shows the clipboard URL as the first new-tab address result and
  that setting `browser.urlbar.suggest.clipboard` to false removes the row
  without reading the clipboard (the pref must still exist and keep its
  boolean type in `browser/app/profile/firefox.js`; Bento reads a missing pref
  as true and a non-boolean pref as off),
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
  caller removal, inspected-tab closure, and restart, verify process-wide
  listeners are released on window close (wrap `AddonManager.addAddonListener` /
  `removeAddonListener` and `PlacesUtils.observers.addListener` / `removeListener`
  from the Browser Toolbox Console, open a second Bento window, close it, and
  confirm the live Bento listener count returns to its prior value), verify the
  first tab keeps its frameloader and progress filter through the startup
  re-parenting (a `browsing-context-attached` / `-discarded` observer shows one
  attach and no discard for a new window's first tab, and its
  `browsingContext.id` is unchanged), then open several
  windows, navigate the first tab and confirm `onLocationChange` /
  `onStateChange` reach the tab label, urlbar, and sidebar address, then close
  each window with the Browser Toolbox Console open: no `Tabbrowser.destroy` or
  `removeProgressListener` error, no `'BentoKey' actor is already registered`
  warning, no `setSplitViewPanelActive` message), run
  `node --check src/browser/base/content/bento-shell-mount.js`, and the relevant
  extension typecheck/lint/build commands after any rebase, and verify title-IPC
  delivery after any Firefox update that touches `WindowGlobalParent.cpp`,
  `browser-custom-element.mjs`, or `Tabbrowser.sys.mjs` title handling: confirm
  `RecvUpdateDocumentTitle` still dispatches `pagetitlechanged` with
  `CanBubble::eYes` and `ChromeOnlyDispatch::eYes` on the embedder element and
  that `currentURI` already reflects the new document when its title event
  arrives (the Browser Console must not show `ignoring title from unexpected
document`), then in a built app open the command palette, address bar, a sidebar context menu,
  the workspace switcher, a confirm dialog, and the welcome flow and confirm each
  opens and closes (those paths cross the shell, overlay, menu, and panel-trailer
  frames), and confirm a `BENTO_PANELS` change such as toggling Auto/Light/Dark
  or adding a panel reaches chrome in the same paint as the sidebar. Idle CPU
  wakeups with all overlays hidden must stay near zero (no title timers or
  `requestAnimationFrame` loop).
- Rollback or migration notes: keep fallback behavior extension-driven where
  possible. If upstream Firefox grows a supported API for the needed panel
  operation, prefer migrating to that API and shrinking this mount. If
  `pagetitlechanged` is removed or changes semantics, the previous receiver was
  per-frame `setInterval` (60 ms and 200 ms) and shell-frame
  `requestAnimationFrame` loops reading `contentTitle` (see git history of
  `attachPaletteCloseListener`).

### Add-Panel Grant (Chrome Tab Record)

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): `tab.documentGlobal` is unchanged;
  `addTab` stays synchronous. No change needed.
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js` (`addNewPanel`)
  - `extensions/bento-tools/experiments/bento-privacy/api.js`
    (`consumeAddPanelGrant`) and `schema.json`
  - `extensions/bento-tools/src/panels/AddPanelGrant.ts`
  - No Firefox patch.
- Bento functionality: the Add panel button, the Enter key on the focused
  trailer, and the splitter "Insert panel here" menu create a tab that bento-tools
  adopts as a side panel. Chrome creates the tab at
  `about:blank?bento_add_as_panel=<uuid>` and stores a one-time grant
  `{ token, windowId, source, expiresAt, acknowledge }` as the
  `bentoAddPanelGrant` property on the native XUL tab element. bento-tools adds
  the tab as a panel only when `browser.bentoPrivacy.consumeAddPanelGrant(tabId,
token)` finds a live grant for that exact tab and token, deletes it, and
  returns its window and insertion source. A web page that navigates to a
  marker-shaped URL, replays a consumed URL, or uses another tab's token has no
  grant and is ignored.
- Vanilla Firefox surface touched or depended on: `gBrowser.addTab` returning
  the native tab element synchronously, the native tab element accepting a
  chrome-side expando property that a different system-principal compartment
  (the extension experiment) can read and delete, the WebExtension
  `tabManager.get(tabId, null).nativeTab` and `.windowId` lookup in
  `browser/components/extensions/parent/ext-browser.js`, and
  `windowTracker.getId(window)` (via the mount's `getChromeWindowId`) matching
  the extension window id.
- Why this cannot stay extension-only: only chrome can mint authority that web
  content cannot forge. The grant lives on a chrome-owned tab element and the
  experiment is the privileged reader.
- Firefox update risk: a tabbrowser change that makes `addTab` asynchronous, a
  rename of the native tab's window accessor (`documentGlobal` in 154 and 157), or
  Xray wrappers between chrome compartments would make every grant lookup miss
  and silently disable the Add panel button.
- Regression checks for future updates: click Add panel, press Enter on the
  focused trailer, and use "Insert panel here" on a splitter and confirm each
  creates a panel in the expected slot; in a content tab run
  `location.hash = 'bento_add_as_panel=1'` and navigate a tab to
  `about:blank?bento_add_as_panel=3f1c2a4e-9b7d-4c1a-8e5f-0a1b2c3d4e5f` and
  confirm neither becomes a panel; confirm the Browser Console logs
  `add-as-panel: no matching grant` for the second case.
- Rollback or migration notes: the old `bento_add_as_panel=1` URL marker is no
  longer accepted by current builds. Rollback variants carry the same grant
  handshake (see `docs/settings-consolidation-rollback.md`).

### Core UI And Window Sync Patch Stack

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): all 24 patches apply. Offset or context
  only (hunk bodies unchanged): chrome-layout/02 and 04, core-ui/03, 04, 05, 07,
  08, 10, 11, 12, 13, 15, window-sync/01 and 04, experiments/01. chrome-layout/01
  drops `class="chrome-block"` from its `#sidebar-container` context line
  (upstream removed the class); core-ui/16 follows the settings test's
  `controlEl` change; experiments/02 follows the `rustflags_sancov` to
  `RUST_SANCOV_FLAGS` rename. Ported: core-ui/02 retargets to
  `tab-bar-visibility.js` (`TabBarVisibility` left `tabbrowser.js`);
  core-ui/06, window-sync/02 and 03 move their `tabbrowser.js` hunks into
  `Tabbrowser.sys.mjs` (module scope, `this.documentGlobal`, the private
  `#beginRemoveTab`); core-ui/09 uses the moz-src SessionStore URL; core-ui/14
  drops the hand-rolled megalist search rules because 157 renders
  `moz-input-search` itself. Firefox 157 defaults `browser.nova.enabled` and
  `sidebar.revamp` to true; Bento ships both false (see the prefs entry).
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

### Chrome Theme Sheets

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): no change. The `jar.mn` hunk only moved
  by one line. `about:logins` and the megalist sidebar render with the generated
  tokens; the megalist search field matches 154 apart from slightly tighter
  spacing.
- Files or patches:
  - `patches/chrome-layout/01-bento-shell-mount.patch` (one `browser/base/jar.mn`
    line: `content/browser/bento-chrome-themes/ (content/bento-chrome-themes/*.css)`)
  - `src/browser/base/content/bento-chrome-themes/*.css` (generated, ignored)
  - `src/browser/base/content/bento-shell-mount.js`
    (`applyChromeThemeToDocument`, `syncChromeThemeAttributes`)
  - `scripts/generate-chrome-tokens.mjs`,
    `scripts/sync-builtin-addon-symlinks.sh`
- Bento functionality: each non-Default workspace theme is its own native
  stylesheet, so a chrome window parses the shared tokens plus only the theme it
  shows instead of every theme (the base sheet fell from 664 kB to 284 kB). The
  mount script attaches the active theme's sheet to the chrome root and to the
  native sidebar and Places documents, and sets `data-bento-theme` once the sheet
  has loaded.
- Vanilla Firefox surface touched or depended on: `browser.jar` content
  registration through `browser/base/jar.mn` (wildcard entries are expanded by
  `python/mozbuild/mozbuild/jar.py` at build time, so only files present at build
  time are listed), the `chrome://browser/content/` package, `<link
  rel="stylesheet">` load and error events on chrome documents, and the
  `chrome://browser/content/sidebar/` and `places/` documents the mount script
  already themes.
- Why this cannot stay extension-only: chrome and the native sidebar and Places
  documents already take their tokens from jar-registered
  `chrome://browser/content/` files, and Bento has no extension-served stylesheet
  path into those documents, so the per-theme files follow the base sheet's
  jar.mn route. Loading `moz-extension://` styles into chrome documents was not
  tried.
- Firefox update risk: low. The jar.mn line sits in the hunk that already adds
  the other Bento chrome files; a change to the surrounding upstream lines is the
  only likely conflict. A change to jar wildcard handling would drop the sheets
  and leave non-Default workspaces on the base palette.
- Regression checks for future updates: `pnpm run firefox:patches:check`;
  `pnpm run import` and confirm
  `engine/browser/base/content/bento-chrome-themes/` holds 15 sheets; after a
  build, `chrome/browser/content/browser/bento-chrome-themes/` in the app
  resources lists the same files. In a running build set a non-Default workspace
  theme, then check the window root's `data-bento-theme`, one
  `link[data-bento-chrome-theme-sheet]` on the root and in the native sidebar
  document, a clean switch between two themes (no unthemed frame, no duplicate
  links), and light and dark. After a Firefox bump also run
  `git apply --check` of the jar.mn hunk against the new `browser/base/jar.mn`.
- Rollback or migration notes: removing the wildcard line and the mount
  function, and running `generate-chrome-tokens.mjs --monolithic` as the default,
  restores the single-sheet layout. The rollback-final-r2 variant already builds
  that layout, because its archived mount script loads only the base sheet.

### Native Preferences Layout

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): patch applies with offsets only. Settings
  layout is centered as on 154. Known and identical on 154: on `about:preferences`
  the Firefox design tokens `--background-color-box`, `--border-radius-circle`
  and `--space-large` compute empty and cards render flat. `--space-large` is
  emptied by the unscoped `:root { --space-large: var(--space-2xs) }` in
  `bento-chrome-tokens.css`, which references a token defined only under
  `[data-bento-theme]`; the other two stay empty even with that sheet disabled
  (cause not identified). Not a 157 regression and not addressed by the
  upgrade.
- Files or patches:
  - `engine/browser/components/preferences/preferences.xhtml`
  - `engine/browser/themes/shared/preferences/preferences.css`
  - `src/browser/base/content/bento-chrome-tokens.css`
- Bento functionality: centers Firefox's native `about:preferences` content pane
  and category navigation as one unit in the available browser content area, so
  the settings controls do not sit flush against the side nav on wide windows.
  The native preferences page also loads Bento's generated Mux UI token sheet
  and maps Firefox in-content semantic variables for surfaces, text, borders,
  buttons, fields, panels, and focus rings onto Mux UI/Bento tokens while
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
  pane width, or disconnect preferences controls from Bento's Mux UI palette.
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

### Native Bento Preferences

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): Firefox 157 rejects `moz-extension:`
  URLs in `Services.scriptloader.loadSubScript` unless the caller passes
  `allowUnsafeURL: true` (or sets `security.allow_unsafe_subscript_loads`), which
  stopped `bento-tools` from starting; the experiment now calls
  `loadSubScriptWithOptions(..., { target, allowUnsafeURL: true })` for its two
  scripts. `moz-select` opens a `panel-list` on mousedown and closes it on any
  window `resize` or `scroll` outside the list, which is why the mount's resize
  guard matters. Verified: the Bento pane and the stock default search engine
  `moz-select` open by mouse, close on Escape, and open again with ArrowDown.
- Files or patches:
  - `patches/core-ui/15-bento-native-preferences.patch`
  - `extensions/_shared/native-preferences-contract.json`
  - `extensions/bento-tools/experiments/bento-native-preferences/**`
  - `extensions/bento-shell/src/experiments/chrome-bridge/**`
  - `src/browser/base/content/bento-shell-mount.js`
- Bento functionality: registers an always-visible native Bento category plus
  backup and shortcut subpanes for `about:preferences` and `about:settings`.
  A generated, hash-pinned observer contract connects native controls to the
  durable tools stores. The parent-process document registry preserves logical
  shell identities across add-on reloads, while source-window title signals
  route Settings launches without accepting arbitrary URLs.
- Vanilla Firefox surface touched or depended on: config-backed preferences
  panes; `moz-page-header`, `moz-select` and its `panel-list` path,
  `moz-slider`, `moz-input-number`, `moz-button`, `moz-input-search`,
  `moz-box-group`, and `moz-box-item`; preferences
  XHTML/jar/locales; browser actors; system-principal observer subjects; and
  built-in WebExtension experiment loading.
- Why this cannot stay extension-only: the category and its controls must be a
  native Settings surface, and only parent chrome can authenticate the document,
  derive its browser window/private audience, and retain shell mount identity.
- Firefox update risk: preference config APIs, `moz-select`/`panel-list`
  properties and popup event behavior, `about:settings` routing, file-picker
  signatures, actor packaging, or extension experiment bootstrap changes can
  break registration or fail the bridge closed.
- Regression checks for future updates: run protocol generation checks, patch
  replay, the four `browser_bento_*` tests, both extension builds, source install,
  packaged-app, and release-package add-on identity checks. Confirm the native
  slider/value pair stays synchronized, the custom panel sizes label names its
  native reorderable list, and panel-size rows reorder by drag and
  Ctrl+Shift+ArrowUp/ArrowDown without losing their occurrence identity. Each
  size row should expose its numeric value and native destructive Remove action
  without a position-based visible label or duplicate Move buttons; its number
  field keeps the unnumbered accessible name “Panel size.” Confirm the long main
  Bento pane keeps every native setting group continuously rendered and scrolls
  without blank, delayed, or jumping cards; do not add `content-visibility`
  containment to those groups.
  Confirm the backup and shortcut subpanes contain native list and action
  components. Open every Bento dropdown with both mouse and keyboard, select a
  value, and confirm the Firefox panel closes and the Bento setting persists.
  Confirm the native page header shows its localized Bento heading beside the
  icon. Test both redesign pref values and regular/private windows.
- Rollback or migration notes: patch 15 is the rollback boundary for the native
  pane. Keep the source overlay routing edit out of patch 15. A rollback build
  must restore a compatible settings surface before removing the category; do
  not leave a bridge-only or pane-only intermediate release.

### Hidden Native Tabs And Titlebar Controls

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): `TabBarVisibility` moved to
  `browser/components/tabbrowser/content/tab-bar-visibility.js`; the patch
  retargets there with the same condition. Verified the native tab strip stays
  hidden.
- Files or patches:
  - `patches/core-ui/02-hide-native-tabs.patch`
  - `browser/components/tabbrowser/content/tab-bar-visibility.js`
  - `browser/components/preferences/config/tabs-browsing.mjs`
  - `browser/components/preferences/tests/browser_appearance_pane.js`
  - `browser/base/content/navigator-toolbox.inc.xhtml`
  - `browser/base/content/titlebar-items.inc.xhtml`
  - `browser/themes/shared/browser-shared.css`
  - `prefs/bento.js`
- Bento functionality: hides Firefox's native horizontal tab strip while keeping
  the operating system's native window controls visible in the top chrome. The
  visible tab UI remains owned by `bento-shell`. Firefox's Browser layout group
  and native sidebar toggle are hidden from Settings and Settings search. While
  Bento's sidebar address bar is active, the native revamp launcher rail and its
  generic toolbar toggle also stay hidden even if Firefox restores a visible
  launcher from profile state; explicit native sidebar panels remain supported.
- Vanilla Firefox surface touched or depended on: `TabBarVisibility.update()`,
  `#navigator-toolbox[tabs-hidden]`, `#nav-bar.browser-titlebar`, the nav-bar
  titlebar spacer/buttonbox copy, the native titlebar commands in
  `titlebar-items.inc.xhtml`, and the config-backed `browserLayout` preferences
  group, plus `#sidebar-container`, `#sidebar-launcher-splitter`, `#sidebar-button`,
  and `#wrapper-sidebar-button`.
- Why this cannot stay extension-only: only Firefox chrome can collapse
  `#TabsToolbar`, mark the toolbox `tabs-hidden`, and promote the nav bar into
  Firefox's native titlebar/window-control state before the shell extension
  renders.
- Firefox update risk: upstream changes to `TabBarVisibility.update()`,
  titlebar-control markup, titlebar CSS, nav-bar drag-region behavior, or the
  Tabs and browsing group id can re-expose native tab/sidebar choices, re-expose
  the native tab strip, hide the native window controls, or make toolbar
  controls draggable/clickable in the wrong places.
- Regression checks for future updates: verify native window controls are
  visible and clickable, Firefox's native horizontal tab strip stays hidden,
  `sidebar.verticalTabs` remains false and no native Firefox vertical-tabs/sidebar
  launcher UI or generic sidebar toolbar button appears after persisted profile
  state is restored, explicit native sidebar panels still open without the
  launcher rail, the Browser layout group does not appear in Tabs and browsing
  or Settings search, popup windows keep Firefox's existing single-tab popup
  behavior, fullscreen/maximized/restored states swap native controls correctly,
  empty titlebar/nav-bar space drags the window, and URL bar or toolbar button
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
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): the SessionStore import uses
  `moz-src:///browser/components/sessionstore/SessionStore.sys.mjs`. The welcome
  flow shows on a fresh profile.
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js`
  - `src/browser/base/content/bento-migration-host.{html,css,js}`
  - `src/browser/base/content/bento-migration-wizard-bridge.css`
  - `patches/core-ui/09-bento-firefox-profile-first-run-import.patch`
- Bento functionality: the multi-step Bento onboarding overlay includes a
  browser-data import state. When the user chooses it, chrome code opens an
  embedded Bento chrome host that renders Firefox's reusable migration wizard for
  ordinary in-window imports and injects Bento/Mux styling into its open shadow
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
  offers every browser. Zen session conversion excludes tabs and selected
  history entries marked private, incognito, or private-window state so those
  URLs are not copied into Bento's normal profile.
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
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): `browser.nova.enabled` and
  `sidebar.revamp` default to true in 157; `prefs/bento.js` sets both false to
  keep the 154 chrome (Bento's shell owns the sidebar and tab strip). Firefox's
  `ProfileDataUpgrader` migrations (178 to 183) never write a user value for
  either pref (183 only clears `sidebar.revamp`), so plain defaults suffice and
  no `lockPref` is used. `browser.promo.focus.enabled` and
  `messaging-system.rsexperimentloader.enabled` no longer exist in the source and
  were removed. `browser.search.separatePrivateDefault` became
  `browser.search.separatePrivateDefault.enabled` (read by the `bento-privacy`
  experiment). `rust-toolchain.toml` stays at 1.94.1; Mozilla's CI for 157 uses
  1.95.0, a follow-up for `node scripts/check-rust-toolchain.mjs`.
- Files or patches:
  - `prefs/bento.js`
  - `engine/services/settings/dumps/main/search-config-v2.json`
  - `engine/third_party/application-services/components/remote_settings/dumps/main/search-config-v2.json`
  - `bento.json`
  - `branding/bento/**`
  - `configs/**`
  - `rust-toolchain.toml`
  - `.github/workflows/release.yml`
  - `.github/actions/**`
  - `scripts/check-rust-toolchain.mjs`
  - `scripts/install-branding.mjs`
  - `scripts/firefox-patch-stack.mjs`
  - `patches/experiments/**`
- Bento functionality: applies Bento defaults, DuckDuckGo fresh-profile search,
  Firefox-visible search options for Bento onboarding and Settings, branding,
  build configuration, and temporary Firefox-source build guards. Privacy defaults include strict
  tracking protection, tracker-cookie partitioning, Global Privacy Control,
  query stripping, speculative networking off, remote search suggestions off,
  local Safe Browsing on, HTTPS-only mode on, remote Safe Browsing download
  checks off by default but independently user-toggleable, DoH disabled, and
  AI/remote suggestion surfaces disabled. Release builds pin Firefox's official
  Rust 1.94.1 toolchain and use a Bento-namespaced ThinLTO opt-in on Linux and
  Windows to keep final Rust linking within standard hosted-runner memory
  limits; macOS retains upstream's default fat LTO.
- Vanilla Firefox surface touched or depended on: Firefox profile defaults,
  search service Remote Settings dumps, branding import paths, Firefox
  configure's `browser/moz.configure` environment-to-config export,
  `config/makefiles/rust.mk` release Rust flags, and patched build/runtime
  behavior covered by `patches/experiments`.
- Why this cannot stay extension-only: prefs, branding, and build behavior are
  consumed before or outside the privileged extension runtime. Fresh-profile
  default search is resolved by Firefox search configuration before Bento's
  extension UI can safely mutate it.
- Firefox update risk: upstream pref renames, search config schema changes,
  branding layout changes, build system or Rust flag changes, or obsolete
  temporary patches can silently stop applying or block security update rebases.
- Regression checks for future updates: run `pnpm run build`, confirm
  `scripts/append-prefs.sh` still appends `prefs/bento.js`, inspect branding in
  the built app, confirm fresh-profile omnibar search uses DuckDuckGo, inspect
  `about:config` for the Standard privacy defaults, confirm Firefox-visible
  search engines can be selected as default search in onboarding and Settings,
  confirm an HTTP-only destination still offers Firefox's exception UI, confirm
  remote download reputation can be toggled without changing the detected
  privacy preset,
  and re-evaluate whether each experiment patch is still needed. Run
  `pnpm run firefox:patches:test`, `pnpm run firefox:patches:check`,
  `node --test scripts/rust-thin-lto.test.mjs`, and
  `node scripts/check-rust-toolchain.mjs`; inspect Linux and Windows release
  logs for configure exporting `BENTO_RUST_LTO=thin`, generated make flags
  containing `-Clto=thin`, successful final linking, and artifact upload.
  Confirm macOS still uses the upstream default LTO path. Native object caches
  never cross Firefox versions (`.github/actions/native-cache-keys`), so the
  first manual CI build after a version bump runs cold: run it on `main`, check
  the cache summary reports a cold build, and confirm the next run restores a
  near-miss tree.
- Rollback or migration notes: remove the ThinLTO export from the Linux and
  Windows mozconfigs and the associated experiment patch together, then export,
  check, import, and invalidate the native object cache (delete the
  `bento-obj-*` entries or change the `v1` key prefix in
  `.github/actions/native-cache-keys`). Keep the Rust pin and release
  verification aligned with the Firefox release's official toolchain.

### Build Configure Flags And Updater

- Status: Active
- Last updated: 2026-10-12
- Files or patches:
  - `configs/common/mozconfig` and `configs/{linux,macos,windows}/mozconfig`
  - `scripts/bento-build.mjs` (the options appended to the generated
    `engine/mozconfig` per build mode, and the updater switch)
  - `bento.json` (`updates.enabled`, `updates.channel`, `updates.hostname`)
  - `config/release-security.json` (`updateService` readiness inputs)
  - `scripts/update-readiness.mjs`, `scripts/check-release-security.mjs`
  - `scripts/validate-bento-artifacts.mjs`, `scripts/build-release.sh`,
    `.github/workflows/release.yml`
- Bento functionality: `dev` and `debug` builds compile with
  `--disable-release` (plus `--enable-macos-target=11.0` on macOS) so they skip
  the final-crate Rust LTO link and can build Rust incrementally; `release`
  builds keep `--enable-release`, `--enable-optimize`, and `--enable-rust-simd`.
  Every mode compiles with `--disable-updater` while `bento.json`
  `updates.enabled` is `false`, because Bento does not yet have a signed update
  path. The `bento` channel (`--enable-update-channel=bento`), the MAR channel
  exports, and `MOZ_APPUPDATE_HOST` are still written so enabling the updater
  later needs no other configure change.
- Vanilla Firefox surface touched or depended on (paths recorded from the
  2026-10-12 audit; re-verify them in the target tree):
  - `--enable-release` / `--disable-release`: `moz.configure` (`developer_options`
    follows it), whose default is on for a release-milestone source tarball, which
    is why dev builds need the explicit `--disable-release`.
  - What developer options change: `config/makefiles/rust.mk` (final-crate LTO and
    `-C codegen-units=1` only when `DEVELOPER_OPTIONS` is unset),
    `build/moz.configure/rust.configure` (cargo incremental only with developer
    options), `build/moz.configure/flags.configure` (function sections and
    identical-code folding only for release), and `build/moz.configure/toolchain.configure`
    (the `--enable-macos-target` default is 11.0 normally and 10.15 under developer
    options).
  - `--disable-updater` and `MOZ_UPDATER` (`build/moz.configure/update-programs.configure`)
    and what the packager derives from it (the updater binary). The option is
    `--enable-updater` with `--with`, `--disable` and `--without` spellings
    (`python/mozbuild/mozbuild/configure/options.py`); configure keys arguments by
    name, so the last occurrence in `engine/mozconfig` wins. `MOZ_UPDATE_CHANNEL`
    is lowercased in `build/moz.configure/init.configure` before
    `toolkit/mozapps/update/updater/moz.build` compares it. Configure records the
    result as `MOZ_UPDATER` in the object directory's `config.status.json`
    (`configure.py`) beside `MOZ_UPDATE_CHANNEL`; `package` and `artifacts:check`
    read both and require the channel to be `bento.json` `updates.channel`. The
    same file defines `--enable-unverified-updates`, which sets
    `MOZ_VERIFY_MAR_SIGNATURE` off. Bento's mozconfig fragments are rejected if
    they mention the updater, unverified updates, `update-channel`,
    `MAR_CHANNEL_ID` or `ACCEPTED_MAR_CHANNEL_IDS`, so a rename of any of these
    needs `overridesUpdateSettings` in `scripts/update-readiness.mjs` updated.
  - `precomplete` is not tied to the updater: `toolkit/mozapps/installer/packager.py`
    calls `generate_precomplete` unconditionally after copying the package,
    `python/mozbuild/mozpack/packager/l10n.py` regenerates it for repacked locales,
    and `config/createprecomplete.py` writes `precomplete` (or
    `Contents/Resources/precomplete` inside a macOS bundle). The Windows installer
    and uninstaller read it (`RemovePrecompleteEntries` in
    `toolkit/mozapps/installer/windows/nsis/common.nsh`, called from
    `browser/installer/windows/nsis/installer.nsi`, `uninstaller.nsi` and
    `stub.nsh`). `artifacts:check` requires it with the updater on or off.
  - Update trust: `toolkit/mozapps/update/updater/moz.build` selects compiled-in
    certificates by `MOZ_UPDATE_CHANNEL` (Mozilla's release certificate for
    release, beta, and esr, its nightly certificates for nightly and aurora names,
    and `dep1.der` and `dep2.der` for any other channel, including `bento`), and
    `build/moz.build` plus `build/application.ini.in` default the update URL to
    `aus5.mozilla.org` because no stock configure code consumes
    `MOZ_APPUPDATE_HOST`.
- Why this cannot stay extension-only: these are compile-time configure options
  that decide what Firefox builds and whether it contains an updater.
- Firefox update risk: a renamed or removed configure option fails configure for
  every mode; a changed developer-options default silently changes dev codegen or
  the macOS deployment target; a new minimum macOS target above 11.0 breaks dev
  and debug configure until `MACOS_DEPLOYMENT_TARGET` in `scripts/bento-build.mjs`
  is raised; a changed packaging rule for `precomplete` or the updater breaks
  `package` and `artifacts:check`; a moved or renamed `MOZ_UPDATER` key in
  `config.status.json`, or a changed rule for lowercasing the update channel,
  breaks the updater-state and channel checks in `scripts/update-readiness.mjs`.
- Regression checks for future updates:
  1. Run `node --test scripts/bento-build.test.mjs scripts/release-security.test.mjs scripts/validate-bento-artifacts.test.mjs`.
  2. Run `pnpm run build` in `dev` mode, then confirm `engine/mozconfig` holds
     `ac_add_options --disable-release`, `--disable-updater`, and on macOS
     `--enable-macos-target=11.0`, and that configure printed no unknown-option or
     conflicting-option error.
  3. In the object directory's `config.status.json`, confirm the updater is off
     (`MOZ_UPDATER` is absent; `package` and `artifacts:check` fail otherwise) and
     developer options are on (`DEVELOPER_OPTIONS` set) for `dev` and `debug` and
     unset for `release`. On macOS confirm the 11.0 target in every mode:
     `-mmacosx-version-min=11.0` is in the compiler flags (`substs` `CC`, `CXX`,
     `CC_BASE_FLAGS`), and the `bento` and `XUL` binaries under
     `engine/obj-bento/dist/Bento.app/Contents/MacOS/` report `minos 11.0`
     (`otool -l <binary> | grep -A4 LC_BUILD_VERSION`, or `vtool -show-build <binary>`).
     `MACOSX_DEPLOYMENT_TARGET` is not a `config.status.json` key. If a name
     moved, find its new home in the new tree.
  4. Compare `toolchain.configure` `--enable-macos-target`: its default and minimum
     must still allow 11.0.
  5. Run `BENTO_BUILD_MODE=release pnpm run build` (or a manual CI build) and
     `pnpm run package`; confirm the package has no updater, that `precomplete` is
     still present in the application (root, or `Contents/Resources` on macOS), and
     that `pnpm run artifacts:check` passes with no MAR or update XML.
     Re-confirm that `packager.py` still generates `precomplete` unconditionally.
  6. Re-read the update-trust paths above. If the updater is enabled in the target
     state, re-check cert selection and the update URL before trusting it.
- Reused object directories: reconfiguring an `obj-bento` that was built with the
  updater keeps updater leftovers. The dev tree's `chrome.manifest` keeps a
  `nsUpdateService.manifest` line (an info-level "Could not read chrome manifest"
  console message) and `dist/Bento.app/Contents/MacOS/updater.app` stays. The
  packaged app has neither, so judge the updater's absence from the packaged app or
  a fresh `BENTO_OBJDIR`, not from a reused dev tree.
- Rollback or migration notes: to restore release policy in dev builds, move
  `--enable-release` back into `configs/common/mozconfig` and drop the
  `--disable-release` branch in `modeOptions`; invalidate the native object cache.
  To ship the updater, follow "Re-enabling the updater" in
  [build-tooling.md](build-tooling.md) and add the new surfaces (certificate
  patch, update-host wiring, MAR signing) to this entry.

### About Pane Updates Group

- Status: Active
- Last updated: 2026-10-12
- Firefox 157.0.1 review (2026-10-12): the patch applies with offsets; its test
  hunk follows the upstream `controlEl` change.
- Files or patches:
  - `patches/core-ui/16-hide-updates-group-without-updater.patch`
    (`browser/components/preferences/config/about-firefox.mjs`, and the
    upstream test `browser/components/preferences/tests/browser_updates_managed_by_os.js`)
- Bento functionality: builds without the updater (`--disable-updater` while
  `bento.json` `updates.enabled` is `false`) show no Updates group in the About
  pane: no heading, description, or "Updates are managed by your operating
  system" message bar, and Settings search finds nothing in it. That message is
  false for Bento. With the updater built in, the group behaves as upstream,
  including the packaged-app message.
- Vanilla Firefox surface touched or depended on: `about-firefox.mjs` registers
  the `updates` setting group with `SettingGroupManager`; the patch adds
  `hidden: !AppConstants.MOZ_UPDATER` and `hiddenFromSearch: !AppConstants.MOZ_UPDATER`
  to that config, the group-level idiom other config files use (`tabs-browsing.mjs`
  sets both on `browserLayout`). It depends on
  `widgets/setting-group/setting-group.mjs` applying `config.hidden` as
  `data-hidden-by-setting-group` (`display: none !important` in
  `setting-group.css`) and `config.hiddenFromSearch` as `data-hidden-from-search`,
  and skipping `handleVisibilityChange` for a hidden group. `hidden` alone does not
  stop Settings search: `findInPage.js` skips such a group in its per-group pass
  (`BASE_SELECTOR`), but its whole-pane fallback (`searchWithinNode` on the
  setting-pane, via `searchChildNodeIfVisible`) only checks `.hidden` and the
  parent's `data-hidden-from-search`, so only `data-hidden-from-search` keeps the
  group's text out of that fallback. The top-level `paneGeneral` copy in
  `main.inc.xhtml` is excluded from search by the same attribute (the
  `#mainPrefPane > *:not([data-hidden-from-search] ...)` query). The patch also
  depends on `AppConstants.MOZ_UPDATER` mirroring the configure option. Upstream
  shows `updatesManagedByOS` whenever `!UpdatesHelpers.showUpdatesSettings`, which
  includes every build without an updater. The patch also changes the upstream
  test `browser_updates_managed_by_os.js` to expect the group hidden and carrying
  `data-hidden-from-search="true"` in that case.
- Why this cannot stay extension-only: the group is registered and rendered by
  Firefox's own Settings module, and Bento's `bento.mjs` is not loaded for the
  About pane, so reaching into another module's registered config would depend on
  load order.
- Firefox update risk: a renamed or reshaped `updates` group, a changed meaning of
  `hidden` or `hiddenFromSearch` in `SettingGroup` or in `findInPage.js`, or a
  moved `updatesManagedByOS` setting makes the patch fail to apply or silently
  bring back the false message or the search result. The version line
  (`updateAppInfo`) lives inside the group's `updateApp` box, which upstream already
  hides without an updater, so the About pane shows no version in these builds.
- Regression checks for future updates:
  1. `pnpm run firefox:patches:check` replays the patch on the new base.
  2. In a dev build, open `about:preferences#about` and confirm the page shows
     only the support group: no "Updates" heading, description, or message bar. Search
     Settings for "update" and for "managed by your operating system" and confirm
     neither surfaces Updates text. In the regular DevTools console of that page
     (Cmd+Opt+I), confirm
     `document.querySelector('setting-group[groupid="updates"]').getAttribute("data-hidden-from-search")`
     returns `"true"`.
  3. Re-read `setting-group.mjs` (`willUpdate`, `handleVisibilityChange`),
     `findInPage.js` (the per-group `BASE_SELECTOR` pass, the whole-pane fallback,
     `searchChildNodeIfVisible`) and `about-firefox.mjs` (`updatesManagedByOS`,
     `updateApp`, the `updates` group) for changes to `hidden` or
     `hiddenFromSearch` handling or to which settings the group renders.
  4. Mochitests are not built (`--disable-tests`). In a test-enabled build, run
     `browser_updates_managed_by_os.js` (listed in `browser-srd.toml`) with the
     updater off and on.
- Rollback or migration notes: drop the patch and its `series.json` entry to
  restore upstream behavior. Enabling the updater needs no change here: the
  condition follows `AppConstants.MOZ_UPDATER`.

### Built-In Extension Copy Surface

- Status: Active
- Last updated: 2026-10-12
- Files or patches:
  - `scripts/install-builtin-addons.mjs`
  - `scripts/install-builtin-addons.test.mjs`
  - `scripts/dev-reload.mjs`
  - `scripts/dev-reload.test.mjs`
  - `scripts/build-mode.mjs`
  - `package.json`
  - `pnpm-lock.yaml`
  - `scripts/import.sh`
  - `scripts/build-bento.sh`
  - `scripts/sync-builtin-addon-symlinks.sh`
  - `extensions/ublock-origin/.bento-runtime-entries.json`
  - `extensions/bento-tools/experiments/bento-privacy/**`
  - `extensions/bento-tools/experiments/bento-native-preferences/**`
  - `extensions/bento-shell/experiments/chrome-bridge/**`
- Bento functionality: Bento's independent installer packages its privileged
  built-in extensions and the bundled uBlock Origin extension into Firefox's
  `builtin-addons/` runtime location. The copy step lets an extension declare a
  per-extension runtime entry list so uBlock Origin keeps its required `js/`,
  `css/`, `lib/`, `assets/`, locale, and HTML entry files without broadening the
  copy surface of Bento's own source-based extensions. Release builds keep
  `MOZ_REQUIRE_SIGNING=1`; Bento-owned privileged add-ons use Firefox's built-in
  location rather than weakening ordinary XPI signature enforcement. Release
  imports copy manifests without the shell's dev-only `dev-reload` command, so
  an imported release manifest differs from its source.
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
  includes both tools experiments and the shell jar includes the chrome bridge, confirm
  `engine/browser/extensions/ublock-origin/jar.mn` includes uBO's `js/`, `css/`,
  `lib/`, and `assets/` folders, launch a fresh build, and verify `about:addons`
  shows Bento Tools, Bento Shell, and uBlock Origin. Run
  `BENTO_RELEASE=1 pnpm run ext:build && BENTO_RELEASE=1 pnpm run import` and
  confirm `pnpm run release:security-check:shell` passes (no `dev-reload` in the
  imported shell manifest or bundle). A release `pnpm run package` also scans the
  shell add-on in the object directory (`dist/bin/browser` and, on macOS, the app
  bundle, following symlinks); after a Firefox update that changes where `mach
  build` installs built-in add-ons, confirm that scan still finds the add-on
  (it fails when it finds none). Running only the source
  overlay helper does not prove this surface is valid because it bypasses
  Bento's branding, built-in add-on installer, patch, and symlink steps.
- Rollback or migration notes: if uBlock Origin is removed, remove
  `extensions/ublock-origin/` and its runtime-entry file. Keep the installer in
  Bento while Bento bundles privileged built-in extensions.

## Private And Internal Firefox Members

The firefox-compat registry lists every Firefox member Bento depends on that is
private or internal upstream: underscore and `on_*` methods, private-field
accessors, prototype patches, lazy chrome globals, module URLs, chrome DOM ids,
the events Firefox dispatches that Bento listens to, and markup contracts. It
also lists the members that code added by a patch calls elsewhere in Firefox. It
lives in `scripts/firefox-compat-registry.mjs`,
a repo-only module that is never shipped, so no browser window parses it. Each
entry records the member, what Bento does with it, where Bento uses it, how it
is detected (probe `R` or engine-only `E`), and where vanilla Firefox
defines it (the version is `BASELINE`, shown in the table header). The table
below is generated; edit the registry, then run
`node scripts/check-firefox-compat.mjs --write-docs`.

- Runtime. The `@bento-firefox-compat` section of
  `src/browser/base/content/bento-shell-mount.js` carries only a compact list
  (ids and a presence check) of the entries marked runtime, plus the probe
  runner, under 10 KB with no call-site, use, or locator text. After Firefox's
  delayed startup, each window probes the list once and logs one
  `console.error('[bento-compat] missing <id>')` per absent member plus one
  `[bento-compat] probed N members on Firefox <platform version>: M missing, D deferred`
  line, where the version is `Services.appinfo.platformVersion` (the Gecko
  version such as `154.0`), not Bento's own app version. It never throws and
  changes no behavior; the guarded hooks keep skipping silently.
  The probe is passive. It reads every property through
  `Object.getOwnPropertyDescriptor` along the prototype chain and never calls
  an accessor, so a lazy window global (`gURLBar`, `PopupNotifications`,
  `PanelUI`, `PanelMultiView`, `DownloadsPanel`, `PlacesUIUtils`, and the rest
  Firefox defines with `defineLazyGetter`, `defineLazyScriptGetter`, or
  `defineESModuleGetters`) stays unloaded. It imports a module only after
  `Cu.isESModuleLoaded(url)` is true. The selected tab and a `<browser>` come
  from native DOM calls (`.tabbrowser-tab[selected]`, `browser`,
  `customElements.get('browser')`), not from the `gBrowser.selectedTab` getter.
  A member whose descriptor exists anywhere on the prototype chain, data or
  accessor, is present: passive means never invoking an accessor, not ignoring
  one (`tab.linkedPanel` is a get/set pair on the `MozTab` prototype). A method
  found as a data property must be a function; one found as an accessor counts
  as present because it cannot be call-checked without running the getter.
  Each entry ends in one of three outcomes: present; missing (the owner or the
  member is absent, including a lazy global with no property at all); or
  deferred (the owner, or a step on the way to it, is still an untriggered
  accessor, a module is not loaded yet, `PrivateDownloadsSubview` before the
  downloads script loads, or the window has not finished delayed startup).
  Deferred is not an error: the entry is probed by a later check once the owner
  has loaded. `window.BentoFirefoxCompat.check()` re-runs it from the Browser
  Toolbox and returns `{ probed, present, missing, deferred }`, the last three
  as id lists. Entries marked engine only have no runtime probe (events,
  markup, fields assigned late, elements that stay inside an `<html:template>`
  until their owner expands them, such as `identity-popup`, members of other
  documents). Look up a logged id in the table below for what Bento does with
  it.
- Replaced members. Bento wraps or shadows some Firefox members, which would
  satisfy a presence probe by themselves. Each patch site calls
  `bentoCompatNoteNative(id, original)` before replacing (registry
  `native: 'note'`) and the probe judges that recorded original, so a missing
  `PopupNotifications._isActiveBrowser` is reported even though Bento's wrapper
  exists. Members Bento only assigns or shadows on instances
  (`tabpanels.splitViewPanels`, the per-tab `splitview` getter) are looked up on
  the prototype instead (`native: 'proto'`).
- Upgrade validation. `pnpm run firefox:compat:engine` greps the `engine/` tree
  for each entry's definition and exits non-zero listing the members that are
  gone, plus modules that are no longer registered. Run it against the target
  source before rebasing patches and again after `pnpm run import`. Add
  `--verbose` for the line each member now has. After an upgrade, update the
  `at` lines and `BASELINE` in the registry module, then regenerate this table.
- Consistency. `pnpm run firefox:compat:check` (also run by
  `scripts/check-firefox-compat.test.mjs` in CI) fails when an entry is
  malformed, a call site named by an entry no longer exists, the mount probe
  list differs from the registry's `R` entries (ids, kinds, module exports), a
  wrapped or overridden runtime entry has no
  `bentoCompatNoteNative` call or prototype lookup, the mount script reaches an
  underscore or `on_*`
  member of a known Firefox global that has no entry, or this table is stale.
  The member scan follows direct access (`gBrowser._x`, `window.gBrowser._x`)
  and a local alias declared as `const gb = window.gBrowser;` (also `let`,
  `var`, or a trailing `??` / `||`) until its block ends by indentation. It does
  not follow destructuring, function parameters, bracket access, or values
  returned by helpers, so give such a use its entry by hand.
- Adding a hook. Add its entry to `scripts/firefox-compat-registry.mjs` in the
  same change, add its id to the mount probe list when its probe is `R`, call
  `bentoCompatNoteNative` before replacing a Firefox member, and regenerate
  this table. A new `addEventListener` for an event Firefox
  dispatches, a new underscore member a patch calls, or a new query parameter
  Bento sends to a Firefox page gets an engine-only entry located at the
  dispatch, definition, or parsing site.
- Not listed. Stable platform APIs (`Services.*`, `PlacesUtils`, `SessionStore`
  calls, `<browser>` navigation such as `loadURI`, XPCOM interface constants
  such as `Ci.nsIWebProgress.NOTIFY_ALL`, the WebExtension API), prefs
  read by name, and the CSS selectors in `injectChromeStyles`. Patches are
  covered by `pnpm run firefox:patches:check`; members that code added by a
  patch calls elsewhere in Firefox are listed here.

<!-- prettier-ignore-start -->
<!-- firefox-compat:begin -->

| Member | Kind | Bento use | Used in | Firefox 157.0.1 source |
| --- | --- | --- | --- | --- |
| `delayedStartupPromise` | member (runtime) | Schedules the compat probes after Firefox finishes delayed startup. | `scheduleBentoFirefoxCompatChecks` | `browser/base/content/browser-init.js:6` |
| `gBrowser.on_visibilitychange` | method (runtime) | No-ops while split view is active so Firefox does not deactivate panel docShells. | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9257` |
| `gBrowser._findTabToBlurTo` | method (runtime) | Excludes panel and other-workspace tabs when Firefox picks the next selected tab. | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7013` |
| `gBrowser.insertBrowser` | method (runtime) | Materializes restored pending panel tabs without selecting them (public since 157; _insertBrowser before). | `materializePanelTab` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3245` |
| `MozTabbrowserTab.isEmpty` | member (runtime) | Prototype getter wrapped so a panel browser with no browsingContext reads as not empty. | `attachTabSelectListener` | `browser/components/tabbrowser/content/tab.js:288` |
| `MozTabbrowserTab.splitview` | member (runtime) | Prototype getter shadowed per tab with Object.defineProperty to carry the Bento split marker. | `reconcilePanelsSplitView`, `makeSplitViewMarker` | `browser/components/tabbrowser/content/tab.js:406` |
| `MozBrowser.prototype.removeProgressListener` | method (runtime) | Swallows NS_ERROR_FAILURE from removing a listener on a browser that is being torn down. | `attachTabSelectListener`, `isStaleWebProgressRemoveError` | `toolkit/content/widgets/browser-custom-element.mjs:987` |
| `gBrowser.showSplitViewPanels` | method (runtime) | Lays the main tab and panel tabs into tabpanels as split-view panels. | `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:4090` |
| `gBrowser.activeSplitView` | member (runtime) | Getter over the private #activeSplitView field; lists browsers that count as visible. | `patchPopupNotificationsForSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:484` |
| `gBrowser.on_TabSplitViewActivate` | method (runtime) | Bento dispatches TabSplitViewActivate so Firefox stores its marker in #activeSplitView. | `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9320` |
| `gBrowser.on_TabSplitViewDeactivate` | method (runtime) | Bento dispatches TabSplitViewDeactivate with the same marker object (identity check) to clear it. | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9325` |
| `gBrowser.warmupTab` | method (runtime) | Recreates the AsyncTabSwitcher that destroys itself after each tab switch. | `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9028` |
| `gBrowser.tabpanels.splitViewPanels` | member (runtime) | Setter marks panel ids as split-view panels (class, column attribute, [splitview], listeners). | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `toolkit/content/widgets/tabbox.js:530` |
| `gBrowser.tabpanels.removeTabsFromSplitview` | method (runtime) | Removes departing tabs from the split view and strips their split-view panel classes. | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `toolkit/content/widgets/tabbox.js:557` |
| `gBrowser.tabpanels.handleEvent` | method (runtime) | Bento removes tabpanels itself as the click/focus listener Firefox registers on each panel's browser container (removeEventListener with the tabpanels object, which dispatches to handleEvent). | `reconcilePanelsSplitView` | `toolkit/content/widgets/tabbox.js:540` |
| `tabpanels split-view-panel classes` | source (engine only) | Bento styles and cleans .split-view-panel, .split-view-panel-active and the column attribute. | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `toolkit/content/widgets/tabbox.js:533` |
| `tabpanels [splitview] attribute` | source (engine only) | setSplitViewActive toggles [splitview]; Bento CSS and on_visibilitychange read it. | `forceMainOnlyChromeState`, `attachTabSelectListener` | `toolkit/content/widgets/tabbox.js:607` |
| `split-view-footer element` | source (engine only) | showSplitViewPanels inserts a footer into each panel; Bento removes it. | `applySubdivisions` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:4116` |
| `.browserContainer panel structure` | source (engine only) | Bento finds a panel browser as :scope > .browserContainer browser inside the tab panel. | `reconcilePanelsSplitView`, `getLivePanelBrowser` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3120` |
| `gBrowser.tabpanels` | member (runtime) | The #tabbrowser-tabpanels element hosting every panel; attachTabSelectListener waits for it. | `attachTabSelectListener`, `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:238` |
| `gBrowser.tabContainer` | member (runtime) | Receives TabSelect/TabOpen listeners; attachTabSelectListener waits for it. | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:234` |
| `MozTabbrowserTab.linkedPanel` | member (runtime) | Id of the tab panel (a get/set accessor on the MozTab prototype); Bento resolves it with getElementById to reach the panel DOM. | `reconcilePanelsSplitView`, `getLivePanelBrowser` | `toolkit/content/widgets/tabbox.js:831` |
| `Element.prototype.moveBefore` | method (runtime) | Re-parents #tabbrowser-tabbox and #bento-side-panel-host at startup without recreating the frameloader of the first tab browser (no pref gate in 154); insertBefore is the fallback. | `moveNodeBefore` | `dom/webidl/ParentNode.webidl:34` |
| `MozBrowser.connectedMoveCallback` | source (engine only) | moveBefore on a browser element ends in this no-op callback instead of destruct() and construct(). | `moveNodeBefore` | `toolkit/content/widgets/browser-custom-element.mjs:428` |
| `XULFrameElement UnbindFromTree IsMove` | source (engine only) | UnbindFromTree keeps the frameloader when the unbind is a move; insertBefore and appendChild destroy it. | `moveNodeBefore` | `dom/xul/XULFrameElement.cpp:165` |
| `gBrowser.addTrustedTab` | method (runtime) | Opens privileged URLs (about:preferences, devtools toolbox) that tabs.create rejects. | `openTrustedAddrbarNewTab`, `openDevtoolsPanelFor` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3561` |
| `gBrowser.addTab` | method (runtime) | Creates the tab behind a new panel with the add-as-panel marker URL. | `addNewPanel` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3684` |
| `gBrowser.getTabForBrowser` | method (runtime) | Maps a panel browser to its tab; patch 04 uses it to inspect the right-clicked panel. | `getTabForPanelHistoryBrowser`, `installInspectInPanelMenuItems`, `patches/core-ui/04-inspect-panel-browser.patch#getTabForBrowser` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:1321` |
| `gBrowser.selectedBrowsers` | member (runtime) | Patch 11 lets DOM fullscreen requests come from any browser active in the split. | `patches/core-ui/11-dom-fullscreen-splitview-browser.patch#selectedBrowsers` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:638` |
| `gBrowser.moveTabBefore` | method (runtime) | Sidebar drag-reorder; skips the moveTabTo path that reads element.splitview. | `handleTabMoveTitle` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7965` |
| `gBrowser.moveTabAfter` | method (runtime) | Sidebar drag-reorder; skips the moveTabTo path that reads element.splitview. | `handleTabMoveTitle` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7987` |
| `MozBrowser.prototype.docShellIsActive` | member (runtime) | Bento forces panel docShells active after Firefox deactivates them. | `reconcilePanelsSplitView` | `toolkit/content/widgets/browser-custom-element.mjs:523` |
| `MozBrowser.prototype.renderLayers` | member (runtime) | Bento re-enables layer rendering for panel browsers after a failed split-view layout. | `reconcilePanelsSplitView` | `toolkit/content/widgets/browser-custom-element.mjs:540` |
| `MozBrowser.prototype.preserveLayers` | method (runtime) | Called before deactivating a panel docShell so it repaints without a blank frame. | `reconcilePanelsSplitView` | `toolkit/content/widgets/browser-custom-element.mjs:951` |
| `MozBrowser.prototype.messageManager` | member (runtime) | Loads Bento frame scripts into extension and panel browsers. | `installPanelNavigatorTooltipFrameScript`, `ensurePanelScrollFrameScript` | `toolkit/content/widgets/browser-custom-element.mjs:581` |
| `MozBrowser.prototype.contentTitle` | member (runtime) | The title-IPC handler reads frame.contentTitle after pagetitlechanged. | `attachPaletteCloseListener` | `toolkit/content/widgets/browser-custom-element.mjs:674` |
| `MozBrowser.mIconURL` | member (runtime) | Panel header favicon fallback reads the browser mIconURL field. | `createPanelHeader` | `toolkit/content/widgets/browser-custom-element.mjs:140` |
| `MessageManager.loadFrameScript` | source (engine only) | Bento injects data: URL frame scripts into its own extension frames and panel browsers. | `ensurePanelScrollFrameScript`, `installPanelNavigatorTooltipFrameScript`, `SHELL_ACTION_FRAME_SCRIPT_URL` | `dom/chrome-webidl/MessageManager.webidl:368` |
| `pagetitlechanged` | source (engine only) | Chrome-only bubbling event on the embedding <browser>; the title-IPC control plane. | `attachPaletteCloseListener` | `dom/ipc/WindowGlobalParent.cpp:563` |
| `PopupNotifications._isActiveBrowser` | method (runtime) | Also accepts browsers of split-view panel tabs so panel-originated popups show. | `patchPopupNotificationsForSplitView` | `toolkit/modules/PopupNotifications.sys.mjs:1666` |
| `PanelUI.ensureReady` | method (runtime) | Builds the app menu before Bento anchors it to a sidebar footer button. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:560` |
| `PanelUI.panel` | member (runtime) | The app menu popup element, created from kElements during PanelUI.init. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:112` |
| `PanelUI.show` | method (runtime) | Fallback that opens the app menu when no sidebar anchor can be built. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:351` |
| `PanelUI.hide` | method (runtime) | Toggles the app menu closed when its sidebar button is clicked again. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:386` |
| `PanelUI._ensureShortcutsShown` | method (runtime) | Refreshes keyboard-shortcut labels before the app menu opens (optional call). | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:1400` |
| `PanelMultiView.openPopup` | method (runtime) | Opens native panels (app menu, downloads, identity) at a sidebar anchor. | `openNativeAppMenuFromSidebar`, `openNativeDownloadsPanelFromSidebar`, `openNativeIdentityPopupForSidebar` | `browser/components/customizableui/PanelMultiView.sys.mjs:393` |
| `PanelMultiView.hidePopup` | method (runtime) | Closes other open panels before the identity popup opens. | `openNativeIdentityPopupForSidebar` | `browser/components/customizableui/PanelMultiView.sys.mjs:417` |
| `DownloadsButton.getAnchor` | method (runtime) | Automatic downloads panel opens anchor to a sidebar fallback element. | `patchDownloadsButtonAnchorForSidebar` | `browser/components/downloads/content/indicator.js:100` |
| `DownloadsButton.releaseAnchor` | method (runtime) | Removes the sidebar fallback anchor when Firefox releases the downloads anchor. | `patchDownloadsButtonAnchorForSidebar` | `browser/components/downloads/content/indicator.js:113` |
| `DownloadsPanel.initialize` | method (runtime) | Initializes the downloads panel before Bento opens it from the sidebar. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:79` |
| `DownloadsPanel.panel` | member (runtime) | The downloads popup element Bento anchors to the sidebar. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:174` |
| `DownloadsPanel.isPanelShowing` | member (runtime) | Detects an already open downloads panel to focus it instead of reopening. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:234` |
| `DownloadsPanel.showPanel` | method (runtime) | Fallback that opens the downloads panel natively when no sidebar anchor exists. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:185` |
| `DownloadsPanel._focusPanel` | method (runtime) | Focuses the downloads panel after it opens (optional call). | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:569` |
| `DownloadsPanel._openedManually` | source (engine only) | Field set before initialize() to mimic a manual open; showPanel assigns it, so no runtime probe. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:190` |
| `DownloadsPanel._preventFocusRing` | source (engine only) | Field set before initialize() to suppress the focus ring; showPanel assigns it, so no runtime probe. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:191` |
| `DownloadsView.loading` | member (runtime) | Bento waits for the downloads view to finish loading before opening the panel. | `waitForDownloadsViewReady` | `browser/components/downloads/content/downloads.js:756` |
| `DownloadsView._visibleViewItems` | member (runtime) | Map of visible download items; Bento refreshes each before showing the panel. | `openNativeDownloadsPanelFromSidebar` | `browser/components/downloads/content/downloads.js:771` |
| `PrivateDownloadsSubview.openWhenReady` | method (runtime) | Shows the private-downloads choice subview when the sidebar opens the panel. | `openPrivateDownloadsChoiceIfNeeded` | `browser/components/downloads/content/downloads.js:1839` |
| `gIdentityHandler._initializePopup` | method (runtime) | Builds the identity popup before Bento anchors it to the sidebar (optional call). | `openNativeIdentityPopupForSidebar` | `browser/base/content/browser-siteIdentity.js:206` |
| `gIdentityHandler._identityPopup` | member (runtime) | The identity popup element (falls back to getElementById when absent). | `openNativeIdentityPopupForSidebar` | `browser/base/content/browser-siteIdentity.js:254` |
| `gIdentityHandler.refreshIdentityPopup` | method (runtime) | Refreshes the identity popup contents for the selected tab (optional call). | `openNativeIdentityPopupForSidebar` | `browser/base/content/browser-siteIdentity.js:1037` |
| `gURLBar.view` | member (runtime) | Bento closes the native urlbar results view when its own address bar opens. | `closeNativeUrlbarPopup` | `browser/components/urlbar/content/UrlbarInputBase.mjs:425` |
| `gURLBar.view.close` | method (runtime) | Closes the native urlbar results view (optional call). | `closeNativeUrlbarPopup` | `browser/components/urlbar/content/UrlbarView.mjs:667` |
| `gURLBar.untrimmedValue` | member (runtime) | Sidebar address row shows the urlbar display value for the selected tab. | `readSidebarAddressDisplayUrl` | `browser/components/urlbar/content/UrlbarInputBase.mjs:3094` |
| `gURLBar.value` | member (runtime) | Fallback display value for the sidebar address row. | `readSidebarAddressDisplayUrl` | `browser/components/urlbar/content/UrlbarInputBase.mjs:3086` |
| `OpenBrowserWindow` | method (runtime) | Opens an unsynced window; the options bag reaches BrowserWindowTracker.openWindow (patch window-sync/01). | `bentoSyncedWindow` | `browser/base/content/browser.js:1726` |
| `gContextMenu.linkURL` | source (engine only) | Open in New Panel reads the right-clicked link from the global context menu object. | `installOpenInNewPanelMenuItem` | `browser/base/content/nsContextMenu.sys.mjs:250` |
| `gContextMenu.onLink` | source (engine only) | Open in New Panel shows only for link targets. | `installOpenInNewPanelMenuItem` | `browser/base/content/nsContextMenu.sys.mjs:261` |
| `gContextMenu.browser` | source (engine only) | Resolves the panel container the context menu opened in; patch 04 resolves its tab. | `installOpenInNewPanelMenuItem`, `installInspectInPanelMenuItems` | `browser/base/content/nsContextMenu.sys.mjs:300` |
| `gContextMenu.targetIdentifier` | source (engine only) | Content DOM reference passed to the devtools inspector for Inspect in Panel. | `installInspectInPanelMenuItems` | `browser/base/content/nsContextMenu.sys.mjs:275` |
| `PlacesUIUtils.lastContextMenuTriggerNode` | member (runtime) | Trigger node of the Places context menu, used to read managed-bookmark URLs. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/PlacesUIUtils.sys.mjs:357` |
| `placesContext._view` | source (engine only) | placesContextShowing stashes the resolved view on the menupopup; Bento reads its selectedNode. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/PlacesUIUtils.sys.mjs:1470` |
| `searchBookmarks` | source (engine only) | Bento injects a search box into the native bookmarks sidebar and calls its filter function. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.js:144` |
| `bookmarks-view` | source (engine only) | Tree of the native bookmarks sidebar document that Bento re-queries. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.xhtml:69` |
| `sidebar-search-container` | source (engine only) | Container in the bookmarks sidebar document that receives Bento’s search box. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.xhtml:62` |
| `search-box` | source (engine only) | Native bookmarks sidebar search input that Bento replaces. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.xhtml:63` |
| `browser` | element (runtime) | Root hbox that holds the Bento host elements added by patch chrome-layout/01. | `attachSidebarChromeDivider`, `attachHiddenSidebarHoverZone` | `browser/base/content/browser-box.inc.xhtml:5` |
| `tabbrowser-tabbox` | element (runtime) | Tabbox that holds tabpanels; Bento tags it as the main panel when no side panels exist. | `unifyMainWithStrip`, `configureSidePanelOnce` | `browser/base/content/browser-box.inc.xhtml:28` |
| `sidebar` | element (runtime) | Native sidebar <browser>; Bento themes the documents loaded in it. | `syncNativeSidebarChromeTheme`, `attachNativeSidebarChromeThemeSync` | `browser/base/content/browser-box.inc.xhtml:24` |
| `sidebar-box` | element (runtime) | Native Bookmarks/History sidebar container; Bento drives its width, persistence and splitter feedback. | `attachNativeSidebarSplitterFeedback` | `browser/base/content/browser-box.inc.xhtml:12` |
| `sidebar-splitter` | element (runtime) | Native sidebar splitter whose resize behavior Bento replaces. | `attachNativeSidebarSplitterFeedback` | `browser/base/content/browser-box.inc.xhtml:27` |
| `navigator-toolbox` | element (runtime) | Native toolbox whose separators and offsets Bento adjusts. | `attachSidebarChromeDivider` | `browser/base/content/navigator-toolbox.inc.xhtml:5` |
| `nav-bar` | element (runtime) | Native navigation toolbar; Bento aligns its controls with the Bento sidebar. | `attachToolbarNavigationAlignment`, `getPanelNavigatorToolbarTarget` | `browser/base/content/navigator-toolbox.inc.xhtml:109` |
| `nav-bar-customization-target` | element (runtime) | Toolbar item container observed for placement changes. | `attachToolbarNavigationAlignment`, `getPanelNavigatorToolbarTarget` | `browser/base/content/navigator-toolbox.inc.xhtml:127` |
| `urlbar` | element (runtime) | Native urlbar; Bento intercepts pointer and focus events on it and opens its own address overlay. | `attachTopUrlbarModalListener` | `browser/base/content/navigator-toolbox.inc.xhtml:165` |
| `urlbar-input` | source (engine only) | Native urlbar text input; Bento blurs it and opens its own address overlay instead. | `attachTopUrlbarModalListener` | `browser/components/urlbar/content/UrlbarInputBase.mjs:407` |
| `stop-reload-button` | source (engine only) | Native toolbar button positioned with the back/forward cluster; user-customizable, so no runtime probe. | `attachToolbarNavigationAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:142` |
| `back-button` | source (engine only) | Native back button aligned with the Bento sidebar edge; user-customizable, so no runtime probe. | `attachToolbarNavigationAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:128` |
| `forward-button` | source (engine only) | Native forward button aligned with the Bento sidebar edge; user-customizable, so no runtime probe. | `attachToolbarNavigationAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:135` |
| `identity-box` | element (runtime) | Native identity box that Bento reads for security state. | `readSidebarAddressSecurity` | `browser/base/content/navigator-toolbox.inc.xhtml:216` |
| `identity-icon` | element (runtime) | Native identity icon read for the sidebar security button. | `readSidebarAddressSecurity` | `browser/base/content/navigator-toolbox.inc.xhtml:230` |
| `identity-icon-label` | element (runtime) | Native identity label read for the sidebar security button. | `readSidebarAddressSecurity` | `browser/base/content/navigator-toolbox.inc.xhtml:231` |
| `identity-popup` | source (engine only) | Native identity panel that Bento opens at a sidebar anchor. It sits inside template-identity-popup until gIdentityHandler._initializePopup() expands it, which Bento calls first. | `openNativeIdentityPopupForSidebar` | `browser/components/controlcenter/content/identityPanel.inc.xhtml:5` |
| `PersonalToolbar` | element (runtime) | Native bookmarks toolbar aligned with the panel strip start edge. | `attachBookmarksToolbarAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:544` |
| `mainPopupSet` | element (runtime) | Popup set that hosts the Bento chrome menus. | `ensurePanelHistoryPopup` | `browser/base/content/main-popupset.inc.xhtml:5` |
| `contentAreaContextMenu` | element (runtime) | Content context menu that receives the Open in New Panel and Inspect in Panel items. | `installOpenInNewPanelMenuItem`, `installInspectInPanelMenuItems` | `browser/base/content/main-popupset.inc.xhtml:657` |
| `placesContext` | element (runtime) | Places context menu that receives Open in New Panel. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:5` |
| `context-openlink` | source (engine only) | Anchor item after which Open in New Panel is inserted. | `installOpenInNewPanelMenuItem` | `browser/base/content/browser-context.inc.xhtml:99` |
| `context-openlinkincurrent` | source (engine only) | Fallback anchor item for Open in New Panel. | `installOpenInNewPanelMenuItem` | `browser/base/content/browser-context.inc.xhtml:70` |
| `context-inspect` | source (engine only) | Native Inspect item that Bento clones as Inspect in Panel. | `installInspectInPanelMenuItems` | `browser/base/content/browser-context.inc.xhtml:450` |
| `context-inspect-a11y` | source (engine only) | Native accessibility Inspect item that Bento clones as Inspect in Panel. | `installInspectInPanelMenuItems` | `browser/base/content/browser-context.inc.xhtml:446` |
| `placesContext_open:newcontainertab` | source (engine only) | Preferred anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:28` |
| `placesContext_openContainer:tabs` | source (engine only) | Fallback anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:36` |
| `placesContext_openLinks:tabs` | source (engine only) | Fallback anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:41` |
| `placesContext_open:newwindow` | source (engine only) | Fallback anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:46` |
| `placesContext_openSeparator` | source (engine only) | Last-resort anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:73` |
| `moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs` | module (runtime) | Supplies URI fixup primitives for sanitizing clipboard text in the new-tab address suggestion. | `getAddrbarUrlbarUtils` | `browser/components/urlbar/UrlbarUtils.sys.mjs:75` |
| `UrlbarUtils.getFixupPrimitives` | source (engine only) | Parent-only URI fixup info that the clipboard sanitizer takes as its second argument. | `sanitizeClipboardUrlText` | `browser/components/urlbar/UrlbarUtils.sys.mjs:507` |
| `chrome://browser/content/urlbar/UrlbarShared.mjs` | module (runtime) | Home of the clipboard sanitizer since 157 (UrlbarUtils.sanitizeTextFromClipboard before). | `getAddrbarUrlbarShared` | `browser/components/urlbar/content/UrlbarShared.mjs:80` |
| `UrlbarShared.sanitizeTextFromClipboard` | source (engine only) | Clipboard sanitizer; Bento falls back to stripping line breaks when it is absent. | `sanitizeClipboardUrlText` | `browser/components/urlbar/content/UrlbarShared.mjs:970` |
| `moz-src:///toolkit/components/search/SearchService.sys.mjs` | module (runtime) | Search engine lookup for one-shot address-bar searches and the search settings API. | `getAddrbarSearchService`, `extensions/bento-tools/experiments/bento-privacy/api.js#SearchService` | `toolkit/components/search/SearchService.sys.mjs:95` |
| `SearchService.promiseInitialized` | source (engine only) | Awaited before any engine lookup. | `getAddrbarSearchService`, `extensions/bento-tools/experiments/bento-privacy/api.js#ensureSearchReady` | `toolkit/components/search/SearchService.sys.mjs:292` |
| `SearchService.getEngineById` | source (engine only) | Resolves a search engine by id. | `getAddrbarSearchService`, `extensions/bento-tools/experiments/bento-privacy/api.js#getEngine` | `toolkit/components/search/SearchService.sys.mjs:398` |
| `SearchService.getDefault` | source (engine only) | Reads the default engine for the search settings. | `extensions/bento-tools/experiments/bento-privacy/api.js#getDefaultSearchEngine` | `toolkit/components/search/SearchService.sys.mjs:179` |
| `SearchService.getVisibleEngines` | source (engine only) | Lists engines for the search settings. | `extensions/bento-tools/experiments/bento-privacy/api.js#getSearchEngines` | `toolkit/components/search/SearchService.sys.mjs:445` |
| `SearchService.setDefault` | source (engine only) | Changes the default engine from the search settings. | `extensions/bento-tools/experiments/bento-privacy/api.js#setDefaultSearchEngine` | `toolkit/components/search/SearchService.sys.mjs:193` |
| `SearchService.setDefaultPrivate` | source (engine only) | Mirrors the default engine into private windows when they share one. | `extensions/bento-tools/experiments/bento-privacy/api.js#setDefaultSearchEngine` | `toolkit/components/search/SearchService.sys.mjs:217` |
| `SearchService.CHANGE_REASON` | source (engine only) | Reason constant passed to setDefault and setDefaultPrivate. | `extensions/bento-tools/experiments/bento-privacy/api.js#setDefaultSearchEngine` | `toolkit/components/search/SearchService.sys.mjs:104` |
| `moz-src:///toolkit/components/search/SearchUtils.sys.mjs` | module (runtime) | Fetches engine icons for the search settings. | `extensions/bento-tools/experiments/bento-privacy/api.js#SearchUtils` | `toolkit/components/search/SearchUtils.sys.mjs:148` |
| `SearchUtils.fetchIcon` | source (engine only) | Fetches an engine icon over a privileged channel. | `extensions/bento-tools/experiments/bento-privacy/api.js#iconUrlToDataUrl` | `toolkit/components/search/SearchUtils.sys.mjs:574` |
| `SearchEngine.getIconURL` | source (engine only) | Reads an engine icon URL (optional call). | `extensions/bento-tools/experiments/bento-privacy/api.js#getEngineIconUrl` | `toolkit/components/search/SearchEngine.sys.mjs:1665` |
| `resource:///modules/MigrationUtils.sys.mjs` | module (runtime) | Opens the migration wizard from the welcome flow. | `showEmbeddedBrowserImportFromWelcome`, `restartToBrowserImportFromWelcome` | `browser/components/migration/MigrationUtils.sys.mjs:1206` |
| `MigrationUtils.showMigrationWizard` | source (engine only) | Shows the migration wizard with the NEWTAB entrypoint. | `restartToBrowserImportFromWelcome` | `browser/components/migration/MigrationUtils.sys.mjs:593` |
| `resource:///modules/ExtensionsUI.sys.mjs` | module (runtime) | Bento re-subscribes ExtensionsUI to the permission-prompt topics when startup missed them. | `ensureExtensionsUIObservers` | `browser/modules/ExtensionsUI.sys.mjs:65` |
| `ExtensionsUI observer topics` | source (engine only) | The four webextension-*-prompt topics ExtensionsUI observes; Bento adds the observer for each if missing. | `ensureExtensionsUIObservers` | `browser/modules/ExtensionsUI.sys.mjs:73` |
| `moz-src:///browser/components/sessionstore/SessionStore.sys.mjs` | module (runtime) | Workspace assignment is stored as a custom tab value. | `getSessionStore` | `browser/components/sessionstore/SessionStore.sys.mjs:8956` |
| `resource://gre/modules/Extension.sys.mjs` | module (runtime) | Management.global.windowTracker resolves the WebExtension window id of a chrome window. | `getChromeWindowId` | `toolkit/components/extensions/Extension.sys.mjs:171` |
| `resource://gre/modules/ExtensionParent.sys.mjs` | module (runtime) | ExtensionParent.apiManager.global.tabTracker maps WebExtension tab ids to tab elements. | `getTabTracker`, `getBentoTabTracker` | `toolkit/components/extensions/ExtensionParent.sys.mjs:2552` |
| `apiManager.global.{tabTracker,windowTracker}` | source (engine only) | ext-browser.js publishes the trackers on the extension API global; Bento reads them from there. | `getTabTracker`, `getBentoTabTracker`, `getChromeWindowId` | `browser/components/extensions/parent/ext-browser.js:787` |
| `tabTracker.getTab` | source (engine only) | Resolves a WebExtension tab id to a chrome tab element. | `getTrackedTabById`, `getBentoTabTracker` | `browser/components/extensions/parent/ext-browser.js:470` |
| `tabTracker.getId` | source (engine only) | Resolves a chrome tab element to its WebExtension tab id. | `getTrackedTabById`, `getBentoTabId` | `browser/components/extensions/parent/ext-browser.js:364` |
| `windowTracker.getId` | source (engine only) | Resolves a chrome window to its WebExtension window id. | `getChromeWindowId` | `toolkit/components/extensions/parent/ext-tabs-base.js:1817` |
| `chrome://devtools-startup/content/DevToolsShim.sys.mjs` | module (runtime) | Entry point to the devtools toolbox list for Inspect in Panel. | `getDevToolsShim` | `devtools/startup/DevToolsShim.sys.mjs:41` |
| `DevToolsShim.getToolboxes` | source (engine only) | Finds the page-hosted toolbox already inspecting a panel browser. | `matchingLivePageToolbox` | `devtools/startup/DevToolsShim.sys.mjs:88` |
| `DevToolsShim.on` | source (engine only) | Waits for the toolbox-ready event of the toolbox opened in a panel. | `openDevtoolsPanelFor` | `devtools/startup/DevToolsShim.sys.mjs:137` |
| `DevToolsShim.off` | source (engine only) | Removes the toolbox-ready listener. | `openDevtoolsPanelFor` | `devtools/startup/DevToolsShim.sys.mjs:152` |
| `about:devtools-toolbox` | source (engine only) | Page Bento opens in a panel tab to host the toolbox. | `openDevtoolsPanelFor` | `devtools/startup/AboutDevToolsToolboxRegistration.sys.mjs:13` |
| `about:devtools-toolbox type parameter` | source (engine only) | Bento sends type=tab; commandsFromURL reads it and rejects a missing one. | `openDevtoolsPanelFor` | `devtools/client/framework/commands-from-url.js:61` |
| `about:devtools-toolbox type=tab branch` | source (engine only) | The tab type resolves the id parameter to a remote tab through CommandsFactory.forRemoteTab. | `openDevtoolsPanelFor` | `devtools/client/framework/commands-from-url.js:92` |
| `about:devtools-toolbox id parameter` | source (engine only) | Bento sends the panel browser's browserId as id; commandsFromURL parses it as the tab to debug. | `openDevtoolsPanelFor` | `devtools/client/framework/commands-from-url.js:60` |
| `about:devtools-toolbox tool parameter` | source (engine only) | The tool query parameter selects the initial devtools tool. | `openDevtoolsPanelFor` | `devtools/client/framework/toolbox-init.js:95` |
| `Toolbox.hostType` | source (engine only) | Identifies the page-hosted toolbox. | `matchingLivePageToolbox`, `openDevtoolsPanelFor` | `devtools/client/framework/toolbox.js:602` |
| `Toolbox.isDestroying` | source (engine only) | Skips half-destroyed toolboxes. | `matchingLivePageToolbox` | `devtools/client/framework/toolbox.js:4372` |
| `Toolbox.commands` | source (engine only) | Reaches descriptorFront.browserId, the root client and the target front. | `matchingLivePageToolbox`, `selectNodeInToolbox` | `devtools/client/framework/toolbox.js:342` |
| `Toolbox.selectTool` | source (engine only) | Switches the toolbox to the inspector or accessibility tool. | `selectNodeInToolbox` | `devtools/client/framework/toolbox.js:3102` |
| `Toolbox.getCurrentPanel` | source (engine only) | Reads the accessibility panel to select the inspected node. | `selectNodeInToolbox` | `devtools/client/framework/toolbox.js:580` |
| `inspectorFront.getNodeActorFromContentDomReference` | source (engine only) | Turns the context-menu DOM reference into a node front (same call Firefox makes). | `selectNodeInToolbox` | `devtools/client/framework/devtools.js:902` |
| `Selection.setNodeFront` | source (engine only) | Selects the inspected node in the inspector. | `selectNodeInToolbox` | `devtools/client/framework/selection.js:190` |
| `AccessibilityPanel.selectAccessibleForNode` | source (engine only) | Selects the inspected node in the accessibility panel. | `selectNodeInToolbox` | `devtools/client/accessibility/panel.js:255` |
| `TabSelect` | source (engine only) | Reconciles panels, refreshes the panel navigator, and snapshots the sidebar address when the selected tab changes. | `attachTabSelectListener`, `setupPanelNavigator`, `attachSidebarAddressSnapshotListeners` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:2006` |
| `TabOpen` | source (engine only) | Reconciles panels when a tab opens (new-tab flows where TabSelect does not reach the listener). | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:5525` |
| `TabAttrModified` | source (engine only) | Refreshes the panel navigator and the sidebar address snapshot when a tab attribute (title, busy, image) changes. | `setupPanelNavigator`, `attachSidebarAddressSnapshotListeners` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:2311` |
| `SSTabRestored` | source (engine only) | Refreshes the sidebar address snapshot after session restore fills a tab. | `attachSidebarAddressSnapshotListeners` | `browser/components/sessionstore/SessionStore.sys.mjs:7935` |
| `MozDOMFullscreen:Entered` | source (engine only) | Marks the panel whose page requested DOM fullscreen. | `attachBentoDomFullscreenRequesterTracking`, `markBentoDomFullscreenRequester` | `dom/base/Document.cpp:16981` |
| `MozDOMFullscreen:Exited` | source (engine only) | Clears the DOM fullscreen requester mark. | `attachBentoDomFullscreenRequesterTracking`, `clearBentoDomFullscreenRequester` | `dom/base/Document.cpp:15984` |
| `aftercustomization` | source (engine only) | Re-aligns toolbar navigation buttons and the bookmarks toolbar, and re-mounts the panel navigator, after the user customizes the toolbar. | `attachToolbarNavigationAlignment`, `attachBookmarksToolbarAlignment`, `watchPanelNavigatorToolbarPlacement` | `browser/components/customizableui/CustomizeMode.sys.mjs:682` |
| `gBrowser._endRemoveTab` | method (runtime) | Finishes closing the source tab after a window-to-window browser swap (patch window-sync/02). | `patches/window-sync/02-tabbrowser-bento-sync.patch#_endRemoveTab` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:6725` |
| `tab._endRemoveArgs` | source (engine only) | Reads the [closeWindow, newTab] arguments _beginRemoveTab stored on the tab when a browser swap closes the source tab (patch window-sync/02). | `patches/window-sync/02-tabbrowser-bento-sync.patch#_endRemoveArgs` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:6573` |
| `OpenBrowserWindow options` | source (engine only) | OpenBrowserWindow forwards its whole options object to BrowserWindowTracker.openWindow, which carries Bento's bentoSyncedWindow flag (patch window-sync/01). | `bentoSyncedWindow` | `browser/base/content/browser.js:1731` |
| `FirefoxProfileMigrator._getFileObject` | source (engine only) | Locates the external browser session files inside a profile directory (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#_getFileObject` | `browser/components/migration/FirefoxProfileMigrator.sys.mjs:100` |
| `FirefoxProfileMigrator.startupOnlyMigrator` | source (engine only) | Decides whether the Firefox profile migrator is offered only at startup (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#startupOnlyMigrator` | `browser/components/migration/FirefoxProfileMigrator.sys.mjs:496` |
| `MigrationUtils.isStartupMigration` | source (engine only) | Tells the first-run import apart from a later import (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#isStartupMigration` | `browser/components/migration/MigrationUtils.sys.mjs:548` |
| `MigrationUtils.profileStartup` | source (engine only) | Reads the running profile's directory so the import skips it (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#profileStartup` | `browser/components/migration/MigrationUtils.sys.mjs:559` |
| `MigrationUtils.resourceTypes` | source (engine only) | Resource type constants the first-run import selects (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#resourceTypes` | `browser/components/migration/MigrationUtils.sys.mjs:198` |
| `MigrationWizard:Close` | source (engine only) | Tells the embedded import host the wizard finished so it can close. | `src/browser/base/content/bento-migration-host.js#MigrationWizard:Close` | `browser/components/migration/content/migration-wizard.mjs:1482` |
| `migration-wizard.requestState` | source (engine only) | Asks the embedded migration wizard to render its initial state. | `src/browser/base/content/bento-migration-host.js#requestState` | `browser/components/migration/content/migration-wizard.mjs:419` |
| `migration-wizard element` | source (engine only) | Custom element the import host waits for before bridging styles. | `src/browser/base/content/bento-migration-host.js#whenDefined('migration-wizard')` | `browser/components/migration/content/migration-wizard.mjs:1619` |
| `migration-wizard #browser-profile-selector` | source (engine only) | Profile selector button inside the wizard's shadow root; the host restyles it. | `src/browser/base/content/bento-migration-host.js#browser-profile-selector` | `browser/components/migration/content/migration-wizard.mjs:56` |
| `migration-wizard .resource-selection-details` | source (engine only) | Resource list details block the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-selection-details` | `browser/components/migration/content/migration-wizard.mjs:83` |
| `migration-wizard #resource-selection-summary` | source (engine only) | Summary line of the resource list the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-selection-summary` | `browser/components/migration/content/migration-wizard.mjs:84` |
| `migration-wizard #resource-type-list` | source (engine only) | Resource checkbox list the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-type-list` | `browser/components/migration/content/migration-wizard.mjs:89` |
| `migration-wizard .resource-progress` | source (engine only) | Progress list the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-progress` | `browser/components/migration/content/migration-wizard.mjs:129` |
| `migration-wizard .resource-progress-group` | source (engine only) | Progress rows the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-progress-group` | `browser/components/migration/content/migration-wizard.mjs:130` |
| `AsyncSetting.emitChange` | source (engine only) | Bento settings pass this bound arrow field to their model subscriptions to refresh the control; it must stay a field, not a method. | `patches/core-ui/15-bento-native-preferences.patch#emitChange` | `toolkit/content/preferences/AsyncSetting.mjs:34` |
| `AsyncSetting.setup` | source (engine only) | Subscribes to the Bento model and returns the teardown function. | `patches/core-ui/15-bento-native-preferences.patch#setup()` | `toolkit/content/preferences/AsyncSetting.mjs:44` |
| `AsyncSetting.get` | source (engine only) | Reads the Bento setting value for the control. | `patches/core-ui/15-bento-native-preferences.patch#async get()` | `toolkit/content/preferences/AsyncSetting.mjs:71` |
| `AsyncSetting.set` | source (engine only) | Writes the control value to the Bento setting. | `patches/core-ui/15-bento-native-preferences.patch#async set(value)` | `toolkit/content/preferences/AsyncSetting.mjs:81` |
| `AsyncSetting.disabled` | source (engine only) | Disables the control while the Bento model is unavailable. | `patches/core-ui/15-bento-native-preferences.patch#async disabled()` | `toolkit/content/preferences/AsyncSetting.mjs:88` |
| `AsyncSetting.visible` | source (engine only) | Hides the control for settings that do not apply. | `patches/core-ui/15-bento-native-preferences.patch#async visible()` | `toolkit/content/preferences/AsyncSetting.mjs:97` |
| `AsyncSetting.getControlConfig` | source (engine only) | Supplies the default search engine options to the control. | `patches/core-ui/15-bento-native-preferences.patch#getControlConfig` | `toolkit/content/preferences/AsyncSetting.mjs:107` |
| `FINAL_TARGET_FILES.actors` | source (engine only) | Bento actors ship through browser/actors/moz.build and load from resource:///actors/. | `registerContentKeyActor`, `patches/chrome-layout/04-bento-key-actors.patch#BentoKeyChild` | `browser/actors/moz.build:92` |
| `chrome://global/content/preferences/Preferences.mjs` | source (engine only) | Bento settings are Preferences settings; registered in toolkit/content/jar.mn. | `patches/core-ui/15-bento-native-preferences.patch#Preferences.mjs` | `toolkit/content/jar.mn:69` |
| `Preferences.addSetting` | source (engine only) | Registers each Bento setting with the Preferences framework. | `patches/core-ui/15-bento-native-preferences.patch#addSetting` | `toolkit/content/preferences/Preferences.mjs:100` |
| `Preferences.AsyncSetting` | source (engine only) | Base class of Bento settings that read and write through the extension bridge. | `patches/core-ui/15-bento-native-preferences.patch#AsyncSetting` | `toolkit/content/preferences/Preferences.mjs:435` |
| `chrome://browser/content/preferences/config/SettingGroupManager.mjs` | source (engine only) | Bento setting groups register here; registered in browser/components/preferences/jar.mn. | `patches/core-ui/15-bento-native-preferences.patch#SettingGroupManager` | `browser/components/preferences/jar.mn:51` |
| `SettingGroupManager.registerGroups` | source (engine only) | Adds the Bento setting groups to the Settings page. | `patches/core-ui/15-bento-native-preferences.patch#registerGroups` | `browser/components/preferences/config/SettingGroupManager.mjs:64` |
| `CONFIG_PANES` | source (engine only) | Bento adds its pane entries (l10nId, iconSrc, groupIds, module, parent, visible) to this object. | `patches/core-ui/15-bento-native-preferences.patch#CONFIG_PANES` | `browser/components/preferences/preferences.js:243` |
| `gotoPref` | source (engine only) | Navigates between the Bento settings subpanes. | `patches/core-ui/15-bento-native-preferences.patch#gotoPref` | `browser/components/preferences/preferences.js:733` |
| `chrome://global/content/elements/moz-box-group.mjs` | source (engine only) | Element module imported by the Bento settings config. | `patches/core-ui/15-bento-native-preferences.patch#moz-box-group` | `toolkit/content/jar.mn:115` |
| `chrome://global/content/elements/moz-box-item.mjs` | source (engine only) | Element module imported by the Bento settings config. | `patches/core-ui/15-bento-native-preferences.patch#moz-box-item` | `toolkit/content/jar.mn:121` |
| `chrome://global/content/elements/moz-button.mjs` | source (engine only) | Element module imported by the Bento settings config. | `patches/core-ui/15-bento-native-preferences.patch#moz-button` | `toolkit/content/jar.mn:125` |
| `chrome://global/content/elements/moz-input-number.mjs` | source (engine only) | Element module imported by the Bento settings config. | `patches/core-ui/15-bento-native-preferences.patch#moz-input-number` | `toolkit/content/jar.mn:140` |
| `chrome://global/content/elements/moz-input-search.mjs` | source (engine only) | Element module imported by the Bento settings config. | `patches/core-ui/15-bento-native-preferences.patch#moz-input-search` | `toolkit/content/jar.mn:142` |
| `chrome://global/content/reader/moz-slider.mjs` | source (engine only) | Slider element module imported by the Bento settings config; registered in the reader jar.mn. | `patches/core-ui/15-bento-native-preferences.patch#moz-slider` | `toolkit/components/reader/jar.mn:8` |

<!-- firefox-compat:end -->
<!-- prettier-ignore-end -->
