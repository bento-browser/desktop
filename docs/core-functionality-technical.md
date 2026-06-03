# Bento Browser core functionality technical notes

This document is the technical companion to
[core-functionality.md](core-functionality.md). It records how Bento's working
workspace, panel, layout, traversal, and theme behavior is achieved today, and
the implementation pitfalls that have already caused regressions.

Keep this document factual. If a future implementation changes the behavior,
update this file in the same change.

## Architecture summary

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
  overlays.

The state contract is declared in `extensions/_shared/protocol.ts`. UI code
dispatches `Action` messages through `extensions/bento-shell/src/bridge/useToolsPort.ts`.
`bento-tools` mutates stores and broadcasts `Event` payloads back. Shell Zustand
stores are mirrors only.

## Workspace implementation

Workspace metadata lives in `extensions/bento-tools/src/workspaces/WorkspaceStore.ts`.
Each workspace has an `id`, `name`, optional `themeId`, optional `icon`, and
`createdAt` timestamp.

The store tracks two active-workspace concepts:

- `#lastGlobalActiveId`: persisted fallback for legacy or not-yet-window-scoped
  callers.
- `#activeIdByWindow`: per-window active workspace map, persisted via
  `browser.sessions.setWindowValue`.

`workspace/activate` is scoped to the requesting window when the shell dispatch
has a `__windowId`. Bento currently enforces one workspace per window. If
another window already owns a workspace, activation returns `conflict` and the
handler focuses the owning window instead of rendering the same workspace in two
windows.

Shell-side workspace state is mirrored in
`extensions/bento-shell/src/state/workspaces.ts`. Use
`selectActiveIdForWindow` or `useActiveWorkspaceIdForWindow`; do not assume the
global fallback is the active workspace for every window.

Sidebar tab multi-selection lives in
`extensions/bento-shell/src/components/TabList/TabList.tsx`. Selection is UI
state scoped to the active rendered workspace: Cmd/Ctrl-click toggles a row,
Shift-click selects a contiguous range, plain click activates the tab and clears
selection, and workspace switches clear selection. `TabRow` only receives a
`selected` visual prop; tab assignment remains tools-owned.
The active/current sidebar tab row is styled in
`extensions/bento-shell/src/components/TabRow/TabRow.css` with Tale UI
`--color-60` and `--color-60-fg`, not neutral surface tokens, so the browser
current tab remains visually distinct from hover and multi-selection states.
The foreground override for active-row text and icons must stay unlayered
because Tale UI text, button, and icon utility styles are also unlayered; keeping
the override only inside `@layer bento.components` lets neutral utility colors
win.

The sidebar context menu is still rendered by chrome through
`BENTO_SIDEBAR_CONTEXT_MENU` in
`src/browser/base/content/bento-shell-mount.js`. When a selected row is
right-clicked, the shell payload includes `tabIds`; chrome dispatches
`tabs/moveToNewWorkspace` for the "Move selected tabs to new workspace" item or
`tabs/assignWorkspace` for batch moves to an existing workspace.

Batch tab assignment is handled in
`extensions/bento-tools/src/messaging/protocol-handler.ts`. Tools creates the
new workspace through inactive `WorkspaceStore.create`, assigns each selected
tab through `TabRegistry.assignWorkspace`, activates the new workspace, removes
stale pinned-panel bindings, and runs the same empty-source-workspace cleanup
used by single-tab moves after the batch finishes. Creating the workspace
inactive prevents the activation orchestrator from seeing an empty workspace and
opening an unwanted blank tab before the moved tabs arrive.

### Workspace pitfalls

- Do not render the same workspace in two windows unless the panel architecture
  has been changed to support that. The current chrome reconciler resolves panel
  tabs against a single window's `gBrowser`.
- Do not bypass `workspace/activate`. Per-window active state, conflict policy,
  and SessionStore persistence live in `WorkspaceStore`.
- Do not mutate `useWorkspacesStore` directly from React components. Dispatch a
  protocol action and let tools broadcast deltas.
- Do not persist sidebar selection in tools or shell stores. It is transient UI
  state for the currently rendered tab list, and hidden workspace selections
  would make batch context-menu actions unsafe.

## Panel state and layout model

Panel state lives in `extensions/bento-tools/src/panels/PanelStore.ts`.
The data model is a workspace-scoped layout tree implemented in
`extensions/bento-tools/src/panels/PanelLayout.ts`.

The runtime layout supports:

- root panels: `{ kind: 'panel', tabId }`;
- vertical groups: top panel plus bottom node;
- horizontal groups inside the bottom slot;
- chooser nodes used while a subdivision is waiting for content;
- group ratios clamped to `0.2..0.8`.

Top-level panel order is the `layout.root` order. Reorder operations use stable
root node ids:

- plain panel roots use `panel:<tabId>`;
- grouped roots use the group id.

Panel persistence is versioned in `extensions/bento-tools/src/panels/Persistence.ts`.
Current persistence is version 5. It stores URL-backed `panelKey` entries plus
the layout tree. Panel keys are derived from visible layout order when writing
so URLs can be restored to fresh tab ids on next launch.

Backup export/import uses schema v2 in
`extensions/bento-tools/src/backup/BackupStore.ts`,
`ImportExecutor.ts`, and `ExportSchema.ts`. A workspace export must include the
same panel state that `PanelStore` persists for restart:

- `panels[]` with durable `panelKey`, URL, and root panel `widthPx`;
- `panelLayout` with panel keys instead of tab ids, preserving root order,
  vertical groups, horizontal split groups, chooser nodes, and clamped ratios;
- `mainWidthPx` for the workspace-scoped main content slot width;
- `stripScrollLeft` for the workspace-scoped panel-strip scroll position;
- pinned panel references by `panelKey` with URL fallback.

Import creates fresh tabs, maps exported panel keys to the new tab ids, restores
the persisted layout tree through `PanelStore.restorePersistedLayout`, and then
applies main width, strip scroll, panel widths, and pinned-panel bindings to the
new workspace. Do not export or import runtime tab ids; they are not durable
across profiles or sessions. Do not treat `panelLayout` alone as the complete
layout snapshot; workspace-level main width and strip scroll are separate
`PanelStore` state and must travel with the backup payload.

Panel session markers live in `extensions/bento-tools/src/panels/SessionMarker.ts`.
They use `browser.sessions.setTabValue` with workspace id and restore location
so a closed panel can be restored by Firefox's closed-tab flow and then
reinserted into Bento's layout.

### Panel actions

Core panel actions are handled in
`extensions/bento-tools/src/messaging/protocol-handler.ts`:

- `panel/add`: promotes an existing tab into the active workspace's panel
  layout, applies default panel width, syncs markers, and emits `panels/sync`.
- `panel/openAt`: creates a background tab and inserts it as a panel. With
  `position` set to `'end'`, it appends from the panel trailer; default or
  `'after'` inserts relative to a source panel or the main slot.
- `panel/remove`: removes the panel binding and closes descendant sub-panels
  when needed.
- `panels/clear`: removes all panels in the active workspace.
- `panelLayout/reorderRoot`: reorders top-level root nodes.
- `panelLayout/movePanel`: moves one visible panel leaf to a root slot, an
  eligible one-panel subdivision row, or an unconfigured subdivision chooser.
- `panelLayout/subdivide`, `fillChooser`, `breakOut`, `removeVerticalGroup`,
  and `setGroupRatio`: mutate the layout tree.
- `panel/setWidth`, `panel/setMainWidth`, and `panel/setStripScroll`: persist
  chrome-measured layout state without broadcasting an immediate
  `panels/sync`.

`emitPanelsSync` in `extensions/bento-tools/src/background.ts` resolves live tab
ids to `{ tabId, url, favIconUrl, widthPx }`, includes `layout`,
`panelStatusByTabId`, workspace-scoped main width, strip scroll, pinned tab
ids, saved-panel count, and optional `scrollToPanelTabId`, then broadcasts
`panels/sync`.

### Panel state pitfalls

- Do not write shell stores as the source of truth. `PanelStore` owns layout and
  persistence.
- Do not emit `panels/sync` after every width write. Chrome already applied the
  live width inline; a sync round-trip can clobber an in-flight drag with stale
  persisted values.
- Do not use tab ids as durable storage identifiers. Persist URLs plus
  `panelKey`; tab ids are runtime-only.
- Keep panel markers synced after add, remove, reorder, and restore. Closed-tab
  restore depends on marker root indexes and containing root ids.
- Do not clear a panel's `bento.isPanel` marker in the `tab/close` path. Firefox
  needs that tab session value to survive into the closed-tab entry so
  `Cmd+Shift+T` can route the restored tab through
  `maybeRestorePanelFromMarker`. Clear the marker only when the tab stays open
  as a normal tab, such as `panel/remove` or explicit panel promotion.
- A user-restored panel tab can also carry Bento's `bento.closingTab` marker
  from the original close path. Clear that closing marker before assignment or
  panel insertion. Otherwise the created-tab workspace backfill guard treats the
  restored tab as still closing and removes it again before panel restore wins.
  `TabRegistry.unmarkClosing` must also suppress stale async hydration reads
  that may have observed the old marker before it was removed.
- Firefox activates the restored tab during `Cmd+Shift+T`. After restoring a
  marked panel, switch selection back to the captured prior non-panel tab, or to
  another non-panel tab in the same workspace/window if the captured value is
  missing. Chrome reconciliation must also reject any selected tab that is
  present in the Bento panel payload as the main slot. Otherwise the restored
  panel can be painted as both selected content and side-panel content, causing
  overlap behind adjacent panels.
- Restored panels often have no `widthPx` because `PanelStore.remove` drops
  width state when the tab leaves all panel layouts. When
  `maybeRestorePanelFromMarker` reinserts the tab, stamp
  `settings.snapshot().defaultPanelWidthPx` through `PanelStore.setWidth` before
  emitting `panels/sync`; `Cmd+Shift+T` restore should use the configured
  default new-panel width, not a stale browser/container width. In flat layout,
  do not clear inline width after the panel-enter animation. Absolute rects
  depend on inline `width`, `min-width`, and `flex`; clearing width lets the
  restored panel auto-size and overlap adjacent panels until a splitter drag
  rewrites sizing.
- Root-panel enter animation must start after chrome computes flat-layout
  geometry and calls `applyPanelLayoutRects`. Starting the animation while the
  restored panel still has Firefox's stale split-view dimensions lets
  `animatePanelEnter` measure the wrong final width and write that stale width
  back on the next animation frame, making the restored panel overlap until a
  splitter drag refreshes layout.
- Chrome's layout sanitizer must treat the `panels` payload as the authoritative
  visible panel set. If a `panels/sync` payload includes a tab id that is absent
  from the decoded layout tree, append it as a root before computing flat-layout
  geometry. Otherwise the panel is resolved and rendered, but receives no
  `panelRects` entry and overlaps until the next live layout refresh.
- When removing a parent panel with descendants, close or remove descendant
  sub-panel tabs intentionally. Do not leave orphaned tabs in the panel layout.
- `panelLayout/breakOut` promotes an existing child into the root layout and
  must not emit `scrollToPanelTabId`. Break-out is a layout normalization action,
  not a new-panel reveal; emitting an explicit scroll target left-aligns the
  promoted panel and loses the user's current strip context.
- Closing the active final regular tab while panels remain must route through
  `closeMainTabWithPanelPromotion`, even when the initiating action is the
  generic sidebar/command-palette `tab/close`. Promoting only from
  `browser.tabs.onRemoved` is too late: Firefox can briefly select a still-panel
  tab as the fallback, chrome reconciles against stale panel payload, and the
  workspace can stay blank until a workspace switch forces a fresh render.
  Promote the leftmost panel out of `PanelStore`, clear its panel marker,
  activate it as the non-panel main tab, emit `panels/sync`, then remove the old
  main tab with the delayed close path.

## Shell to chrome bridge

Chrome-bound state travels through title IPC because WebExtension UI documents
cannot directly mutate Firefox chrome.

The main channel is `BENTO_PANELS:<ts>:<base64-json>`, written by
`useToolsPort.ts` when a `panels/sync` event matches the shell document's active
workspace for its window. The payload carries:

- workspace id and optional window id;
- panel array;
- layout tree and layout status map;
- workspace theme id;
- UI color mode;
- sidebar collapsed state;
- custom panel sizes;
- panel cycle wraparound setting;
- panel shadow setting;
- persisted strip scroll;
- pinned panel tab ids for the active workspace;
- saved panel count;
- optional panel id to scroll into view.

Other title channels still exist for one-off chrome actions, such as opening
overlays, focusing a pinned panel, moving tabs, and scrolling back to main.

### Title IPC pitfalls

- `document.title` is last-write-wins. Do not reintroduce separate title writes
  for chrome-bound settings that can ride inside `BENTO_PANELS`.
- `uiColorMode` intentionally rides inside `BENTO_PANELS`; separate
  `BENTO_COLOR_MODE` writes previously raced panel sync at boot.
- Only the sidebar entry should push workspace theme changes to chrome. Other
  shell entries share `document.title` for their own sentinels and can stomp the
  theme signal.
- The shell forwards `panels/sync` to chrome only for the active workspace in
  that window. Tools may broadcast panel state for every workspace so shell
  mirrors can filter tab lists during workspace transitions.

### Chrome overlay transparency

Chrome-mounted menu overlays such as the workspace switcher cover the whole
browser window so their popovers can escape the sidebar iframe. The host and the
overlay document must both stay transparent; the popover itself is the only
opaque surface.

Load-bearing details:

- `ensureOverlayHost` creates JS-owned overlay hosts with transparent XUL
  `vbox` and `<browser>` backgrounds. Static or theme-owned overlay hosts must
  also be listed as transparent in `bento-chrome-theme.css`.
- Chrome overlay HTML entries, including `workspace-switcher.html`,
  `palette.html`, `edit-workspace.html`, `confirm.html`, `welcome.html`, and
  `panel-trailer.html`, must force `html`, `body`, and `#root` to
  `background: transparent !important`. The shell build uses
  `cssCodeSplit: false`, so unrelated entry CSS such as `panel-newtab.css` can
  arrive later in the shared `style.css` bundle and otherwise override plain
  transparent background declarations.
- Do not add an app-wide surface to menu overlay roots. If an overlay needs a
  scrim, it should be drawn by that overlay's dialog/backdrop component, not by
  the page or chrome host background.

## Chrome panel rendering

The working panel renderer is `reconcilePanelsSplitView` in
`src/browser/base/content/bento-shell-mount.js`.

Bento does not move a tab's `linkedBrowser` into a custom host. Earlier
docShell-swap and browser-reparent approaches broke WebExtensions and browser
identity. The current renderer drives Firefox 150's native split-view machinery:

1. Resolve `panels/sync` tab ids to real `gBrowser` tab elements with
   `ExtensionParent`'s tab tracker.
2. Materialize pending/lazy restored tabs with `gBrowser._insertBrowser(tab)`
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

### Required split-view compatibility shims

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
- `.split-view-panel-active` must be removed from departing panels. Firefox's
  `removeTabsFromSplitview` removes `.split-view-panel` but can leave the active
  class behind, producing ghost overlays.
- `gBrowser.warmupTab(tab)` must run for active split tabs. Without an
  `AsyncTabSwitcher`, Firefox's visibility fallback can deactivate panel
  docShells.
- `gBrowser.on_visibilitychange` is overridden to no-op while split-view mode is
  active. This prevents minimized/restored windows and DevTools focus changes
  from blanking panels.
- Firefox's split-view auto-select listeners are removed from panel containers.
  Otherwise clicking a side panel sets it as `gBrowser.selectedTab`, which
  promotes the side panel into the main slot and reorders the strip.

### Chrome rendering pitfalls

- Do not call `gBrowser.hideTab(tab)` for active panel tabs. Smoke testing showed
  hidden tabs render as black or blank split-view slots.
- Do not move or swap a tab's `linkedBrowser`. Extension content scripts depend
  on stable tab/browser identity.
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
  `max-width`, `height`, `flex`, etc.). If any remain, run the full teardown.
  Otherwise a newly-created or newly-activated empty workspace can show its main
  tab at an old panel width with blank space beside it.

## Flat panel layout and subdivisions

The tools-side layout is a tree, but the current chrome renderer keeps all live
panel browser containers as direct `tabpanels` children. Chrome computes a flat
geometry for the tree in `computePanelLayoutGeometry`, then applies absolute
rects with `applyPanelLayoutRects` and `syncFlatLayoutOverlays`.

This avoids reparenting live browsers into nested subdivision containers. Nested
browser moves can detach browsing contexts and break Firefox progress listener
assumptions.

Flat layout overlays include:

- vertical and horizontal splitters for group ratios;
- chooser overlays for empty subdivisions;
- an extent element to maintain horizontal scroll width;
- rect assignment for main, root panels, sub-panels, split children, and the
  add-panel trailer.

### Verified flat layout fixes

Top-level panel resizing:

- Source of truth: `PanelStore` persists side-panel widths through
  `panel/setWidth`; the main slot width persists per workspace through
  `panel/setMainWidth`.
- Chrome bridge: `bento-shell-mount.js` dispatches the width action only after
  drag end. The live drag must not wait for a `panels/sync` echo.
- Main width scope: `panel/setMainWidth` resolves the active workspace for the
  dispatching window and stores the width in `mainWidthByWorkspace`. A
  `panels/sync` payload without `mainWidthPx` is authoritative for that
  workspace and chrome must clear `mainPanelWidth` to return to default flex
  sizing. Do not use a global or profile-wide fallback for new workspaces.
- Renderer path: flat layout uses absolute rects from
  `computePanelLayoutGeometry`. During pointer movement,
  `refreshFlatPanelLayoutFromLiveState` recomputes geometry with the live width
  override, reapplies panel rects, resyncs root splitters, and updates the strip
  scrollbar.
- Window resize path: `attachResizeRepaintPoke` must call
  `refreshFlatPanelLayoutFromLiveState`, not only `syncInterPanelSplitters`.
  Flat layout writes absolute inline heights to each panel; if the browser
  window shrinks and only splitters are resynced, panels keep their old
  `height/minHeight/maxHeight` and extend underneath the navigator or beyond the
  visible Bento window.
- Working solution: keep the flat-layout computed gap at `var(--space-2xs)`.
  Do not let `.bento-flat-panel-layout` compute `gap: 0`, because geometry reads
  that value and panels will visually touch. The add-panel trailer also needs an
  explicit width plus a `getTrailerLayoutWidth` measurement fallback so the
  final root splitter and scroll extent can account for it.
- Working solution: live flat-layout recomputes must preserve rendered widths
  for panels that are not being actively resized. `refreshFlatPanelLayoutFromLiveState`
  and `applyLiveLayoutGroupRatio` pass `preferLivePanelWidths` into
  `computePanelLayoutGeometry` so stale `panels/sync` payload widths do not snap
  neighboring panels back to old widths or shift the strip while a splitter is
  moving. Subdivision ratio changes also preserve the current main rect width
  while recomputing the group geometry.
- Manual verification surface: checklist item 17, root panel width resize.

Add-panel trailer visibility:

- Renderer path: the trailer participates in the same flat geometry as root
  panels and contributes to the horizontal scroll extent.
- Working solution: keep the explicit `#bento-add-panel-trailer` width and
  `getTrailerLayoutWidth` fallback. If either is removed, the final root
  splitter and scroll extent can miss the trailer and hide the Add panels button
  cluster.
- Working solution: keep the existing trailer node mounted once it has been
  appended to `tabpanels`. Flat-layout geometry and the CSS `order: 999` rule
  keep it visually trailing without moving it in the DOM. Re-appending an
  already-mounted trailer reparents its remote `bento-panel-trailer-frame`
  iframe, which can make the Add panels cluster blink when subdivision fill
  actions create new panel nodes.
- Manual verification surface: checklist item 4, create root panels.

Subdivision splitter resizing:

- Source of truth: group ratios live in the `PanelLayout` tree and are persisted
  by `PanelStore.setGroupRatio` through `panelLayout/setGroupRatio`.
- Chrome bridge: layout splitter drag commits only the final ratio through
  `panelLayout/setGroupRatio`; tools persists it and later syncs the canonical
  tree.
- Renderer path: vertical and horizontal subdivision splitters are flat overlay
  splitters in `#bento-side-panel-host`, not children of nested browser hosts.
  During drag, `applyLiveLayoutGroupRatio` mutates the current in-memory layout
  mirror, recomputes flat geometry, reapplies panel rects, updates existing
  overlay splitter positions, and resyncs root splitters.
- Working solution: do not only move the overlay handle while dragging. Update
  the flat geometry live, otherwise the visible panels do not resize until a
  later sync, and the drag appears broken. Keep `pointer-events: auto` on
  `.bento-layout-vsplitter` and `.bento-layout-hsplitter` because these overlay
  splitters sit outside `tabpanels`.
- Working solution: live subdivision ratio recomputes must also preserve current
  rendered root panel widths. Otherwise adjusting a vertical or horizontal
  subdivision splitter can reset neighboring root widths from stale payload data.
- Regression pitfall: when `computePanelLayoutGeometry` is called with
  `preferLivePanelWidths`, root panel width overrides still win, but existing
  vertical groups must prefer `currentPanelLayoutGeometry.rootRects` over
  payload `widthPx`. A horizontal split-child drag changes child panel rects;
  treating a child payload/live width as the vertical group's root width can
  collapse or reset the whole group.
- Manual verification surface: checklist items 15 and 16, vertical and
  horizontal subdivision splitter drag.

Chooser fill sizing:

- Source of truth: chooser children get their width from the flat layout rect
  computed for the vertical group or horizontal split, not from
  `defaultPanelWidthPx`.
- Tools path: `panelLayout/fillChooser` creates the requested tab or tabs and
  assigns them to the workspace, but must not call `PanelStore.setWidth` with
  the default root-panel width. A chooser child is not a new root panel.
  It also must not emit `scrollToPanelTabId`; subdivision fill should preserve
  the user's current strip scroll position.
- Chooser UI: `createSubdivisionChooser` renders the primary `Full panel` and
  `Split panels` actions side by side, mirrors saved-panel bookmark options
  from `panels/sync.savedPanelItems`, and fills the chooser with the clicked
  saved URL through `panelLayout/fillChooser` in `single` mode. The chooser's
  close button dispatches `panelLayout/removeVerticalGroup`, which promotes the
  top child back to root without creating a temporary bottom panel.
- Empty chooser removal pitfall: `removeVerticalGroup` can validly remove a
  group with zero bottom victims. `PanelStore.removeVerticalGroup` must persist
  and sync based on layout mutation, not `victims.length`, otherwise closing an
  empty subdivision only changes in-memory state and can reappear after restart.
- Renderer path: subdivision child enter animations are collected during
  reconcile, but run only after `applyPanelLayoutRects` has applied the final
  flat-layout rects. They fade in without width or transform animation so the
  first painted size is the assigned subdivision size.
- Regression pitfall: do not run the generic root-panel enter animation for
  `subdivision-bottom` or `split-child` panels before flat geometry is applied.
  Its requestAnimationFrame callback can overwrite the correct rect with a
  stale default-width measurement.
- Regression pitfall: generic new-panel auto-scroll in `reconcilePanels` must
  ignore new tabs whose layout status is `subdivision-bottom` or `split-child`.
  Only new root panels should trigger implicit panel-strip auto-scroll.
- Regression pitfall: default new-panel loading for chooser-created split
  children must be idempotent. Metadata-only `panels/sync` broadcasts can arrive
  while a new split child is still settling; `loadDefaultNewTabInBrowser` must
  not reissue the same Bento new-panel load when that URL is already in flight or
  already loaded, or the panel can flicker between the loading overlay and the
  blank/new-panel surface.
- Manual verification surface: checklist items 6 and 7, fill chooser as single
  panel and dual split.

Top-row splits and 2x2 groups:

- Source of truth: `PanelLayout` vertical groups now accept a top child of
  either a panel or a horizontal group. The bottom child remains a panel,
  chooser, or horizontal group.
- Tools path: `panelLayout/splitTopPanel` creates one new tab, assigns it to
  the workspace, and calls `PanelStore.splitTopPanel` to replace the single top
  panel with a horizontal group. Do not model this as a second vertical group;
  that creates two independent 1x2 columns instead of one shared 2x2 grid.
  It must not emit `scrollToPanelTabId`; splitting inside an existing vertical
  group should preserve strip scroll.
- Bottom survivor re-split path: when one child of a bottom horizontal split is
  closed, `removePanelFromRoot` normalizes the bottom child back to a single
  `subdivision-bottom` panel. That panel exposes `Split this panel`, dispatches
  `panelLayout/splitBottomPanel`, and `PanelStore.splitBottomPanel` replaces the
  bottom panel with a new horizontal group in the same vertical group. Do not
  route this through `panelLayout/subdivide`; that would violate the depth cap
  by creating a nested vertical subdivision. This path also preserves strip
  scroll rather than focusing or revealing the new split child.
- Renderer path: `computePanelLayoutGeometry` uses the same horizontal-group
  rect logic for vertical group top and bottom children, and emits a separate
  overlay splitter for each horizontal group id. Root width should be anchored
  to the top-left panel's stored width when present, falling back to the
  previous root rect when a just-created top split has no stored width yet.
- Top-level strip resize pitfall: once the top row is split, the first visible
  panel element is only the left child. `startPanelDrag` and `endPanelDrag`
  must read the root rect width for that element's `data-bento-root-node-id`,
  then persist that width through the anchor tab id. Reading the child element's
  own rect collapses the vertical group to half width on the next reconcile.
- Header menu: an unsplit top panel with status `chooser-owner` or
  `subdivision-top`, and a single bottom panel with status
  `subdivision-bottom`, exposes `Split this panel`. Once it is split, children
  are `split-child` entries and the split action is no longer shown.
- Manual verification surface: checklist item 7, top split plus bottom split
  creates a single 2x2 vertical group; checklist item 13, close one bottom
  split child and re-split the survivor.
- Panel navigator grouped favicons must derive from `currentPanelLayout`, not
  the legacy `currentSubdivisions` mirror. Flat layout keeps subdivision leaves
  as direct `tabpanels` children and resets `currentSubdivisions`, so the
  navigator must build each root icon from the active layout node: one row for a
  panel child, two cells for a horizontal child, and a placeholder cell for a
  chooser. Active marker mapping must also use root node ids; mapping cycle
  targets by raw panel index points split-child focus at the wrong favicon when
  one root node contains multiple visible leaves.
- Panel navigator favicons must update on panel tab metadata changes, not just
  on layout changes. Chrome listens for `TabAttrModified`, patches
  `__lastPanelsPayload` for the changed panel tab, and re-runs
  `refreshPanelNav` for an immediate local update after panel-header URL
  navigation. Bento-tools also emits `panels/sync` when a panel tab `title` or
  `favIconUrl` delta arrives so the canonical payload catches up and reused
  grouped/nav buttons receive the latest favicon. Do not include `title` or
  `favIconUrl` in the navigator structural signature; those are metadata updates
  that must patch the existing button/image in place. Otherwise navigation
  rebuilds the button, triggering the nav icon enter/leave width transition and
  producing a resize flicker. While a tab is still loading, an empty favicon is
  treated as transient and the existing favicon is retained until a new favicon
  arrives or loading settles. The main-slot favicon is subject to the same rule:
  panel-tab `TabAttrModified` events must not refresh the main icon, and
  `panels/sync` must reuse the main button untouched. The main key has no
  side-panel payload, so never route it through side-panel metadata update logic;
  doing so makes `updatePanelNavButton` reject the null metadata and rebuild the
  first nav button on every panel metadata sync.
- Panel navigator structural changes must keep each button at a stable layout
  size. Split, subdivide, promote-survivor, and remove operations can convert a
  single-panel icon to a grouped icon or back while the panel strip is also
  recomputing geometry. Entry states in `bento-shell-mount.js` should fade
  opacity only and must not animate width, padding, or margin; stale replaced
  buttons should be removed synchronously before reordering the desired buttons,
  otherwise the old root icon can flash before the main-slot icon for one paint.
  The nav button box itself should use border-box sizing so grouped-icon padding
  differences do not change the outer slot. Dimensional nav animation makes the
  navigator row jump during those layout operations even when favicon metadata is
  patched in place.
- Panel navigator button size should track the sidebar footer controls:
  `--bento-panel-nav-button-size` uses `--bento-control-size-sm`, matching Tale
  UI `IconButton size="sm"`, and `#bento-panel-nav` uses the same `space-2xs`
  block/inline padding as `.bento-shell-app__footer`. Keep grouped favicon cells
  small enough to fit inside that fixed 24px slot; increasing grouped favicon
  dimensions without changing the slot causes the navigator to overflow or
  drift out of alignment with the sidebar footer.

### Flat layout pitfalls

- Keep live panel browser containers as direct `tabpanels` children unless the
  browser reparenting risks have been revalidated.
- Splitter drags should update local flat geometry live, then dispatch
  `panelLayout/setGroupRatio` on commit. Tools persists the ratio and the next
  `panels/sync` re-applies it.
- Sanitise layout payloads against the current panel list. A layout node for a
  missing tab must not be rendered.
- Use stable root node ids for reorder. Grouped roots are not equivalent to the
  top panel's tab id.
- Header drag reorder should compute target slots from the pointer position
  against stable snapped drop targets, not from the dragged panel's centre. Using
  the dragged panel's centre makes target zones scale with the width of the panel
  being dragged, which makes the drop affordance drift away from the cursor for
  wide panels. Header drag now moves a single visible panel leaf, not always its
  containing root. Chrome clones `currentPanelLayout`, removes the dragged leaf,
  and computes root drop targets from that post-removal layout so subpanels and
  split children can be dragged out into the top-level strip without moving the
  whole vertical group. Horizontal row insertion targets should use live row
  geometry so the hit zone matches the row the user is hovering, but must be
  validated against the post-removal layout so rows in a group that would be
  collapsed away are not offered. Rows already represented by a horizontal group
  are full unless the dragged source is one of that row's two children; in that
  case the survivor's live rect is a valid target for reordering the pair.
  Empty subdivision chooser targets are collected from live chooser geometry and
  filtered against the post-removal layout, so a panel can be dragged into an
  unconfigured subdivision area while a chooser that disappears after removing
  the dragged source is not offered. Dropping on a chooser dispatches
  `panelLayout/movePanel` with a chooser target and tools replaces that chooser
  with the existing panel as a full bottom panel.
  Dropping on an eligible row dispatches `panelLayout/movePanel` with a
  horizontal target and tools creates a two-panel horizontal group. Cache those
  targets for the active drag session. Repeated reorder FLIP animations can
  leave transient transforms on panel elements; starting a new header drag
  should therefore settle any in-flight transform-only reorder animation before
  painting the new drag transform.
- When promoting a child out of a closing subdivision, preserve the child's
  browser content and width. Otherwise the promoted panel can flash blank or
  resize unexpectedly.
- Panel close animation is opacity-only. `.bento-panel--removing` must not
  mutate width, min-width, max-width, flex, transform, or margins; otherwise the
  outgoing panel fades while the surrounding layout resizes. Let the delayed
  `tab/close` dispatch and the following reconcile remove the slot after the
  fade.
- Plain top-level panel close uses a separate transform-only close-gap FLIP.
  `stageTopLevelPanelCloseGapFlip` snapshots the surviving root slots and the
  add-panel trailer immediately before the delayed `tab/close` dispatch, and
  `runPendingTopLevelPanelCloseGapFlip` consumes that snapshot after the next
  reconcile. Keep this separate from the reorder FLIP and do not run it for
  subdivision promotion paths; those use their own close/promotion animation
  rules.

## Panel traversal and focus

Panel traversal is split between chrome focus tracking and a JSWindowActor pair:

- `src/browser/actors/BentoKeyChild.sys.mjs` listens in content documents.
- `src/browser/actors/BentoKeyParent.sys.mjs` dispatches a chrome
  `BentoKey:Cycle` event.
- `bento-shell-mount.js` registers the actor with `ChromeUtils.registerWindowActor`
  and handles the custom event by calling the private `navigatePanels` closure.

The actor forwards only unmodified `ArrowLeft` and `ArrowRight`, skips editable
targets, and skips already-handled events. Other page keys pass through so
keyboard extensions like Vimium still receive normal content key events.

`setActiveByIndex` focuses the panel's `<browser>` for panel targets, not the
chrome notificationbox. The add-panel trailer is the exception: cycle focus
stays on the outer XUL `vbox` so Enter/Space creates a blank panel.

Arrow-key and Shift-wheel traversal must use minimal reveal scrolling. If the
next cycle target is already fully visible, the strip should not scroll. When
the target reaches an edge, call `scrollPanelIntoViewFromRight` so the strip
only nudges enough to reveal the target instead of snapping the target to the
leftmost slot. Navigator favicon clicks are the explicit left-align affordance
and still use `scrollPanelToLeftmost`.

The `Wrap arrow-key cycling at the ends` setting applies to arrow-key
traversal only. Shift-wheel panel cycling must always clamp at the first and
last cycle targets; do not let scroll gestures loop back to the start or end.
When the Add-panel trailer receives focus, both the `focusin` auto-scroll
listener and the capture-phase focus tracker must ignore it. The trailer sits
under an ancestor with `data-bento-main-panel`, so an unguarded `closest()`
lookup can misidentify trailer focus as main-panel focus and reset
`currentActiveIdx` to 0. That makes the next scroll gesture appear to loop back
to the main content slot even when wheel traversal is clamped.

The Add-panel trailer's visible cycle indicator belongs on the outer
`#bento-add-panel-trailer` XUL host, not only inside the iframe. The host is the
actual arrow-cycle focus target; the iframe owns pointer/Tab focus for the
individual buttons.

The outer Add-panel trailer `keydown` handler is only for cycle-Enter or
cycle-Space while the outer XUL host itself is focused. When focus has moved
inside the trailer iframe, the iframe buttons own Enter/Space. Do not let saved
panel button keyboard activation bubble back to the outer host, or a saved-panel
Enter press will create a blank `about:blank?bento_add_as_panel=1...` marker
panel instead of opening the saved URL.

Boot-time strip scroll restore uses `stripScrollLeft` from `panels/sync` and
applies it after the flat layout commits. When restoring to a nonzero scroll
position on first launch, keep `__suppressNextMainAutoScrollForWorkspace` armed
until the user explicitly navigates to the main slot. Both the reconcile-time
main auto-scroll and the `focusin` auto-scroll path must respect that guard;
otherwise the first click in chrome, the address bar, or browser content can
reinterpret Firefox's settled main-browser focus as intent to reveal the main
slot and yank the strip back to the left.

Pinned panel activation is a two-part flow:

1. React dispatches `pinnedPanel/activate`, which activates the workspace but
   does not select the panel tab as main.
2. React also writes `BENTO_FOCUS_PANEL:<ts>:<tabId>`. Chrome retries scroll and
   focus until the panel exists after workspace reconcile.

### Traversal pitfalls

- Do not focus chrome panel containers as the normal traversal target. Content
  key extensions need DOM focus inside the page.
- Do not use `scrollPanelToLeftmost` for arrow-key or Shift-wheel traversal.
  That makes focus appear locked to the left edge and hides visible context.
- Do not let Shift-wheel traversal inherit arrow-key wraparound. Pass
  `allowWrap: false` when scroll gestures call `navigatePanels`.
- Do not let trailer focus update `currentActiveIdx` through ancestor
  `data-bento-main-panel` lookup.
- Do not forward arrow keys from editable targets in the actor.
- Do not activate a pinned panel by setting `gBrowser.selectedTab` to the panel
  tab. That relocates the panel into the main slot.
- The actor files must live under `src/browser/actors/` and be registered into
  Firefox with `patches/chrome-layout/04-bento-key-actors.patch`. The build sync
  script also copies them into built app actor targets.

## Panel widgets, saved panels, and pinned panels

Pinned panels are global sidebar shortcuts backed by
`extensions/bento-tools/src/pinnedPanels/PinnedPanelsStore.ts`. Runtime identity
is `(workspaceId, tabId)`, but persistence stores URLs and optional panel keys
because tab ids do not survive restart. Boot restore remaps persisted entries to
live tab ids after panels have been restored for each workspace.

Saved panels are bookmarks in a managed "Saved panels" folder under Firefox's
"Other Bookmarks" root. The store is
`extensions/bento-tools/src/saved-panels/SavedPanelsStore.ts`. It creates or
adopts the folder, dedupes by URL, mirrors bookmark changes, and broadcasts
snapshots to the panel trailer.

The visible panel trailer is rendered by `extensions/bento-shell/src/panel-trailer/main.tsx`
and `components/PanelTrailer`. It runs inside the chrome-mounted
`bento-panel-trailer-frame`.

### Widget pitfalls

- Do not call Places APIs from shell or chrome UI for saved panels. The
  `SavedPanelsStore` owns bookmarks interaction.
- Do not persist pinned panels by tab id only. Use URL and panel key remapping.
- Pinned panel rows must use `pinnedPanel/activate` plus `BENTO_FOCUS_PANEL`;
  direct tab activation breaks the main/panel distinction.
- The saved-panel favicon row cannot rely on `page-icon:` URLs from the
  trailer iframe. `SavedPanelsStore` filters privileged favicon URLs and uses
  placeholders when needed.

## Theming and color mode

Workspace theme metadata is stored as `Workspace.themeId`.

Shell theme flow:

- `extensions/bento-shell/src/theme/useWorkspaceTheme.ts` mirrors the active
  workspace theme to `<html data-bento-theme="...">`.
- The sidebar entry calls `useWorkspaceTheme({ pushChrome: true })`, which writes
  `BENTO_THEME:<ts>:<themeId>`.
- `bento-shell-mount.js` mirrors the theme id to the chrome window root.

UI color mode flow:

- `BentoSettings.uiColorMode` is the source for shell and chrome UI mode.
- `useFirefoxTheme.ts` updates shell `<html data-color-mode>` and localStorage.
- Chrome receives `uiColorMode` through `BENTO_PANELS` and applies
  `data-color-mode` to the chrome root.

Content color mode is separate: `BentoSettings.contentColorMode` is applied by
`bento-tools` through Firefox's content color-scheme browser setting.

Theme authoring and import workflow is documented in [themes.md](themes.md).

### Theme pitfalls

- Do not let secondary shell entries push `BENTO_THEME`; they use
  `document.title` for their own sentinels.
- Do not re-add a `system` color mode without auditing boot CSS, localStorage,
  settings migration, and chrome token behavior. Current settings are explicit
  `light` or `dark`.
- Workspace themes are static scoped CSS. Do not generate runtime style elements
  for theme switching.
- Chrome token updates require regenerating/importing the chrome stylesheet; the
  shell CSS bundle alone is not enough.

## Manual regression areas

When changing core functionality, manually verify at least the affected subset:

- workspace switch with different panel sets;
- workspace switch with saved strip scroll positions;
- first panel add in a workspace;
- panel add from main context menu and from panel context menu;
- panel trailer blank add and saved-panel add;
- panel resize, main resize, and workspace switch after resize;
- panel reorder with grouped and ungrouped roots;
- subdivision create, fill, resize, break out, and remove;
- closing main tabs while panels exist;
- closing side panels with descendant sub-panels;
- Cmd+Shift+T restore of a closed panel;
- arrow-key panel traversal while content has focus;
- Vimium or another content-key extension inside a panel;
- AMO install permission prompt from a panel;
- Dark Reader or another content-script extension inside a panel;
- theme switch, UI light/dark switch, and content color mode switch;
- profile restart with panels, pinned panels, saved panels, widths, and scroll
  positions restored.

If a regression touches these areas, record the cause and fix in this document
or in the relevant feature section before closing the task.
