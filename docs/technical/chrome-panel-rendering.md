# Chrome panel rendering

Part of the [technical notes index](../core-functionality-technical.md).

The working panel renderer is `reconcilePanelsSplitView` in
`src/browser/base/content/bento-shell-mount.js`.

Bento does not move a tab's `linkedBrowser` into a custom host. Earlier
docShell-swap and browser-reparent approaches broke WebExtensions and browser
identity. The current renderer drives Firefox's native split-view machinery:

1. Resolve `panels/sync` tab ids to real `gBrowser` tab elements with
   `ExtensionParent`'s tab tracker.
2. Materialize pending/lazy restored tabs with `gBrowser.insertBrowser(tab)`
   when needed.
3. Build the render list as `[gBrowser.selectedTab, ...workspacePanelTabs]`.
4. Assign a Bento `tab.splitview` marker to every tab that must stay active.
5. Dispatch `TabSplitViewDeactivate` for the previous marker and
   `TabSplitViewActivate` for the new marker.
6. Call `gBrowser.showSplitViewPanels(layoutTabsToRender)`.
7. Re-force `docShellIsActive = true` on every active split browser.
8. Inject per-panel headers into side panel notificationboxes.
9. Apply layout rects, splitters, panel trailer, nav state, focus state, and
   scroll restoration.

Every panel remains a normal Firefox tab whose `linkedBrowser` remains inside
`#tabbrowser-tabpanels`. This preserves content scripts, page state, history,
media, devtools, and extension identity.

## Required split-view compatibility shims

The following mechanisms are load-bearing:

- `tab.splitview` is defined with `Object.defineProperty`, not plain assignment.
  Firefox's native getter otherwise ignores the value.
- The marker must expose `.tabs`, `.activeTab`, `.before()`, and
  `.nextElementSibling`. Firefox progress listeners and tab insertion paths read
  these fields.
- `TabSplitViewActivate` must be dispatched so `gBrowser.activeSplitView`,
  `splitViewBrowsers`, and `shouldActivateDocShell` know Bento panel browsers are
  active.
- `preserveLayers(true)` must happen before deactivating departing panel
  browsers, or returning panels can paint blank for a frame.
- `.split-view-panel-active` must be removed from departing panels, or a stale
  class produces ghost overlays. Firefox's `removeTabsFromSplitview` removes
  both `.split-view-panel` and `.split-view-panel-active`, so the reconciler only
  calls it. The old `MozTabpanels.setSplitViewPanelActive` helper no longer
  exists; do not call it.
- `gBrowser.warmupTab(tab)` must run for active split tabs. Without an
  `AsyncTabSwitcher`, Firefox's visibility fallback can deactivate panel
  docShells.
- `gBrowser.on_visibilitychange` is overridden to no-op while split-view mode is
  active. This prevents minimized/restored windows and DevTools focus changes
  from blanking panels.
- Firefox's split-view auto-select listeners are removed from panel containers.
  Otherwise clicking a side panel sets it as `gBrowser.selectedTab`, which
  promotes the side panel into the main slot and reorders the strip.

Every private Firefox member these shims touch (`on_visibilitychange`,
`_findTabToBlurTo`, `insertBrowser`, the `isEmpty` and
`splitview` tab getters, `activeSplitView`, the `TabSplitView*` handlers,
`splitViewPanels`, `removeTabsFromSplitview`, `PopupNotifications._isActiveBrowser`,
and the rest) is an entry in the firefox-compat registry
(`scripts/firefox-compat-registry.mjs`). A new shim that reaches a private member
adds its entry, and its id in the mount probe list, in the same change.

## Chrome rendering pitfalls

- Chrome layout stylesheet. Source of truth: `src/browser/base/content/bento-shell-mount.css`,
  a static file, not a template literal in the mount script. Chrome bridge:
  `injectChromeStyles()` appends `<link rel="stylesheet" href="chrome://browser/content/bento-shell-mount.css">`
  to the window root after the tokens and theme links, then calls
  `gateFirstPaintOnSheets` with those three links. Persistence: none. Manual
  verification: in the Browser Toolbox Console,
  `[...document.styleSheets].map((s) => s.href)` lists `bento-chrome-tokens.css`,
  `bento-chrome-theme.css`, `bento-shell-mount.css` in that order, ahead of any
  `bento-chrome-themes/` sheet; the Browser Toolbox Style Editor lists
  `bento-shell-mount.css`; `window.__bentoSheetGate` is `undefined` (every sheet
  was already cached) or `{ pending, releasedBy: 'load', heldMs }`, and
  `document.documentElement.style.visibility` is empty. Then cold-start the
  first window and open a second one and look for an unstyled frame; on Windows
  also cold-start with a persisted window size and the default theme, where
  Firefox shows an early blank window. Pitfalls:
  - The file ships only through the `browser/base/jar.mn` line in
    `patches/chrome-layout/01-bento-shell-mount.patch`. Without the line the
    import succeeds and the app loads with no layout CSS.
    `scripts/check-import-output.mjs` fails on any `src/browser/base/content`
    file the engine `jar.mn` does not register.
  - Keep the link where the former inline `<style>` was appended (after the
    tokens and theme links, before any theme sheet). Stylesheets order by owner
    node position, and the file's `@layer bento.chrome-theme` blocks must follow
    the ones in `bento-chrome-theme.css`. A parser-created link in
    `browser-box.inc.xhtml` would sort the file before the tokens and theme
    links, and an `<?xml-stylesheet?>` instruction before every other sheet, which
    changes which rule wins on equal specificity. `scripts/mount-sheet-gate.test.mjs`
    checks the order of the three calls.
  - Do not load it with `windowUtils.loadSheetUsingURIString`. That makes it an
    additional author sheet: it is parsed again in every window (the loader has
    no document, so no shared sheet cache), DevTools does not list it (the
    Style Editor and `document.styleSheets` skip additional sheets, and
    registering it later through a matched rule can fail on its missing
    `associatedDocument`), and it sorts after the per-theme sheets.
  - What holds back first paint depends on the startup path.
    - Normal first window: the chrome window stays hidden until `browser.xhtml`
      finishes loading. The three links block that load, and each link's own
      load event also blocks it, so the gate is released before the window is
      shown and adds no delay.
    - Early blank window (`browser.startup.blankWindow`: on by default on Windows,
      on Linux only in Nightly builds or when turned on; it needs a persisted
      window size and the default theme): the window is already visible when
      Firefox navigates it to `browser.xhtml`. Script-inserted links do not
      count toward the prototype sink's pending-sheet counter, so initial layout
      can start with them pending and paint suppression ends after 5 ms
      (`nglayout.initialpaint.delay`). The gate hides the root until the pending
      links have fired `load` or `error`, so tokens, theme, and layout rules are
      all present when the chrome first paints.
    - Later windows: the sheets come from the shared sheet cache, so each link
      has a complete sheet when it is inserted (`link.sheet` is null until the
      sheet is complete) and the gate never engages. The mount sheet is cloned
      from the cache like the old inline style.
  - The gate sets `visibility: hidden !important` on the root's inline style: no
    stylesheet, no layout change. It puts back any inline `visibility` that was
    there and releases on the last `load` or `error`, after 2 s with a console
    warning, or on `unload`; a failure while arming it also releases. Nothing
    else writes the root's inline `visibility` (Firefox chrome and the mount use
    other root properties). Hidden elements cannot take focus, so do not hold
    the gate past the document load event, which `gBrowserInit` follows with its
    focus and delayed startup work.
    `scripts/mount-sheet-gate.test.mjs` runs the real functions against a stub
    DOM and covers cached, pending, error, timeout, unload, and arming failure.
  - Do not move the rules back into a JS template literal or an inline
    `<style>`: one stray backtick or dollar-brace breaks the whole mount script.
  - `scripts/check-chrome-resize-guard.mjs` matches the shadow-token rules in
    this file, not in the mount script.
- Chrome icons. Source of truth: the `ICONS` table in
  `src/browser/base/content/bento-shell-mount.js`, verbatim copies of the
  `lucide-react` icon nodes (the version `@muxui/react` depends on, pinned in
  `extensions/bento-shell/package.json`), because chrome JS cannot import npm
  packages. Chrome bridge: `makeIcon` draws an entry as an inline `<svg>` with
  `stroke="currentColor"`, `stroke-width="2"`, and round caps and joins; panel
  header buttons, the panel navigator, and the music-note particles all use it.
  Persistence: none. Manual verification: open a side panel and compare its
  header icons (Back, Forward, Reload, audio, Bookmark, Pin, Close, drag handle,
  options) with the same icons in a shell menu. Pitfalls:
  - Copy the whole icon node, not a path. Dot icons (`gripVertical`,
    `ellipsisVertical`) are lucide `<circle r="1">` shapes. An earlier copy drew
    each dot as a zero-length stroke and raised `stroke-width` to 3.5 in CSS to
    compensate; with the real circles that override would draw oversized dots,
    so do not reintroduce it.
  - `scripts/mount-icons.test.mjs` fails when an entry differs from the installed
    package. After a `lucide-react` bump, re-sync the entries from each icon's
    `__iconNode` instead of editing path data by hand.
- The gBrowser hooks are guarded by `typeof` and a `__bento*` flag, so a Firefox
  rename silently disables them (ghost panels, wrong tab focus after a close).
  After a Firefox update, run `pnpm run firefox:compat:engine` before anything
  else and check the Browser Console of a built app for
  `[bento-compat] missing <id>` lines (the table in
  `docs/firefox-core-touchpoints.md` explains each id). The runtime probe runs
  after delayed startup, never throws, and changes no behavior. It is passive
  (see the pitfall below), so objects Firefox has not loaded yet, such as the
  downloads panel, are counted as `deferred` instead of probed;
  `window.BentoFirefoxCompat.check()` in the Browser Toolbox re-runs it after
  opening them and returns the `present`, `missing`, and `deferred` id lists.
- A compat probe must not trigger what it probes. Reading `window.gURLBar`,
  `PanelUI`, or `PanelMultiView` runs the lazy getter that loads them,
  `ChromeUtils.importESModule` loads a module that is not loaded yet, and
  `gBrowser.selectedTab` is a getter too. The probe reads every property with
  `Object.getOwnPropertyDescriptor` along the prototype chain (a data property
  has a `value`, an accessor does not and is never called), imports a module
  only after `Cu.isESModuleLoaded(url)` is true, and finds the selected tab and
  a `<browser>` with native DOM calls. A review found seven imports and a
  `PanelMultiView` getter call from a check made before anything had loaded;
  the passive test in `scripts/check-firefox-compat.test.mjs` counts both and
  expects zero. A new probe goes through `bentoCompatPeek`, never `owner[key]`
  or `key in owner` on a Firefox object.
- Passive does not mean data-only. A first runtime check logged
  `missing MozTabbrowserTab.linkedPanel` because the probe required a string
  data value, but `linkedPanel` is a get/set accessor on the `MozTab` prototype
  (`tabbox.js`), so it was present and working. A descriptor found anywhere on
  the prototype chain, data or accessor, counts as present; only an owner that
  is still an untriggered lazy accessor is `deferred`. A method found as a data
  property must be a function, and one found as an accessor counts as present
  because checking it would mean calling the getter. The same run printed
  `Firefox 0.0.1`: the summary line uses `Services.appinfo.platformVersion`
  (`158.0`), not Bento's app version. The tests build fixtures whose members are
  prototype accessors that throw if invoked; keep new fixtures in that shape,
  because a data-property fixture hides this bug.
- The private-member scan follows local aliases such as
  `const gb = window.gBrowser;` (the former `reattachTabProgressFilters` reached
  `_getTabProgressFilter` only through `gb`, which the direct-access scan
  missed). It does not follow destructuring, parameters, bracket access, or
  helper return values; register those members by hand.
- A compat probe must not be satisfied by Bento's own code. Wrapping a Firefox
  member and then checking `typeof gBrowser.x === 'function'` finds the wrapper;
  patch sites call `bentoCompatNoteNative(id, original)` first and the probe
  judges that, and members Bento assigns on an instance (`splitViewPanels`, the
  per-tab `splitview` getter) are probed on the prototype. Elements inside a
  `<html:template>` (`identity-popup` until `gIdentityHandler._initializePopup()`
  runs) and lazy globals that Firefox has not materialised must not be probed as
  if present: the former are engine-only, and a lazy global that is absent is
  `missing` while one still behind its getter (or a module that is not loaded
  yet) is `deferred`.
- Do not call `gBrowser.hideTab(tab)` for active panel tabs. Smoke testing showed
  hidden tabs render as black or blank split-view slots.
- Do not move or swap a tab's `linkedBrowser`. Extension content scripts depend
  on stable tab/browser identity.
- Reparenting a tab `<browser>` strands Tabbrowser's progress filter. Moving a
  connected `<browser>` (or an ancestor) with `insertBefore` / `appendChild`
  unbinds and rebinds it, which destroys and recreates its frameloader (only
  `moveBefore` keeps it), so `browser.webProgress` becomes a new
  BrowsingContext's empty `nsIWebProgress`. Tabbrowser only moves its per-tab
  browser status filter on remoteness change, so the filter stays on the
  discarded BrowsingContext. Source of truth: Tabbrowser's private
  `#tabFilters` / `#tabListeners` maps (the filter keeps its
  `TabProgressListener`; only the filter-to-webProgress link is lost). Firefox
  154 exposed the filter through `gBrowser._getTabProgressFilter(tab)`, which
  let Bento re-add it; Firefox 157 (module `Tabbrowser.sys.mjs`) removed the
  accessor, so no re-attach is possible and the `moveBefore` move is the only
  protection. Symptoms in every window:
  the first tab gets no `onLocationChange` / `onStateChange`, the
  `WillChangeBrowserRemoteness` handler throws, and `Tabbrowser.destroy()` on
  window close throws `NS_ERROR_FAILURE [nsIWebProgress.removeProgressListener]`
  and skips later tabs' cleanup and `AsyncTabSwitcher.destroy()`.
  `unifyMainWithStrip()` and `setupPanelNavigator()` move `#tabbrowser-tabbox`
  after `Tabbrowser.init()` created the first tab, so both go through
  `moveNodeBefore()`: `Element.moveBefore` (the node must share the parent's
  composed root, must not be an ancestor of it, and the reference child must be
  a child of the parent; otherwise it throws `HierarchyRequestError` /
  `NotFoundError`), falling back to `insertBefore` if `moveBefore` is missing or
  throws. `XULFrameElement` and `MozBrowser.connectedMoveCallback` skip
  frameloader teardown on a move, so the first tab keeps its BrowsingContext and
  filter. The `insertBefore` fallback in `moveNodeBefore()` would strand the filter
  for good on 157 (the former `reattachTabProgressFilters()` safety net is
  gone), so any other move of a tab panel or `<browser>` must use `moveBefore`.
  The legacy nested-DOM subdivision renderer (`applySubdivisions`, its
  `insertBefore` / `appendChild` moves of tab panels into parent and bottom
  containers, `detachSubPanelsBeforeParentRemoval`, and the nested-panel
  promotion in `reconcilePanelsSplitView`) was inactive in the flat renderer
  (`currentSubdivisions` was only ever assigned an empty `Map`) and has been
  deleted. No code moves an individual tab panel or `<browser>` now; any new
  code that does must use `moveNodeBefore()`, or it strands filters.
  Manual check: open several windows and
  confirm, with a `browsing-context-attached` / `browsing-context-discarded`
  observer registered in the Browser Toolbox Console before opening a window,
  that the new window's first tab logs one attach, no discard, and the same
  `gBrowser.tabs[0].linkedBrowser.browsingContext.id` (no frameloader
  recreation, so no extra process switch) and that the layout is unchanged;
  navigate the first tab and confirm the tab label, urlbar, and sidebar address
  update; then close each window and confirm no `Tabbrowser.destroy` or
  `removeProgressListener` error.
- The `removeProgressListener` suppressors (the capture-phase window `error`
  filter and the `<browser>` prototype `removeProgressListener` guard in
  `bento-shell-mount.js`; the `_beginRemoveTab` wrapper that used to be a third
  went away with the Firefox 157 tab-closing change below) predate the progress
  filter fix. They may be removable once the `moveBefore` relocation and
  re-attach are verified across window close, tab close, and split-view panel
  moves. Follow-up, not part of
  the re-attach change; remove them one at a time and watch the console for the
  errors above.
- Closing the selected tab (Firefox 157). Firefox's `#beginRemoveTab` is now a
  true-private method of the `Tabbrowser.sys.mjs` module class, so Bento cannot
  wrap it. It runs `#blurTab`, which selects the successor and fires `TabSelect`
  (and the tabpanels `select` event), and only afterwards, in the same
  synchronous run, sets `tab.closing = true`. A reconcile run inside those events
  still sees the closing tab and renders it as a ghost strip panel. The
  reconcile in `bento-shell-mount.js` therefore queues one microtask per
  selection signal (`reconcile` sets a flag, `runReconcile` runs after
  `#beginRemoveTab` returns and reads the final `selectedTab`); signals for one
  change coalesce. The workspace's last-tab policy is unchanged: it lives in
  `bento-tools` (`tabs.onRemoved`), and patch `window-sync/03` keeps Firefox's
  `closeWindowWithLastTab` false (Firefox 158 added it as an explicit
  `removeTabs` option; the patch defaults it to false and still honors an explicit
  value from the caller, as `removeTab` already did). Manual check: close the selected sidebar tab,
  a multi-selection, and the last tab of a workspace; the render list passed to
  `showSplitViewPanels` after `TabClose` must not contain the closing tab and no
  ghost strip panel may appear. If a future Firefox awaits between `#blurTab`
  and `closing = true`, switch to waiting for `TabClose`; a Firefox patch is the
  last resort.
- Firefox 157 moved `tabbrowser.js` into the module `Tabbrowser.sys.mjs`: the
  window is `this.documentGlobal`, members are module-private (`#tabFilters`,
  `#beginRemoveTab`), and `insertBrowser` is public (was `_insertBrowser`).
  Patch hunks that target tabbrowser code belong in the module file
  (`window-sync/02`, `window-sync/03`, `core-ui/06`); `TabBarVisibility` lives in
  `tab-bar-visibility.js` (`core-ui/02`). `UrlbarUtils.sanitizeTextFromClipboard`
  moved to `UrlbarShared` (`chrome://browser/content/urlbar/UrlbarShared.mjs`),
  and SessionStore is imported from
  `moz-src:///browser/components/sessionstore/SessionStore.sys.mjs`.
- Firefox 158 removed the `aBrowser.docShellIsActive = aBrowser.docShellIsActive`
  self-assignment from `insertBrowser`; it existed only for the
  `MozLayerTreeReady` and `MozLayerTreeCleared` events the tab switcher listens
  for. Bento sets `docShellIsActive` on every split-view panel itself (step 7
  above), so panels still paint: on 158.0 every split-view panel reports
  `docShellIsActive` and `renderLayers` true, and `drawSnapshot` returns the page
  background of each. If a future Firefox deactivates panel docShells again,
  repeat that check first.
- `Services.scriptloader.loadSubScript` rejects `moz-extension:`, `file:` and
  `jar:` URLs in Firefox 157 unless the caller passes `allowUnsafeURL: true`
  (`loadSubScriptWithOptions(url, { target, allowUnsafeURL: true })`). No Bento
  experiment loads extension scripts that way now; a new one that does needs the
  option, or `bento-tools` fails to start ("Trying to load untrusted URI").
- Firefox 157 delivers `resize` events from in-process `about:` pages (Settings)
  to the chrome window's bubbling `resize` listener. `attachWindowResizePerfMode`
  ignores events whose `target` is not the window. Without that guard, freezing a
  Settings browser at its rounded geometry resized the page, the page fired
  `resize`, and the freeze and thaw cycle re-ran every 300 ms; `moz-select`'s
  `panel-list` hides itself on any `resize`, so Settings dropdowns closed as soon
  as they opened. Manual check: open `about:preferences`, confirm the browser
  element has no `bento-settings-about-live-resize-frozen` mutations while idle,
  click a `moz-select` such as the default search engine (it must stay open;
  Escape closes it), and resize the window (the attribute must appear and clear
  once).
- Closing a tab that has a beforeunload prompt. In Firefox 157 the prompt is a
  content dialog in the tab's own `TabDialogBox` (`getContentDialogManager()`),
  not a tab-modal dialog, so Marionette's alert commands do not see it and
  `execute_script` calls can appear to hang until it is answered. Answer it with
  `box.getContentDialogManager()._dialogs[0]._frame.contentDocument.getElementById('commonDialog')`
  and `cancelDialog()` or `acceptDialog()` (wait for `_buttons` to exist first).
  A background tab is selected while its prompt is pending, and a selected tab's
  prompt blocks every later Marionette command, so the dialog has to be answered
  from a timer armed inside the browser before the close is triggered. Accepting
  removes the tab with normal succession and no ghost panel. Behavior is
  identical on 154.0, so it is a tools-side policy, not a Firefox 157 change.
  `browser.tabs.remove` resolves whether or not the user stays, but a committed
  close has already fired `TabClose`, which drops the extension tab id, so a
  `tabs.get` that still succeeds after `remove` resolves means the tab was kept.
  Bento therefore closes transactionally in `protocol-handler.ts`: the close
  paths (`tab/close`, `tabs/close`, `tab/closeMain`, `pinnedPanel/close`, and
  sub-panel closes) capture a `CloseUndo` (workspace, folder, each panel restore
  location, width, header-hidden) before `markClosing` and the panel removal
  strip those bindings, and `removeMarkedTab` reports `kept` when the tab
  survives. `restoreKeptTab` then clears the closing marker, reassigns the
  workspace and folder, re-inserts the tab at its panel restore location,
  restores width and header state, and re-syncs markers and `panels/sync`. The
  rollback only restores into the workspace the tab's own window still shows
  (`tabs.get(tabId).windowId` against `getActiveId`): the prompt can stay open
  while that window switches away and another window takes the workspace, and
  re-inserting the panel slot then would put it in a layout the tab's window does
  not render. In that case the tab becomes a normal tab of the workspace its
  window shows and its panel marker is cleared. The restored panel is rendered
  again from the same element, so
  `resetPanelInlineLayoutState` must drop the `bento-panel--removing` fade class;
  without that the panel returns at opacity 0 and ignores pointer events. Before
  this, cancelling the prompt left every kept tab, panel or not, with no
  workspace and `bento.closingTab=1`: it vanished from the sidebar and
  `closeMarkedTabs` removed it at the next launch. DevTools closes never roll
  back, and a sub-panel closed along with its parent only gets its workspace back
  (it returns as a sidebar tab, not a panel). Restore locations are root-level, so
  a sub-panel or subdivision that does come back is a root panel at its group's
  position, not inside the group. `workspace/delete` does not use this path: its
  tabs are removed directly after their workspace is gone, so a tab kept by a
  prompt there has no workspace to return to and stays marked closing until the
  next launch.
- The reconciler must not pick a main tab from another workspace. When the
  selected tab is a panel that is still in a stale payload (a promoted panel is
  activated before its `panels/sync` arrives), `reconcilePanelsSplitView` looks for
  a replacement main tab; taking the first non-panel tab in the window selected a
  tab of another workspace that tools never follows, so the sidebar kept showing
  the old workspace over a foreign page. Replacements now come from the rendered
  workspace (`isInRenderedWorkspace`, read from the SessionStore workspace value);
  with none, the promoted panel stays selected and the dedupe renders it as the
  main slot. The path for a selected tab that cannot be materialized prefers the
  rendered workspace and falls back to any tab.
- A selection in another workspace arms the workspace-switch curtain
  (`bento-workspace-switching`, opacity 0 on the strip, nav and tabpanels) and defers
  the reconcile until tools answers with a workspace switch. If tools never
  follows (a tab selected by Firefox or an extension, or a tools failure) the
  curtain used to stay up with no watchdog, hiding the page for good.
  `armDeferredWorkspaceSwitchWatchdog` lifts it after `WORKSPACE_FADE_WATCHDOG_MS`
  and reconciles the selected tab alone (`reconcilePanelsSplitView([])`);
  `performWorkspaceSwitchFade` replaces the timer when the switch does arrive. The
  held payload must not be passed: a slow legitimate switch (parked-tab restore
  selects the destination's first tab before tools finishes) outlasts the timer,
  and the held payload is the previous workspace's, so it would draw old panels
  around a new workspace's tab. The real `panels/sync` reconciles normally when it
  lands (`scripts/mount-workspace-watchdog.test.mjs`). The watchdog is the one literal
  time in the workspace fade: `performWorkspaceSwitchFade` waits for the fade-out
  through `afterMotion` on the strip container's opacity (the Mux `state` role,
  `bento-shell-mount.css`), and holds `bento-workspace-stabilizing` for the fade-in
  or the Mux `reveal` duration, whichever is longer, read by `workspaceStabilizeMs`
  (the layout transitions are switched off while the class is set, so the `reveal`
  time comes from its token). Do not give them literals back. Do not "fix" this by activating the
  selected tab's workspace from the selection signal: selection fires for
  transient states (closing, adoption) and would fight tools.
- Tear-out with panels present. `replaceTabWithWindow` hands the new window
  `aTab.splitview ?? aTab`, `replaceTabsWithWindow` uses `contextTab.splitview ??
contextTab` (or the multi-selection), and the new window adopts its first tab
  only when `getTabToAdopt()` receives a XUL element. While the reconciler has
  tabs marked, `tab.splitview` is Bento's own-property marker (a plain object),
  so tearing out the selected tab or a panel tab failed silently: the source
  tab stayed, and the new window opened with blank tabs of its own. Confirmed
  by deleting the own property first, after which the tab moves. The mount now
  wraps both methods on the `gBrowser` instance (`hideBentoSplitViewMarkers`):
  it hides every own `splitview` marker whose `kind` is `bento-split` for the
  synchronous call, in which Firefox reads the element, and puts the markers
  back in `finally`. The adoption itself runs later on the tab elements.
  Identical on 154.0. Four tools-side effects follow a successful tear-out and
  are handled in `bento-tools`:
  - The tab keeps its tab id and, through `SessionStore`, the old
    `bento.workspaceId`, folder, and panel marker, so it was hidden in the new
    window's sidebar and the window opened an extra blank tab for its own empty
    workspace. `tabs.onAttached` runs `releaseAdoptedTab` (`tabs/AdoptedTab.ts`):
    a tab that arrives in a window which does not show its workspace leaves its
    panel layouts, loses the stale workspace and folder, and joins the
    destination's workspace (or waits for it). Bento's own cross-window moves
    (a window claiming its workspace's tabs, an import relocating tabs) go through
    `moveTabsToWindow`, which records tab id to workspace and destination window
    (`bentoTabMoves`) before the move and keeps only the tabs it reports as moved;
    `onAttached` takes the record for the window the tab arrived in first and leaves
    the tab alone. Judging
    by ownership alone misread such a move as a user drag whenever the window
    switched workspace before the attach event arrived. Dragging a tab into an
    existing window takes the user path.
  - The new window opens with the adopted tabs unassigned, so
    `handleWorkspaceActivation` assigns every unassigned tab of a window where no
    tab has a workspace (`adoptableTabs`) instead of creating a blank tab. A plain
    `OpenBrowserWindow()` had the same race and opened two tabs (its initial tab
    had no workspace yet when the first activation ran). This only runs for a
    window created after startup has settled and hydrated (`createAdoptionGate`),
    and only for tabs whose session metadata is read at that moment and found empty
    (`TabRegistry.confirmUnassigned`; a tab that `clearWorkspace` detached counts
    without a read, because SessionStore copies the old value back onto it). At
    boot `restoreFromSession` activates workspaces before SessionStore has
    restored the tabs and before `hydrateWorkspaceIds` ran, so every restored tab
    still looks unassigned at that moment; assigning the window's workspace to it
    there persisted over the real assignment. The activation handler no longer
    runs that early: it waits on `startupRestored`, which `bootReady` releases
    after the hydrate, the parked-list drop and the panel restore, and it stops if
    its window has switched workspaces by then (see "Selection at startup" in
    [workspaces.md](workspaces.md)). The gate stays as the second guard: windows
    that exist before it settles, and any window with one tab that has a stored
    value (an undone window close), adopt nothing and fall back to a new tab as
    before. The workspace's own tabs are read
    again after the session values (`settleWorkspaceTabs`) before a tab is
    created: another handler can assign the window's initial tab during that read,
    and creating from the earlier read left an extra blank tab beside it.
  - SessionStore copies the source tab's custom values onto the new tab after the
    attach event, so a panel marker can reappear on a tab that is no longer a
    panel; the activation path clears it again (`onActivated` would otherwise
    treat the tab as a restored panel).
  - Removing the last sidebar tab of a workspace by tearing it out fires no
    `tabs.onRemoved`, so `tabs.onDetached` promotes the leftmost live panel
    (`panelToPromoteAfterDetach`) the way the last-tab handler does. Without it
    the panel ended up selected as the main tab of a workspace with an empty
    sidebar.
    The extension-API entry points `windows.create({ tabId })` and cross-window
    `tabs.move` read `tab.splitview` inside Firefox and are not covered by the
    wrapper; Bento calls neither on a marked tab (workspace activation moves
    unmarked stray tabs, and a closing window adopts its tabs with `gBrowser.adoptTab`
    after tearing the split view down; see the next item).
- Window close with live tabs. Closing a window destroyed every tab it hosted, so
  the tabs of a workspace that a second window had claimed, and the hidden tabs of
  other workspaces, lost their page state and were recreated from URLs later (see
  the pitfall in [workspaces.md](workspaces.md)). `attachWindowCloseHandover` in the
  mount script adds two listeners once the window has loaded, and
  `handOverTabsBeforeClose` picks the first other window that can take tabs
  (`findHandoverSurvivor`) and, in the same task, tears the split view down
  (`reconcilePanelsSplitView([])`; `handingOverTabs` then makes the reconciler return
  at once, or a TabSelect or `panels/sync` would mark the tabs again) and calls
  `survivor.gBrowser.adoptTab(tab, { tabIndex, selectTab: false })` for each tab worth
  keeping, in the tabs' own order: pinned tabs at `pinnedTabCount` (adoptTab pins only
  when the index is inside or right after the pinned region), the rest at the end of
  the destination. Before the first call it adds one selected `about:blank` tab to the
  closing window (`addTrustedTab` with `inBackground: false`; `addTab` returns null when
  it cannot make a tab, so a missing or disconnected blank tab hands nothing over), so
  no adoption is that window's last tab and the selected tab is never one that leaves.
  Tabs that `swapBrowsersAndCloseOther` would refuse are left out beforehand (empty,
  closing and non-remote tabs, a survivor in another Fission mode), so they keep their
  identity and values and are parked with the window. After a successful adoption the
  mount appends a hop to the `bento.handover` value on the returned tab (pruning old
  ones), and for a pending tab first puts back the custom tab values the swap dropped.
  An `adoptTab` that still returns null or throws is logged with `console.error`
  (title and address) and not rebuilt; see [workspaces.md](workspaces.md) for what that
  leaves.
  - `close` is dispatched by `AppWindow::RequestWindowClose` for the OS close button.
    The `window.onclose` handler `WindowIsClosing` (browser-main.js) is assigned while
    the window is parsed and a handler property keeps its place in the listener
    order, so a listener added at `load` runs after it: the closing-tabs warning and
    the beforeunload prompts have been answered, and a cancelled close arrives with
    `defaultPrevented`. When the event is not cancelled `Destroy()` follows
    synchronously.
  - `DOMWindowClose` is dispatched by `nsGlobalWindowOuter::CloseOuter` after
    `CanClose` (the same prompts) for `window.close()`, `windows.remove` and
    Cmd+Shift+W, and by `ForceClose` on a quit. Once it is not prevented, `FinalClose`
    sets `mIsClosed` and the window goes; nothing else listens to it on the window.
    It is registered in the capture phase to see a tab's close first (next item).
  - A tab's own `window.close()` also reaches the window: `BrowserElementParent`
    re-dispatches it on the browser element as a bubbling, non-cancelable
    `DOMWindowClose`, the tabbrowser closes the tab and `preventDefault`s, and when
    that tab is the window's only one it calls `window.close()` from inside the event,
    which arrives here with `target === window`. The handler acts only on events
    targeted at the window, and a second capture listener (`notePageClose`) records
    the tab of any other target (`getTabForBrowser`; `pageClosedTab`, cleared in the
    next task), so the page that asked to go is not adopted while the window's other
    tabs still are.
  - With the blank tab no adoption is the window's last, so `swapBrowsersAndCloseOther`
    never calls `window.close()` from inside `adoptTab` (which re-entered the handler
    and skipped `TabClose`, and with it the DevTools toolbox transfer). `handingOverTabs`
    stays set so a second close request finds nothing to do, also after a refused tab
    that is still in the window.
  - Close prompts: a close request repeated while a beforeunload prompt is up reaches
    the handler with that tab's check still running (`permitUnload` threw, the close
    went on). `isCheckingUnload` asks each connected browser with `getInPermitUnload`;
    the closing window hands nothing over, and a survivor in that state or with
    `gDialogBox.isOpen` (the closing-tabs warning) is not chosen.
  - A quit: `nsAppStartup::Quit` sets `attemptingQuit` before it force-closes the
    windows; `Services.startup.shuttingDown` only turns true after `CloseAllWindows`.
    The handler returns while `attemptingQuit` is true.
  - There is no hold, timer or message to bento-tools: the move is finished when the
    listener returns. The first design held the close and waited for tools; see
    [workspaces.md](workspaces.md) for why it was dropped.
  - `scripts/mount-window-handover.test.mjs` runs the real handler against stubbed
    windows and SessionStore.
- `prefs/bento.js` sets `browser.nova.enabled` and `sidebar.revamp` to false.
  Firefox 157 defaults both to true; Bento keeps the 154 chrome because its shell
  owns the sidebar and tab strip. No upgrade migration
  writes a user value for either pref, so plain defaults hold; use `lockPref`
  only if a future migration does. `browser.search.separatePrivateDefault` is
  now `browser.search.separatePrivateDefault.enabled`.
- Do not register nested sub-panels directly in `splitViewPanels`. Firefox
  assumes split-view panels are direct children of `tabpanels`.
- Do not put inter-panel splitter elements directly in `tabpanels`. XUL deck
  hit-testing ignores non-panel siblings. Splitters live in
  `#bento-side-panel-host` and are positioned over the panel boundaries.
- Keep the splitter ResizeObserver's membership stable. `syncInterPanelSplitters`
  is also the `__bentoSplitterRO` callback, so a sync that calls
  `disconnect()` and re-`observe()`s the panels starts new observations at
  last-reported size (-1, -1), so each one always delivers an initial
  notification and the callback re-runs the sync every frame, even at idle,
  whenever a splitter exists (found by reading the code and Gecko's
  `ResizeObserver.cpp`, not from a runtime trace). `setObservedSplitterPanels` diffs the desired panel elements (panel
  ids plus DevTools caller panels) against `__bentoSplitterObserved`,
  `unobserve`s the ones that left (including detached ones, so the Set does not
  leak) and `observe`s only the new ones. Never `disconnect()` or re-observe the
  full set from inside the sync.
- The add-panel trailer must be a XUL `vbox` with
  `.split-view-panel-active`, with the React trailer inside a chrome
  `<browser>`. HTML children in `tabpanels` do not reliably paint or receive
  hit testing.
- Keep materialization retries. Session restore can briefly expose pending tabs
  with no `linkedPanel` or no loaded browser.
- Keep the `reload()` in `materializePanelTab` for a tab it had to materialize. A
  pinned panel tab is unloaded with the other pending pinned tabs once its
  history restore is done (`attachRestoredPinnedTabUnload`), unless the window
  already renders it as a panel, so the reconciler can find it with no
  `linkedPanel`, `insertBrowser` creates its browser, and the reload loads it. A pending tab that
  still has its real browser already reports its saved address, so the
  `about:blank` test beside that reload does not fire for it: the `SSTabRestoring`
  handler loads such a rendered panel (`shouldLoadRestoredPinnedPanel`), so keep
  `materializePanelTab` unchanged and that handler in place (derived from the
  source, not run). See "Pinned tabs restore on demand after a restart" in
  [workspaces.md](workspaces.md).
- Keep cleanup broad when tearing down to main-only mode. Stale split-view
  classes, inline sizing, and data attributes can make the next main tab render
  at fractional width.
- The main-only "already torn down" fast path must first scan for stale Bento
  artifacts: `bento-flat-panel-layout`, the flat layout extent, overlay
  splitters/choosers, Bento data attributes, split-view classes, `column`, panel
  headers, loading overlays, and inline rect styles (`left`, `width`,
  `max-width`, `height`, `flex`, `display`, `position`, `visibility`, etc.). If
  any remain, run the full teardown.
  Otherwise a newly-created or newly-activated empty workspace can show its main
  tab at an old panel width with blank space beside it.
- When the final regular tab closes while panels remain, the promoted panel tab
  is immediately torn down into main-only mode. Regression symptom: the sidebar
  correctly shows the promoted panel as the sole workspace tab, but the content
  area is blank until switching away from the workspace and back. Cause: the
  promoted tab's notificationbox can retain flat-panel inline state
  (`display`, `position`, `visibility`, `opacity`, `pointer-events`, etc.) and
  browser paint flags (`blank` / `pendingpaint`) from its previous side-panel
  role. Fix: strip inline panel state before restoring
  `tabpanels.selectedPanel`, then force a selected-main browser repaint and
  clear `blank`/`pendingpaint`. The workspace-switch workaround appeared to
  fix the bug only because it ran a later full reconcile.
- DOM fullscreen depends on Bento yielding the chrome it adds around Firefox's
  browser deck. Firefox's stock fullscreen stylesheet hides `#navigator-toolbox`
  and native sidebar elements, but not `#bento-shell-host`,
  `#bento-shell-splitter`, `#bento-panel-nav`, `#bento-strip-scrollbar`,
  chrome-injected panel headers/loading overlays, the add-panel trailer, or
  flat-layout overlay splitters. Keep the
  `:root[inDOMFullscreen]` rules in `bento-shell-mount.css` so the selected
  deck panel overrides stale flat-layout inline rects, loses rounded corners and
  shadows, suppresses Bento focus-ring pseudo-elements and loading overlays,
  hides non-selected panel slots, removes strip padding, clears the outer strip
  host radius, and lets video fullscreen cover the whole browser window.
  Panel-origin fullscreen needs one additional bridge: Firefox's
  `FullScreen.enterDomFullscreen` normally aborts when the requester is not
  `gBrowser.selectedBrowser`, so
  `patches/core-ui/11-dom-fullscreen-splitview-browser.patch` changes that
  check to use `gBrowser.selectedBrowsers`, which already includes active
  split-view browsers and calls `window.BentoShellDomFullscreen` with the exact
  requesting browser before Firefox sets `inDOMFullscreen`. Bento records that
  slot using `data-bento-dom-fullscreen-requester` plus the root
  `bento-dom-fullscreen-panel` attribute; fullscreen CSS expands that marked
  slot and hides every other split-view slot. The `MozDOMFullscreen:Entered`
  listener remains only as a fallback.
  Regression history: the first pass hid Bento chrome but left the browser UI
  around the video; the second pass left the main-slot focus pseudo-element
  visible at the video edge; the third pass still allowed the rounded outer
  strip host to clip the fullscreen browser; the fourth pass allowed panel
  requests but still needed requester-specific CSS so a side panel, not the
  deck-selected main slot, owns fullscreen; the fifth pass hid Bento's
  per-panel loading overlay so its neutral background and spinner cannot cover
  a fullscreen panel video; the sixth pass reset Firefox's stock
  `-moz-subtree-hidden-only-visually: 1` rule for the marked requester because
  side-panel requesters are not normally `.deck-selected`. Preserve all parts of
  the fix: hide Bento chrome/controls/overlays, accept visible split-view
  browsers as fullscreen requesters, mark the requesting panel slot from the
  exact `aBrowser`, keep that marked slot visually unhidden, suppress focus-ring
  pseudo-elements, and clear every panel/browser wrapper radius while
  `inDOMFullscreen` is active.

## Main frame origin

The hairline around a main or panel frame is drawn by the frame's `::after` overlay, above
the remote page. Source of truth: `--bento-panel-frame-outline-shadow` and the overlay
rules in `src/browser/base/content/bento-shell-mount.css` (the split-mode
`#tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel|data-bento-panel-tab-id]::after`
rule, and the no-panels `#bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel]::after`
rule). Chrome bridge: none. Persistence: none. Pitfalls:

- Cause. The stroke used to be a `box-shadow` ring on the frame element and the remote page
  is clipped by a rounded `overflow` clip inside it. Gecko snaps the two with different
  rules, so at some device-pixel phases of the frame origin the page overpaints the ring at
  the arcs (the straight edges are not affected): a jagged corner with the stroke missing on
  the arc. The phase depends on the display scale, the axis, the sidebar width (a dragged,
  fractional sidebar width moves every frame origin) and the strip scroll offset.
- Fix: the hairline sits on the overlay that already carries the focus ring (`inset: 0`,
  transparent border, `z-index: 10`, the panel radius), as
  `box-shadow: var(--bento-panel-frame-outline-shadow)`, outside the frame edge exactly where
  the frame's own ring was. It paints above the page, so the page clip's snapping cannot cover it. The
  frame keeps only the elevation shadow: `--bento-panel-frame-shadow` is `var(--shadow-l)`, and
  `none` under `bento-panel-shadows-disabled`, which still shows the outline because the
  overlay always draws it. With no panels the frame is `.browserSidebarContainer` inside the
  main tabbox, and the tabbox (same box and radius, its margins are the gutter) carries the
  overlay; in panel mode the tabbox is the whole strip, so its overlay stays unstroked and
  each slot's own overlay carries the hairline. The fullscreen rules already remove the
  overlay (`content: none`) and the frame shadow, so fullscreen stays square with no stroke.
  The subdivision chooser has no page, so it keeps the hairline on its own box-shadow, as
  `<outline>, <frame shadow>`. `<outline>, none` is an invalid list that drops the whole
  declaration (and the hairline), so under `bento-panel-shadows-disabled` a second rule sets
  the outline alone; `check-chrome-resize-guard.mjs` asserts it.
- The elevation shadow spills about 40 px left of the frame into the sidebar's area, and
  the frame, its shadow and the hairline overlay all sit inside `#bento-strip-container`'s
  stacking context. During a sidebar push the host is `z-index: 5`, so the strip is raised
  to `z-index: 6` for the slide or the host would cover the shadow (issue #85); see
  [Sidebar collapse and expand](workspaces.md#sidebar-collapse-and-expand).
- Kept as cheap alignment, not as the fix: the no-panels frame margins are
  rounded to whole pixels (`round(<space token>, 1px)`) and the collapsed rail is a whole number of pixels wide
  (`--bento-rail-width: round(var(--bento-tab-strip-width-collapsed), 1px)`, measured by the
  same expression in `sidebarRailWidth()`). The generated `--bento-tab-strip-width-collapsed`
  token (51.8px) is unchanged: it comes from the token generator and is asserted by
  `theme-sheets.test.mjs`.
- Snapping alone was not enough. With the margins, the rail rounding and a `scrollend`
  handler that settled the strip on a whole `scrollLeft`, a user-resized expanded sidebar
  still left the defect visible in the main panel plus one side panel at 2x: with the
  sidebar at 280.4px the main panel's ring loss per corner (top-left, top-right, bottom-left,
  bottom-right) was 25.6, 4.1, 25.6, 11.2 (10.2, 10.3, 10.2, 12.7 at 300px and at 280px).
  The `scrollend` handler is gone: with the overlay a strip at rest on a fractional offset
  draws a complete ring.
- Measured at 2x, light, radius 12, main panel plus one side panel (ring loss per corner,
  magenta on the outline token only, frame elevation shadow off): 2.3 each at sidebar
  widths 300, 280.4 and 280, 2.3 with panel shadows disabled, 0.2 in dark at 280.4. Three
  frames with `scrollLeft` left at 0.4 (no snap): 2.3; at 654.75 the side panel, at x=284.65,
  measures 0.0. With no panels: 8.1 each at 300 and 280.4 (7.7 before at 300), 0.0 in dark.
  The no-panels residual is the same on all four corners and both widths and the ring is
  unbroken in the screenshot, so it is a difference in the ring's antialiased edge pixels
  between the page-hidden and page-visible shots, not page overpaint. The metric cannot
  tell the ring is on top: it only compares the ring with and without the page.
- Not kept: shifting panel origins to whole pixels, a fractional y that tracks the
  device-pixel phase, and a scroll-aware quarter-pixel target. The loss depends on the
  device-pixel phase and the axis, exactly whole y is a knife edge, and the origin has too
  many inputs (sidebar width, rail, scroll, window size) to pin.
- Manual verification, Browser Toolbox Console on a window with `layout.css.devPixelsPerPx`
  at `2.0`: set `document.getElementById('bento-shell-host').style.width = '280.4px'`, then
  read `getComputedStyle(frame, '::after').boxShadow` for a panel slot
  (`gBrowser.tabpanels.querySelector(':scope > [data-bento-main-panel]')`) and, with no
  panels, for `#bento-side-panel-host > [data-bento-main-panel]`; both are the hairline, and
  the frame's own `boxShadow` has no 1px ring. To measure the ring, set
  `--bento-panel-frame-outline-shadow` to `0 0 0 1px #ff00ff` and `--bento-panel-frame-shadow`
  to `none` on the root, screenshot the window with `.browserContainer` visible and then
  hidden, and compare the ring pixels at the four corners.
  `scripts/check-chrome-resize-guard.mjs` checks the overlay hairline, the frame shadow
  tokens, the rounded no-panels margins and the rail expression.
