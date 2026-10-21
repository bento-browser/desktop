# Flat panel layout and subdivisions

Part of the [technical notes index](../core-functionality-technical.md).

The tools-side layout is a tree, but the current chrome renderer keeps all live
panel browser containers as direct `tabpanels` children. Chrome computes a flat
geometry for the tree in `computePanelLayoutGeometry`, then applies absolute
rects with `applyPanelLayoutRects` and `syncFlatLayoutOverlays`.

This avoids reparenting live browsers into nested subdivision containers. Nested
browser moves can detach browsing contexts and break Firefox progress listener
assumptions.

The nested renderer that used to build those containers is gone: there is no
`currentSubdivisions` mirror, no `data-bento-subdivided`, `data-bento-subpanel`
or `data-bento-subdivision-*` attribute, and no `.bento-subdivision-bottom`
container. Persisted subdivision-shaped data still loads through the tools-side
migration in `Persistence.ts` and `PanelLayout.ts`. Names that survive and are
live: `createSubdivisionChooser` and the `.bento-subdivision-chooser` classes
(flat-layout choosers reuse them), and the `.bento-subdivision-vsplitter` and
`.bento-subdivision-hsplitter` classes (flat-layout splitters carry them next to
`.bento-layout-vsplitter` / `.bento-layout-hsplitter`).

Pitfall from the removal: `clearSubdivisionFromPanel(panelEl, { force: true })`
looked dead (it only matched nested DOM) but its forced path also stripped
inline layout styles (display, flex, size, opacity, visibility, position, and
similar) from every resolved panel and its header, browser container, browser
stack, browser and loading overlay on each reconcile, and cleared
`_bentoPanelRemoving`. That reset is live and was kept as
`resetPanelInlineLayoutState`; check any other call to a function named for a
removed feature for side effects before deleting it.

Flat layout overlays include:

- vertical and horizontal splitters for group ratios;
- chooser overlays for empty subdivisions;
- an extent element to maintain horizontal scroll width;
- rect assignment for main, root panels, sub-panels, split children, and the
  add-panel trailer.

## Verified flat layout fixes

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
  sizing. That default flex sizing still uses `defaultPanelWidthPx` from Bento
  Settings as the main slot minimum width so fresh workspaces do not squeeze tab
  content below the normal panel size as panels are spawned. Do not use a global
  or profile-wide persisted main-width fallback for new workspaces.
- Renderer path: flat layout uses absolute rects from
  `computePanelLayoutGeometry`. During pointer movement,
  `refreshFlatPanelLayoutFromLiveState` recomputes geometry with the live width
  override, reapplies panel rects, resyncs root splitters, and updates the strip
  scrollbar.
- Menu preset width path: header "Custom panel widths" actions must use the
  same live flat-layout refresh as splitter drags after writing the target
  panel's inline width. Persisting `panel/setWidth` alone does not emit an
  immediate `panels/sync`; if chrome skips the live refresh, neighbouring panel
  rects, root splitters, and the strip scroll extent remain aligned to the old
  width until a later reconcile.
- Panel corner radius path: `BentoSettings.panelCornerRadiusPx` defaults to 12
  (the stylesheet's `--bento-panel-corner-radius` starts at the same 12px, so there is
  no jump before the setting arrives; keep the two in step with `DEFAULT_SETTINGS`
  and the `defaultValue` in `patches/core-ui/15-bento-native-preferences.patch`).
  Stored values survive: the settings store keeps only overrides from the default,
  so a profile that never changed the slider follows the new default and one that
  did keeps its value. Settings writes
  it through `settings/update`; `background.ts` treats it as chrome-bound and
  re-emits `panels/sync`; `useToolsPort.ts` includes it in the `BENTO_PANELS`
  title payload; `bento-shell-mount.js` clamps it to `0-36px` and writes
  `--bento-panel-corner-radius` for panel frames, content clips, focus rings,
  subdivision frames, the add-panel trailer, and the no-panels main frame
  (`.browserSidebarContainer`, which owns both its stroke and its clip). The
  fullscreen rules still set the radius to 0.
- Panel splitter size path: `BentoSettings.panelSplitterSizePx` defaults to 14,
  matching the previous hard-coded `--bento-splitter-hit-size`. Settings writes
  it through `settings/update`; `background.ts` treats it as chrome-bound and
  re-emits `panels/sync`; `useToolsPort.ts` includes it in the `BENTO_PANELS`
  title payload; `bento-shell-mount.js` clamps it to `6-36px` and writes
  `--bento-splitter-hit-size`. `--bento-panel-gap` derives from that token, so
  splitter drag targets and the visible gap between panels stay aligned.
- Workspace height resize path: the `tabpanels` `ResizeObserver` and the
  settled window-resize path (`attachWindowResizePerfMode` ->
  `repaintSelectedBrowserAfterWindowResize`) must call
  `refreshFlatPanelLayoutFromLiveState`, not only `syncInterPanelSplitters`.
  Flat layout writes absolute inline heights to each panel; if the browser
  window shrinks, or chrome height changes because the bookmarks toolbar is
  toggled, and only splitters are resynced, panels keep their old
  `height/minHeight/maxHeight` and extend underneath the navigator or beyond
  the visible Bento window. Keep the selected-browser `docShellIsActive`
  false/true repaint poke after the resize gesture settles; running it during
  macOS live resize made no-panel resizing visibly rougher.
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

Panel header hiding:

- Source of truth: `PanelStore.#headerHiddenByTabId` persists side-panel and
  sub-panel header visibility keyed by tab id. `StoredEntryV5.headerHidden`
  stores only `true`; missing, false, or malformed values load as absent. No
  storage version bump is required.
- Chrome bridge: `panel/setHeaderHidden` writes the store and does not trigger a
  sync echo. `panels/sync.panels[]` carries `headerHidden` so chrome can restore
  the flag after restart or workspace switch.
- Renderer path: the flat-layout reconciler's per-resolved-panel header
  injection loop toggles `data-bento-header-hidden` from each payload. Flat
  layout keeps subdivision leaves as direct `tabpanels` children, so this loop
  is the only place that stamps it.
- Restore path: `restorePanelsForWorkspace` reapplies `headerHidden` after
  matching persisted entries to live tab ids, alongside persisted panel widths.
- Header hide must use `max-height` collapse without `!important`.
  `forcePanelHeaderInteractiveState` stamps inline-important opacity and
  visibility on injected headers.
- Departing-panel cleanup must remove `data-bento-header-hidden`; otherwise a
  recycled tab panel can leak a stale hidden-header state into another layout.

Add-panel trailer visibility:

- Renderer path: the trailer participates in the same flat geometry as root
  panels and contributes to the horizontal scroll extent.
- Working solution: keep the explicit `#bento-add-panel-trailer` width and
  `getTrailerLayoutWidth` fallback. If either is removed, the final root
  splitter and scroll extent can miss the trailer and hide the Add panels button
  cluster.
- The trailer's width comes from the pinned `--bento-panel-trailer-*` tokens
  (256 px, 284 px with the saved-panels select; see
  [panel-widgets.md](panel-widgets.md)). `getTrailerLayoutWidth` measures the
  rendered host, so the reserved space follows the tokens: 80 px more than the old
  176 px host, taken from the main panel's width and from the strip's scroll extent.
- Working solution: keep the existing trailer node mounted once it has been
  appended to `tabpanels`. Flat-layout geometry and the CSS `order: 999` rule
  keep it visually trailing without moving it in the DOM. Re-appending an
  already-mounted trailer reparents its remote `bento-panel-trailer-frame`
  iframe, which can make the Add panels cluster blink when subdivision fill
  actions create new panel nodes.
- Manual verification surface: checklist item 4, create root panels.

Add-panel grant:

- Source of truth: chrome. `addNewPanel` in `bento-shell-mount.js` generates a
  `crypto.randomUUID()` token, creates the tab at
  `about:blank?bento_add_as_panel=<token>` (the URL carries only the token), and
  sets `newTab.bentoAddPanelGrant = { token, windowId, source, expiresAt,
acknowledge }` on the native XUL tab element in the same synchronous turn as
  `gBrowser.addTab`. `source` is `'main'` (insert before the main slot), a
  non-negative integer tab id (insert after that panel), or `'end'`; the
  trailer click passes its click Event, which maps to `'end'`. `expiresAt` is
  two seconds out.
- Consumer: `bento-tools` `maybeHandleAddPanelMarker` ->
  `createAddPanelMarkerHandler` in `src/panels/AddPanelGrant.ts`. Only a URL
  matching `^about:blank\?bento_add_as_panel=<lowercase uuid>$` triggers a
  check, once per tab (`onCreated` and `onUpdated` share it). The check is
  `browser.bentoPrivacy.consumeAddPanelGrant(tabId, token)`, which resolves the
  native tab with `extension.tabManager.get(tabId, null)`, compares the token,
  deletes the property before any further check (single use; a mismatch leaves
  the live grant alone), calls `acknowledge()`, then rejects expired grants,
  a recorded window id that differs from the tab's current window, and
  malformed sources. It returns `{ windowId, source }` or `null`, and tools
  validates that shape again before inserting the panel into
  `workspaces.getActiveId(windowId)`. The tab can close while the result is in
  flight, so `tabs.onRemoved` (`forget`) cancels the pending attempt and
  tools applies the grant only if `browser.tabs.get` still places the tab in
  the grant's window; otherwise a closed tab would be inserted into panel state.
- Redirect timing: chrome navigates the tab to the panel new-tab page after at
  least 250 ms and after the grant is acknowledged (or after the two second
  expiry, so a stalled tools background cannot leave the sentinel URL up).
- Pitfalls: never accept the URL alone as authority (the old
  `bento_add_as_panel=1` substring check let any page, including
  `location.hash`, turn its tab into a panel and persist that layout). Do not
  move the grant into the URL, a title, or SessionStore data that content or
  other extensions can influence. Do not move the grant off the native tab
  element without another chrome-only, tab-bound store. The experiment reads an
  expando across system-principal compartments, so an Xray wrapper or a rename
  of the native tab's window accessor would make every lookup return `null` and
  silently disable the button; the manual checks below catch that. A profile
  that already ran an older tools build can serve a stale cached experiment
  schema without `consumeAddPanelGrant`; verify in a fresh profile.
- Manual verification surface: click Add panel, press Enter on the focused
  trailer, and use "Insert panel here"; each adds one panel in the right slot
  and the tab ends on the panel new-tab page. In a content tab, set
  `location.hash = 'bento_add_as_panel=1'`, and navigate to
  `about:blank?bento_add_as_panel=3f1c2a4e-9b7d-4c1a-8e5f-0a1b2c3d4e5f`; neither
  becomes a panel and the second logs `add-as-panel: no matching grant`.

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
  any DOM mirror of subdivisions. Flat layout keeps subdivision leaves as
  direct `tabpanels` children, so the navigator must build each root icon from
  the active layout node: one row for a panel child, two cells for a horizontal
  child, and a placeholder cell for a chooser. Active marker mapping must also use root node ids; mapping cycle
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
- Sleeping panel visuals ride the same metadata path. `panels/sync` includes
  each panel tab's `discarded` state, `background.ts` re-emits panel sync when a
  panel tab's discarded flag changes, and `bento-shell-mount.js` toggles
  `.bento-panel--discarded` plus `.bento-panel-nav__icon--discarded` without
  changing navigator structure. Grouped navigator cells also receive a per-cell
  dimming class so subdivided groups can show which contained panel is asleep.
  `SleepPolicy` receives active-workspace visible panel ids from `background.ts`
  as protected tab ids, so the 60-second sweep cannot discard a panel currently
  rendered in a visible workspace and trigger an immediate wake/reload loop.
  Inactive-workspace panels can still be discarded and later wake through
  Firefox's normal tab restore path.
  `SleepPolicy.sweep` also re-reads each candidate with `browser.tabs.get`
  immediately before `browser.tabs.discard` and skips it when `audible` is true
  or `sharingState` reports `camera`, `microphone`, or `screen`. Firefox's own
  discard path does not check media or capture, so this check is the only guard.
  The read is live rather than from the `TabRegistry` mirror so a call that
  started after the last registry delta is still protected; a tab that has
  already closed makes `tabs.get` reject, which is logged and skipped like any
  failed discard. Exempt tabs are not marked active, so they keep their
  place in the keep-alive ranking and follow the normal idle rules once quiet; a
  tab idle longer than the sleep timeout can be discarded on the first sweep
  after it stops (Firefox keeps `audible` set for a couple of seconds after
  sound stops, and there is no further grace period).
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
- Panel navigator button size must match native top-toolbar controls:
  `--bento-panel-nav-button-size` uses Firefox's `--toolbarbutton-padding-inner`
  with the native 16px icon dimension, so density and narrow-window breakpoint
  changes apply to the plain-HTML navigator too. `#bento-panel-nav` is mounted
  before the first extension toolbar child so it stays after Reload/Stop while
  the first extension child becomes the right-aligned toolbar anchor. Bento
  collapses native toolbar springs in sidebar-addressbar mode so that the
  navigator starts at the sidebar divider instead of drifting right behind an
  empty URL-bar gap. Keep grouped favicon cells small enough to fit inside this
  derived button slot; increasing grouped favicon dimensions without changing
  the slot causes the navigator to overflow or drift out of alignment with the
  sidebar footer.
- Panel navigator drag reorder must dispatch only layout root node ids to
  `panelLayout/reorderRoot`. Do not derive this payload from
  `getOrderedPanels()`: that list includes the main content slot, so it can add
  a bogus `panel:undefined` entry and make `PanelStore.reorderRootNodes` reject
  the reorder. Use the navigator root-node payload (`getPanelNavRootNodeIds`) so
  the ids match `currentPanelLayout.root` exactly. Because the navigator is
  mounted in Firefox's titlebar-capable nav bar, draggable side-panel favicon
  buttons must explicitly set `-moz-window-dragging: no-drag`; otherwise the
  titlebar drag region consumes pointer movement before `setupNavDrag()` can
  start a reorder. Scope that override to the favicon buttons so blank top-bar
  space still moves the browser window.
- The previous/next navigator controls are also in that titlebar-capable nav
  bar. Set `-moz-window-dragging: no-drag` on `.bento-panel-nav__btn`, and
  cancel their bubbled `click` and `dblclick` events after calling
  `navigatePanels`. Without both safeguards, a rapid pair of control clicks
  can reach Firefox's titlebar double-click handler and maximize the window.
- The first panel navigator button represents the fixed main content slot, not a
  draggable panel. Keep `bento-panel-nav__icon--main` applied when the button is
  created and when it is reused during navigator diffing. It should have the
  current main tab's page-title label, should use a divider between itself and
  the side-panel buttons instead of an outline/border treatment, and must not
  receive `data-bento-nav-draggable`; side-panel buttons are the only navigator
  entries that participate in drag reorder. Navigator button hover labels are
  rendered by the `panel-navigator-tooltip.html` chrome overlay using Mux UI's
  `Tooltip` component: chrome sends the button's screen rect and label through
  its frame message manager, and the overlay positions an invisible trigger at
  that rect. Center the divider within the
  combined main-button trailing margin and list flex gap so its clearance from
  the main slot and first side-panel button remains equal. Its absolute
  containing block is inside the main button's border, so include the border
  hairline in the inline-end offset rather than leaving the divider one pixel
  closer to the main slot.

## Flat layout pitfalls

- The frame hairline is drawn by each frame's `::after` overlay above the remote page, not
  by the frame's own box-shadow; a stroke on the frame is overpainted at the arcs by the
  page's clip at some device-pixel phases (a fractional sidebar width or scroll offset is
  enough). Keep the frame shadow token to the elevation shadow only. See
  [Main frame origin](chrome-panel-rendering.md#main-frame-origin).
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
  fade. `removePanel` waits for the end of that CSS fade (Mux `dismiss` role,
  `afterMotion` on the panel's opacity), not a fixed delay.
- Plain top-level panel close uses a separate transform-only close-gap FLIP.
  `stageTopLevelPanelCloseGapFlip` snapshots the surviving root slots and the
  add-panel trailer immediately before the delayed `tab/close` dispatch, and
  `runPendingTopLevelPanelCloseGapFlip` consumes that snapshot after the next
  reconcile. Keep this separate from the reorder FLIP and do not run it for
  panels that are not plain root panels (subdivision tops and children);
  `stageTopLevelPanelCloseGapFlip` returns early unless the status is
  `root-panel`.
