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
- Last updated: 2026-10-17
- Firefox 158.0 review (2026-10-14): `pnpm run firefox:compat:engine` found all
  202 registry members of that date in the vanilla and in the patched tree; 60 `at`
  lines moved and `BASELINE` is 158.0. Re-run 2026-10-17 after the window-handover
  and native-preferences entries landed: 217 of 217 members found in the
  patched tree. Upstream changes read against this entry:
  `Tabbrowser.sys.mjs` no longer re-assigns `docShellIsActive` after it inserts
  or adopts a browser (that self-assignment existed only to send the
  `MozLayerTreeReady` and `MozLayerTreeCleared` events the tab switcher uses; the
  mount sets `docShellIsActive` on panel browsers itself), `TabMultiSelect` is
  dispatched on `tabContainer` instead of the tabbrowser (the mount does not
  listen for it), `_findTabToBlurTo` drops explicitly unloaded tabs when others
  remain (the wrapper still removes panel and other-workspace tabs first),
  `AppWindow` gained `FullscreenChangeFailed` (failure path only), per-window idle
  tasks moved from `gBrowserInit` into the `browser-window-idle-tasks` category
  (the mount reads none of `gSync`, `gGestureSupport`, `gBrowserThumbnails`,
  `gHistorySwipeAnimation`, `gGfxUtils` or `gProfiles`), and mini-window hooks
  (`MiniWindowManager`, the `mini-window` root attribute in `TabBarVisibility`,
  `BrowserWindowTracker` and `gBrowserInit`) stay inert while
  `browser.mini-window.enabled` is false. Runtime on 158.0 (headless harness, fresh
  profile): the Browser Console logs
  `[bento-compat] probed 86 members on Firefox 158.0: 0 missing, 1 deferred` for the
  first window, and `BentoFirefoxCompat.check()` later reports 87 probed, 0 missing,
  0 deferred; the smoke (add, select, remove a tab) adds no console errors; three
  extra windows open in 0.6 to 0.9 s, close, and leave 0 ghost windows and 0
  detached-window bytes. Panels created through the add-panel grant flow render
  side by side (`bento-split-active` and `bento-flat-panel-layout` on the
  tabpanels, the add trailer after the last panel, `docShellIsActive` true and
  `renderLayers` true on every split-view panel), and `drawSnapshot` of each
  panel returns the background of the `data:` page loaded in it. A
  `gBrowser.replaceTabWithWindow` call on a panel tab opens a mounted window with
  exactly that tab (same BrowsingContext id) and drops it from the source.
  `removeTabs` on every tab of a window does not take Firefox's `close-last-tab`
  short-circuit (`window.closeWindow` is not called) by default or with
  `closeWindowWithLastTab: false`, and calls `closeWindow(..., "close-last-tab")`
  synchronously with `closeWindowWithLastTab: true`; the window still closes in
  both default cases because the bento-tools `tabs.onRemoved` handler closes it when
  its last workspace empties. Console noise: four `loadURI failed` warnings per
  window for the eager frames, the `TelemetryUtils.sys.mjs` `getFullYear` error,
  the Roboto Mono `glyf` warning, the `Tabbrowser.destroy` progress-listener error
  on window close, and `UrlbarValueFormatter.sys.mjs` `nsIEditor.rootElement`
  errors after tabs or windows are added (not compared against a 157.0.1 run, which
  was not available). Not covered headless: panel traversal keys, native popups,
  DOM fullscreen, and drag tear-out. Found on the 158.0 build and present in the
  157.0.1 source (`JSActorService.cpp` and the
  `dom.jsipc.check_safeForUntrustedWebProcess` default are identical in both): the
  `BentoKey` actor is registered without `safeForUntrustedWebProcess`, and with that
  pref true Firefox refuses it in `web` and `webIsolated=` processes.
  `getActor('BentoKey')` throws "doesn't match remote type 'web'" for `about:blank`
  in a web process and succeeds for `about:newtab` (`privilegedabout`). Panel
  shortcuts therefore reach chrome only from privileged pages until the
  registration changes; see the traversal pitfalls in
  [panel-traversal-focus.md](technical/panel-traversal-focus.md).
- Window close handover (2026-10-14): closing a window destroyed every tab it
  hosted, so the tabs of a workspace that a second window had claimed (and the
  hidden tabs of other workspaces) lost their page state and were recreated from
  URLs on the next activation. `attachWindowCloseHandover` in the mount script
  adds a `close` listener (the OS close button; `AppWindow::RequestWindowClose`
  destroys the window synchronously after it, so it runs after
  `window.onclose = WindowIsClosing` has answered the prompts and sees
  `defaultPrevented`) and a capture-phase `DOMWindowClose` listener
  (`nsGlobalWindowOuter::CloseOuter` dispatches it after `CanClose` for
  `window.close()`, `windows.remove` and Cmd+Shift+W, and `FinalClose` follows
  unconditionally; `ForceClose` dispatches it on a quit). When another regular
  Bento window exists it tears the split view down, adds a selected `about:blank`
  tab to the closing window and adopts each tab worth keeping with
  `gBrowser.adoptTab` in the same task, then appends a hop to the
  `bento.handover` tab value on the returned tab for bento-tools. The blank tab
  keeps every adoption off the window's last-tab path, where `adoptTab` closes the
  window itself and returns before `TabClose` (the DevTools toolbox transfer). Tabs
  that `swapBrowsersAndCloseOther` would refuse (non-remote, closing) and survivors
  in another Fission mode are ruled out first; the source tabbrowser's private
  `#windowIsClosing` is only set once the last tab is already closing, never by the
  OS close button or a script `window.close()`. No
  patch and no hold, timer or message: nothing runs between the listeners and the
  teardown that could cancel the close. Depended-on surfaces: `Tabbrowser.adoptTab`
  (returns the new tab or null, after removing the empty twin it made; the live
  browsing context moves into a new `<browser>` element and the tab id is kept by
  `ext-browser.js` `adopt()`), `swapBrowsersAndCloseOther` (closes the window from
  inside `adoptTab` when the last tab leaves, and restores a pending tab by state),
  SessionStore (moves a tab's custom values to the twin on `TabOpen` with
  `adoptedTab`, so a refused adoption takes them away; `#restoreTab` deletes a
  pending tab's values when the state has no `extData`; on `TabClose` with
  `adoptedBy` it copies the old browser's cached state, session history included, to
  the twin once `TabStateFlusher.flush` settles, and that flush promise comes from
  `frameLoader.requestTabStateFlush()` and belongs to the closing window, so
  `adoptTabInto` shadows that method on the old frame loader for the call with one
  that returns a promise of the surviving window; SessionStore's own write comes 2 to
  15 s after a close (`SessionStore` `#onClose` to `SessionSaver.runDelayed`: not
  sooner than 2 s nor than the last write plus `browser.sessionstore.interval`), and a
  tab's history reaches the parent cache up to one interval after it changes, so a
  crash right after a handover would lose every adopted tab that no earlier write
  held, which the previous parking of the tabs' URLs used to cover),
  `SessionSaver.run()` (`moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs`:
  writes the session at once, also during shutdown), `browser.getInPermitUnload`
  and `gDialogBox.isOpen` (a window in a close prompt neither hands over nor takes
  tabs), `BrowserElementParent` (a tab's `window.close()` reaches the window as a
  non-cancelable `DOMWindowClose` from the browser element), the `window.onclose`
  handler `WindowIsClosing`, and the public `Services.startup.attemptingQuit`
  (`nsAppStartup::Quit` sets it before `CloseAllWindows`; `shuttingDown` is still
  false then). After the loop, when at least one tab was adopted, the closing window
  calls `window.__bentoSaveSessionAfterHandover(flushes)` on the survivor
  (`saveSessionAfterHandover`, defined by the survivor's own mount instance), with
  the survivor promises `adoptTabInto` collected. The survivor seals the batch in a
  timer task of its own (requests that arrive before it, also from promise reactions,
  share the write), waits for the flushes (at most 2 s), then one task for
  SessionStore's copy, then calls `SessionSaver.run()` unless the window closed or a
  quit has started. If the cap won, it writes then, and each flush that settles later
  gets a write of its own one timer task after it settles (flushes that settle before
  that task share it; same guards), because `run()` cancels SessionStore's pending
  delayed save and resets its interval; a flush that never settles arms nothing and
  holds back no other tab. Fire and forget: the close never waits for it. Nothing that must run may belong to the
  closing window: promise reactions and timers of a window that is being destroyed
  never run, which is also why the flush promises are the survivor's. Registry
  entries: `gBrowser.adoptTab`, `gDialogBox.isOpen` and
  `MozBrowser.prototype.getInPermitUnload` (runtime probes), `gFissionBrowser`,
  `swapBrowsersAndCloseOther closeWindow`, `SessionStore adoptedTab custom values`,
  `TabStateFlusher.flush requestTabStateFlush`, `SessionStore onMoveToNewWindow flush`,
  `DOMWindowClose`, `BrowserElementParent DOMWindowClose` and
  `window.onclose WindowIsClosing`, `SessionSaver.run` (engine only), plus
  `FrameLoader.prototype.requestTabStateFlush` and the `SessionSaver.sys.mjs` module
  (runtime probes). `windowUtils.isInModalState()` was
  checked and not used: it covers content windows opened modal and the debugger
  start, not the window-modal closing-tabs warning (shown through `gDialogBox`) or
  the content-modal beforeunload prompts. Firefox update
  risk: if `DOMWindowClose` stops reaching the window's own listeners, or
  `window.onclose` stops being the single OS close handler, windows close at once
  again (tabs parked as URLs, the previous behavior) and nothing breaks; if
  `adoptTab` stops keeping the tab id or the tab values of a live tab, handed-over
  tabs lose their workspace (the `bento.handover` value would be missing or the
  tab released as a drag); if a window with another open tab stops counting as
  "not the last tab" in `#isLastTabInWindow`, the last adoption closes the window
  itself again (re-entering the handler and skipping `TabClose`); if SessionStore's
  move handler stops reading `frameLoader.requestTabStateFlush()` (or copies the
  state some other way), the shadow is harmless but inert and adopted tabs lose their
  session history again, with no error: check
  `JSON.parse(SessionStore.getTabState(tab)).entries.length` of a handed-over tab
  against its history; if `SessionSaver.run` is renamed or stops writing at once, the
  save logs `session save after a window handover failed` (or writes nothing) and a
  crash within 2 to 15 s of a handover loses the tabs again: check
  `sessionstore-backups/recovery.jsonlz4` right after a close. Individual
  adoption does not keep native tab-group membership or a multiselection, which
  Bento does not use. Regression checks: with two workspaces, give a tab of the
  second workspace unique state (form text), open a second window so it claims that
  workspace, close it with Cmd+Shift+W, the close button and `window.close()`: the
  tab keeps its tab id, its BrowsingContext id and its text in the remaining window,
  stays in its workspace (hidden from that window's sidebar), the panel layout is
  intact when the workspace is shown again, the tabs keep their order, a DevTools
  toolbox open on the window's selected tab follows it, and no blank tab remains.
  After 15 s, dragging a handed-over tab out of the window that received it and
  back releases its workspace like any drag (the expired hop no longer matches;
  tools never deletes the `bento.handover` value and chrome prunes expired hops
  only when it appends the next). Close two windows in a row with a
  third open: workspace, folder and panels survive both hops. From a page opened by
  `window.open()` call `window.close()` with two windows open: only that tab closes.
  Press Cmd+Q right after closing a window: the session restores both windows' tabs,
  the handed-over ones with their history. Open or navigate tabs in a second window,
  close it, and `kill -9` Bento 0.3 s and 3 s later (a test profile only): the next
  launch restores every handed-over tab once, with its history, workspace, folder and
  pin; `recovery.jsonlz4` is written about 50 ms after the close for a few tabs
  (about 300 ms for 48), before any natural write.
  A tab with a beforeunload prompt answered "Stay" on the close leaves the window
  untouched, and closing it again while the prompt is up hands nothing over.
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
  - `src/browser/base/content/bento-shell-mount.css` (see Chrome Layout Stylesheet)
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
  shell UI actions such as inline tab/folder rename, routes `Cmd/Ctrl+T`,
  sidebar `New tab`, and native top-urlbar fallback opens to the centered
  address/search overlay, routes `Cmd/Ctrl+L`, `Cmd/Ctrl+E` and direct
  expanded-sidebar URL row activation to the same overlay anchored over the row
  (the palette's top-left corner is the row's, its header is the row grown, and it
  grows from the row's box on the `reveal` spring pair), asks the row for its rect
  over the sidebar address frame-script channel (an `open-request` message scoped by
  window id and bridge token, answered through the existing `BENTO_OPEN_ADDRBAR`
  title signal; a 120 ms timer, a sidebar that is collapsed, hidden or pushing, and a
  row that is not laid out all open the centered overlay; Esc, an outside click or
  another overlay cancels a request still waiting), tells the row over the same channel
  when the anchored palette is shown over it and when it starts to hide (a
  `palette-over-row` message with the same scope; the row fades its border out
  meanwhile; a new sidebar document announces itself with the
  `BENTO_SIDEBAR_ADDRESS_READY` title, on which chrome forgets what it last sent the row
  and sends it again), routes submitted
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
  and has no host width transition (collapse and expand slide the host and the
  page as one strip, see Chrome Layout Stylesheet),
  leaves the collapsed workspace-switcher section unpadded so its centered
  avatar trigger remains the same square size as the other collapsed rail
  controls,
  hides the native top URL/search field under a Bento
  chrome attribute while keeping toolbar and window controls visible on the
  sidebar-matched background in no-panel view, and on the sidebar-matched
  background on the sidebar side of the divider plus neutral-14 on the
  main-content side when panels are visible (the same neutral-14 on both sides while the
  sidebar is the collapsed rail), and without Firefox's toolbox
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
  footer alignment and temporary native panel animation suppression, adds a
  "Bento Settings" `toolbarbutton.subviewbutton` directly above Firefox's
  Settings item in the app menu main view (inserted on the panel's bubbling
  `ViewShowing` for `#appMenu-mainView`, so any way of opening the menu gets it
  exactly once; its command calls `showSettingsPalette` and Firefox's panel close
  listeners hide the menu), opens the manual merge palette from the command
  palette overlay's title signal and from a `BentoOpenMergePalette` event that
  the native Bento Settings page dispatches on its top chrome window, opens
  Firefox's native downloads panel from a sidebar footer button by anchoring
  `DownloadsPanel.panel` to a temporary chrome-side element with the same
  left-edge footer alignment and animation suppression, patches
  `DownloadsButton.getAnchor()`/`releaseAnchor()` so automatic native downloads
  panel opens use a sidebar fallback anchor placed from the Downloads button's
  edges that the shell reports (`BENTO_DOWNLOADS_ANCHOR`), hides the stock toolbar
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
  generated Mux UI/Bento chrome tokens (Passwords `about:logins` and the megalist sidebar are
  written with `data-color-mode="light"` and `color-scheme` light in patches 13 and 14, so they
  stay light in dark mode and do not fade; making them follow the mode needs a hook in the
  pages' own scripts like patch 12's `syncColorMode` block, which the patches do not carry
  context for, and for `about:logins`, a content-process page without `topChromeWindow`, a
  source of the window's mode (a `matchMedia` of Bento's content override if it tracks the
  mode, otherwise an actor message); not done),
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
  (`PanelUI`, `#appMenu-popup`, the template-created `#appMenu-mainView` and
  its `#appMenu-settings-button`, the bubbling `ViewShowing` event,
  `CustomizableUI.maybeAutoHidePanel`, `#PanelUI-button`), Places bookmark APIs and
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
  `docs/technical/shell-chrome-bridge.md` ("Title IPC pitfalls") on a profile
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
  re-attach safety net can return. If `PanelMultiView` stops bubbling
  `ViewShowing` from `#appMenu-mainView` to `#appMenu-popup`, or renames
  `#appMenu-mainView` or `#appMenu-settings-button`, the Bento Settings item
  silently disappears (a missing Settings button logs
  `appMenu-settings-button missing` in the Browser Console); if
  `CustomizableUI.maybeAutoHidePanel` stops hiding the panel after a
  `subviewbutton` command, the item opens Settings but leaves the menu open. Hooks guarded by `typeof` skip silently when a private member is renamed; the
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
  folder to another workspace, verify `Cmd/Ctrl+L` and
  `Cmd/Ctrl+E` open the address/search overlay anchored over the expanded-sidebar
  URL row (its top-left corner on the row's, the current address selected) from
  chrome focus and from web content focus, and open it centered with the sidebar
  collapsed or hidden, verify `Cmd/Ctrl+T` opens the centered overlay in new-tab
  mode, verify Esc or an outside click right after `Cmd/Ctrl+L` leaves no palette
  behind, verify collapsing or hiding the sidebar right after `Cmd/Ctrl+L` opens it
  centered, verify clicking the expanded-sidebar URL row opens the address/search
  overlay anchored over that row (no new Firefox internal is read: the row rect comes
  from the shell, and the placement from `#browser` and `#bento-shell-frame`
  geometry already listed here),
  verify clicking or programmatic focus into Firefox's hidden native top address
  input opens Bento's centered address entry and does not leave the native urlbar
  suggestions dropdown open, verify the native top URL/search field, stock
  toolbar app-menu button, stock toolbar downloads button, and stock toolbar
  Account menu are hidden while
  the sidebar footer Firefox-menu button opens the native app menu with
  submenus, Settings, More Tools, Help, update/sign-in banners, and keyboard
  shortcuts intact and grows rightward from the trigger when space allows,
  without sliding in from the top or bottom, verify the app menu lists
  "Bento Settings" directly above Settings with the same styling, hover and
  focus ring in light and dark modes, only once after repeated opens and in a
  second window, that arrow keys reach it, and that Enter or a click closes the
  menu and opens the Settings palette, verify the sidebar footer is the same five buttons (no
  Settings, merge or progress button) in the expanded and collapsed rail while a
  merge runs, and that a running merge shows as a card over the bottom of the tab
  list, verify the command palette's Merge browser session
  command and the Settings palette's Merge browser session row open the merge
  palette, verify the
  sidebar footer Downloads
  button opens Firefox's native downloads panel with recent download actions and
  download history intact while using the same footer-side alignment and no
  top/bottom slide, verify that when Firefox opens its own downloads panel (a
  started download, or `DownloadsPanel.showPanel()`) it attaches to the Downloads
  button in the expanded footer and the collapsed rail, with and without a merge
  card showing, verify the native top toolbar matches the sidebar
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
  strip/main content while editing, stays smaller than the centered
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
  bar, verify the sidebar merge card opens the merge palette, refreshes
  sources on every open, closes on Esc or close action, and never leaves the
  command palette and merge palette visible at the same time, verify the rail
  merge card's tooltip (`BENTO_RAIL_TOOLTIP`, shown in the panel navigator tooltip
  overlay beside the ring on hover and keyboard focus, hidden on leave, blur,
  rail expand and merge palette open), verify the floating
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

### Lazy Overlay Documents

- Status: Active
- Last updated: 2026-10-31
- Host presentation gate (2026-10-31): `setFrameSrc` merges a hosted-overlay hint
  into the existing hash; hidden shell overlays default to unpresented before
  module initialization. After readiness, the manager queries the current
  `BentoShellBusChild` through `WindowGlobalParent.getActor` / `JSActor.sendQuery`
  and waits for its synchronous root-state update/event acknowledgement before
  revealing or focusing. The child validates the own-shell policy and hint and
  uses `JSWindowActorChild.document`, rejecting destroyed or navigation-mismatched
  actors. Parent and child generations reject stale opens, hides, and replies;
  reloads replay the current open before reveal. False follows completed native
  exit opacity, or immediate menu/tooltip hide. Workspace-switcher layout remains
  retained while its final hidden commit now waits for opacity completion.
  This gates shell colour preparation without changing docshell activity,
  rendering priority, motion timing, or native compositor policy. Ordinary pages,
  sidebar, and panel trailers retain existing behavior. Live hidden-document
  suppression and whole-window timing remain pending. Regression checks:
  initial/prewarmed closed overlays process
  mode flips without catch-all transitions; opens wait for actor acknowledgement;
  hide-start keeps exits visible; completed/reduced-motion hides settle the latest
  mode; rapid reopen and reload cannot apply stale state. Check palette, Settings,
  workspace switcher, address bar, menu, and tooltip on regular/private windows.
  Rollback removes the presentation query, hash hint, and controller gate together;
  do not substitute `docShellIsActive` or a global compositor preference.
- Motion tokens change (2026-10-17): the palette, merge palette and confirm hosts
  declared in `browser-box.inc.xhtml` no longer carry the inline
  `transition: opacity 0.18s ease` (patch `chrome-layout/01-bento-shell-mount.patch`;
  the `index` blob ids of that patch and of `chrome-layout/02-bento-side-panel.patch`
  were recomputed, and both apply to the pristine 158.0 files). Their fade now comes
  from `bento-shell-mount.css` (`#bento-palette-host`, `#bento-merge-palette-host`,
  `#bento-confirm-host`: `opacity var(--muxui-semantic-motion-modal-transition)`);
  the hosts the mount script creates carry the same value inline. The `hide*`
  functions no longer wait a fixed 180 ms: `hideOverlayHostAfterFade` reads the host's
  computed opacity transition (`measureMotion`) and commits `display: none` on the
  `transitionend` or after the measured time, and every reveal calls
  `cancelMotion(host, 'hide')`. With no transition (reduced motion) the host hides at
  once. Needs `pnpm run build` (the patch changed).
- Firefox 158.0 review (2026-10-14): no private Firefox member in this entry
  moved. Runtime on 158.0 (first window, fresh profile): `BentoOverlayStats` lists
  `confirm`, `edit-workspace`, `workspace-switcher` (eager) and `addrbar`,
  `palette`, `menu` (idle) as `ready` with `readyBy: 'signal'` and none stalled;
  `welcome` is `ready` while the welcome flow shows; `workspace-palette`,
  `merge-palette`, `embedded-import` and `panel-navigator-tooltip` stay `absent`.
  The `loadURI failed` warning appears four times per window.
- Firefox 157.0.1 review (2026-10-12): nothing in this entry uses a private
  Firefox member that moved, and the compat probe stays at 0 missing. Runtime on
  157.0.1 with the merged tree: a first window lists `confirm`, `edit-workspace`,
  `workspace-switcher` (eager, `startup`), then `addrbar`, `palette`, `menu`
  (`idle`), each `readyBy: 'signal'`, none stalled; a window with the welcome
  open also lists `welcome` (`show`). Dist documents per window: 7, or 8 while
  the welcome is open. A cold palette
  (`Cmd+Alt+P` in a new window, before its idle creation) goes `absent` to
  `loading` with `pendingOpen: true` to `ready` by signal (first open wait 266
  ms), and `Esc` before it is ready cancels the pending open without showing the
  overlay. A cold address bar opens through `Cmd+L` (first open wait 157 ms) and
  accepts typed text. A confirm opened for window A leaves window B's confirm
  host hidden and its dialog without A's payload; cancelling in A deletes
  nothing. The `loadURI failed ... this.webNavigation is undefined` warning,
  recorded for the frames the mount navigates at startup, dropped from 11 to 4
  per window (the eager frames) because the lazy overlays are not created until
  needed; the warning itself is unchanged and also appears on 154.
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js` (`createOverlayManager`, the
    `overlays` table, `createOverlayFrame`, `openOverlay`, `isOverlayOpen`, the
    `BentoAddrbarOpen` and `BentoMergePaletteLifecycle` frame scripts)
  - `patches/chrome-layout/01-bento-shell-mount.patch` (the palette,
    merge-palette, confirm, and menu `<browser>` elements it declares stay
    in the window; palette, merge palette, and menu are navigated on first use or at
    idle; the three fading hosts lost their inline `transition`, see above)
  - `extensions/bento-shell/src/bridge/overlayReady.ts` (shell side of the
    handshake) and `windowId.ts` (the window id every overlay bus is scoped by)
  - No new Firefox patch.
- Bento functionality: the sidebar shell, the panel trailer, and the confirm,
  edit-workspace, and workspace-switcher overlays load at window startup, as before.
  The address bar, command palette, and menu are created at idle after the launch
  veil lifts. The workspace palette, merge palette, welcome, embedded import, and
  panel navigator tooltip are created on first use. Chrome reveals an overlay, and
  sends it anything, only after the document's `BENTO_OVERLAY_READY` title; a
  document that does not announce within 5 s is logged once and its open stays
  pending (no reveal). A pending open counts as open for Esc, the toggles, and
  outside click. Every overlay bus message names the chrome window it is for.
  `window.BentoOverlayStats` reports what exists and when.
- Vanilla Firefox surface touched or depended on:
  `document.createXULElement('browser')` creating a `type="content"`,
  `remote="true"`, `remoteType="extension"` `<browser>` in an already loaded
  `browser.xhtml` and appending it to a host that is `display: none` (the same
  attributes and hosts as before, only later in the window's life);
  `<browser>.loadURI()` with a system principal on such a new element (the
  existing `navigateChromeFrame` path); `<browser>` elements declared without a
  `src` staying inert until navigated; `window.requestIdleCallback`;
  `<browser>.messageManager.sendAsyncMessage` and `loadFrameScript` reaching a
  document that is still loading (they do not queue, which is why chrome waits for
  the announcement before it sends); `windowTracker.getId(window)` from
  `Extension.sys.mjs` for the window id stamped on the bus messages (already used
  for the frame URL hash); the `pagetitlechanged` event for a frame created after
  startup. No private member is used, so the firefox-compat registry has no new
  entry.
- Why this cannot stay extension-only: the overlay `<browser>` elements live in
  the chrome document and only chrome can create them.
- Firefox update risk: if a `<browser>` created after window load stops
  inheriting the extension process, or `loadURI` with the system principal is
  rejected for it, the first open of an idle or on-demand overlay stays pending
  with no visible effect and the 5 s stall error fires
  (`[bento-shell-mount] overlay <id> did not announce readiness`). If a remote
  `<browser>` without a `src` starts costing a document or process, the patch-declared
  frames cost memory at startup again; moving them out of the patch into
  `createOverlayFrame` is the fix. If `requestIdleCallback` is removed from chrome
  windows, the manager falls back to `setTimeout(0)`. If `windowTracker.getId`
  stops resolving, window ids are null and receivers accept every message (the
  old unscoped behavior), so cross-window isolation is lost until it is fixed.
- Regression checks for future updates: run `pnpm run build`, launch with
  `--jsdebugger`, and in the Browser Toolbox Console read
  `window.BentoOverlayStats`: right after startup `created` lists `confirm`,
  `edit-workspace`, `workspace-switcher`, and within a few seconds `addrbar`,
  `palette`, `menu`. Open the workspace palette, merge palette, and a delete
  confirmation once each and confirm every entry reports `readyBy: 'signal'` and
  `stalled: false`. On a profile with `welcomeSeen` false confirm the welcome
  overlay appears on first run. Hover a panel navigator button and confirm the
  tooltip follows the workspace theme and color mode after changing both in
  Settings. Then, in the Bento window: press the palette shortcut on a fresh
  profile and Esc at once (nothing may appear later); press the palette shortcut
  and the merge palette trigger back to back (only the merge palette may end up
  open, whichever loads first); open menus, the address bar, the merge palette,
  and a delete confirmation in two windows at the same time (each window keeps its
  own, and confirming deletes only that window's workspace); and open a menu in
  the first second of a new window (it appears once its document is up, with the
  items of the last request). After the motion tokens change: in the Browser
  Toolbox Console `getComputedStyle(document.getElementById('bento-palette-host'))`
  reports `transitionProperty: 'opacity'` and the modal duration (`0.18s` with the
  default Mux tokens) for the palette, merge palette and confirm hosts before
  their first show; open and close each overlay, the address bar and the welcome
  screen (the fade must not clip, and no host may stay at opacity 0 over the page
  and block input), reopen one during its fade-out (it stays open), and repeat
  with macOS Reduce motion on (nothing may hang at opacity 0).
- Rollback or migration notes: restoring the previous behavior is calling every
  `setBento*Src()` at startup again, as the end of `bento-shell-mount.js` did
  before this change.

### Add-Panel Grant (Chrome Tab Record)

- Status: Active
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): `gBrowser.addTab` still returns the native tab
  synchronously and the tab keeps its `bentoAddPanelGrant` property. Runtime on
  158.0: two grants created with `windowTracker.getId(window)` were each consumed
  by `bento-tools` (the grant was gone and the tab appeared as a panel in the
  expected slot). No change needed.
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
  longer accepted by current builds.

### Shell Bus Relay (BentoShellBus Actor)

- Status: Active
- Last updated: 2026-10-22
- Files or patches:
  - `src/browser/actors/BentoShellBusChild.sys.mjs` and
    `BentoShellBusParent.sys.mjs`
  - `patches/chrome-layout/04-bento-key-actors.patch` (a second
    `FINAL_TARGET_FILES.actors` block in `browser/actors/moz.build` that lists the
    bus actors beside the sorted list)
  - `src/browser/base/content/bento-shell-mount.js` (`registerShellBusActor`,
    `postShellActionThroughBusHub`, the `bentoPrivate` hash flag in `setFrameSrc`)
  - `extensions/bento-shell/src/experiments/chrome-bridge/` and the tracked
    `extensions/bento-shell/experiments/chrome-bridge/` (`bentoChrome.onBusMessage`,
    `bentoChrome.postToDocument`), `extensions/bento-shell/manifest.json` (version
    0.0.5)
- Document registry removal (2026-10-22): `BentoShellDocumentRegistry.sys.mjs` is
  gone, with the experiment's `bindBackground`, `listDocuments`, `getRebindProofs`,
  `ackRebindGeneration`, `noteLifecycle`, `invalidateDocument` and `onDocument*`
  events, the shell background's `shell-client/*` handshake and targeted per-document
  channel, `GraphPublicationCoordinator` and the sidebar's `useGraphStore`. The mount
  imported the registry as `resource://app/actors/...` while the experiment imported
  `resource:///actors/...`, so they held two module instances: documents registered
  in one and the experiment read the other, which was always empty, so no document
  was ever attached or delivered to. Imports and restores still ran the publication
  bookkeeping for zero recipients: a tab read and three `bento.graphPublication.v1`
  writes, which a crash mid-publish could leave behind. Measured on the 158.0 dev build with a throwaway profile:
  the `resource://app/` instance listed the sidebar, the `resource:///` instance
  listed none and held the only background binding. The shell manifest version was
  bumped because the experiment schema lost functions and events. `bento-tools`
  deletes the retired `bento.graphPublication.v1` storage key at startup.
- Bento functionality: shell documents in a private window reach the shell
  background through a JSWindowActor pair and a parent-process hub, because
  `BroadcastChannel` is partitioned by `privateBrowsingId`. The actor attaches to
  every bento-shell extension frame in every window; only private-window
  documents use it for the bus (regular windows keep `BroadcastChannel`), and the
  Settings palette overlay uses it for its requests in every window. The parent derives the document's
  window id and privacy from the hosting chrome window; the page supplies only a
  JSON string. Chrome posts a private window's tools-bound actions straight into the
  hub. The hub also mints one session id (`Services.uuid`, when the parent-process
  module loads) and stamps it on every upward record as `sessionId`; Settings scopes a
  window's durable operations to it, so they survive a reload of the extensions and
  not a browser restart. The child actor forwards an upward message of up to 22 MiB
  (`MAX_MESSAGE_CHARS`, equal to `RELAY_UP_MAX_CHARS` in
  `extensions/bento-shell/src/settings-palette/relayLimit.ts`): it counts the serialized message,
  in which JSON escaping doubles a 10 MiB backup import. The hub's backlog (records that
  arrive before the shell background listens) is bounded by count (128) and by 24 Mi
  characters of document messages, so one maximal import fits and several large ones
  cannot pile up. `scripts/shell-bus-actors.test.mjs` runs both actor modules against stubs.
- Vanilla Firefox surface touched or depended on: `ChromeUtils.registerWindowActor`
  with `allFrames`, `matches: moz-extension://*/*` and a `wantUntrusted` DOM event;
  `JSWindowActorParent.manager.documentURI` and
  `browsingContext.top.topChromeWindow`; `WebExtensionPolicy.getByID(...)
.mozExtensionHostname`; `Management.global.windowTracker.getId` and
  `PrivateBrowsingUtils.isWindowPrivate`; the `resource:///actors/` mapping of
  `FINAL_TARGET_FILES.actors` (the mount, the experiment and the registration must
  use this exact spelling, since `resource://app/actors/` loads a second module
  instance, which is how the removed document registry split in two); `BroadcastChannel`'s `privateBrowsingId` partition (the reason for the
  relay, observed on 158.0).
- Why this cannot stay extension-only: an extension page has no way to reach a
  background in another privacy partition, and the overlay documents have no
  `browser` API. A privileged actor with chrome-derived identity is the smallest
  surface that carries messages across.
- Firefox update risk: a change that attaches `topChromeWindow` differently, makes
  `BroadcastChannel` share one partition (the relay then becomes unnecessary but
  harmless), a rename of `documentURI` on `WindowGlobalParent`, or a different
  default for `wantUntrusted` events would leave private windows at "connecting...".
- Regression checks for future updates: open a private window and confirm its
  sidebar shows the "Private" workspace and its tabs, the palette lists them, and a
  regular window's workspace list never shows "Private"; in the Browser Toolbox
  Console import `resource:///actors/BentoShellBusParent.sys.mjs`, attach
  `BentoShellBusHub.onUp`, and confirm each private document's hello reports
  `isPrivate: true` and its window id; confirm no `[BentoShellBus]` warning appears and every record carries the same
  `sessionId`; import a backup of about 10 MiB that is mostly quotes and newlines in the
  Settings palette (the request message is then about 20 MiB) and confirm it reaches the
  preview step.
- Rollback or migration notes: removing the actor leaves private windows without a
  working shell (the pre-existing state); the patch hunk is independent of the key
  actors. The shell manifest version was bumped because the experiment API gained
  functions.

### Settings Palette Overlay (mount script)

- Status: Active
- Last updated: 2026-10-23
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.js` (`settings-palette` overlay
    entry, `ensureOverlayHost` for `bento-settings-palette-host`,
    `showSettingsPalette` / `hideSettingsPalette` / `dismissSettingsPalette`,
    `dispatchSettingsPaletteShow` and its `SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_URL`,
    `openFirefoxSearchSettings`, `handleSettingsTargetTitle`, the
    `bento-settings-palette-frame` title handler)
  - `scripts/firefox-compat-registry.mjs` (new sites on `gBrowser.addTrustedTab` and
    `MessageManager.loadFrameScript`; no new Firefox member), the regenerated table
    below
  - `scripts/overlay-surfaces.test.mjs`, `scripts/overlay-manager.test.mjs`
- Bento functionality: Bento Settings is a quick-pick overlay over the browser
  window instead of a Settings tab. The app menu item, the command palette's two
  commands and the welcome Open Settings button open it (`BENTO_OPEN_SETTINGS_`,
  `BENTO_OPEN_SETTINGS_PRIVACY_`), and so does a Settings row in the command
  palette's results (`BENTO_OPEN_SETTING:<row id>:<ts>`; the palette holds only a
  static label index, no settings state, and chrome accepts only an id of
  letters, digits, colon, dash and underscore up to 64 characters); chrome sends the document its show with a frame
  script (`BentoSettingsPaletteShow`, the same `loadFrameScript` and
  `sendAsyncMessage` the merge palette uses) that dispatches a DOM event carrying
  `{target, origin}` (a row id or null, and `'palette'` when the command palette opened it
  so the document can offer a way back; the document's back button writes
  `BENTO_SETTINGS_BACK_TO_PALETTE_<ts>`, which shows the command palette again), so no channel is involved; hiding the overlay sends
  the same way a `BentoSettingsPaletteHide` message that dispatches a
  `bento-settings-hide` event, so the document can put back an unfinished live edit
  and stop its timer at once. Show and Hide share a generation counter in the mount
  script: a retry of an older message is dropped once a newer one was sent, so a delayed
  Hide cannot land after a later Show. The overlay opens
  Firefox's own search settings (`about:preferences#search`, through
  `gBrowser.addTrustedTab` or the open Settings tab) for adding engines. Firefox's
  own Settings page has no Bento category any more (the native pane and its patch
  were removed 2026-10-22).
- Esc depends on one Firefox behavior, not a member: the parent process receives the key
  events of a remote `<browser>` before its document, with the `<browser>` as
  `event.target`. The capturing Esc listener (`attachPaletteEscListener`) therefore returns
  for a key whose target is `bento-settings-palette-frame` and lets the document step back,
  and consumes it only for an open waiting for its document or with focus elsewhere in the
  window. If a Firefox update delivers such keys differently (a different target, or only
  after the document), Esc would close Settings from every stage again or never reach
  chrome. The registry entry `remote <browser> key events reach the parent first` checks
  that `EventStateManager::HandleCrossProcessEvent` still forwards keyboard events with
  `SendRealKeyEvent`; the order itself is only visible at runtime, so after a Firefox bump
  send Esc from the parent (see the test note in palettes-and-address-bar.md) with the
  Settings frame focused.
- Vanilla Firefox surface touched or depended on: `gBrowser.addTrustedTab`,
  `messageManager.loadFrameScript`/`sendAsyncMessage` (both already logged), the
  overlay manager and `afterMotion` of the mount script, and the BentoShellBus relay
  (entry above) for requests.
- Why this cannot stay extension-only: the overlay must cover the window, including
  the toolbar, which only a chrome-hosted `<browser>` can do; opening Firefox's own
  search settings needs a privileged tab.
- Firefox update risk: a `loadFrameScript` data: URL restriction or a change to
  `addTrustedTab` would break the show message and the search settings link; the
  overlay would then open at its first list and the link would do nothing.
- Regression checks for future updates: open Settings from the app menu, the command
  palette (Open Settings and Privacy, and a Settings result such as typing
  "radius") and the welcome Open Settings button, in a regular and a private
  window; confirm Esc (sent from the parent, for example Marionette key actions in the chrome
  context, not from inside the page) steps back one list and closes from the first, also when
  the command palette opened Settings, and that Back from the first list returns to the
  command palette with its query; start a number edit, open the command palette without finishing it and
  confirm the setting returns to its old value at once (hide message); confirm "Manage search engines" opens `about:preferences#search`; confirm
  the merge palette and the command palette close the Settings palette and the
  reverse.
- Rollback or migration notes: none; the native pane and the rollback builds were
  retired with this surface.

### Search Engine Icons (bento-privacy Experiment)

- Status: Active
- Last updated: 2026-10-21
- Firefox 158.0 review (2026-10-21): `SearchEngine.getIconURL()` returns
  `blob:system/<uuid>` for every configured engine (Google, Bing, DuckDuckGo,
  Perplexity and Wikipedia on a fresh profile). Those blobs come from
  `IconHandler.createIconURL` (`URL.createObjectURL` in a system module), and a
  system-scope `fetch` of one returns the icon bytes with their MIME type. The
  experiment scope had no `fetch`, `AbortController`, `TextDecoder`, `btoa` or
  timers, so before this change no engine had an `iconUrl` at all.
- Files or patches:
  - `extensions/bento-tools/experiments/bento-privacy/api.js`
    (`getSearchEngines`, `getEngineIconUrl`, `iconUrlToDataUrl`,
    `SYSTEM_BLOB_ICON_URL`) and `search-icons/`
  - `scripts/bento-privacy-security.test.mjs`
  - `scripts/firefox-compat-registry.mjs` (`SearchEngine.getIconURL`,
    `IconHandler.createIconURL`, `resource://gre/modules/Timer.sys.mjs`,
    `Timer.clearTimeout`) and the `Timer.sys.mjs` line of the probe list in
    `src/browser/base/content/bento-shell-mount.js`
  - No Firefox patch.
- Bento functionality: `browser.bentoPrivacy.getSearchEngines()` returns each
  visible engine with a `data:image/` `iconUrl` (size limits per URL form:
  `docs/technical/privacy-search.md`), which the
  onboarding Search step and the address bar's engine picker draw. An engine
  without one shows a search glyph.
- Vanilla Firefox surface touched or depended on: `SearchEngine.getIconURL()` and
  the URL it returns (`blob:system/<uuid>` for configured engines; `data:` or
  `moz-extension:` for user-added and add-on engines),
  `SearchUtils.fetchIcon` for `chrome:`, `resource:` and `moz-icon:`, the
  `Cu.importGlobalProperties` and `resource://gre/modules/Timer.sys.mjs`
  facilities an experiment scope offers, and a system-scope `fetch` of a system
  blob URL.
- Why this cannot stay extension-only: engine icons live in Firefox's search
  service and its remote-settings attachments; only the parent process can read
  them, and extension pages cannot fetch a system blob URL.
- Firefox update risk: a different icon URL scheme or blob origin from
  `getIconURL()`, a changed scope for experiment scripts (a global the file uses
  is no longer provided, or `Cu.importGlobalProperties` is removed), or a
  `SearchUtils.fetchIcon` signature change. All of them fail silently as "no icon"
  because the pipeline swallows its errors.
- Regression checks for future updates: run
  `node scripts/check-firefox-compat.mjs --engine <tree>` and
  `node --test scripts/bento-privacy-security.test.mjs`, and confirm the Browser
  Console shows no `[bento-compat] missing resource://gre/modules/Timer.sys.mjs`
  (a missing export leaves every search icon empty). In a dev build on a fresh
  profile, call `browser.bentoPrivacy.getSearchEngines()` (the Marionette recipe
  in `docs/technical/privacy-search.md`) and confirm every configured engine has
  a `data:image/` `iconUrl`; then open onboarding's Search step in light and dark
  and confirm each engine shows its own icon, not the glyph, and that the address
  bar's engine picker shows the default engine's.
- Rollback or migration notes: none. Removing the experiment's icon code only
  returns the glyph fallback.

### Privacy Prefs (bento-privacy Experiment): Shutdown Clearing, HTTPS-Only, Referrer

- Status: Active
- Last updated: 2026-10-23
- Firefox 158.0 review (2026-10-23, runtime-checked in a Bento dev build on a
  fresh profile): `privacy.sanitize.sanitizeOnShutdown` plus the
  `privacy.clearOnShutdown_v2.*` item prefs are the only shutdown-clearing prefs
  Firefox reads; the `privacy.sanitize.clearOnShutdown.{cache,cookies,offlineApps}`
  prefs Bento used to write do not exist. With only the master pref on, a quit
  cleared history, form history, cookies, local storage, IndexedDB and the HTTP
  cache. `Sanitizer.maybeMigratePrefs("clearOnShutdown")` runs at every shutdown
  until `privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3` is true, even
  with the master pref off, and rewrites the v2 prefs from the legacy
  `privacy.clearOnShutdown.*` defaults (history, form data, cookies, cache on).
  `browser.privacy.network.httpsOnlyMode.set()` returns false without changing
  anything (the setting is `readOnly`), so the single-switch path had no effect.
- Files or patches:
  - `extensions/_shared/privacy-levels.ts` (`SHUTDOWN_CLEAR_PREFS`,
    `HTTPS_ONLY_MODE_PREFS`, the preset pref maps)
  - `extensions/bento-tools/src/privacy/ProtectionLevels.ts`
    (`applyAdvancedSetting`) and
    `extensions/bento-tools/experiments/bento-privacy/api.js` (`ALLOWED_PREFS`)
  - `scripts/bento-privacy-security.test.mjs` (allowlist covers every preset pref)
  - No Firefox patch and no firefox-compat registry entry (the registry lists
    members, not prefs read by name).
- Bento functionality: the "Clear cookies and cache on shutdown" switch and
  Hardened set `sanitizeOnShutdown`, `clearOnShutdown_v2.cookiesAndStorage` and
  `.cache` on, `browsingHistoryAndDownloads`, `formdata` and `siteSettings` off,
  and `hasMigratedToNewPrefs3` true. Turning the switch off, or choosing
  Standard or Enhanced, sets only `sanitizeOnShutdown` false. The HTTPS-only
  switch writes `dom.security.https_only_mode` and `dom.security.https_only_mode_pbm`
  directly, as the presets do. Hardened also sets
  `network.http.referer.XOriginPolicy` 2 and
  `dom.security.https_only_mode_send_http_background_request` false; Standard and
  Enhanced write Firefox's defaults (0 and true) so stepping down undoes them.
  The switch and the HTTPS-only choice read back every pref they wrote (a write
  to a locked pref neither throws nor changes the effective value) and, on any
  mismatch or later failure, restore the effective values captured before the
  write instead of replaying the old boolean or mode. A fresh profile gets
  Standard applied on its first launch (`WorkspaceStore` found no persisted
  workspaces), because Firefox's own
  prefs plus `prefs/bento.js` are not Standard (tracking protection only in
  private windows, Discovery Stream on, `privacy.resistFingerprinting.letterboxing`
  absent in 158).
- Vanilla Firefox surface touched or depended on:
  `browser/modules/Sanitizer.sys.mjs` (`PREF_SANITIZE_ON_SHUTDOWN`,
  `PREF_SHUTDOWN_BRANCH`, `maybeMigratePrefs`, `getItemsToClearFromPrefBranch`,
  `sanitizeOnShutdown`), the default values in `browser/app/profile/firefox.js`
  and `modules/libpref/init/StaticPrefList.yaml`, and
  `toolkit/components/extensions/parent/ext-privacy.js` (`network.httpsOnlyMode`
  read-only, its `getCallback`).
- Why this cannot stay extension-only: the prefs are read by Firefox's sanitizer
  and network stack; extensions cannot write them, and the experiment is the
  allowlisted writer.
- Firefox update risk: a renamed or re-purposed item pref, a new item name in
  `Sanitizer.items`, a new migration version (a `hasMigratedToNewPrefs4` would
  rewrite the v2 prefs again on the first shutdown after the update), or
  `network.httpsOnlyMode` becoming writable or changing its read mapping.
- Regression checks for future updates: grep the new tree for
  `PREF_SHUTDOWN_BRANCH`, `hasMigratedToNewPrefs`, and the `privacy.clearOnShutdown_v2.`
  defaults. In a dev build on a fresh profile apply Hardened, add a cookie,
  local storage, a history visit and a cached page, quit, relaunch: cookies,
  site data and cache are gone and history and form history remain.
  `browser.privacy.network.httpsOnlyMode.get({})` must read `never` after both
  HTTPS-only prefs are false and `always` after both are true. On a fresh
  profile (`user_pref("remote.prefs.recommended", false);`, since Marionette turns
  Safe Browsing off) the Settings palette must mark Standard before onboarding
  finishes and `PrivacySettings.protectionLevel` must read `standard`; change an
  Advanced switch, relaunch, and it must stay changed.
- Rollback or migration notes: there is no repair for profiles that turned the
  switch on under the old build. They keep Firefox's broader clearing (history,
  downloads, form data) until the switch is turned off and on once. Profiles on
  Hardened get the bundle from the boot re-apply of the stored level. The dead
  `privacy.sanitize.clearOnShutdown.{cache,cookies,offlineApps}` user prefs stay
  in old profiles and are ignored.

### Core UI And Window Sync Patch Stack

- Status: Active
- Last updated: 2026-10-31
- Native no-scroll root capture (2026-10-31): patch 18 adds the scoped
  ViewTransition producer documented below. Patch 19 adds the explicit native
  theme-only capture-stage input contract; 26 patches are in the series.
- Shared mode presenter (2026-11-01): patch 20 packages its native module;
  redundant background-compositor patch 17 is removed. The series has 26 patches.
- Patch removal (2026-10-22): `core-ui/15-bento-native-preferences.patch` is gone
  (see Native Bento Preferences (removed)); 23 patches remain. Its only shared
  file with a later patch was `browser/actors/moz.build`, which
  `chrome-layout/04` now edits alone (a second `FINAL_TARGET_FILES.actors` block
  that lists the shell bus actors); `core-ui/12` precedes it
  and is unchanged. The series applied in order with `git apply
--ignore-space-change --ignore-whitespace` to the pristine 158.0 files it
  touches; the source-import CI job and `pnpm run firefox:patches:check` replay the
  full stack.
- Firefox 158.0 review (2026-10-14): all 24 patches apply to 158.0. The rebase
  (`pnpm run firefox:patches:rebase` from the 157.0.1 base) stopped on three
  patches, each resolved in the stack worktree: core-ui/09 (see First-Run Browser
  Profile Import), window-sync/03 (`removeTabs` gained a `closeWindowWithLastTab`
  option that it also passes to `removeTab`; the patch now replaces the pref
  default with `false` and still honors an explicit caller value), and
  experiments/02 (see the prefs entry). window-sync/02 merged without a conflict:
  `replaceTabWithWindow(aTab, { replaceLastTab = false, ...features })` renamed the
  options argument, and the patch's `args.appendElement(aTab.splitview ?? aTab)`
  hunk is unchanged. The other 20 patches differ from their 157.0.1 form only in
  hunk offsets, `index` lines and mail hashes (compared after stripping those),
  including core-ui/12 and 15 as changed by the Settings fixes on `main`. Upstream
  changes to patched files that did not need a port: `infobar.css` (new
  `--message-bar-*` variables and an `.icon-container` margin; the accent-token
  hunk applies and the infobars keep the Bento accent), `preferences.js` and
  `preferences.xhtml` (the legacy Home pane, `home.js` and `home.inc.xhtml`, is
  gone; `customHomepage` is always registered), `nsContextMenu.sys.mjs` and
  `tab-context-menu.js` (mini-window and AI items behind their prefs), and
  `nsAppRunner.cpp` (`MOZ_CAN_RUN_SCRIPT` annotations, a web-auth profile-dialog
  skip, `GeckoProcessTypes.inc`).
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

### Shared Native Mode Presentation

- Status: Source implemented; integrated dev/dev:mux/release validation pending
- Files: `src/browser/actors/BentoModePresentation.sys.mjs`, both shell-bus actors,
  mount/theme overlays, and `patches/core-ui/20-native-mode-presenter-resource.patch`.
- Purpose: one root-only old UI image presents exact colour commits across native
  chrome and hosted shell documents. Actual native browser quads and rounded
  clip owners exclude live webpages and docked DevTools; public opaque shell
  surfaces and native focus rings restore UI over those holes. Unknown geometry
  settles instantly, with no full stale-page image fallback.
- Native dependencies: current WindowGlobal/actor identity, ChromeOnly box quads
  with `ignoreTransforms`, and `windowUtils.updateLayerTree`/`syncFlushCompositor`.
  Child submission waits for transaction receipt before ACK; one parent flush
  follows all current child ACKs. No per-frame fence or page DOM read.
- Ownership: native reads bind actual window/privacy/session and the current
  background registration; regular state is an atomic settings/stamp snapshot,
  private state comes from its per-window in-memory owner. Hosted writers request
  before any mutation, including same-mode and fallback notices.
- Upgrade checks: run focused actor/presenter/geometry/theme tests; verify the
  current native submission fence semantics and ChromeOnly geometry options;
  compile and prove actual displayed old pixels, fully live page holes/input,
  nested theme scopes, rounded-edge fidelity, reversal and dismissal in dev,
  dev:mux and a genuine production build. Node mocks are not pixel/input proof.
- Rollback: remove the product coordinator/resource patch together, restore a
  separately validated presentation strategy and rebuild. The former patch 17
  background-colour compositor opt-out is removed, not retained as extra policy;
  patches 18/19 remain narrowly scoped native capabilities. Global preferences,
  docShell activity and ordinary webpage eligibility are unchanged.


### Native No-Scroll Root ViewTransition Capture

- Status: Source-ready; native compilation and displayed-pixel validation pending
- Last updated: 2026-10-31
- Files or patches:
  - `patches/core-ui/18-native-root-view-transition-capture.patch`
  - `layout/generic/ViewportFrame.cpp`
- Bento functionality: supplies the missing WebRender root snapshot producer
  for the main browser document when its viewport has no root scroll container.
  This is capture plumbing; no product coordinator or transition is started by
  the patch.
- Vanilla Firefox surface touched or depended on: only the existing no-scroll
  branch of `ViewportFrame::BuildDisplayList`. The fallback requires a painting
  list (excluding printing), the document's own system principal and root
  `windowtype="navigator:browser"`, and
  `NS_FRAME_CAPTURED_IN_VIEW_TRANSITION` on the actual root style frame returned
  by `nsCSSFrameConstructor::GetRootElementStyleFrame`. Root scroll-container
  documents retain their existing producer. Other privileged documents and
  ordinary webpages do not enter the fallback; event-delivery lists retain the
  original path.
- Why this cannot stay extension-only: the browser root is HTML with
  `scrolling="false"`, so frame construction omits its root scroll container.
  Firefox's existing root producer lives in `ScrollContainerFrame`; the generic
  frame producer deliberately excludes root style. The viewport previously
  emitted ordinary content and ViewTransition pseudo-elements without a root
  capture item, leaving no root image keys for the pseudo-image to display.
  An API `ready` result and running pseudo-element animation therefore did not
  establish a visible captured old image. CSS or an extension cannot supply the
  missing display-list producer.
- Paint/list ownership: ordinary viewport content and the content-accessible
  top layer are built within `AutoEnterViewTransitionCapture`, with a null ASR
  and cleared clip matching the existing scroller capture convention. The six
  collection lists are consumed once through `SerializeWithCorrectZOrder`,
  using the actual document root for content order, then wrapped once in
  `nsDisplayViewTransitionCapture` with `aIsRoot=true`. The existing wrapper
  resolves the actual root style image key and snapshot-containing-block
  coordinates. Builder ASR/clip/capture state is restored before the separate
  ViewTransition/anonymous-content top layer is appended above and outside the
  captured children. The existing opaque content-top-layer culling remains.
- Firefox update risk: changes to viewport/root-frame construction, root
  capture state, list serialization, image-key ownership, capture coordinates,
  or top-layer ordering can invalidate this fallback. Check whether upstream
  gained its own no-scroll producer before rebasing, to avoid double capture.
- Regression checks for future updates: replay the stack and compile. In the
  rebuilt native browser, hold an opaque old magenta probe while its live DOM
  becomes blue; require actual displayed old magenta pixels, then a new-only
  phase showing blue. Check live webpage holes and input through the existing
  event path, content top-layer ordering without recursive ViewTransition
  capture, and a normal HTML scroll-root control. Confirm scope with ordinary
  web and other privileged documents. Current build configuration disables
  native tests; the existing ViewTransition browser test checks lifecycle only.
  Source/compat checks and `drawSnapshot` are not displayed-old-image proof.
- Rollback or migration notes: remove patch 18 and its manifest/registry entries,
  then re-import and rebuild. Keep policy 17 independent. Do not flip the browser
  root's `scrolling` attribute or introduce a preference/input exception. Product
  masking and the fully live webpage contract remain separate coordinator work.

### Native Theme-Only Capture-Stage Input

- Status: Source-ready; native compilation and trusted/physical input validation pending
- Last updated: 2026-10-31
- Files or patches:
  - `patches/core-ui/19-native-mode-transition-input.patch`
  - `dom/view-transitions/ViewTransition.{h,cpp}`
  - `layout/base/PresShell.cpp`, `layout/base/TouchManager.cpp`
- Bento functionality: preserves normal native hit testing during the rendering
  suppression stage of an explicitly owned, root-only theme presentation. The
  future controller must call `startViewTransition()` without an update callback,
  keep all non-root elements unnamed, defer colour commits until `ready`, and
  preserve geometry or abort. This patch does not implement that controller.
- Vanilla Firefox surface: a false-by-default internal transition latch is set
  only after successful old capture collection for a same-document transition
  with no update callback, its own system-principal `navigator:browser` root,
  `data-bento-mode-presentation="theme"`, and exactly one captured frame matching
  the actual document root style frame. The cross-document factory is explicitly
  marked; its null callback cannot opt in. Marker removal does not revoke a valid
  latched transaction.
- Input and phase scope: only the existing rendering-suppressed retarget checks
  in `PresShell::EventHandler::GetFrameToHandleNonTouchEvent` and
  `TouchManager::SetupTarget` consult the existing document's active transition.
  Its accessor is limited to capture/update phases and current ownership. Skip,
  replacement, cleanup and activation cannot leave an effective exemption.
  Rendering suppression, event display lists, named-element targeting, existing
  touch capture and APZ are unchanged. No new WebIDL, Document API or preference
  is added. New capture membership is revalidated before animation; missing,
  renamed or non-root membership in an opted-in transition causes an
  `InvalidStateError` skip through existing cleanup.
- Why this cannot stay extension-only: Firefox retargets suppressed input to the
  document root before normal hit testing. Disabling pseudo-element pointer
  events cannot change that early branch. The bounded native latch allows the
  existing input path only for this owned theme transaction; ordinary webpages
  and other privileged documents retain the upstream suppression behavior.
- Regression source: the patch adds a browser-chrome test under
  `dom/view-transitions/test/browser`. It advances the refresh synchronously,
  then calls ChromeOnly `synthesizeMouseEvent` with `toWindow:true` and synchronous
  dispatch before yielding to the queued update task. The mandatory missing-marker
  control targets `documentElement`; an eligible transaction must hit the owned
  native probe. Tests also cover wrong marker/identity, update callback,
  additional old/new capture, missing new root, marker removal, skip/replacement
  and an ordinary page spoofing the attributes. Every path skips its transition
  and restores normal refresh in `finally`.
- Validation limits and upgrade checks: current native tests are disabled, so
  parser/source checks do not claim trusted engine targeting was executed. Run
  the browser-chrome test in a test-enabled rebuild, then the equivalent compiled
  app diagnostic. That establishes trusted PresShell targeting separately from
  physical OS/APZ input. Recheck cross-document construction, capture arrays,
  phase changes, skip cleanup and both retarget branches on Firefox upgrades.
- Rollback: remove patch 19 and its manifest/registry entries, then import and
  rebuild. Patches 17/18 stay independent. No broad rendering/input preference or
  webpage-transition fallback should replace this contract.

### Chrome Theme Sheets

- Status: Active
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): no change. The `jar.mn` hunk in
  chrome-layout/01 applies with an offset; `document.styleSheets` of the chrome
  window ends with `bento-chrome-tokens.css`, `bento-chrome-theme.css` and
  `bento-shell-mount.css`.
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
  function, and folding the theme sheets back into the base sheet in
  `generate-chrome-tokens.mjs`, restores the single-sheet layout.

### Chrome Layout Stylesheet

- Status: Active
- Last updated: 2026-10-26
- Mode flip fade (2026-10-25, reworked 2026-10-26): `applyChromeColorMode` prepares the flip in the
  next animation frame: it sets the transient root attribute `data-bento-mode-fade` with
  `data-color-mode` and the registered delay `--bento-mode-fade-delay` (the time left until the
  flip's deadline), announces the mode at the deadline, and removes the attribute and the delay after
  the motion. One `!important` `transition` rule at the end of `bento-chrome-theme.css`, in
  `@layer bento.chrome-theme.fade` (with the exclusion below in `bento.chrome-theme.fade-exclusion`,
  ordered first) so it out-ranks every unlayered `transition: none !important` (Bento's own and
  Firefox's ID-selector ones) and every important transition of `bento.chrome-theme` itself (the
  Customize Toolbar buttons), fades every colour property of every chrome
  element (Firefox's own toolbar, urlbar and button elements included) on the Mux `state`
  pair. A generated region of the same layer (`fade-twins:begin` to `fade-twins:end`, written by
  `node scripts/fade-twins.mjs` from `bento-shell-mount.css`) repeats every Bento rule that declares
  a non-colour transition with its own entries first and the shared colour list after, so a
  running opacity or transform motion (a workspace switch) is not cancelled by a flip; the
  `.browserSidebarContainer` and `.bento-panel-header` twins list the colours without `color`,
  because Firefox's `showSplitViewPanels` rewrites the panels' classes in the panel reconcile and
  cancelled an own `color` transition there. It leaves out the native tab strip (`#tabbrowser-tabs`)
  and the panel containers of background tabs (`#tabbrowser-tabpanels > .browserSidebarContainer`
  that are not selected, split or `.split-view-panel-active`), which paint nothing but hold most of
  the elements of a window with many tabs; these are Firefox ids and classes the rule names, so a
  Firefox change to them is a regression to check (they have registry entries:
  `#navigator-toolbox[tabs-hidden]`, `.browserSidebarContainer panel container`,
  `tabpanels .deck-selected class`, `tabpanels split-view-panel classes`). No new Firefox surface
  for the chrome window except one id: with the native tab strip shown, its overflow arrows are
  toolbarbuttons inside `#tabbrowser-arrowscrollbox`'s shadow tree, which a selector does not reach.
  Bento sets the inherited `--toolbarbutton-icon-fill` on the arrowscrollbox from the registered
  `<color>` carrier `--bento-arrow-fill` (`bento-chrome-theme.css`; registered in
  `bento-shell-mount.css`), so the shadow content follows the animated value (registry entry
  `#tabbrowser-arrowscrollbox`). The window's other shadow roots with colours of their own are the
  other arrowscrollbox elements of the native strip (such as `#pinned-tabs-container`), which were
  measured only while the strip is hidden, where they paint nothing.
  About   `about:preferences`: patch 12 now also fades the page (see the patch 12 entry below).
  The colour change also reaches chrome directly: the `bentoPrivacy.notifyUiColorMode`
  experiment method fires a `bento-ui-color-mode-set` window event at each
  `navigator:browser` window (`Services.wm.getEnumerator`, `dispatchEvent`; public APIs, no new
  registry entry) and the mount script applies it, with `BENTO_PANELS` as the backstop (a later
  request for the mode the waiting flip already shows joins it). The
  stamp the event carries includes `flipAt`, the time the change should show (a plain
  `Date.now()` epoch value from bento-tools): the mount script turns it into a deadline on the
  window's monotonic clock on receipt and announces the mode on the `bento-ui-color-mode`
  topic at that deadline, so the window flips with the shell documents; no new Firefox member is
  used. A window that hides during a prepared or running fade drops the attribute and the delay
  at once.
  After a Firefox update, flip
  the mode in a running build and check in the Browser Toolbox Console that
  `document.getAnimations().filter(a => 'transitionProperty' in a)` is non-empty in the
  first frames and every entry has a 120 ms `ease` effect and the same
  `startTime + effect.getTiming().delay` (the attribute timestamps are the prepare, up to the
  120 ms lead earlier, not the visible start); a chrome element that snaps
  has a `transition: ... !important` of higher specificity upstream or an unregistered
  custom property inside a gradient (see theming.md, "Mode flip fade"). With the native tab
  strip shown (`bento.chrome.hideNativeTabs` false) and enough tabs for the strip to overflow,
  check that `getComputedStyle(document.getElementById('tabbrowser-arrowscrollbox')).getPropertyValue('--toolbarbutton-icon-fill')`
  animates through the flip and that the arrow icons (`#scrollbutton-up` in the shadow root)
  follow it.
- Last updated before that: 2026-10-17
- Motion tokens (2026-10-17): the transitions and animations in
  `bento-shell-mount.css` and `bento-chrome-theme.css` read the Mux
  `--muxui-semantic-motion-*` tokens that `bento-chrome-tokens.css` carries, instead
  of the removed `--bento-duration-*` and `--bento-easing-*` tokens and literal
  times; `--drag-drop-transition-duration` (Firefox's customize-mode property, set
  in `bento-chrome-theme.css`) is the Mux reveal duration. `pnpm run lint:motion`
  checks both sheets for raw times and easings. After a build, in the Browser
  Toolbox Console
  `getComputedStyle(document.documentElement).getPropertyValue('--muxui-semantic-motion-reveal-transition-duration')`
  is `200ms` with the default tokens.
- Sidebar push (2026-10-17, hide added 2026-10-19, shell frame still and `show` added
  2026-10-22): Cmd+S collapse and expand no longer transition the host width, and hide
  mode's hide slides the same way (`:root[bento-sidebar-push='hide']`,
  `.bento-sidebar-hidden` lands when the slide ends; `'show'` is the expand out of the
  hidden state; no new Firefox surface). `applyChromeSidebarCollapsed` in the mount script
  slides the host and the in-flow children of `#browser` right of it as one strip
  with `transform` and `opacity` (`:root[bento-sidebar-push]`,
  `.bento-sidebar-push-page`, the `bento-sidebar-push-*` keyframes in this sheet),
  on the Mux reveal role's spring pair (400 ms, no overshoot; the hidden-sidebar
  edge-hover slide-over uses the same pair), and `#nav-bar::before` is used while it
  runs. The strip does not fade. Collapse and expand also keep the shell document still: the host
  `#bento-shell-host` (a XUL `vbox`) takes `overflow: clip`, the remote
  `<browser id="bento-shell-frame">` inside it gets an opposite `transform` animation on
  the host's timing (`bento-sidebar-push-frame-collapse` and `-frame-expand`), and a
  `#bento-shell-host::after` 1px line marks the visible right edge. Firefox surface
  depended on: a `transform` animation on a remote `<browser>` element running on the
  compositor, the `overflow: clip` of its XUL `vbox` parent clipping that remote
  content, and `::after` rendering on a XUL `vbox`; the
  children of `#browser` are laid out as flex items in document order with
  `#bento-shell-host` first (`browser-box.inc.xhtml`), the page group is found by
  computed style (`display`, `position`), not by id, and `#nav-bar`,
  `#nav-bar-customization-target`, `#PersonalToolbar` and the native
  Back/Forward/Reload ids keep their roles (all already used by the toolbar
  alignment code). No private Firefox member is added, so the firefox-compat
  registry has no new entry. Regression checks for future updates: in a build,
  collapse and expand with Cmd+S and check that the sidebar, page, toolbar
  controls and the toolbar's sidebar-coloured segment move together with no jump at
  either end, that the panels are aligned after each toggle, and that
  `document.documentElement.hasAttribute('bento-sidebar-push')` is false afterwards;
  in hide mode, check the same for hide and show (no jump of the page at the start of
  a hide, the divider entering with the strip on a show). For the remote-frame
  transform and clip: with side panels open, raise
  `--muxui-semantic-motion-reveal-transition-spring-duration` on the chrome root (30 s),
  collapse, and in the Browser Toolbox Console check that `document.getAnimations()`
  lists the host's and `#bento-shell-frame`'s slide, both with `isRunningOnCompositor`
  true, that their `getComputedStyle(...).transform` translations sum to 0 at several
  `currentTime` values, that the sidebar's pixels (screenshot) do not move while its
  right edge does, that the content right of the edge is clipped and a 1px line in the
  sidebar divider colour sits at the edge (and is absent with no side panels); repeat for
  expand, and confirm hide and show have no frame animation, clip or line. If the remote
  frame ignores the transform or the clip (content drawn outside the host, or moving with
  the host), the counter-translation fails and the sidebar shows the host's slide only;
  after a Firefox bump,
  re-read `browser-box.inc.xhtml` for added in-flow children of `#browser` and for
  any `::before` or `::after` rule on `#nav-bar`. Stacking (2026-10-24, issue #85): the
  host is `z-index: 5` for the slide and `#bento-strip-container` is `z-index: 6`, so the
  main frame's and panel frames' drop shadow keeps painting over the host's area; with
  side panels and with none, check in recorded frames of a collapse, expand, hide and show
  that the shadow beside the card keeps the same width and darkness as the settled
  state (about 40 px, not cut to the gutter and not snapping at the end).
- Fluid sidebar push (2026-10-25): with no side panels (`bento-no-side-panels`), Cmd+S
  collapse and expand resize the main container with the host's edge every frame instead of
  sliding a finished layout (`:root[bento-sidebar-push-fluid]`, latched by
  `startSidebarPush`; windows with side panels, hide and show keep the transform slide above).
  Firefox surface depended on: a registered, non-inherited `<number>` custom property
  (`@property --bento-sidebar-push-progress`) animated by a CSS animation on
  `#bento-shell-host`, `#bento-shell-frame`, `#PersonalToolbar`, the native
  Back/Forward/Reload ids, `#bento-panel-nav` and the generated `#nav-bar::before`, read by
  `transform`, `margin-right` and `margin-inline-start` declarations on the same element
  (main thread, so layout and every moving part are sampled in one restyle; no compositor
  animation); `round()` in `calc()` for the whole-pixel edge; the flex layout of `#browser`
  (`#bento-shell-host`, the splitter, `#bento-strip-container`) re-laying out the
  container when the host's negative right margin changes, and the remote `<browser>` in
  the main panel receiving a resize every frame; `animationend` firing on the host for an
  animation that animates only a custom property (it ends the push through `afterMotion`).
  No private Firefox member is added, so the firefox-compat registry has no new entry.
  Regression checks for future updates: with no side panels, in the Browser Toolbox Console
  during a collapse and an expand (raise the spring duration token to see it slowly),
  `#bento-shell-host`'s right edge and `#bento-strip-container`'s left edge from
  `getBoundingClientRect()` are equal on every frame and the strip's right edge is the window's;
  the content window's `innerWidth` changes every frame; `document.getAnimations()` lists
  only `bento-sidebar-push-progress` animations for the push, with one `startTime` and
  `isRunningOnCompositor` false; the last animated frame equals the settled layout; with a
  side panel open the same toggle still lists the transform animations; the same with the
  sidebar's inline width set to a fractional value (`host.style.width = '300.25px'`): the
  first frame equals the pre-push layout and the last the settled one. After a Firefox bump,
  confirm registered custom property animations still run and fire `animationend`
  (`getComputedStyle($0).getPropertyValue('--bento-sidebar-push-progress')` mid-push).
- Rail colour (2026-10-22): the collapsed rail takes the toolbar's main colour (the shell's
  rail look; chrome's `:root[bento-sidebar-rail]`, set by `applyChromeSidebarCollapsed`),
  with no right edge line, and the colour fades with a collapse or expand. Firefox surface
  depended on: a registered, non-inherited `<color>` custom property
  (`@property --bento-toolbar-left-bg`) transitioning on `#navigator-toolbox`,
  `#TabsToolbar` and `#nav-bar` and read by their gradients, `inherit` of it by the
  generated `#nav-bar::before` (the band), `background-color` and opacity animation on the
  `#bento-shell-host` XUL `vbox` and its `::after`, and the layered
  `bento.chrome-theme` `#bento-shell-host { background-color: ... !important }` rule in
  this sheet following the one in `bento-chrome-theme.css`. The push's `transition` on
  `#navigator-toolbox`, `#TabsToolbar` and `#nav-bar` replaces whatever transition list
  Firefox gives them for the 400 ms (an extension theme's `transition:
var(--ext-theme-background-transition)` on `#nav-bar` only matters if a theme changes
  during a push, and the `.browser-titlebar` inactive-window opacity fade on `#nav-bar`
  only if the window loses or gains focus during one), so it skips `#navigator-toolbox[fullscreenShouldAnimate]`: upstream's
  `transition: 0.8s margin-top ease-out` on that attribute (`browser-shared.css`, set by
  `browser-fullScreenAndPointerLock.js`) is the fullscreen reveal, and replacing it
  cancelled the animation and snapped the toolbox. That attribute selector is the one new
  upstream dependency, recorded in the firefox-compat registry (engine-only entry). No
  private Firefox member is added. Regression checks for future
  updates: with side panels open, collapse and expand with Cmd+S (and raise the spring
  duration token as above) and check that the toolbar segment left of the split, the
  host's background, the divider line and the host's edge line all reach the main colour
  or the sidebar colour together, with no snap at the settle; that the window controls
  and the rail are one surface in the rail; with no side panels, that nothing changes
  colour; that hide, show and a theme change switch at once; and that the toolbox's
  fullscreen transition survives a push (enter fullscreen, press Cmd+S while the toolbox
  slides: its `margin-top` animation keeps running to the end). After a Firefox bump,
  confirm `@property` transitions still animate on these toolbar elements (check
  `getComputedStyle($0).getPropertyValue('--bento-toolbar-left-bg')` mid-push), and
  re-read any new `transition` or background rule on `#navigator-toolbox`, `#nav-bar` or
  `#TabsToolbar` in the Firefox toolbar stylesheets.
- Firefox 158.0 review (2026-10-14): `Loader::LoadStyleLink`,
  `LinkStyle::GetSheetForBindings` and `AppWindow::OnChromeLoaded` still exist;
  `Loader.cpp` changed only the stylesheet MIME-type diagnostic (`MimeNotCss`,
  now keyed by a final-URI same-origin flag) and the `mRecordErrors`
  initialization. Runtime on 158.0: the first window shows
  `__bentoSheetGate = { pending: 3, releasedBy: 'load', heldMs: 121 }` and the
  sheets load in the order tokens, theme, layout.
- Firefox 157.0.1 review (2026-10-12): the `jar.mn` line is carried by the 157
  rebase of `patches/chrome-layout/01-bento-shell-mount.patch` (it was added
  through the patch stack worktree, not by editing patch text; the hunk moved by
  one line). The branches the gate relies on are unchanged between 154.0 and
  157.0.1: `Loader::LoadStyleLink` still inserts a sheet that is already complete
  in the shared cache synchronously (only inline-sheet parsing changed), and
  `LinkStyle::GetSheetForBindings` and `AppWindow::OnChromeLoaded` exist.
  Runtime on 157.0.1: `document.styleSheets` ends with the tokens, theme, and
  `bento-shell-mount.css` sheets in that order. The first window shows
  `__bentoSheetGate = { pending: 3, releasedBy: 'load', heldMs: 192 }`. Windows
  opened later show `undefined`, with one exception: the first extra window
  opened right after a GC and cycle-collection pass (the `windows-cycle`
  harness) was gated for 9 ms and released by `'load'`, which the technical
  companion allows; treat `releasedBy: 'load'` in a second window as healthy
  and `'timeout'` or `null` as the failures.
- Files or patches:
  - `src/browser/base/content/bento-shell-mount.css`
  - `src/browser/base/content/bento-shell-mount.js` (`injectChromeStyles`,
    `gateFirstPaintOnSheets`)
  - `patches/chrome-layout/01-bento-shell-mount.patch` (one `browser/base/jar.mn`
    line: `content/browser/bento-shell-mount.css (content/bento-shell-mount.css)`)
  - `scripts/mount-sheet-gate.test.mjs`, `scripts/check-chrome-resize-guard.mjs`,
    `scripts/check-import-output.mjs`, `scripts/sync-builtin-addon-symlinks.sh`
- Bento functionality: the chrome layout rules (panel strip, splitters,
  navigator, overlays, startup veil, fullscreen overrides; about 2,500 lines and
  100 kB) are a static chrome stylesheet instead of a template literal in the
  mount script. `injectChromeStyles()` appends one `<link rel="stylesheet">` to
  the window root at the point where the former inline `<style>` was appended, so
  the rules, their order, and their place in the cascade are unchanged. Because
  Gecko does not hold initial layout for script-inserted links, a paint gate
  keeps the chrome root invisible while the tokens, theme, or layout link has no
  complete sheet yet (see below). The mount script lost 114 kB (866,038 to
  751,825 bytes). The link is a document sheet, so the sheet is parsed once per
  process and cloned from the shared sheet cache in later windows, as the inline
  sheet was, and DevTools lists it.
- Vanilla Firefox surface touched or depended on: `browser.jar` content
  registration through `browser/base/jar.mn`; the `chrome://browser/content/`
  package; the CSS loader's handling of a script-inserted stylesheet link in a
  chrome document (`layout/style/Loader.cpp`: the sheet is inserted by document
  order of its owner node, so a link keeps the place the `<style>` held; the
  load joins the document load group and blocks the load event, and the link's
  `load` or `error` event is itself load-blocking; a sheet already complete in
  the shared sheet cache is inserted synchronously); `LinkStyle.sheet`, which
  is null until the sheet is complete (`LinkStyle::GetSheetForBindings`); and the
  startup behavior the gate compensates for: `PrototypeDocumentContentSink`
  counts only parser-created links and `<?xml-stylesheet?>` instructions as
  pending sheets before initial layout, `PresShell` paint suppression ends after
  `nglayout.initialpaint.delay` (5 ms), and `AppWindow` shows a normal window only
  after its document finishes loading (`xpfe/appshell/AppWindow.cpp`) while the
  early blank window (`browser.startup.blankWindow`,
  `BrowserGlue._earlyBlankFirstPaint`, `BrowserContentHandler.replaceStartupWindow`)
  is visible before `browser.xhtml` loads. No private Firefox member is used, so
  the firefox-compat registry has no entry for it.
- What holds back first paint, by startup path:
  - Normal first window: the window is hidden until the document load event; the
    links and their load events block it, so the gate is released before the
    window is shown and adds no delay.
  - Early blank window (Windows by default; Linux in Nightly or with the pref
    on; needs a persisted window size and the default theme): the window is
    already visible, script-inserted links do not hold back initial layout, and
    paint is unsuppressed after 5 ms. The gate hides the root until every
    pending link has fired `load` or `error` (2 s timeout), so the tokens,
    theme, and layout sheets are all present at first paint. This also covers
    the tokens and theme links, which had the same exposure before.
  - Later windows: all three sheets come from the shared cache and are complete
    when inserted, so the gate does not engage.
- Why this cannot stay extension-only: the rules style Firefox's own chrome
  elements (`#browser`, `#tabbrowser-tabpanels`, `.browserContainer`,
  `:root[inDOMFullscreen]`), and Bento has no extension-served stylesheet path
  into the browser window. It follows the jar.mn route of `bento-chrome-theme.css`.
- Firefox update risk: low. The jar.mn line sits in the hunk that already adds
  the other Bento chrome files. Upstream would have to change how chrome
  documents order, block on, or cache script-inserted stylesheet links to affect
  it. The gate hides the root with an inline `visibility` declaration; Firefox
  chrome and the mount write no other inline `visibility` on the root.
- Regression checks for future updates: `pnpm run firefox:patches:check`;
  `node --test scripts/mount-sheet-gate.test.mjs`; `pnpm run import` then
  `node scripts/check-import-output.mjs` (fails when any
  `src/browser/base/content` file is missing from the engine or from
  `browser/base/jar.mn`); after a build,
  `chrome/browser/content/browser/bento-shell-mount.css` exists in the app
  resources. In a running build, in the Browser Toolbox Console,
  `[...document.styleSheets].map((s) => s.href)` lists the tokens, theme, and
  layout sheets in that order ahead of any `bento-chrome-themes/` sheet, the
  Style Editor lists `bento-shell-mount.css`, and `window.__bentoSheetGate` is
  `undefined` or has `releasedBy` set to `'load'` (never `'timeout'`, never
  null after startup). Cold-start the first window and open a second one:
  styled at first paint, and the second window's `__bentoSheetGate` is
  `undefined` (never hidden). Blank-window cold start: on Windows with a
  persisted window size and the default theme, and on Linux with
  `browser.startup.blankWindow` set to true, record the launch and check the
  first frames after the blank window navigates to the browser: no frame with
  unstyled chrome or startup veil, and the root is shown again (`releasedBy`
  `'load'`). After a Firefox bump also re-read `Loader::LoadStyleLink`,
  `LinkStyle::GetSheetForBindings`, `PrototypeDocumentContentSink::CloseElement`,
  and `AppWindow::OnChromeLoaded`, and run `git apply --check` on the jar.mn
  hunk against the new `browser/base/jar.mn`.
- Rollback or migration notes: restoring the sheet as a template literal inside
  `injectChromeStyles()` and dropping the jar.mn line returns to the inline
  `<style>`; the gate then has nothing to wait for on the layout link, and its
  call can stay for the tokens and theme links.

### Native Preferences Layout

- Status: Active
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): the patch applies with offsets. Upstream
  deleted the legacy Home pane (`#homepageGroup` and `#homeContentsGroup` rules in
  `preferences.css`, `home.js`, `home.inc.xhtml`) and changed the
  `#blockAiGroup` and `#aiBlockedMessage` rules; neither is in this patch's
  hunks. Runtime on 158.0 (`about:preferences` in a panel): the root carries
  `data-bento-theme="default"` and a `data-color-mode` equal to the host window's
  (`light`), `color-scheme` is `light`, and `--background-color-box`,
  `--border-radius-circle`, `--space-large` and `--neutral-5` are all non-empty.
  The wide-window centering, narrow-window clipping, dark mode and window-move
  checks below were not repeated headless.
- Firefox 157.0.1 review (2026-10-12): patch applies with offsets only. Settings
  layout is centered as on 154. Known on 154 and 157: on `about:preferences` the
  Firefox design tokens `--background-color-box`, `--border-radius-circle` and
  `--space-large` computed empty and cards rendered flat. Cause: the page links
  `bento-chrome-tokens.css`, which declares the legacy aliases (`--neutral-*`,
  `--radius-*`, `--space-2xs`) only for elements with `data-bento-theme` or
  `data-color-mode`, and the preferences root carried neither, so every token
  this patch maps onto an alias, and the sheet's own `:root` `--space-large`
  family, was invalid. Fixed in this patch: the root has
  `data-bento-theme="default"`, `preferences.js` copies the hosting window's
  `data-color-mode`, and `preferences.css` sets `color-scheme` from it.
- Files or patches:
  - `engine/browser/components/preferences/preferences.xhtml`
  - `engine/browser/components/preferences/preferences.js`
  - `engine/browser/themes/shared/preferences/preferences.css`
  - `src/browser/base/content/bento-chrome-tokens.css`
  - `src/browser/base/content/bento-shell-mount.js` (`applyChromeColorMode`)
- Bento functionality: centers Firefox's native `about:preferences` content pane
  and category navigation as one unit in the available browser content area, so
  the settings controls do not sit flush against the side nav on wide windows.
  The native preferences page also loads Bento's generated Mux UI token sheet
  and maps Firefox in-content semantic variables for surfaces, text, borders,
  buttons, fields, panels, and focus rings onto Mux UI/Bento tokens while
  rendering preferences cards and box groups as borderless neutral-5 tiles. The
  document root carries `data-bento-theme="default"` and a `data-color-mode`
  that `preferences.js` copies from the root of the window hosting the page,
  because the token sheet's aliases and mode blocks apply only to elements with
  those attributes; `color-scheme` follows the same attribute so Firefox's
  `light-dark()` tokens agree. The mount script's `applyChromeColorMode`
  announces each change on the `bento-ui-color-mode` observer topic, and the
  page looks its host window up again each time (`topChromeWindow`), because a
  Settings tab moved to another window keeps its document. A move into a window
  whose mode already differs announces nothing, so the page also re-reads on
  `visibilitychange` (when visible) and window `focus`. A change after the first copy also
  fades the page's own colours (2026-10-25): `preferences.js` adopts a small stylesheet into
  the document, sets `data-bento-mode-fade` on the root while the colours change and removes
  it after the root's computed `transition-duration` (a timer, not frames, so a page that is hidden
  during the fade still loses the attribute); moz-* shadow DOM is out of reach. The page follows the
  `bento-ui-color-mode` notification, which the window announces at the flip's deadline, so the page
  starts its fade with the other documents (its re-read on `focus` or `visibilitychange` reads the
  window's attribute, which changes at the prepare, up to the lead earlier). Under
  reduced motion or in a hidden page the change does not fade and ends a running fade (the same
  gate as the window and the shell). The addition is one block of about 28 lines in the same
  hunk (the hunk is 68 added lines in all), checked with `git apply --check`
  against a synthetic file and `pnpm run firefox:patches:test`; it has not run in a real
  build (no engine here), so the first build after the merge must check it.
- Vanilla Firefox surface touched or depended on: the native preferences XHTML
  layout and in-content theme cascade, including `#categories`,
  `.main-content`, `.pane-container`, `chrome://global/skin/in-content/common.css`,
  the generated `chrome://browser/content/bento-chrome-tokens.css`, and
  `window.browsingContext.topChromeWindow` (read by `preferences.js` to mirror the
  window's color mode, as `main.js` and `sync.js` already do).
- Why this cannot stay extension-only: `about:preferences` is a privileged
  built-in Firefox page; extension CSS cannot reliably restyle its chrome-loaded
  layout or define its in-content semantic theme variables.
- Firefox update risk: upstream preferences markup, XUL box alignment behavior,
  settings redesign layout changes, in-content variable names, or preferences
  widget token dependencies can reintroduce left alignment, alter the content
  pane width, or disconnect preferences controls from Bento's Mux UI palette.
- Regression checks for future updates: on `about:preferences` read the computed
  `--background-color-box`, `--border-radius-circle`, `--space-large` and
  `--neutral-5` on the root (all must be non-empty), confirm
  `data-color-mode` follows the sidebar color mode control in both directions
  (the page's own `prefers-color-scheme` does not), also after moving the
  Settings tab to a new window (`gBrowser.replaceTabWithWindow`) and closing the
  first one, after moving it into a window whose mode differs from the one it
  left (with no toggle afterwards it must adopt the destination's mode), that
  flipping the mode with the page open fades its colours (its root carries
  `data-bento-mode-fade` for the duration of the `state` transition, then loses it, and
  the first load in dark mode does not fade), and that
  a card has a fill and a radius. Open `about:preferences` in a wide
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

### Native Bento Preferences (removed)

- Status: Removed (2026-10-22)
- Last updated: 2026-10-22
- Files or patches: none remain. Removed with the Settings palette work:
  `patches/core-ui/15-bento-native-preferences.patch` (the Bento category and
  panes of `about:preferences` and `about:settings`, their config module,
  custom elements, protocol copies, Fluent file, stylesheet, mochitests, and the
  `moz-select` and `test_moz_select_panel.html` edits),
  `extensions/_shared/native-preferences-contract.json` with its generated
  copies, and `extensions/bento-tools/experiments/bento-native-preferences/**`.
  Kept: `patches/core-ui/12-center-native-preferences.patch` (entry above). The
  parent-process document registry that survived this removal was itself removed
  later the same day (see the Shell Bus Relay entry); bento-tools numbers its own
  run for durable-operation ownership.
- Bento functionality: none; Bento's settings live in the Settings palette
  (entry above). `bento-tools` deletes the retired `bento.nativeSessions.v1`
  storage key at startup and keeps `bento.nativeOperations.v1`, the durable
  operation records the palette still uses. The `BentoOpenMergePalette` window
  listener of the mount script was removed with the pane's Merge button.
- Vanilla Firefox surface no longer touched: config-backed preferences panes
  (`Preferences.mjs`, `AsyncSetting`, `SettingGroupManager`, `CONFIG_PANES`,
  `gotoPref`), `moz-select`, `moz-slider`, `moz-input-number`, `moz-button`,
  `moz-input-search`, `moz-box-group`, `moz-box-item`, preferences jar and
  locales, and `extension.windowManager.getWrapper`. The 21 registry members for
  them were removed from `scripts/firefox-compat-registry.mjs`. Still used:
  `CanonicalBrowsingContext.topChromeWindow` (patch 12 and the shell bus relay)
  and `FINAL_TARGET_FILES.actors`.
- Why this exists: the Settings palette replaced the pane, and the pane's
  observer bridge and the rollback builds that guarded its removal were retired
  together.
- Firefox update risk: none from the pane.
- Regression checks for future updates: patch replay passes with the pane patch
  absent; `about:preferences` shows no Bento category; the Browser Console shows
  no `[bento-compat] missing` line and no error from
  `resource:///actors/BentoShellBusParent.sys.mjs`; the Settings palette
  opens and applies a change in a regular and a private window.
- Rollback or migration notes: the rollback builds (`rollback/legacy-source`,
  `scripts/build-rollback-variant.mjs`) were removed with the pane. Restoring the
  pane means restoring the patch from version control and the experiment with it.

### Hidden Native Tabs And Titlebar Controls

- Status: Active
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): `TabBarVisibility.update()` now also treats a
  window with the `mini-window` root attribute as a single-tab window; the patch's
  condition is unchanged and the attribute is never set while
  `browser.mini-window.enabled` is false. Runtime on 158.0: `#TabsToolbar` computes
  `visibility: collapse` with a 1 by 0 px box, `bento.chrome.hideNativeTabs` is
  true, and `browser.nova.enabled` and `sidebar.revamp` read false. Window
  controls, dragging and fullscreen were not checked headless.
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
- Last updated: 2026-10-22
- Firefox 158.0 review (2026-10-14): `FirefoxProfileMigrator.key` now returns
  `AppConstants.MOZ_APP_NAME`, its display-name string is
  `migration-wizard-migrator-display-name-self`, and `MigrationUtils` keys
  `APP_DESC_TO_KEY` and the default-browser fallback by `MOZ_APP_BASENAME` and
  `MOZ_APP_NAME`. For Bento, `MOZ_APP_NAME` is `bento`, which would have made the
  migrator list Bento itself and miss Mozilla Firefox. core-ui/09 therefore keeps
  `key` at `"firefox"` and the display name at the `-firefox` string ("Firefox")
  when `MOZ_APP_NAME` is `bento`, restores the `Firefox` and `Nightly` entries of
  `APP_DESC_TO_KEY` and the `startsWith("Firefox")` fallback, and adds back the
  `-firefox` string in `migrationWizard.ftl` next to upstream's `-self` string.
  Two more keys changed in 158 and must agree with `nsAppRunner.cpp`, which still
  requests the literal `firefox-selectable-profile` when a selectable profile is
  reset (`--reset-profile --migration`, `SelectProfile` migration branch):
  `FirefoxSelectableProfileMigrator.key` and `FIREFOX_REFRESH_MIGRATOR_KEYS` (the
  set that picks the `fxrefresh` telemetry entrypoint) are built from
  `MOZ_APP_NAME` upstream. For Bento that registered `bento-selectable-profile`,
  so `MigrationUtils.asyncStartupMigration` threw "asked to open auto-migrate from
  a non-existent source" after the replacement profile existed and no data
  migrated. core-ui/09 therefore keeps the firefox keys there too: the
  selectable-profile migrator is `firefox-selectable-profile` and the refresh set
  is `firefox` plus `firefox-selectable-profile`, the 157 values. The C++ stays
  untouched. The plain-profile reset branch of `nsAppRunner.cpp` requests
  `MOZ_APP_NAME` (`bento`), which no migrator registers; that mismatch predates
  158 (the 157.0.1 source has the same line and the Firefox migrator was already
  keyed `firefox`), it is left as it is, and its migrator would read Mozilla
  Firefox profiles rather than the old Bento profile. The refresh UI is gated
  the same way: `ResetProfile.resetSupported` requires
  `MigrationUtils.migratorExists(MOZ_APP_NAME)`, so Refresh Bento is unavailable,
  for selectable profiles too, until Bento has a migrator for its own profiles.
  Aliasing `bento` to the Firefox importer would pick the wrong source. Bento's first-run flow
  (`BENTO_RESTART_TO_MIGRATION`) passes no key. After a Firefox update re-read
  the `aKey = ...` lines in `nsAppRunner.cpp` (the compat registry entry
  `nsAppRunner selectable-profile reset key` fails if the literal changes) and
  confirm in a running build that `MigrationUtils.migratorExists` is true for the
  key the selectable-profile branch requests.
  Regression check: in the welcome flow's import step and in the startup wizard
  the Firefox source reads "Firefox", and the default-browser preselection still
  resolves to Firefox when Firefox is the system default. Runtime on 158.0
  (headless, fresh profile): `FirefoxProfileMigrator.key` is `firefox` and its
  display-name id is `migration-wizard-migrator-display-name-firefox`, which
  localizes to "Firefox" (the `-zen` string to "Zen Browser");
  `MigrationUtils.availableMigratorKeys` lists `firefox`, `zen` and
  `firefox-selectable-profile`; `getMigrator("firefox")` returned null because
  `FirefoxProfileMigrator` is startup-only (`isSourceAvailable()` is false outside
  a startup migration). Driving `MigrationUtils.asyncStartupMigration` with the
  key `nsAppRunner.cpp` requests (wizard window stubbed, source discovery faked,
  no profile read) resolves `FirefoxSelectableProfileMigrator` and reaches the
  wizard with entrypoint `fxrefresh` and `skipSourceSelection` true; `bento` and
  `bento-selectable-profile` throw the non-existent source error. The reset itself
  (`--reset-profile --migration` on a selectable profile) was not run: macOS
  ignores `HOME`, so a named profile with a store ID would live in the real
  `~/Library/Application Support/Bento`, and the startup wizard needs a click
  before Marionette is available. The welcome overlay is `ready` on a fresh
  profile. The import wizard itself and the default-browser preselection were not
  exercised.
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
  root. The card opens at the onboarding dialog's rectangle and reshapes into the
  wizard (and back on Cancel or Done), so the dialog and the wizard read as one
  card; the host reports ready when the wizard's `#wizard-deck` leaves
  `page-loading`. Full Mozilla Firefox or macOS Zen Browser profile imports remain an
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
  URLs are not copied into Bento's normal profile. The Ready step's Open Settings
  button ends onboarding and sends `BENTO_OPEN_SETTINGS_<ts>` from the welcome
  frame; the mount script's `bento-welcome-frame` title handler answers with
  `hideWelcome()` and then `showSettingsPalette()`, the same helper the app
  menu's Bento Settings item and the command palette use, so it adds no Firefox
  member and no compat-registry entry (Start browsing sends the close title and
  only hides the overlay). The handler acts only while the welcome host is showing
  (`isWelcomeShowing`: visible and opacity not `0`), because `hideWelcome()` fades the
  host out and a second Open Settings title made during the fade would open the Settings
  palette twice (it added a second Settings tab before the palette). The guard reads
  the host's style, not page state, so onboarding shown again in the same window
  (after Reset Bento settings) finishes normally.
- Vanilla Firefox surface touched or depended on:
  `toolkit/xre/nsAppRunner.cpp`,
  `browser/components/migration/FirefoxProfileMigrator.sys.mjs`,
  `browser/components/migration/MigrationUtils.sys.mjs`,
  `browser/components/migration/MigrationWizardParent.sys.mjs`,
  `browser/locales/en-US/browser/migrationWizard.ftl`, and the native
  `ProfileMigrator` / `MigrationUtils` startup and in-window migration paths. The host
  and bridge sheets also depend on these Firefox styling surfaces (token names and
  rules, no registry entries, like the other design tokens the host maps):
  `toolkit/themes/shared/in-content/common-shared.css` (`--button-*` tokens and the
  `html|button:enabled:hover`, `:hover:active` and `button:focus-visible` rules),
  `toolkit/themes/shared/popup.css` (`--panel-background-color`, `--panel-text-color`,
  `--panel-border-color`, `--panel-border-radius`, `--panel-padding`, and the macOS
  native `appearance` and `color-scheme`), `toolkit/content/widgets/panel-list/`
  (`panel-item.css` and its `--button-background-color-menu-*` tokens, the `part="button"`
  and `part="label"` parts), and `browser/themes/shared/migration/migration-wizard.css`
  (`panel { --panel-padding }`, `panel-item.selected`), plus the wizard's XUL `<panel>`
  around its `<panel-list>` (`#ensureSelectionDropdown`).
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
  path conventions, the wizard's `#wizard-deck` `selected-view` attribute and its
  `page-loading` initial value (the morph waits on it, and falls back to the plain
  fade after a ceiling), the Import step's tiles (the migrators' `static key` and
  `brandImage` getters, the `MigrationUtils.getMigrator` result, `enabled`,
  `hasPermissions`, `canGetPermissions` and `getSourceProfiles` that decide whether
  the wizard lists a browser, `FirefoxProfileMigrator.getAllProfiles`, and the
  wizard's `setState`, the selection state's `migrators` and `migratorKey`,
  `MigrationWizardChild.setComponentState` waiving Xrays, and
  `MigrationWizardConstants.PAGES.SELECTION`, which the preselecting hook
  depends on), chrome restart environment propagation, the welcome-frame
  hash URL convention, macOS app bundle locations, `moz-icon://` icon behavior,
  `zen-sessions.jsonlz4` structure, Firefox SessionStore JSON structure, or
  WebExtension sessions extData key encoding can stop the onboarding import
  action from opening migration, break the Firefox/Zen scoping, restart the
  welcome flow at the first step after import, make the Firefox-family migrators
  enumerate Bento profiles, use Bento's icon for source apps, or make Zen
  spaces/tabs restore without Bento workspace/panel ownership. A rename of the
  `--button-*` or `--panel-*` tokens above, a change to the specificity of the
  in-content button rules, the wizard dropping its XUL `<panel>` for a `popover` panel-list
  (then the `--panel-list-*` tokens and the panel-list shadow apply instead), or
  `panel-item.selected` changing its fill turns the import host's buttons grey on hover
  or the selector dropdown back into the native OS-scheme menu.
- Regression checks for future updates: launch Bento with no existing Bento
  profile while Mozilla Firefox and/or macOS Zen `profiles.ini` files exist,
  confirm Bento onboarding appears first, advance to the import state, click
  import, confirm the embedded import host appears without closing the Bento
  window as one card reshaping from the dialog (no second dialog visible, the
  scrim unchanged) and that Cancel returns on Privacy the same way, confirm
  non-startup migrators can populate in the embedded wizard, then
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
  Confirm the Import step shows a tile (with its logo) for each browser the wizard
  lists, no more and no fewer: open Other sources and compare the wizard's
  selector list with the tiles. If `MigrationUtils.getMigrator` now awaits
  `canGetPermissions()` the detection's extra test is redundant but harmless; if the
  wizard's list rule changes, change `wizardListsMigrator` to match. Click a tile
  other than the wizard's first entry and confirm the selector shows that browser.
  Confirm the Firefox or Zen tile appears only when a Firefox or Zen profile is
  registered, and that it restarts into the startup wizard scoped to Firefox/Zen.
  In the open wizard, in Light and Dark with macOS set to either appearance, hover and
  press Import Firefox or Zen (release the pointer away from it) and confirm the fill
  stays the accent colour, then open the browser selector and confirm the popup uses
  Bento's surface, border and text colours (not the native menu), the hovered, arrow-key
  focused and selected rows are readable, and the popup is as wide as the selector.
  Confirm Bento creates
  matching workspaces, the Zen pinned tab appears as a pinned Bento tab, and the
  Zen essential tab appears as a pinned Bento panel. Also confirm copied
  bookmarks/history/password resources are present in the new
  Bento profile. On the Ready step click Open Settings (and, in a second pass,
  double-click it): the overlay and its toolbar scrim are gone once the fade ends
  and the Settings palette opens with focus in its search field; a second click while
  the dialog fades out is ignored; Start browsing still only closes the overlay. Then use Reset Bento settings in the same window
  and confirm onboarding shows again and both Ready buttons work.
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
- Last updated: 2026-10-18
- Pinned tabs on demand (2026-10-18): `prefs/bento.js` sets
  `browser.sessionstore.restore_pinned_tabs_on_demand` to true. Firefox defaults
  it to false (`browser/app/profile/firefox.js`), and with it false `TabRestoreQueue`
  in `SessionStore.sys.mjs` restores every pinned tab at startup even though
  `browser.sessionstore.restore_on_demand` (default true) leaves other tabs
  pending: `TabRestoreQueue.add` buckets by `tab.pinned` before `tab.hidden`, and
  `shift()` and `willRestoreSoon()` drain that priority bucket unless both prefs
  are true. Bento's pinned sidebar tabs are native pinned tabs, so each launch
  loaded all of them, in every workspace. With the pref true they stay pending
  until first selected; the tab selected at shutdown still loads because Firefox
  always restores it. The pref only takes effect while `restore_on_demand` stays
  true, which Bento does not pin. The backing tabs of pinned panels are native
  pinned tabs too: those in a workspace the window is not showing now stay
  pending, while panels of the shown workspace load at startup because
  `materializePanelTab` in the mount script inserts their browsers to render the
  strip (they are unloaded with the other pending pinned tabs first, below, and
  `materializePanelTab` reloads them). The prefs are read by name, so they have no
  firefox-compat registry entry; the `TabRestoreQueue` condition they feed does.
- Pinned tabs created non-lazily (2026-10-18): `createTabsForSessionRestore` in
  `Tabbrowser.sys.mjs` builds a restored tab with a lazy browser only when
  `createLazyBrowser = restoreTabsLazily && !select && !tabData.pinned` holds, so a
  restored pinned tab always gets a real browser, even while pending. The
  WebExtension `tabs.Tab.discarded` getter (`!nativeTab.linkedPanel` in
  `ext-browser.js`) therefore reports it as `discarded: false`, and no WebExtension
  field tells it from a loaded tab: SessionStore sets the saved address before any
  load (`#restoreHistory` calls `SessionStoreUtils.restoreDocShellState`, which
  calls `SetCurrentURIForSessionStore` in `SessionStoreUtils.cpp`), so
  `tabs.Tab.url` shows the real address. Only the `pending` attribute that
  `SessionStore.#restoreTab` sets (and `#markTabAsRestoring` clears) marks it.
- Pinned tabs unloaded from chrome (2026-10-18): the mount script
  (`src/browser/base/content/bento-shell-mount.js`: `attachRestoredPinnedTabUnload`,
  `shouldUnloadRestoredPinnedTab`, `shouldLoadRestoredPinnedPanel`,
  `pinnedRestoreOnDemand`) listens for
  `SSTabRestoring` on its window. For a pinned target it waits one task
  (`setTimeout(..., 0)`), checks again, and calls `gBrowser.discardBrowser(tab)`
  without force when the tab is `pinned`, has the `pending` attribute, is not
  `selected`, is neither `soundplaying` nor `sharing` (nor a panel the window already
  renders), so the pending real browser becomes a lazy one and the tab reports
  `discarded: true`. A pending pinned tab the window already renders as a panel (and
  that has its `linkedPanel`) is loaded instead with `tab.linkedBrowser.reload()`,
  whichever prefs are set: its saved address is already set, so
  `materializePanelTab` does not reload it, and nothing else would load it.
  `onResolve` in `#restoreHistory` registers `#listenForNavigations` right before
  `#restoreHistoryComplete` dispatches the event, and that listener's
  `onHistoryReload` calls `#restoreTabContentForBrowser`, which for a load
  SessionStore did not start in a `TAB_STATE_NEEDS_RESTORE` tab calls
  `#markTabAsRestoring` (clearing `pending`) and loads the history entry. A reload
  before `onResolve` is not intercepted (`nsDocShell::Reload` finds no history
  listener to veto it). `SessionStore.#restoreHistoryComplete` dispatches
  `SSTabRestoring` on the tab as the last step of `#restoreHistory`, after the
  `SessionStoreUtils.restoreDocShellState` promise resolves. That is why the unload
  cannot run earlier, for example on `SSWindowRestored`, which fires before the
  promise resolves: the promise's `onResolve` calls `#listenForNavigations` on the
  browser, and on a lazy browser that touches its default getter (the "[bug 1345098]
  Lazy browser prematurely inserted" path in `Tabbrowser.sys.mjs`), which runs
  `#insertBrowser` and brings the browser back, loaded, within seconds. The extra
  task lets loads that start inside the dispatch clear `pending` first (a lazy
  browser's `reload` waits for the same event). The unload acts only while
  `browser.sessionstore.restore_on_demand` and `restore_pinned_tabs_on_demand` are
  both true, the condition under which `TabRestoreQueue.shift` and `willRestoreSoon`
  leave pinned tabs pending; with either false the queue loads them, and discarding
  one that is still queued would remove it from the queue (`#cleanUpRemovedBrowser`
  ends in `#resetLocalTabRestoringState`). Every restore of a tab with a real browser
  goes through `#restoreTab` and `#restoreHistory`, so the event covers a startup,
  a reopened closed window (`undoCloseWindow` → `#restoreWindows` →
  `#restoreWindowsFeaturesAndTabs` → `#restoreWindow` → `#restoreTabs`), "Restore
  previous session" and `setBrowserState`/`setWindowState`. It also covers the
  restore `onBeforeBrowserWindowShown` does for a macOS app whose last window was
  closed (`#restoreLastWindow` in `#initializeWindow`), which calls `#restoreWindow`
  directly and notifies only the `sessionstore-single-window-restored` observer,
  never `SSWindowRestored` (derived from the source, not run in Bento). The unload
  lands a few hundred milliseconds after `SSWindowRestored` at a startup, so the
  extension's first `tabs.query` can still see a tab as loaded and then receives
  the `discarded` change through `tabs.onUpdated` (`TabBrowserDiscarded`,
  `ext-tabs.js`). `Tabbrowser.#mayDiscardBrowser` refuses a selected or closing tab,
  a tab with an open dialog or a vetoing `beforeunload`, and one that is already
  lazy, but not an audible or sharing one, so those two checks are Bento's. A pinned
  panel tab is unloaded unless the window already renders it
  (`currentPanelTabIds`; it is loaded then, above), and `materializePanelTab`
  inserts and reloads one it finds unloaded. The sidebar's "Unload tab" item makes the same `discardBrowser` call
  through `browser.tabs.discard` (`ext-tabs.js`). If Firefox starts creating pinned
  tabs lazily, they report `discarded: true` on their own and the unload picks
  nothing (`discardBrowser` returns false for a lazy tab); the pref must still
  exist. Registry entries: `gBrowser.discardBrowser` (probed at runtime),
  `SSTabRestoring`, `tab [pending] attribute`, `tab [soundplaying] attribute`,
  `tab [sharing] attribute`, `TabRestoreQueue pinned on-demand gate` and
  `SessionStore pending-tab reload restore` (checked against the engine source).
  Upgrade regression check: restart with both prefs
  true; the pinned tabs that are not selected stay discarded (no `linkedPanel` in the
  Browser Toolbox Console) 20 seconds after launch, not only right after the
  restore, and their sidebar rows are dimmed; a pinned panel shows its page without
  a click after a startup, after a reopened closed window and in a second window
  (`tab.hasAttribute('pending')` is false for it afterwards), and
  `#listenForNavigations` still registers in `onResolve` before
  `#restoreHistoryComplete` with an `onHistoryReload` that calls
  `#restoreTabContentForBrowser`.
- Firefox 158.0 review (2026-10-14): Firefox 158.0 was released on 2026-10-13
  (security advisory MFSA 2026-106); its source digest is the row for
  `source/firefox-158.0.source.tar.xz` in `releases/158.0/SHA256SUMS`.
  `browser.nova.enabled` and `sidebar.revamp` still default to true and
  `ProfileDataUpgrader` still writes no user value for either, so the two false
  defaults stay. New prefs, both defaulting to false in `browser/app/profile/firefox.js`
  and both pinned false in `prefs/bento.js`:
  - `browser.smartwindow.aitab.enabled` follows the precedent that hides remote
    and AI browser surfaces (`browser.ml.enable`, `browser.ml.chat.enabled`). It
    gates Smart Window's AI-generated tab: `about:smartpage` in `AboutRedirector.cpp`
    (`chrome://browser/content/aiwindow/aitab.html`), the `context-create-aitab`
    and `context_createAITab` menu items, and a tab-group menu option.
  - `browser.mini-window.enabled` is not a remote or AI feature. It lets a tab, or
    a cropped region of one, pop into a separate always-on-top window.
    `MiniWindowManager` returns the popped tabs to their origin window when that
    window closes or the application quits, and `maybeMoveOldestMiniWindow` in
    `Tabbrowser.sys.mjs` moves one back when the origin window's last tab closes.
    That moves tabs between windows outside the workspace and panel layout that
    Bento's shell and tools own, so Bento keeps it off. Its entry points are the
    `context-use-mini-window` and `context_openTabInMiniWindow` context-menu items,
    a screenshots selection mode, the `mini-window-button` toolbar widget, and the
    `mini-window` root attribute handled in `TabBarVisibility` and
    `BrowserWindowTracker`.
    The Smart Window master pref `browser.smartwindow.enabled` also defaults to
    false and is not pinned: `smartformfill.enabled` and `agent.toolbar.enabled`
    flipped to true in 158, but the smart-form-fill actor registers only while
    `browser.smartwindow.enabled` is true. Rust stays at 1.95.0: Mozilla's 158 CI
    still builds with 1.95.0 (`taskcluster/kinds/toolchain/rust.yml`) and the
    minimum Firefox 158 accepts is 1.90.0 (`mozboot/util.py`). Firefox 158 moved Rust
    LTO selection into configure (`RUST_LTO_ELIGIBLE`) and the per-library
    `RUST_LIBRARY_LTO` flag in `config/makefiles/rust.mk`; experiments/02 now wraps
    that file's single `-Clto` line (Firefox's `-Clto` stays the default and
    `-Clto=thin` applies only with `BENTO_RUST_LTO=thin`) and drops its former
    `check_binary` hunk, because the binary check now keys on `RUST_LIBRARY_LTO`
    too. `scripts/rust-thin-lto.test.mjs` asserts that line. `branding/bento` was
    compared with `browser/branding/unofficial`: only the four `firefox-wordmark.svg`
    files changed upstream (a dark-mode fill for the wordmark); Bento keeps its own
    white wordmark and `branding.nsi` is unchanged. The Windows installer defines
    moved; see the Build Configure Flags entry. Runtime on 158.0: the four
    pinned or defaulted prefs above, `browser.ml.enable`, `browser.ml.chat.enabled`,
    `browser.nova.enabled` and `sidebar.revamp` all read false with no user value.
- Firefox 157.0.1 review (2026-10-12): `browser.nova.enabled` and
  `sidebar.revamp` default to true in 157; `prefs/bento.js` sets both false to
  keep the 154 chrome (Bento's shell owns the sidebar and tab strip). Firefox's
  `ProfileDataUpgrader` migrations (178 to 183) never write a user value for
  either pref (183 only clears `sidebar.revamp`), so plain defaults suffice and
  no `lockPref` is used. `browser.promo.focus.enabled` and
  `messaging-system.rsexperimentloader.enabled` no longer exist in the source and
  were removed. `browser.search.separatePrivateDefault` became
  `browser.search.separatePrivateDefault.enabled` (read by the `bento-privacy`
  experiment). `rust-toolchain.toml` moved from 1.94.1 to 1.95.0 afterwards to
  match Mozilla's CI for 157 (`taskcluster/kinds/toolchain/rust.yml`; the
  minimum Firefox 157 accepts is 1.90.0).
- Files or patches:
  - `prefs/bento.js`
  - `engine/services/settings/dumps/main/search-config-v2.json`
  - `engine/third_party/application-services/components/remote_settings/dumps/main/search-config-v2.json`
  - `bento.json`
  - `branding/bento/**`
  - `configs/**`
  - `rust-toolchain.toml`
  - `scripts/check-rust-toolchain.mjs`
  - `scripts/install-branding.mjs`
  - `scripts/firefox-patch-stack.mjs`
  - `patches/experiments/**`
- Bento functionality: applies Bento defaults, Firefox-visible search options
  for Bento onboarding and Settings, branding,
  build configuration, and temporary Firefox-source build guards. Privacy defaults include strict
  tracking protection, tracker-cookie partitioning, Global Privacy Control,
  query stripping, speculative networking off, remote search suggestions off,
  local Safe Browsing on, HTTPS-only mode on, remote Safe Browsing download
  checks off by default but independently user-toggleable, DoH disabled, and
  AI/remote suggestion surfaces disabled. Release builds pin Firefox's official
  Rust 1.95.0 toolchain and use a Bento-namespaced ThinLTO opt-in on Linux and
  Windows (which CI no longer builds) to keep final Rust linking within
  standard hosted-runner memory limits; macOS retains upstream's default fat
  LTO.
- Vanilla Firefox surface touched or depended on: Firefox profile defaults,
  search service Remote Settings dumps (read, not changed: `search-config-v2.json`
  `globalDefault` is `google` and its `ddg` engine identifier is the id the boot
  seed below applies), branding import paths, Firefox
  configure's `browser/moz.configure` environment-to-config export,
  `config/makefiles/rust.mk` release Rust flags, and patched build/runtime
  behavior covered by `patches/experiments`.
- Why this cannot stay extension-only: prefs, branding, and build behavior are
  consumed before or outside the privileged extension runtime. Default search is
  not one of them: no pref, patch, or search-config change sets it, so Firefox
  stays on its own default (`google`) until bento-tools applies one. Fresh-profile
  DuckDuckGo comes only from `applyBootDefaultSearchEngine`
  (`extensions/bento-tools/src/privacy/BootSearchDefault.ts`), which calls
  `SearchService.setDefault` through the `bento-privacy` experiment at boot while
  onboarding is unfinished and no engine override is stored.
- Firefox update risk: upstream pref renames, search config schema changes,
  branding layout changes, build system or Rust flag changes, or obsolete
  temporary patches can silently stop applying or block security update rebases.
  A renamed `ddg` engine identifier makes the boot seed log a warning and leave
  Firefox's default.
- Regression checks for future updates: run `pnpm run build`, confirm
  `scripts/append-prefs.sh` still appends `prefs/bento.js`, inspect branding in
  the built app, confirm a fresh profile's `SearchService.defaultEngine.id` is `ddg`
  while `SearchService.appDefaultEngine.id` is Firefox's own default (`google`),
  that the Search onboarding step preselects DuckDuckGo, and that a profile with
  `welcomeSeen` true and no engine override stays on its saved default after a
  relaunch (Browser Toolbox Console, parent process), inspect
  `about:config` for the Standard privacy defaults, confirm Firefox-visible
  search engines can be selected as default search in onboarding and Settings,
  confirm an HTTP-only destination still offers Firefox's exception UI, confirm
  remote download reputation can be toggled without changing the detected
  privacy preset, confirm `browser.sessionstore.restore_pinned_tabs_on_demand`
  still exists in `browser/app/profile/firefox.js` and `TabRestoreQueue` still
  skips the priority bucket when it and `restore_on_demand` are true (pin two
  tabs in different workspaces, quit, relaunch: only the selected tab loads and
  each pinned tab loads when first selected), confirm `createTabsForSessionRestore`
  still excludes pinned tabs from the lazy browser, `SessionStore` still sets the
  `pending` attribute in `#restoreTab` and dispatches `SSTabRestoring` from
  `#restoreHistoryComplete` after the history restore resolves
  (`pnpm run firefox:compat:engine` greps the event, the attribute, the queue
  condition and the `onHistoryReload` listener), `Tabbrowser.discardBrowser`
  still takes the tab and an optional force flag, and the `tabs.Tab.discarded`
  getter is still `!linkedPanel` (after the same relaunch the pending pinned tabs
  are dimmed in the sidebar and still unloaded 20 seconds after launch,
  `tab.hasAttribute('pending')` is true and `tab.linkedPanel` is empty for them in
  the Browser Toolbox Console, and
  `tabs.query({ pinned: true })` reports `discarded: true`; an Alt+Shift+R reload
  and a relaunch with `restore_pinned_tabs_on_demand` false unload none), confirm
  `runtime.onStartup` still fires only at app startup once the background page has
  loaded (`ext-runtime.js`, `ext-backgroundPage.js`), which bento-tools' parked tab
  list gate relies on (an Alt+Shift+R reload must not drop the lists),
  and re-evaluate whether each experiment patch is still needed. Run
  `pnpm run firefox:patches:test`, `pnpm run firefox:patches:check`,
  `node --test scripts/rust-thin-lto.test.mjs`, and
  `node scripts/check-rust-toolchain.mjs`. Confirm a local macOS release build
  still uses the upstream default LTO path. If Linux or Windows builds return,
  build them locally and inspect the release logs for configure exporting
  `BENTO_RUST_LTO=thin`, generated make flags containing `-Clto=thin`, and
  successful final linking.
- Rollback or migration notes: remove the ThinLTO export from the Linux and
  Windows mozconfigs and the associated experiment patch together, then export,
  check, and import. Keep the Rust pin and release verification aligned with the
  Firefox release's official toolchain.

### Build Configure Flags And Updater

- Status: Active
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): the dev-mode checks below pass on macOS arm64:
  `engine/mozconfig` holds `--disable-release`, `--disable-updater` and
  `--enable-macos-target=11.0`; `config.status.json` has no `MOZ_UPDATER`,
  `DEVELOPER_OPTIONS` is `1`, `MOZ_UPDATE_CHANNEL` is `bento`; `bento` and `XUL`
  report `minos 11.0`; `toolchain.configure` still defaults `--enable-macos-target`
  to 11.0 only on arm64 without developer options and to 10.15 otherwise. The
  release-mode checks pass too (`pnpm run build:release` in a separate object
  directory, `BENTO_OBJDIR=obj-release`): `engine/mozconfig` holds
  `--enable-release` and `--disable-updater`, `config.status.json` has no
  `MOZ_UPDATER` and no `DEVELOPER_OPTIONS`, `XUL` reports `minos 11.0`, the
  package has no `updater.app`, `update-settings.ini` or MAR, `precomplete` is at
  `Contents/Resources`, and `artifacts:check` accepts the `.dmg`; `application.ini`
  `BuildID` matches `dist/bento-artifacts.json` and differs from `platform.ini`.
  The ThinLTO opt-in (`BENTO_RUST_LTO=thin`) was not run. New in 158:
  `MOZ_PKG_FORMAT` (`toolkit/moz.configure`) defaults to `TAR` on macOS when
  developer options are on and automation is off, so a dev or debug
  `pnpm run package` writes `bento-<version>.en-US.mac.tar` instead of a `.dmg`;
  `scripts/validate-bento-artifacts.mjs` accepts that package, and release builds
  still make the `.dmg`. A release build with `BENTO_OBJDIR` set also needs
  `pnpm run import` to run first without it: `import.sh`'s symlink sync fails when
  `BENTO_OBJDIR` differs from the object directory `engine/mozconfig` names and the
  new one does not exist yet (use `BENTO_RELEASE_PREPARED=1` for the release script
  after a release-mode `ext:build` and `import`). Windows packaging changed in 158: the NSIS
  build moved from `browser/installer/windows/Makefile.in` and `moz.build`
  `DEFINES` into `browser/moz.configure`, which now sets `NSIS_INSTALLER_FILES`,
  `NSIS_BRANDING_FILES`, `NSIS_SFX_MODULE` and `NSIS_INSTALLER_DEFINES`, and stages
  and builds the installer through `nsis_stage.py` and `nsis_build.py` from a
  `GeneratedFile` in `browser/installer/windows/moz.build` unless
  `--enable-makefile-installer-build` (`MOZ_USE_MAKEFILE_INSTALLER_BUILD`) selects
  the old Make path, which reads the same `NSIS_*` variables. Bento sets neither
  switch, so Windows uses the new path. Bento's inputs are unchanged and reach the
  new defines: `ac_add_options --with-app-name=bento` (`MOZ_APP_NAME`),
  `branding/bento/configure.sh` (`MOZ_APP_DISPLAYNAME="Bento"`) and
  `browser/config/version.txt` (`APP_VERSION`, which the build driver writes from
  `bento.json` `displayVersion`, `0.0.1`). `NSIS_INSTALLER_DEFINES` on Windows
  should therefore
  read `-DAPP_VERSION=0.0.1 -DMOZ_APP_NAME=bento -DMOZ_TOAST_APP_NAME=Bento
-DMOZ_APP_DISPLAYNAME=Bento -DMOZ_DEFAULT_BROWSER_AGENT=1
-DMOZ_PUSH_NOTIFICATION_HELPER=1`, and `NSIS_BRANDING_FILES` are all present in
  `branding/bento` (`branding.nsi`, `firefox64.ico`, the three `stubinstaller/`
  files, three `.bmp` files). `branding.nsi` is unchanged upstream, so Bento's copy
  needs no edit. New in 158 on Windows: the push notification helper
  (`--enable-push-notification-helper` defaults on for Windows browser builds,
  `--disable-push-notification-helper` turns it off). It adds the Rust crate
  `toolkit/mozapps/pushnotificationhelper`, `notification-helper.exe` in the
  package, and installer stop and start calls; it runs only while both
  `app.backgroundNotifications.helper.available` and `.enabled` are true, and both
  default false. Bento keeps the default. If Windows builds return (CI builds no
  application), a Windows build must confirm: configure succeeds; `config.status.json` carries the `NSIS_INSTALLER_DEFINES` value above
  (no `None`, no `Firefox`); `instgen/defines.nsi` has `AppVersion "0.0.1"`,
  `FileMainEXE "bento.exe"`, `BrandShortName "Bento"` and
  `ToastAumidPrefix "BentoToast-"`; `helper.exe`, `setup.exe` and the stub
  installer build; `notification-helper.exe` compiles and is packaged; and
  `pnpm run artifacts:check` finds exactly one `bento-<version>*.installer.exe`.
- Files or patches:
  - `configs/common/mozconfig` and `configs/{linux,macos,windows}/mozconfig`
  - `scripts/bento-build.mjs` (the options appended to the generated
    `engine/mozconfig` per build mode, and the updater switch)
  - `bento.json` (`updates.enabled`, `updates.channel`, `updates.hostname`)
  - `config/release-security.json` (`updateService` readiness inputs)
  - `scripts/update-readiness.mjs`, `scripts/check-release-security.mjs`
  - `scripts/validate-bento-artifacts.mjs`, `scripts/build-release.sh`
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
  5. Run `BENTO_BUILD_MODE=release pnpm run build` and
     `pnpm run package`; confirm the package has no updater, that `precomplete` is
     still present in the application (root, or `Contents/Resources` on macOS), and
     that `pnpm run artifacts:check` passes with no MAR or update XML.
     Re-confirm that `packager.py` still generates `precomplete` unconditionally.
     Also run `pnpm run package` and `pnpm run artifacts:check` after a dev build:
     a macOS dev package is a `.tar` (Firefox 158 and later), a release package a
     `.dmg`.
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
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): neither `about-firefox.mjs` nor the upstream
  test changed between 157.0.1 and 158.0; the patch applies with offsets. Runtime
  on 158.0 (dev build, no updater): `about:preferences#about` shows only the
  `support` group; the `updates` group has `data-hidden-from-search="true"` and
  computes `display: none`. The Settings search checks were not repeated.
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
- Last updated: 2026-10-14
- Firefox 158.0 review (2026-10-14): `pnpm run import` twice more on the built
  tree is idempotent (identical `snapshot-import-output` digest, then
  `check-import-output` passes with 3 add-ons and 24 patches). Runtime on 158.0:
  `AddonManager` lists Bento Shell 0.0.3, Bento Tools 0.1.11 and uBlock Origin
  1.75.0, all active. The release-mode checks below were not run on 158.0.
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
  - `extensions/bento-tools/experiments/bento-external-sessions/**`
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
  includes the tools experiments and the shell jar includes the chrome bridge, confirm
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
  version such as `158.0`), not Bento's own app version. It never throws and
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
  read by name, and the CSS selectors in `bento-shell-mount.css`. Patches are
  covered by `pnpm run firefox:patches:check`; members that code added by a
  patch calls elsewhere in Firefox are listed here.

<!-- prettier-ignore-start -->
<!-- firefox-compat:begin -->

| Member | Kind | Bento use | Used in | Firefox 158.0 source |
| --- | --- | --- | --- | --- |
| `delayedStartupPromise` | member (runtime) | Schedules the compat probes after Firefox finishes delayed startup. | `scheduleBentoFirefoxCompatChecks` | `browser/base/content/browser-init.js:6` |
| `gBrowser.on_visibilitychange` | method (runtime) | No-ops while split view is active so Firefox does not deactivate panel docShells. | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9314` |
| `gBrowser._findTabToBlurTo` | method (runtime) | Excludes panel and other-workspace tabs when Firefox picks the next selected tab. | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7053` |
| `gBrowser.insertBrowser` | method (runtime) | Materializes restored pending panel tabs without selecting them (public since 157; _insertBrowser before). | `materializePanelTab` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3241` |
| `gBrowser.discardBrowser` | method (runtime) | Unloads a pinned tab Firefox restored pending (a real browser, not a lazy one), without force: its own guard refuses the selected, closing, dialog and beforeunload cases. The tab keeps its session state and loads when selected. | `attachRestoredPinnedTabUnload` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3396` |
| `MozTabbrowserTab.isEmpty` | member (runtime) | Prototype getter wrapped so a panel browser with no browsingContext reads as not empty. | `attachTabSelectListener` | `browser/components/tabbrowser/content/tab.js:288` |
| `MozTabbrowserTab.splitview` | member (runtime) | Prototype getter shadowed per tab with Object.defineProperty to carry the Bento split marker. | `reconcilePanelsSplitView`, `makeSplitViewMarker` | `browser/components/tabbrowser/content/tab.js:406` |
| `MozBrowser.prototype.removeProgressListener` | method (runtime) | Swallows NS_ERROR_FAILURE from removing a listener on a browser that is being torn down. | `attachTabSelectListener`, `isStaleWebProgressRemoveError` | `toolkit/content/widgets/browser-custom-element.mjs:987` |
| `gBrowser.showSplitViewPanels` | method (runtime) | Lays the main tab and panel tabs into tabpanels as split-view panels. | `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:4088` |
| `gBrowser.activeSplitView` | member (runtime) | Getter over the private #activeSplitView field; lists browsers that count as visible. | `patchPopupNotificationsForSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:487` |
| `gBrowser.on_TabSplitViewActivate` | method (runtime) | Bento dispatches TabSplitViewActivate so Firefox stores its marker in #activeSplitView. | `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9377` |
| `gBrowser.on_TabSplitViewDeactivate` | method (runtime) | Bento dispatches TabSplitViewDeactivate with the same marker object (identity check) to clear it. | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9382` |
| `gBrowser.warmupTab` | method (runtime) | Recreates the AsyncTabSwitcher that destroys itself after each tab switch. | `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:9085` |
| `gBrowser.tabpanels.splitViewPanels` | member (runtime) | Setter marks panel ids as split-view panels (class, column attribute, [splitview], listeners). | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `toolkit/content/widgets/tabbox.js:530` |
| `gBrowser.tabpanels.removeTabsFromSplitview` | method (runtime) | Removes departing tabs from the split view and strips their split-view panel classes. | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `toolkit/content/widgets/tabbox.js:557` |
| `gBrowser.tabpanels.handleEvent` | method (runtime) | Bento removes tabpanels itself as the click/focus listener Firefox registers on each panel's browser container (removeEventListener with the tabpanels object, which dispatches to handleEvent). | `reconcilePanelsSplitView` | `toolkit/content/widgets/tabbox.js:540` |
| `tabpanels split-view-panel classes` | source (engine only) | Bento styles and cleans .split-view-panel, .split-view-panel-active and the column attribute. | `reconcilePanelsSplitView`, `forceMainOnlyChromeState` | `toolkit/content/widgets/tabbox.js:533` |
| `tabpanels [splitview] attribute` | source (engine only) | setSplitViewActive toggles [splitview]; Bento CSS and on_visibilitychange read it. | `forceMainOnlyChromeState`, `attachTabSelectListener` | `toolkit/content/widgets/tabbox.js:607` |
| `split-view-footer element` | source (engine only) | showSplitViewPanels inserts a footer into each panel; Bento hides it with a mount stylesheet rule. | `src/browser/base/content/bento-shell-mount.css#split-view-footer` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:4114` |
| `#navigator-toolbox[fullscreenShouldAnimate]` | source (engine only) | The sidebar push's colour transition on the toolbar surfaces replaces their transition list, so it skips #navigator-toolbox while Firefox's fullscreen reveal (`transition: 0.8s margin-top` on this attribute, set by browser-fullScreenAndPointerLock.js) runs. | `src/browser/base/content/bento-shell-mount.css#fullscreenShouldAnimate` | `browser/themes/shared/browser-shared.css:221` |
| `#navigator-toolbox[tabs-hidden]` | source (engine only) | The mode flip fade skips the native tab strip (#tabbrowser-tabs) only while Firefox marks the toolbox tabs-hidden, which TabBarVisibility.update() sets from the hidden-tabs state Bento turns on; a profile that shows the strip keeps the fade there. | `src/browser/base/content/bento-chrome-theme.css#tabs-hidden` | `browser/components/tabbrowser/content/tab-bar-visibility.js:36` |
| `.browserSidebarContainer panel container` | source (engine only) | Every tab keeps a .browserSidebarContainer in #tabbrowser-tabpanels; the mode flip fade gives the ones that are neither selected nor split no transitions (hundreds of invisible elements with many tabs). | `src/browser/base/content/bento-chrome-theme.css#browserSidebarContainer` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3120` |
| `tabpanels .deck-selected class` | source (engine only) | The tabpanels deck marks the selected panel container .deck-selected; the mode flip fade keeps the selected container (and .split-view-panel and .split-view-panel-active ones) out of its exclusion. | `src/browser/base/content/bento-chrome-theme.css#deck-selected` | `toolkit/content/widgets/tabbox.js:218` |
| `#tabbrowser-arrowscrollbox` | source (engine only) | The native tab strip's arrowscrollbox, whose shadow-tree overflow arrows take their icon fill from the inherited --toolbarbutton-icon-fill. Bento sets that property from the registered --bento-arrow-fill on this element so the arrows fade with the mode flip (a profile that shows the strip). | `src/browser/base/content/bento-chrome-theme.css#tabbrowser-arrowscrollbox` | `browser/base/content/navigator-toolbox.inc.xhtml:60` |
| `.browserContainer panel structure` | source (engine only) | Bento finds a panel browser as :scope > .browserContainer browser inside the tab panel. | `reconcilePanelsSplitView`, `getLivePanelBrowser` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3116` |
| `gBrowser.tabpanels` | member (runtime) | The #tabbrowser-tabpanels element hosting every panel; attachTabSelectListener waits for it. | `attachTabSelectListener`, `reconcilePanelsSplitView` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:241` |
| `gBrowser.tabContainer` | member (runtime) | Receives TabSelect/TabOpen listeners; attachTabSelectListener waits for it. | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:237` |
| `MozTabbrowserTab.linkedPanel` | member (runtime) | Id of the tab panel (a get/set accessor on the MozTab prototype); Bento resolves it with getElementById to reach the panel DOM. | `reconcilePanelsSplitView`, `getLivePanelBrowser` | `toolkit/content/widgets/tabbox.js:831` |
| `Element.prototype.moveBefore` | method (runtime) | Re-parents #tabbrowser-tabbox and #bento-side-panel-host at startup without recreating the frameloader of the first tab browser (no pref gate in 154); insertBefore is the fallback. | `moveNodeBefore` | `dom/webidl/ParentNode.webidl:34` |
| `MozBrowser.connectedMoveCallback` | source (engine only) | moveBefore on a browser element ends in this no-op callback instead of destruct() and construct(). | `moveNodeBefore` | `toolkit/content/widgets/browser-custom-element.mjs:428` |
| `XULFrameElement UnbindFromTree IsMove` | source (engine only) | UnbindFromTree keeps the frameloader when the unbind is a move; insertBefore and appendChild destroy it. | `moveNodeBefore` | `dom/xul/XULFrameElement.cpp:165` |
| `gBrowser.addTrustedTab` | method (runtime) | Opens privileged URLs (about:preferences, devtools toolbox) that tabs.create rejects; the window handover opens the blank tab that holds a closing window open (null when the tab cannot be made). | `openTrustedAddrbarNewTab`, `openDevtoolsPanelFor`, `handOverTabsBeforeClose`, `openFirefoxSearchSettings` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3559` |
| `gBrowser.addTab` | method (runtime) | Creates the tab behind a new panel with the add-as-panel marker URL. | `addNewPanel` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:3682` |
| `gBrowser.getTabForBrowser` | method (runtime) | Maps a panel browser to its tab; patch 04 uses it to inspect the right-clicked panel, and a page's window.close() uses it to name the tab that asked. | `getTabForPanelHistoryBrowser`, `installInspectInPanelMenuItems`, `notePageClose`, `patches/core-ui/04-inspect-panel-browser.patch#getTabForBrowser` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:1324` |
| `gBrowser.selectedBrowsers` | member (runtime) | Patch 11 lets DOM fullscreen requests come from any browser active in the split. | `patches/core-ui/11-dom-fullscreen-splitview-browser.patch#selectedBrowsers` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:641` |
| `gBrowser.moveTabBefore` | method (runtime) | Sidebar drag-reorder; skips the moveTabTo path that reads element.splitview. | `handleTabMoveTitle` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:8022` |
| `gBrowser.moveTabAfter` | method (runtime) | Sidebar drag-reorder; skips the moveTabTo path that reads element.splitview. | `handleTabMoveTitle` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:8044` |
| `gBrowser.replaceTabWithWindow` | method (runtime) | Hides Bento's split-view markers while Firefox picks the element it hands a torn-out window (aTab.splitview ?? aTab). | `hideBentoSplitViewMarkers` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7709` |
| `gBrowser.replaceTabsWithWindow` | method (runtime) | Same as replaceTabWithWindow for the context-menu and multi-select tear-out (contextTab.splitview ?? contextTab). | `hideBentoSplitViewMarkers` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7750` |
| `getTabToAdopt XULElement` | source (engine only) | The new window adopts its first tab only when the window argument is a XUL element, so a Bento marker object makes the adoption silently fail. | `hideBentoSplitViewMarkers` | `browser/base/content/browser-init.js:88` |
| `gBrowser.adoptTab` | method (runtime) | Moves a closing window's live tabs into a window that stays open (the docShell swap behind tabs.move; the tab id is kept). Returns the new tab, or null when the swap is refused, after removing the empty twin it made (the tab's id and custom values went to the twin). | `handOverTabsBeforeClose` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:8480` |
| `swapBrowsersAndCloseOther closeWindow` | source (engine only) | Adopting the last tab of a window closes that window from inside adoptTab (window.close(), so DOMWindowClose again) and returns before TabClose, which a DevTools toolbox moves with. The handover keeps a blank selected tab in the closing window so no adoption is its last tab. A pending tab is moved by state, which drops its custom tab values. It returns false for a private or Fission mismatch, a non-remote source tab (the twin is remote), a closing source tab, or a source tabbrowser whose window is closing; the handover rules out all but the last, which is only set once the last tab is already gone. | `handOverTabsBeforeClose` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:7391` |
| `SessionStore adoptedTab custom values` | source (engine only) | SessionStore moves a tab's custom values to the adopting twin on TabOpen, so the handover value is written after adoptTab and a refused adoption (which removes the twin) takes them away. Restoring a pending tab's state without extData deletes them, so the mount copies them back. | `handOverTabsBeforeClose` | `browser/components/sessionstore/SessionStore.sys.mjs:1349` |
| `FrameLoader.prototype.requestTabStateFlush` | method (runtime) | adoptTab makes SessionStore flush the old browser and copy its cached state to the twin, and the flush promise belongs to the closing window, so the copy never ran. For the adoptTab call the old frame loader shadows this method with one that returns a promise of the surviving window settling with the original, and the shadow is deleted afterwards (the prototype's method is not touched). | `adoptTabInto` | `dom/chrome-webidl/FrameLoader.webidl:70` |
| `TabStateFlusher.flush requestTabStateFlush` | source (engine only) | TabStateFlusher.flush(browser) takes the promise from browser.frameLoader.requestTabStateFlush() and races it, which is why handing out a promise of another window from there reaches SessionStore's move handler. | `adoptTabInto` | `browser/components/sessionstore/TabStateFlusher.sys.mjs:79` |
| `SessionStore onMoveToNewWindow flush` | source (engine only) | On TabClose with adoptedBy, SessionStore flushes the old browser and, in the promise's then, copies its cached tab state (session history) to the adopting twin. A flush that never settles leaves the adopted tab without history in SessionStore until it navigates. | `adoptTabInto` | `browser/components/sessionstore/SessionStore.sys.mjs:2919` |
| `moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs` | module (runtime) | The write behind a handover: SessionSaver.run() saves the session at once (SessionStore itself waits 2 to 15 s after a close). | `getSessionSaver` | `browser/components/sessionstore/SessionSaver.sys.mjs:55` |
| `SessionSaver.run` | source (engine only) | The only call that writes the session now. After a window handover the surviving window calls it once SessionStore has copied the adopted tabs state, so a crash seconds after the close does not lose tabs that no earlier write held. Called during shutdown it still writes, so Bento skips it once a quit has started. | `saveSessionAfterHandover` | `browser/components/sessionstore/SessionSaver.sys.mjs:59` |
| `DOMWindowClose` | source (engine only) | Chrome-only event the window receives before a script close (window.close(), windows.remove, Cmd+Shift+W after WindowIsClosing) tears it down, and on a quit. Nothing after it can cancel the close once it passes, so the window's live tabs are handed to a window that stays here. | `attachWindowCloseHandover`, `handOverTabsBeforeClose` | `dom/base/nsGlobalWindowOuter.cpp:6096` |
| `BrowserElementParent DOMWindowClose` | source (engine only) | A tab's window.close() reaches the chrome window as a DOMWindowClose that bubbles from the browser element and is not cancelable. Bento acts only on one targeted at the window; notePageClose records the tab that asked, which is not handed over when the tabbrowser then closes the window for it (the window's only tab). | `notePageClose`, `handOverTabsBeforeClose` | `toolkit/actors/BrowserElementParent.sys.mjs:25` |
| `window.onclose WindowIsClosing` | source (engine only) | The OS close button dispatches a cancelable close event, answered by window.onclose = WindowIsClosing (closing-tabs warning, beforeunload prompts). Bento adds its own listener after that handler and acts only when the event is not already cancelled. | `attachWindowCloseHandover`, `handOverTabsBeforeClose` | `browser/base/content/browser-main.js:44` |
| `remote <browser> key events reach the parent first` | source (engine only) | The chrome process sees a key event for a remote <browser> before that browser's document does: EventStateManager dispatches it in the parent, with the <browser> element as event.target, and only then forwards it to the child with SendRealKeyEvent. The capture-phase Esc listener relies on this to skip an Esc aimed at the Settings frame (event.target.id) and leave it to the Settings document; if the order changed, it would either miss the frame or consume Esc for every stage. | `attachPaletteEscListener` | `dom/events/EventStateManager.cpp:2306` |
| `gFissionBrowser` | source (engine only) | A window runs with Fission or without; swapBrowsersAndCloseOther refuses to swap a tab between the two, so a window in another mode is not chosen to take tabs. | `findHandoverSurvivor` | `browser/base/content/browser.js:689` |
| `gDialogBox.isOpen` | member (runtime) | A window-modal dialog is up in the candidate window (the closing-tabs warning is one): the window may be about to close, so it takes no tabs. | `findHandoverSurvivor` | `browser/base/content/browser.js:4770` |
| `MozBrowser.prototype.docShellIsActive` | member (runtime) | Bento forces panel docShells active after Firefox deactivates them. | `reconcilePanelsSplitView` | `toolkit/content/widgets/browser-custom-element.mjs:523` |
| `MozBrowser.prototype.renderLayers` | member (runtime) | Bento re-enables layer rendering for panel browsers after a failed split-view layout. | `reconcilePanelsSplitView` | `toolkit/content/widgets/browser-custom-element.mjs:540` |
| `MozBrowser.prototype.preserveLayers` | method (runtime) | Called before deactivating a panel docShell so it repaints without a blank frame. | `reconcilePanelsSplitView` | `toolkit/content/widgets/browser-custom-element.mjs:951` |
| `MozBrowser.prototype.messageManager` | member (runtime) | Loads Bento frame scripts into extension and panel browsers. | `installPanelNavigatorTooltipFrameScript`, `ensurePanelScrollFrameScript`, `postToWelcomePage` | `toolkit/content/widgets/browser-custom-element.mjs:581` |
| `MozBrowser.prototype.contentTitle` | member (runtime) | The title-IPC handler reads frame.contentTitle after pagetitlechanged. | `attachPaletteCloseListener` | `toolkit/content/widgets/browser-custom-element.mjs:674` |
| `MozBrowser.prototype.getInPermitUnload` | method (runtime) | Says synchronously whether a tab is answering a beforeunload check. permitUnload throws when asked again, so a close repeated meanwhile hands nothing over and such a window takes no tabs. | `isCheckingUnload` | `toolkit/content/widgets/browser-custom-element.mjs:1718` |
| `MozBrowser.mIconURL` | member (runtime) | Panel header favicon fallback reads the browser mIconURL field. | `createPanelHeader` | `toolkit/content/widgets/browser-custom-element.mjs:140` |
| `MessageManager.loadFrameScript` | source (engine only) | Bento injects data: URL frame scripts into its own extension frames and panel browsers. | `ensurePanelScrollFrameScript`, `installPanelNavigatorTooltipFrameScript`, `SHELL_ACTION_FRAME_SCRIPT_URL`, `SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_URL`, `WELCOME_HANDOFF_FRAME_SCRIPT_URL` | `dom/chrome-webidl/MessageManager.webidl:368` |
| `pagetitlechanged` | source (engine only) | Chrome-only bubbling event on the embedding <browser>; the title-IPC control plane. | `attachPaletteCloseListener` | `dom/ipc/WindowGlobalParent.cpp:558` |
| `PopupNotifications._isActiveBrowser` | method (runtime) | Also accepts browsers of split-view panel tabs so panel-originated popups show. | `patchPopupNotificationsForSplitView` | `toolkit/modules/PopupNotifications.sys.mjs:1666` |
| `PanelUI.ensureReady` | method (runtime) | Builds the app menu before Bento anchors it to a sidebar footer button. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:560` |
| `PanelUI.panel` | member (runtime) | The app menu popup element, created from kElements during PanelUI.init. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:112` |
| `PanelUI.show` | method (runtime) | Fallback that opens the app menu when no sidebar anchor can be built. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:351` |
| `PanelUI.hide` | method (runtime) | Toggles the app menu closed when its sidebar button is clicked again. | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:386` |
| `PanelUI._ensureShortcutsShown` | method (runtime) | Refreshes keyboard-shortcut labels before the app menu opens (optional call). | `openNativeAppMenuFromSidebar` | `browser/components/customizableui/content/panelUI.js:1403` |
| `PanelMultiView.openPopup` | method (runtime) | Opens native panels (app menu, downloads, identity) at a sidebar anchor. | `openNativeAppMenuFromSidebar`, `openNativeDownloadsPanelFromSidebar`, `openNativeIdentityPopupForSidebar` | `browser/components/customizableui/PanelMultiView.sys.mjs:393` |
| `PanelMultiView.hidePopup` | method (runtime) | Closes other open panels before the identity popup opens. | `openNativeIdentityPopupForSidebar` | `browser/components/customizableui/PanelMultiView.sys.mjs:417` |
| `DownloadsButton.getAnchor` | method (runtime) | Automatic downloads panel opens anchor to a sidebar fallback element placed over the Downloads footer button from the edges the shell reports. | `patchDownloadsButtonAnchorForSidebar` | `browser/components/downloads/content/indicator.js:100` |
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
| `gURLBar.view` | member (runtime) | Bento closes the native urlbar results view when its own address bar opens. | `closeNativeUrlbarPopup` | `browser/components/urlbar/content/UrlbarInputBase.mjs:420` |
| `gURLBar.view.close` | method (runtime) | Closes the native urlbar results view (optional call). | `closeNativeUrlbarPopup` | `browser/components/urlbar/content/UrlbarView.mjs:671` |
| `gURLBar.untrimmedValue` | member (runtime) | Sidebar address row shows the urlbar display value for the selected tab. | `readSidebarAddressDisplayUrl` | `browser/components/urlbar/content/UrlbarInputBase.mjs:3064` |
| `gURLBar.value` | member (runtime) | Fallback display value for the sidebar address row. | `readSidebarAddressDisplayUrl` | `browser/components/urlbar/content/UrlbarInputBase.mjs:3056` |
| `OpenBrowserWindow` | method (runtime) | Opens an unsynced window; the options bag reaches BrowserWindowTracker.openWindow (patch window-sync/01). | `bentoSyncedWindow` | `browser/base/content/browser.js:1754` |
| `gContextMenu.linkURL` | source (engine only) | Open in New Panel reads the right-clicked link from the global context menu object. | `installOpenInNewPanelMenuItem` | `browser/base/content/nsContextMenu.sys.mjs:259` |
| `gContextMenu.onLink` | source (engine only) | Open in New Panel shows only for link targets. | `installOpenInNewPanelMenuItem` | `browser/base/content/nsContextMenu.sys.mjs:270` |
| `gContextMenu.browser` | source (engine only) | Resolves the panel container the context menu opened in; patch 04 resolves its tab. | `installOpenInNewPanelMenuItem`, `installInspectInPanelMenuItems` | `browser/base/content/nsContextMenu.sys.mjs:309` |
| `gContextMenu.targetIdentifier` | source (engine only) | Content DOM reference passed to the devtools inspector for Inspect in Panel. | `installInspectInPanelMenuItems` | `browser/base/content/nsContextMenu.sys.mjs:284` |
| `PlacesUIUtils.lastContextMenuTriggerNode` | member (runtime) | Trigger node of the Places context menu, used to read managed-bookmark URLs. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/PlacesUIUtils.sys.mjs:357` |
| `placesContext._view` | source (engine only) | placesContextShowing stashes the resolved view on the menupopup; Bento reads its selectedNode. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/PlacesUIUtils.sys.mjs:1470` |
| `searchBookmarks` | source (engine only) | Bento injects a search box into the native bookmarks sidebar and calls its filter function. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.js:144` |
| `bookmarks-view` | source (engine only) | Tree of the native bookmarks sidebar document that Bento re-queries. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.xhtml:69` |
| `sidebar-search-container` | source (engine only) | Container in the bookmarks sidebar document that receives Bento’s search box. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.xhtml:62` |
| `search-box` | source (engine only) | Native bookmarks sidebar search input that Bento replaces. | `runNativeBookmarksSearch` | `browser/components/places/content/bookmarksSidebar.xhtml:63` |
| `browser` | element (runtime) | Root hbox that holds the Bento host elements added by patch chrome-layout/01. | `attachSidebarChromeDivider` | `browser/base/content/browser-box.inc.xhtml:5` |
| `tabbrowser-tabbox` | element (runtime) | Tabbox that holds tabpanels; Bento tags it as the main panel when no side panels exist. | `unifyMainWithStrip`, `configureSidePanelOnce` | `browser/base/content/browser-box.inc.xhtml:28` |
| `sidebar` | element (runtime) | Native sidebar <browser>; Bento themes the documents loaded in it. | `syncNativeSidebarChromeTheme`, `attachNativeSidebarChromeThemeSync` | `browser/base/content/browser-box.inc.xhtml:24` |
| `sidebar-box` | element (runtime) | Native Bookmarks/History sidebar container; Bento drives its width, persistence and splitter feedback. | `attachNativeSidebarSplitterFeedback` | `browser/base/content/browser-box.inc.xhtml:12` |
| `sidebar-splitter` | element (runtime) | Native sidebar splitter whose resize behavior Bento replaces. | `attachNativeSidebarSplitterFeedback` | `browser/base/content/browser-box.inc.xhtml:27` |
| `navigator-toolbox` | element (runtime) | Native toolbox whose separators and offsets Bento adjusts. | `attachSidebarChromeDivider` | `browser/base/content/navigator-toolbox.inc.xhtml:5` |
| `nav-bar` | element (runtime) | Native navigation toolbar; Bento aligns its controls with the Bento sidebar. | `attachToolbarNavigationAlignment`, `getPanelNavigatorToolbarTarget` | `browser/base/content/navigator-toolbox.inc.xhtml:109` |
| `nav-bar-customization-target` | element (runtime) | Toolbar item container observed for placement changes. | `attachToolbarNavigationAlignment`, `getPanelNavigatorToolbarTarget` | `browser/base/content/navigator-toolbox.inc.xhtml:127` |
| `urlbar` | element (runtime) | Native urlbar; Bento intercepts pointer and focus events on it and opens its own address overlay. | `attachTopUrlbarModalListener` | `browser/base/content/navigator-toolbox.inc.xhtml:165` |
| `urlbar-input` | source (engine only) | Native urlbar text input; Bento blurs it and opens its own address overlay instead. | `attachTopUrlbarModalListener` | `browser/components/urlbar/content/UrlbarInputBase.mjs:402` |
| `stop-reload-button` | source (engine only) | Native toolbar button positioned with the back/forward cluster; user-customizable, so no runtime probe. | `attachToolbarNavigationAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:142` |
| `back-button` | source (engine only) | Native back button aligned with the Bento sidebar edge; user-customizable, so no runtime probe. | `attachToolbarNavigationAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:128` |
| `forward-button` | source (engine only) | Native forward button aligned with the Bento sidebar edge; user-customizable, so no runtime probe. | `attachToolbarNavigationAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:135` |
| `identity-box` | element (runtime) | Native identity box that Bento reads for security state. | `readSidebarAddressSecurity` | `browser/base/content/navigator-toolbox.inc.xhtml:216` |
| `identity-icon` | element (runtime) | Native identity icon read for the sidebar security button. | `readSidebarAddressSecurity` | `browser/base/content/navigator-toolbox.inc.xhtml:230` |
| `identity-icon-label` | element (runtime) | Native identity label read for the sidebar security button. | `readSidebarAddressSecurity` | `browser/base/content/navigator-toolbox.inc.xhtml:231` |
| `identity-popup` | source (engine only) | Native identity panel that Bento opens at a sidebar anchor. It sits inside template-identity-popup until gIdentityHandler._initializePopup() expands it, which Bento calls first. | `openNativeIdentityPopupForSidebar` | `browser/components/controlcenter/content/identityPanel.inc.xhtml:5` |
| `PersonalToolbar` | element (runtime) | Native bookmarks toolbar aligned with the panel strip start edge. | `attachBookmarksToolbarAlignment` | `browser/base/content/navigator-toolbox.inc.xhtml:546` |
| `mainPopupSet` | element (runtime) | Popup set that hosts the Bento chrome menus. | `ensurePanelHistoryPopup` | `browser/base/content/main-popupset.inc.xhtml:5` |
| `contentAreaContextMenu` | element (runtime) | Content context menu that receives the Open in New Panel and Inspect in Panel items. | `installOpenInNewPanelMenuItem`, `installInspectInPanelMenuItems` | `browser/base/content/main-popupset.inc.xhtml:679` |
| `placesContext` | element (runtime) | Places context menu that receives Open in New Panel. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:5` |
| `appMenu-popup` | source (engine only) | App menu panel, looked up by id at load. Bento listens on it for ViewShowing, so the Bento Settings item is added whichever way the menu opens. PanelUI.panel is the same element and is probed at runtime. | `installBentoSettingsAppMenuItem` | `browser/components/customizableui/content/panelUI.inc.xhtml:274` |
| `appMenu-mainView` | source (engine only) | The app menu main view, created lazily from the appMenu-viewCache template. Bento adds its Settings item when this view reports ViewShowing, matching the view by id. | `installBentoSettingsAppMenuItem` | `browser/base/content/appmenu-viewcache.inc.xhtml:6` |
| `appMenu-settings-button` | source (engine only) | Firefox's Settings item in the app menu main view. Bento inserts Bento Settings directly above it, as a toolbarbutton with the same subviewbutton class so it takes the menu's look, hover and arrow-key navigation. | `installBentoSettingsAppMenuItem` | `browser/base/content/appmenu-viewcache.inc.xhtml:205` |
| `CustomizableUI.maybeAutoHidePanel` | source (engine only) | Hides the app menu after a click or Enter on any subviewbutton without closemenu="none". Bento Settings relies on it to close the menu and does not hide the panel itself. | `installBentoSettingsAppMenuItem` | `browser/components/customizableui/CustomizableUI.sys.mjs:3275` |
| `context-openlink` | source (engine only) | Anchor item after which Open in New Panel is inserted. | `installOpenInNewPanelMenuItem` | `browser/base/content/browser-context.inc.xhtml:99` |
| `context-openlinkincurrent` | source (engine only) | Fallback anchor item for Open in New Panel. | `installOpenInNewPanelMenuItem` | `browser/base/content/browser-context.inc.xhtml:70` |
| `context-inspect` | source (engine only) | Native Inspect item that Bento clones as Inspect in Panel. | `installInspectInPanelMenuItems` | `browser/base/content/browser-context.inc.xhtml:456` |
| `context-inspect-a11y` | source (engine only) | Native accessibility Inspect item that Bento clones as Inspect in Panel. | `installInspectInPanelMenuItems` | `browser/base/content/browser-context.inc.xhtml:452` |
| `placesContext_open:newcontainertab` | source (engine only) | Preferred anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:28` |
| `placesContext_openContainer:tabs` | source (engine only) | Fallback anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:36` |
| `placesContext_openLinks:tabs` | source (engine only) | Fallback anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:41` |
| `placesContext_open:newwindow` | source (engine only) | Fallback anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:46` |
| `placesContext_openSeparator` | source (engine only) | Last-resort anchor for the Places Open in New Panel item. | `installOpenInNewPanelBookmarkMenuItem` | `browser/components/places/content/placesContextMenu.inc.xhtml:73` |
| `moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs` | module (runtime) | Supplies URI fixup primitives for sanitizing clipboard text in the new-tab address suggestion. | `getAddrbarUrlbarUtils` | `browser/components/urlbar/UrlbarUtils.sys.mjs:81` |
| `UrlbarUtils.getFixupPrimitives` | source (engine only) | Parent-only URI fixup info that the clipboard sanitizer takes as its second argument. | `sanitizeClipboardUrlText` | `browser/components/urlbar/UrlbarUtils.sys.mjs:517` |
| `chrome://browser/content/urlbar/UrlbarShared.mjs` | module (runtime) | Home of the clipboard sanitizer since 157 (UrlbarUtils.sanitizeTextFromClipboard before). | `getAddrbarUrlbarShared` | `browser/components/urlbar/content/UrlbarShared.mjs:79` |
| `UrlbarShared.sanitizeTextFromClipboard` | source (engine only) | Clipboard sanitizer; Bento falls back to stripping line breaks when it is absent. | `sanitizeClipboardUrlText` | `browser/components/urlbar/content/UrlbarShared.mjs:973` |
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
| `SearchEngine.getIconURL` | source (engine only) | Reads an engine icon URL (optional call). Configured engines return blob:system/<uuid>, which the experiment fetches; user-added and add-on engines return data: or moz-extension: URLs. | `extensions/bento-tools/experiments/bento-privacy/api.js#getEngineIconUrl` | `toolkit/components/search/SearchEngine.sys.mjs:1665` |
| `resource://gre/modules/Timer.sys.mjs` | module (runtime) | Timers for the search icon fetch timeout. An experiment scope has no setTimeout or clearTimeout, and a missing export leaves every search icon empty. | `extensions/bento-tools/experiments/bento-privacy/api.js#setTimeout` | `toolkit/modules/Timer.sys.mjs:96` |
| `Timer.clearTimeout` | source (engine only) | Cancels the search icon fetch timer once the icon has been read. | `extensions/bento-tools/experiments/bento-privacy/api.js#clearTimeout` | `toolkit/modules/Timer.sys.mjs:161` |
| `IconHandler.createIconURL` | source (engine only) | Makes the blob:system/<uuid> object URLs that getIconURL returns for configured engines. The experiment fetches only that form; a change of origin or scheme leaves the search icons empty. | `extensions/bento-tools/experiments/bento-privacy/api.js#SYSTEM_BLOB_ICON_URL` | `toolkit/components/search/ConfigSearchEngine.sys.mjs:151` |
| `resource:///modules/MigrationUtils.sys.mjs` | module (runtime) | Opens the migration wizard from the welcome flow. | `showEmbeddedBrowserImportFromWelcome`, `restartToBrowserImportFromWelcome` | `browser/components/migration/MigrationUtils.sys.mjs:1206` |
| `MigrationUtils.showMigrationWizard` | source (engine only) | Shows the migration wizard with the NEWTAB entrypoint. | `restartToBrowserImportFromWelcome` | `browser/components/migration/MigrationUtils.sys.mjs:593` |
| `resource:///modules/ExtensionsUI.sys.mjs` | module (runtime) | Bento re-subscribes ExtensionsUI to the permission-prompt topics when startup missed them. | `ensureExtensionsUIObservers` | `browser/modules/ExtensionsUI.sys.mjs:65` |
| `ExtensionsUI observer topics` | source (engine only) | The four webextension-*-prompt topics ExtensionsUI observes; Bento adds the observer for each if missing. | `ensureExtensionsUIObservers` | `browser/modules/ExtensionsUI.sys.mjs:73` |
| `moz-src:///browser/components/sessionstore/SessionStore.sys.mjs` | module (runtime) | Workspace assignment is stored as a custom tab value. | `getSessionStore` | `browser/components/sessionstore/SessionStore.sys.mjs:9114` |
| `resource://gre/modules/Extension.sys.mjs` | module (runtime) | Management.global.windowTracker resolves the WebExtension window id of a chrome window. | `getChromeWindowId`, `src/browser/actors/BentoShellBusParent.sys.mjs#windowTracker` | `toolkit/components/extensions/Extension.sys.mjs:171` |
| `resource://gre/modules/ExtensionParent.sys.mjs` | module (runtime) | ExtensionParent.apiManager.global.tabTracker maps WebExtension tab ids to tab elements. | `getTabTracker`, `getBentoTabTracker` | `toolkit/components/extensions/ExtensionParent.sys.mjs:2564` |
| `apiManager.global.{tabTracker,windowTracker}` | source (engine only) | ext-browser.js publishes the trackers on the extension API global; Bento reads them from there. | `getTabTracker`, `getBentoTabTracker`, `getChromeWindowId` | `browser/components/extensions/parent/ext-browser.js:787` |
| `tabTracker.getTab` | source (engine only) | Resolves a WebExtension tab id to a chrome tab element. | `getTrackedTabById`, `getBentoTabTracker` | `browser/components/extensions/parent/ext-browser.js:470` |
| `tabTracker.getId` | source (engine only) | Resolves a chrome tab element to its WebExtension tab id. | `getTrackedTabById`, `getBentoTabId` | `browser/components/extensions/parent/ext-browser.js:364` |
| `windowTracker.getId` | source (engine only) | Resolves a chrome window to its WebExtension window id. | `getChromeWindowId`, `src/browser/actors/BentoShellBusParent.sys.mjs#windowTracker` | `toolkit/components/extensions/parent/ext-tabs-base.js:1817` |
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
| `Toolbox.isDestroying` | source (engine only) | Skips half-destroyed toolboxes. | `matchingLivePageToolbox` | `devtools/client/framework/toolbox.js:4374` |
| `Toolbox.commands` | source (engine only) | Reaches descriptorFront.browserId, the root client and the target front. | `matchingLivePageToolbox`, `selectNodeInToolbox` | `devtools/client/framework/toolbox.js:342` |
| `Toolbox.selectTool` | source (engine only) | Switches the toolbox to the inspector or accessibility tool. | `selectNodeInToolbox` | `devtools/client/framework/toolbox.js:3104` |
| `Toolbox.getCurrentPanel` | source (engine only) | Reads the accessibility panel to select the inspected node. | `selectNodeInToolbox` | `devtools/client/framework/toolbox.js:580` |
| `inspectorFront.getNodeActorFromContentDomReference` | source (engine only) | Turns the context-menu DOM reference into a node front (same call Firefox makes). | `selectNodeInToolbox` | `devtools/client/framework/devtools.js:902` |
| `Selection.setNodeFront` | source (engine only) | Selects the inspected node in the inspector. | `selectNodeInToolbox` | `devtools/client/framework/selection.js:190` |
| `AccessibilityPanel.selectAccessibleForNode` | source (engine only) | Selects the inspected node in the accessibility panel. | `selectNodeInToolbox` | `devtools/client/accessibility/panel.js:255` |
| `ViewShowing` | source (engine only) | Bubbling event PanelMultiView dispatches on a panelview once it is in the panel and before it is measured. Bento listens on the app menu panel and adds its Settings item when the main view shows, which covers every way the menu can open. | `installBentoSettingsAppMenuItem` | `browser/components/customizableui/PanelMultiView.sys.mjs:1057` |
| `TabSelect` | source (engine only) | Reconciles panels, refreshes the panel navigator, and snapshots the sidebar address when the selected tab changes. | `attachTabSelectListener`, `setupPanelNavigator`, `attachSidebarAddressSnapshotListeners` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:2009` |
| `TabOpen` | source (engine only) | Reconciles panels when a tab opens (new-tab flows where TabSelect does not reach the listener). | `attachTabSelectListener` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:5529` |
| `TabAttrModified` | source (engine only) | Refreshes the panel navigator and the sidebar address snapshot when a tab attribute (title, busy, image) changes. | `setupPanelNavigator`, `attachSidebarAddressSnapshotListeners` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:2314` |
| `SSTabRestored` | source (engine only) | Refreshes the sidebar address snapshot after session restore fills a tab. | `attachSidebarAddressSnapshotListeners` | `browser/components/sessionstore/SessionStore.sys.mjs:8093` |
| `SSTabRestoring` | source (engine only) | Fires on a restored tab as the last step of SessionStore's history restore (#restoreHistoryComplete), also in a window restored without SSWindowRestored. A browser discarded before it is re-inserted by that restore, so Bento unloads a pending pinned tab one task after its event, or loads it when the window renders it as a panel. | `attachRestoredPinnedTabUnload` | `browser/components/sessionstore/SessionStore.sys.mjs:8570` |
| `SessionStore pending-tab reload restore` | source (engine only) | Bento loads a pending pinned tab that is a rendered panel with linkedBrowser.reload() in its SSTabRestoring handler. The history restore registers #listenForNavigations just before it dispatches that event, and the listener's onHistoryReload starts the content restore (#restoreTabContentForBrowser, which marks the pending tab as restoring and clears 'pending'). A reload before the listener exists is not intercepted. | `attachRestoredPinnedTabUnload` | `browser/components/sessionstore/SessionStore.sys.mjs:8451` |
| `tab [pending] attribute` | source (engine only) | SessionStore sets it on every restored tab that has not loaded yet and clears it when the content restore starts; it is the only sign of a pending tab (the saved address is already the browser URL). Bento selects pinned tabs to unload by it, reloads a pending pinned panel tab the window renders, reloads a pending panel tab it materializes, and copies the custom values of a pending tab it adopts. | `shouldUnloadRestoredPinnedTab`, `shouldLoadRestoredPinnedPanel`, `materializePanelTab`, `adoptTabInto` | `browser/components/sessionstore/SessionStore.sys.mjs:6527` |
| `tab [soundplaying] attribute` | source (engine only) | A tab playing audio is never unloaded as a pending pinned tab, and the panel navigator shows the playing state of the main tab by it. | `shouldUnloadRestoredPinnedTab`, `isMainTabAudioPlaying` | `browser/components/tabbrowser/content/tab.js:876` |
| `tab [sharing] attribute` | source (engine only) | A tab sharing the camera, microphone or screen is never unloaded as a pending pinned tab. | `shouldUnloadRestoredPinnedTab` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:2356` |
| `TabRestoreQueue pinned on-demand gate` | source (engine only) | Pinned tabs stay pending only while restore_on_demand and restore_pinned_tabs_on_demand are both true; otherwise the queue loads them in turn. Bento unloads pending pinned tabs only under the same condition, so it never unloads a tab the queue is about to load. | `pinnedRestoreOnDemand` | `browser/components/sessionstore/SessionStore.sys.mjs:9209` |
| `MozDOMFullscreen:Entered` | source (engine only) | Marks the panel whose page requested DOM fullscreen. | `attachBentoDomFullscreenRequesterTracking`, `markBentoDomFullscreenRequester` | `dom/base/Document.cpp:17080` |
| `MozDOMFullscreen:Exited` | source (engine only) | Clears the DOM fullscreen requester mark. | `attachBentoDomFullscreenRequesterTracking`, `clearBentoDomFullscreenRequester` | `dom/base/Document.cpp:16083` |
| `aftercustomization` | source (engine only) | Re-aligns toolbar navigation buttons and the bookmarks toolbar, and re-mounts the panel navigator, after the user customizes the toolbar. | `attachToolbarNavigationAlignment`, `attachBookmarksToolbarAlignment`, `watchPanelNavigatorToolbarPlacement` | `browser/components/customizableui/CustomizeMode.sys.mjs:683` |
| `gBrowser._endRemoveTab` | method (runtime) | Finishes closing the source tab after a window-to-window browser swap (patch window-sync/02). | `patches/window-sync/02-tabbrowser-bento-sync.patch#_endRemoveTab` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:6765` |
| `tab._endRemoveArgs` | source (engine only) | Reads the [closeWindow, newTab] arguments _beginRemoveTab stored on the tab when a browser swap closes the source tab (patch window-sync/02). | `patches/window-sync/02-tabbrowser-bento-sync.patch#_endRemoveArgs` | `browser/components/tabbrowser/Tabbrowser.sys.mjs:6613` |
| `OpenBrowserWindow options` | source (engine only) | OpenBrowserWindow forwards its whole options object to BrowserWindowTracker.openWindow, which carries Bento's bentoSyncedWindow flag (patch window-sync/01). | `bentoSyncedWindow` | `browser/base/content/browser.js:1759` |
| `browser.xhtml navigator:browser windowtype` | source (engine only) | The native no-scroll capture and theme-input policies check the document's own root windowtype together with its system principal; ancestor browser identity never opts a document in. | `patches/core-ui/18-native-root-view-transition-capture.patch#navigator:browser`, `patches/core-ui/19-native-mode-transition-input.patch#navigator:browser` | `browser/base/content/browser.xhtml:13` |
| `ViewportFrame.BuildDisplayList` | source (engine only) | Supplies the missing root capture producer only for a painted system-principal main browser document without a root scroll container, while its actual root style frame is captured. | `patches/core-ui/18-native-root-view-transition-capture.patch#ViewportFrame` | `layout/generic/ViewportFrame.cpp:69` |
| `nsCSSFrameConstructor.GetRootElementStyleFrame` | source (engine only) | Uses the actual document root style frame to test capture state; the existing root capture wrapper resolves its image key through the same frame. | `patches/core-ui/18-native-root-view-transition-capture.patch#GetRootElementStyleFrame`, `patches/core-ui/19-native-mode-transition-input.patch#GetRootElementStyleFrame` | `layout/base/nsCSSFrameConstructor.h:333` |
| `NS_FRAME_CAPTURED_IN_VIEW_TRANSITION` | source (engine only) | Restricts the no-scroll native root fallback to the actual root frame captured by the active view transition. | `patches/core-ui/18-native-root-view-transition-capture.patch#NS_FRAME_CAPTURED_IN_VIEW_TRANSITION` | `layout/generic/nsFrameStateBits.h:80` |
| `nsDisplayViewTransitionCapture.CreateWebRenderCommands` | source (engine only) | Reuses the root snapshot image-key and snapshot-containing-block coordinate path with aIsRoot=true; ViewTransition/NAC top-layer items remain outside its children. | `patches/core-ui/18-native-root-view-transition-capture.patch#nsDisplayViewTransitionCapture` | `layout/painting/nsDisplayList.cpp:5661` |
| `ViewTransition.CaptureOldState` | source (engine only) | Latches the explicit native theme-input contract only after successful old capture collection: same document, no callback, own system browser root and exactly its actual root style frame. | `patches/core-ui/19-native-mode-transition-input.patch#CaptureOldState` | `dom/view-transitions/ViewTransition.cpp:1352` |
| `ViewTransition.CaptureNewState` | source (engine only) | Rejects an opted-in transaction before animation if new capture membership is missing, renamed or includes a non-root frame; ordinary transitions retain upstream membership behavior. | `patches/core-ui/19-native-mode-transition-input.patch#CaptureNewState` | `dom/view-transitions/ViewTransition.cpp:1450` |
| `ViewTransition.CreateCrossDocument` | source (engine only) | Marks cross-document transitions explicitly so the null update callback used by that factory cannot satisfy the same-document native input contract. | `patches/core-ui/19-native-mode-transition-input.patch#CreateCrossDocument` | `dom/view-transitions/ViewTransition.cpp:281` |
| `Document.GetActiveViewTransition` | source (engine only) | Uses the existing active transition to scope the internal input latch to its capture/update phase, without adding a Document or WebIDL API. | `patches/core-ui/19-native-mode-transition-input.patch#GetActiveViewTransition` | `dom/base/Document.h:4255` |
| `PresShell.EventHandler.GetFrameToHandleNonTouchEvent` | source (engine only) | Consults the active native theme latch only inside rendering-suppressed input retargeting; eligible native input continues through existing hit testing. | `patches/core-ui/19-native-mode-transition-input.patch#GetFrameToHandleNonTouchEvent` | `layout/base/PresShell.cpp:8077` |
| `TouchManager.SetupTarget` | source (engine only) | Applies the same native theme latch only to the existing suppressed touchstart retarget check; captured touch sessions and normal targeting remain upstream. | `patches/core-ui/19-native-mode-transition-input.patch#TouchManager::SetupTarget` | `layout/base/TouchManager.cpp:110` |
| `FirefoxProfileMigrator._getFileObject` | source (engine only) | Locates the external browser session files inside a profile directory (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#_getFileObject` | `browser/components/migration/FirefoxProfileMigrator.sys.mjs:102` |
| `FirefoxProfileMigrator.startupOnlyMigrator` | source (engine only) | Decides whether the Firefox profile migrator is offered only at startup (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#startupOnlyMigrator` | `browser/components/migration/FirefoxProfileMigrator.sys.mjs:498` |
| `MigrationUtils.isStartupMigration` | source (engine only) | Tells the first-run import apart from a later import (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#isStartupMigration` | `browser/components/migration/MigrationUtils.sys.mjs:548` |
| `MigrationUtils.profileStartup` | source (engine only) | Reads the running profile's directory so the import skips it (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#profileStartup` | `browser/components/migration/MigrationUtils.sys.mjs:559` |
| `MigrationUtils.resourceTypes` | source (engine only) | Resource type constants the first-run import selects (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#resourceTypes` | `browser/components/migration/MigrationUtils.sys.mjs:198` |
| `nsAppRunner selectable-profile reset key` | source (engine only) | The migrator key nsAppRunner.cpp requests when a selectable profile is reset; the selectable-profile migrator and the refresh key set keep it (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#firefox-selectable-profile` | `toolkit/xre/nsAppRunner.cpp:6166` |
| `FirefoxSelectableProfileMigrator.key` | source (engine only) | Registers the selectable-profile migrator under the firefox-keyed name nsAppRunner.cpp requests (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#FirefoxSelectableProfileMigrator` | `browser/components/migration/FirefoxSelectableProfileMigrator.sys.mjs:27` |
| `MigrationUtils.FIREFOX_REFRESH_MIGRATOR_KEYS` | source (engine only) | Keys that count as a Firefox profile refresh; Bento keeps the firefox-keyed names (patch core-ui/09). | `patches/core-ui/09-bento-firefox-profile-first-run-import.patch#FIREFOX_REFRESH_MIGRATOR_KEYS` | `browser/components/migration/MigrationUtils.sys.mjs:46` |
| `MigrationWizard:Close` | source (engine only) | Tells the embedded import host the wizard finished so it can close. | `src/browser/base/content/bento-migration-host.js#MigrationWizard:Close` | `browser/components/migration/content/migration-wizard.mjs:1482` |
| `migration-wizard.requestState` | source (engine only) | Asks the embedded migration wizard to render its initial state. | `src/browser/base/content/bento-migration-host.js#requestState` | `browser/components/migration/content/migration-wizard.mjs:419` |
| `migration-wizard element` | source (engine only) | Custom element the import host waits for before bridging styles. | `src/browser/base/content/bento-migration-host.js#whenDefined('migration-wizard')` | `browser/components/migration/content/migration-wizard.mjs:1619` |
| `migration-wizard #wizard-deck` | source (engine only) | Deck inside the wizard whose selected-view leaves page-loading once the wizard shows its first state; the import host reports ready then. | `src/browser/base/content/bento-migration-host.js#wizard-deck` | `browser/components/migration/content/migration-wizard.mjs:39` |
| `resource:///modules/FirefoxProfileMigrator.sys.mjs` | module (runtime) | Finds a Mozilla Firefox or Zen profile for the onboarding Import step's Firefox or Zen tile. ZenProfileMigrator, the other export it reads, comes from Bento's patch core-ui/09. | `hasFirefoxZenProfile` | `browser/components/migration/FirefoxProfileMigrator.sys.mjs:36` |
| `FirefoxProfileMigrator.getAllProfiles` | source (engine only) | Lists the Firefox and Zen profile registries for the Import step's Firefox or Zen tile. getSourceProfiles reads MigrationUtils.profileStartup, which only a startup migration has. | `getAllProfiles` | `browser/components/migration/FirefoxProfileMigrator.sys.mjs:61` |
| `MigrationUtils.getMigrator` | source (engine only) | Gets a browser's migrator for the Import step's tiles. It does not await canGetPermissions(), so it also returns Chromium browsers whose data folder has no readable Local State; detection applies the wizard's own test as well. | `getMigrator` | `browser/components/migration/MigrationUtils.sys.mjs:447` |
| `MigratorBase.enabled` | source (engine only) | The wizard lists only enabled migrators (browser.migrate.<key>.enabled); the Import step applies the same test. | `migrator?.enabled` | `browser/components/migration/MigratorBase.sys.mjs:201` |
| `MigratorBase.hasPermissions` | source (engine only) | Part of the wizard's test for listing a migrator, applied by the Import step. | `hasPermissions` | `browser/components/migration/MigratorBase.sys.mjs:214` |
| `MigratorBase.canGetPermissions` | source (engine only) | Part of the wizard's test for listing a migrator without permissions (Safari asks after the user picks it), applied by the Import step. | `canGetPermissions` | `browser/components/migration/MigratorBase.sys.mjs:242` |
| `MigratorBase.getSourceProfiles` | source (engine only) | Part of the wizard's test for listing a migrator: an array must be non-empty, null is a source without a profile list. | `getSourceProfiles` | `browser/components/migration/MigratorBase.sys.mjs:100` |
| `MigratorBase.brandImage` | source (engine only) | The chrome:// logo of a migrator; chrome re-encodes it as a data URL for the onboarding page, which cannot load chrome:// images. | `brandImage` | `browser/components/migration/MigratorBase.sys.mjs:78` |
| `migrator key chrome` | source (engine only) | Key of the Chrome migrator: the onboarding Import step reports availability under it and the wizard preselects it. | `'chrome'` | `browser/components/migration/ChromeProfileMigrator.sys.mjs:97` |
| `migrator key safari` | source (engine only) | Key of the Safari migrator: the onboarding Import step reports availability under it and the wizard preselects it. | `'safari'` | `browser/components/migration/SafariProfileMigrator.sys.mjs:527` |
| `migrator key chromium-edge` | source (engine only) | Key of the Edge migrator: the onboarding Import step reports availability under it and the wizard preselects it. | `'chromium-edge'` | `browser/components/migration/ChromeProfileMigrator.sys.mjs:1156` |
| `migrator key brave` | source (engine only) | Key of the Brave migrator: the onboarding Import step reports availability under it and the wizard preselects it. | `'brave'` | `browser/components/migration/ChromeProfileMigrator.sys.mjs:1135` |
| `migrator key vivaldi` | source (engine only) | Key of the Vivaldi migrator: the onboarding Import step reports availability under it and the wizard preselects it. | `'vivaldi'` | `browser/components/migration/ChromeProfileMigrator.sys.mjs:1276` |
| `migrator key opera` | source (engine only) | Key of the Opera migrator: the onboarding Import step reports availability under it and the wizard preselects it. | `'opera'` | `browser/components/migration/ChromeProfileMigrator.sys.mjs:1219` |
| `migration-wizard.setState` | source (engine only) | The import host wraps the wizard element's setState once to add state.migratorKey to the first selection state, so an onboarding tile opens the wizard with its browser selected. | `src/browser/base/content/bento-migration-host.js#wizard.setState` | `browser/components/migration/content/migration-wizard.mjs:446` |
| `MigrationWizardChild.setComponentState` | source (engine only) | The wizard actor delivers every state through the element's own setState (Cu.waiveXrays(el).setState), which is what lets the host's wrapper see it. | `src/browser/base/content/bento-migration-host.js#setComponentState` | `browser/components/migration/MigrationWizardChild.sys.mjs:433` |
| `migration-wizard selection state migratorKey` | source (engine only) | Key of the migrator the selection page selects. A key the page does not list throws and leaves the wizard on its loading page, so the host adds it only when listed. | `src/browser/base/content/bento-migration-host.js#state.migratorKey` | `browser/components/migration/content/migration-wizard.mjs:722` |
| `migration-wizard selection state migrators` | source (engine only) | Entries (each with a key) the selection page lists; the host checks the chosen key against them. | `src/browser/base/content/bento-migration-host.js#state.migrators` | `browser/components/migration/content/migration-wizard.mjs:678` |
| `MigrationWizardConstants.PAGES.SELECTION` | source (engine only) | Page id of the wizard's selection state, which the host imports from chrome://browser/content/migration/migration-wizard-constants.mjs. | `src/browser/base/content/bento-migration-host.js#migration-wizard-constants.mjs` | `browser/components/migration/content/migration-wizard-constants.mjs:18` |
| `migration-wizard #browser-profile-selector` | source (engine only) | Profile selector button inside the wizard's shadow root; the host restyles it. | `src/browser/base/content/bento-migration-host.js#browser-profile-selector` | `browser/components/migration/content/migration-wizard.mjs:56` |
| `migration-wizard .resource-selection-details` | source (engine only) | Resource list details block the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-selection-details` | `browser/components/migration/content/migration-wizard.mjs:83` |
| `migration-wizard #resource-selection-summary` | source (engine only) | Summary line of the resource list the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-selection-summary` | `browser/components/migration/content/migration-wizard.mjs:84` |
| `migration-wizard #resource-type-list` | source (engine only) | Resource checkbox list the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-type-list` | `browser/components/migration/content/migration-wizard.mjs:89` |
| `migration-wizard .resource-progress` | source (engine only) | Progress list the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-progress` | `browser/components/migration/content/migration-wizard.mjs:129` |
| `migration-wizard .resource-progress-group` | source (engine only) | Progress rows the host restyles. | `src/browser/base/content/bento-migration-host.js#resource-progress-group` | `browser/components/migration/content/migration-wizard.mjs:130` |
| `FINAL_TARGET_FILES.actors` | source (engine only) | Bento actors ship through browser/actors/moz.build and load from resource:///actors/. The shell bus relay actors (BentoShellBus) sit in a second FINAL_TARGET_FILES.actors block beside the sorted list; the parent module is imported by the chrome-bridge experiment and the actor registration under the same resource:///actors/ URL, because resource:// and resource://app/ spellings load separate module instances. | `registerContentKeyActor`, `registerShellBusActor`, `patches/chrome-layout/04-bento-key-actors.patch#BentoKeyChild`, `patches/chrome-layout/04-bento-key-actors.patch#BentoShellBusChild` | `browser/actors/moz.build:92` |
| `Animatable.getAnimations pseudoElement option` | source (engine only) | Selects only the owned native panel ::after animations so preparation can finish its running border-color CSSTransitions before mask collection, without scanning descendants or finishing other motion. | `src/browser/actors/BentoModePresentation.sys.mjs#settleNativeFocusRings` | `dom/webidl/Animatable.webidl:27` |
| `Window.windowUtils` | source (engine only) | Submits current native/child style state through privileged window utilities before releasing the shared opaque UI hold. | `src/browser/actors/BentoModePresentation.sys.mjs#windowUtils`, `src/browser/actors/BentoShellBusChild.sys.mjs#windowUtils` | `dom/webidl/Window.webidl:602` |
| `nsIDOMWindowUtils.updateLayerTree` | source (engine only) | Each child submits once before its actor ACK; the parent submits after those ACKs. Upgrades must preserve synchronous display-list receipt fencing. | `src/browser/actors/BentoModePresentation.sys.mjs#updateLayerTree`, `src/browser/actors/BentoShellBusChild.sys.mjs#updateLayerTree` | `dom/interfaces/base/nsIDOMWindowUtils.idl:116` |
| `nsDOMWindowUtils.UpdateLayerTree receipt fence` | source (engine only) | The child ACK follows WaitOnTransactionProcessed; the final parent compositor flush can therefore fence the shared scene-builder after all child display lists arrive. | `src/browser/actors/BentoShellBusChild.sys.mjs#submitModeDocument` | `dom/base/nsDOMWindowUtils.cpp:430` |
| `nsIDOMWindowUtils.syncFlushCompositor` | source (engine only) | One parent compositor fence follows current child submissions before old-root opacity playback. No per-frame flush. | `src/browser/actors/BentoModePresentation.sys.mjs#syncFlushCompositor` | `dom/interfaces/base/nsIDOMWindowUtils.idl:2150` |
| `GeometryUtils BoxQuadOptions.ignoreTransforms` | source (engine only) | ChromeOnly untransformed quads preserve exact local radii when fractional page clips and public opaque shell surfaces map through native hosts. | `src/browser/actors/BentoModePresentation.sys.mjs#ignoreTransforms`, `src/browser/actors/BentoShellBusChild.sys.mjs#ignoreTransforms` | `dom/webidl/GeometryUtils.webidl:25` |
| `BrowsingContext.currentWindowGlobal` | source (engine only) | Mode participant queries and overlay reveals bind to the actual current WindowGlobal and reject navigation-stale replies. | `src/browser/actors/BentoShellBusParent.sys.mjs#currentWindowGlobal`, `src/browser/base/content/bento-shell-mount.js#setOverlayPresentation` | `dom/chrome-webidl/BrowsingContext.webidl:339` |
| `WindowGlobalParent.getActor` | source (engine only) | Gets the current overlay document actor for an acknowledged native-host presentation update before reveal. | `src/browser/base/content/bento-shell-mount.js#setOverlayPresentation` | `dom/chrome-webidl/WindowGlobalActors.webidl:209` |
| `JSActor.sendQuery` | source (engine only) | Waits for the overlay actor to apply parent-owned presentation state synchronously before native reveal or focus. | `src/browser/base/content/bento-shell-mount.js#setOverlayPresentation`, `src/browser/actors/BentoShellBusParent.sys.mjs#sendQuery`, `src/browser/actors/BentoShellBusChild.sys.mjs#sendQuery` | `dom/chrome-webidl/JSActor.webidl:16` |
| `JSWindowActorChild.document` | source (engine only) | Binds presentation updates to the actor document; a WindowProxy may already refer to a replacement page during navigation. | `src/browser/actors/BentoShellBusChild.sys.mjs#this.document` | `dom/chrome-webidl/JSWindowActor.webidl:60` |
| `CanonicalBrowsingContext.topChromeWindow` | source (engine only) | The BentoShellBus parent actor reads it to find the browser window that hosts a shell frame, and takes the document's window id and privacy from it (embedderElement.ownerGlobal is null for these frames). preferences.js reads the window that hosts about:preferences to copy its Bento color mode onto the page root. It reads it again on every 'bento-ui-color-mode' notification, on visibilitychange and on focus, because a tab moved to another window keeps the document. | `patches/core-ui/12-center-native-preferences.patch#topChromeWindow`, `src/browser/actors/BentoShellBusParent.sys.mjs#topChromeWindow` | `dom/chrome-webidl/BrowsingContext.webidl:341` |
| `JSWindowActorParent.manager` | source (engine only) | The BentoShellBus parent actor reads its WindowGlobalParent to check which document a relayed message comes from. | `src/browser/actors/BentoShellBusParent.sys.mjs#manager` | `dom/chrome-webidl/JSWindowActor.webidl:26` |
| `WindowGlobalParent.documentURI` | source (engine only) | The BentoShellBus parent actor accepts a message only from a document of the bento-shell extension: it reads the loaded document scheme and host here, and a null or foreign URI is refused, so a web page that reached the actor cannot speak for a window. | `src/browser/actors/BentoShellBusParent.sys.mjs#documentURI`, `src/browser/base/content/bento-shell-mount.js#setOverlayPresentation` | `dom/chrome-webidl/WindowGlobalActors.webidl:159` |
| `WebExtensionPolicy.getByID` | source (engine only) | The BentoShellBus parent actor looks up the bento-shell policy by add-on id to learn the moz-extension host that its documents have. | `src/browser/actors/BentoShellBusParent.sys.mjs#getByID`, `src/browser/actors/BentoShellBusChild.sys.mjs#getByID` | `dom/chrome-webidl/WebExtensionPolicy.webidl:294` |
| `WebExtensionPolicy.mozExtensionHostname` | source (engine only) | The host of the bento-shell policy is the identity check for the BentoShellBus actor: a document whose moz-extension host differs is not a shell document, and its messages are dropped. | `src/browser/actors/BentoShellBusParent.sys.mjs#mozExtensionHostname`, `src/browser/actors/BentoShellBusChild.sys.mjs#mozExtensionHostname` | `dom/chrome-webidl/WebExtensionPolicy.webidl:31` |

<!-- firefox-compat:end -->
<!-- prettier-ignore-end -->
