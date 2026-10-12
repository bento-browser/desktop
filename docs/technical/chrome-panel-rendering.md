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
  (`157.0.1`), not Bento's app version. The tests build fixtures whose members are
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
  `closeWindowWithLastTab` false. Manual check: close the selected sidebar tab,
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
- `Services.scriptloader.loadSubScript` rejects `moz-extension:`, `file:` and
  `jar:` URLs in Firefox 157 unless the caller passes `allowUnsafeURL: true`.
  The `bento-native-preferences` experiment loads two extension scripts, so it
  uses `loadSubScriptWithOptions(url, { target, allowUnsafeURL: true })`; without
  it `bento-tools` fails to start ("Trying to load untrusted URI").
- Firefox 157 delivers `resize` events from in-process `about:` pages (Settings)
  to the chrome window's bubbling `resize` listener. `attachWindowResizePerfMode`
  ignores events whose `target` is not the window. Without that guard, freezing a
  Settings browser at its rounded geometry resized the page, the page fired
  `resize`, and the freeze and thaw cycle re-ran every 300 ms; `moz-select`'s
  `panel-list` hides itself on any `resize`, so Settings dropdowns closed as soon
  as they opened. Manual check: open `about:preferences#bento`, confirm the
  browser element has no `bento-settings-about-live-resize-frozen` mutations
  while idle, click a `moz-select` (it must stay open; Escape closes it), and
  resize the window (the attribute must appear and clear once).
- Closing a tab that has a beforeunload prompt. In Firefox 157 the prompt is a
  content dialog in the tab's own `TabDialogBox` (`getContentDialogManager()`),
  not a tab-modal dialog, so Marionette's alert commands do not see it and
  `execute_script` calls can appear to hang until it is answered. Answer it with
  `box.getContentDialogManager()._dialogs[0]._frame.contentDocument.getElementById('commonDialog')`
  and `cancelDialog()` or `acceptDialog()`. Bento's `closeTabFromSidebar` removes
  the panel binding and marks the tab closing before it calls `tabs.remove`, so
  cancelling the prompt on a panel tab keeps the tab but not the panel (the panel
  strip is already emptied of it); cancelling on a selected or background tab keeps
  both. A background tab is selected while its prompt is pending. Accepting
  removes the tab with normal succession and no ghost panel. Behavior is
  identical on 154.0, so it is a tools-side policy, not a Firefox 157 change.
- Tear-out with panels present. `replaceTabWithWindow` passes `aTab.splitview ??
  aTab` to the new window, and while a workspace has panels Bento gives the
  rendered tabs a `tab.splitview` marker (see "Required split-view compatibility
  shims"); that is the likely cause (inferred, not traced) of this: tearing out the
  selected tab or a panel tab opens an unsynced window with two new tabs and leaves
  the source tab in place. Tearing out a background tab, or any tab while the workspace has no panels,
  moves the tab (same BrowsingContext, content, and container) into an unsynced
  window that also carries one extra new tab; a window's only tab is not torn out
  (`replaceTabWithWindow` returns null). Identical on 154.0.
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
- The add-panel trailer must be a XUL `vbox` with
  `.split-view-panel-active`, with the React trailer inside a chrome
  `<browser>`. HTML children in `tabpanels` do not reliably paint or receive
  hit testing.
- Keep materialization retries. Session restore can briefly expose pending tabs
  with no `linkedPanel` or no loaded browser.
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
