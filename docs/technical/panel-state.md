# Panel state and layout model

Part of the [technical notes index](../core-functionality-technical.md).

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

Panel persistence write path:

- Source of truth: `PanelStore` in-memory maps (layouts, widths, header-hidden,
  main widths, strip scroll, parked `persistedWorkspaces`). The durable copy is
  `bento.panels` plus `bento.panelStripScroll` in `browser.storage.local`; the
  shell never writes either.
- Every write is a whole-graph read-modify-write: `Persistence.#flush` reads each
  live panel's URL with `browser.tabs.get` and then writes the payload. Writes
  never overlap. `Persistence` keeps one write in flight and one queued snapshot;
  a newer request replaces the queued one, so a burst behind a slow write costs
  at most two writes. `flushNow` resolves once a write at least as new as its
  snapshot has landed (a superseded caller resolves after the superseding write),
  which `ImportExecutor` relies on when it awaits `persistCurrentState`. A flush
  that throws is logged and does not block later ones.
- Triggers: layout and size mutations that must stick (move, subdivide, split,
  chooser fill, group ratio, width, header hidden, main width, window-close
  parking) call `flushNow`. Panel add and remove, strip scroll, and panel URL
  changes in `background.ts` (`tabs.onUpdated`, through
  `PanelStore.schedulePersistCurrentState`) use the trailing timer
  (`DEBOUNCE_MS`). The first request arms the timer and it fires after the delay
  with the latest snapshot, so continuous URL churn writes at most once per
  interval. An immediate flush cancels a pending timer and supersedes it. There is
  no `runtime.onSuspend` or unload hook. The prompt paths are the immediate
  mutations, `persistCurrentState` (awaited by `ImportExecutor`), and window-close
  parking: `parkWorkspaceWithResolvedUrls` stores URLs taken from the
  `TabRegistry` closing-window snapshot and flushes at once, which also covers a
  URL change still inside the trailing interval at quit.
- Private-window tabs are never persisted. `persistableUrl` in `Persistence.ts`
  is the single place a live tab becomes a stored URL and returns null for
  `tab.incognito` tabs, so `#flush` drops the panel from `entries` and from the
  persisted layout (`toPersistenceLayout` only emits nodes whose panel key was
  kept). A workspace whose panels are all private is omitted from `byWorkspace`.
  A vertical or horizontal group needs both children, so a group containing a
  private panel is omitted whole, exactly like a panel without a stored URL;
  surviving siblings keep their entries and restore as ordinary tabs. The parked
  path uses `parkableWorkspaceTabs` (`panels/ParkedWorkspace.ts`), which
  `parkTabsForClosingWindow` calls with `TabRegistry.isPrivate`: private tabs
  contribute no panel URL and no `parkedWorkspaceTabs` sidebar entry (URL, title,
  custom title). `TabRegistry` still holds the private tab ids while the
  closing-window listeners run, so the check is valid at that point.
- Manual verification: open a panel, navigate it rapidly (a page that updates
  `location` continuously), and confirm in the Browser Toolbox that
  `browser.storage.local.get('bento.panels')` changes at most about twice per
  second; quit and relaunch to confirm the last URL restores.

Panel session markers live in `extensions/bento-tools/src/panels/SessionMarker.ts`.
They use `browser.sessions.setTabValue` with workspace id, restore location
(`rootIndex`, `containingRootNodeId`) and the panel's layout key (`panelKey`, the
key its entry has in `bento.panels`: `panel-<n>`, its position in the layout's
visible panel order, from `PanelStore.getPanelKey`) so a closed panel can be
restored by Firefox's closed-tab flow and then reinserted into Bento's layout,
and so a restart can tell which entry a restored tab is.
`syncPanelMarkersForWorkspace` (`createPanelMarkerSync`, `panels/PanelMarkerSync.ts`)
rewrites every marker of a workspace, key included, after each mutation that adds,
removes or moves panels, and `restorePanelsForWorkspace` rewrites them once the
persisted layout is applied. A key is positional, so it changes when panels ahead
of it come or go; the rewrite keeps it equal to the key a snapshot or parking
would give that panel. A workspace that still has persisted entries to apply is
not rewritten at all: its layout holds only the panels that came back, so its
numbering is not the entries' (below). A marker written before keys existed has no
`panelKey`.

At a browser start the markers are the first restore of panels. Firefox restores
each panel tab with its markers, `restorePanelsFromSessionMarkersAtBoot` and the
`tabs.onCreated` handler put those tabs back into their slots, and only then does
`restorePanelsForWorkspace` apply the persisted entries from `bento.panels` (URL,
width, header state, and the layout tree with its group ratios).
`planPanelRestore` (`panels/PanelRestore.ts`) binds each entry to a tab of the
workspace in this order:

1. By key: the entry binds to the panel in the layout whose marker carried its
   `panelKey`, whatever that panel shows now. This is what keeps the entry's
   width, header state and pinned-panel binding on the right tab. Position cannot
   do it: the marker restore inserts tabs by `rootIndex` and then Firefox tab
   index, and two subdivision leaves share one `rootIndex` and
   `containingRootNodeId`, so they can come back in either order. Address cannot
   either: a panel may have navigated away, and a restored tab with a real browser
   (pinned-panel backing tabs are native pinned tabs, which Firefox never restores
   lazily) reads `about:blank` until SessionStore has set its saved address
   (`#restoreHistory` calls `SessionStoreUtils.restoreDocShellState`). After that
   `Tab.url` is the real address even while the tab is pending, but a read taken
   before it lands sees a blank tab.
2. By exact address, among panels still in the layout (a marker without a key, or
   whose key matches no entry).
3. By exact address, among sidebar tabs. This comes last on purpose: a sidebar
   tab at a pending panel's address never takes the entry of a panel that came
   back with its marker.

A marker without a key is bound only by steps 2 and 3, never by layout order or
leftover position. So the first restart after upgrading from markers written
without keys can open a second copy of a panel whose address cannot be read
(a pinned panel): the copy takes the entry, and the original, which no entry
binds to, is kept (below). The markers are rewritten with keys on that launch,
but nothing removes the duplicate: persistence stores both panels from then on, so
the extra copy comes back on every launch until the user closes it. Only an entry
with no tab at all opens a new tab, which is the path for a window that closed and
was not restored (it has no marker tabs).

The key a marker carried is read before anything rewrites it. The marker sync
numbers the layout as it stands, and until the entries are applied the layout
holds only the panels that came back, in marker order, so its numbering is not
the entries'. Two things follow. `captureKey` (`panels/PanelMarkerSync.ts`) keeps
each restored marker's key in memory for workspaces that still have persisted
entries, the first time the tab's marker is read and never replaced by a later
read, and `restorePanelsForWorkspace` reads them from there and drops them once
bound. And `sync` writes nothing for such a workspace, so an inactive workspace
that is never activated in a session keeps the markers it came back with, and its
persisted entries stay in storage as they are: a persistence flush
(`Persistence.#flush`) and a window-close parking
(`PanelStore.parkWorkspaceWithResolvedUrls`) both skip a workspace that still has
unapplied entries, even when its panels report readable addresses, because the layout
they would write is the temporary one. Rewritten markers or entries would carry the
temporary numbering, so two restarts later the entries would bind to the wrong tabs, a
top and a bottom panel swapped, with the subdivision and widths lost. The first sync
after the layout is applied writes the final keys, and the first flush after that
writes the applied layout.

A panel of such a workspace that the user closes before the apply takes its entry
with it. `browser.tabs.onRemoved` calls `PanelMarkerSync.tabRemoved`, which finds the
entry by the key `captureKey` kept for the tab, and `PanelStore.dropPersistedPanel`
removes that entry and its node in the persisted layout (`removePersistedPanel`
runs the root node through the live layout shape, so a subdivision left with one
panel collapses as `removePanel` collapses it) and schedules a persist. The other
entries keep their keys and nodes, and a workspace left with no entry has nothing to
apply. `removeInfo.isWindowClosing` tells a close from a window going away: a tab removed
with its window (a window close or a quit) only releases its key, because the entries
are what the next start restores that window's panels from, and the parking and flush
guards above keep them. The prune that drops a missing tab from the live layout
(`emitPanelsSync`) and the apply itself never touch the stored entries. A panel with no
captured key (a marker written before keys existed, or a tab closed before its marker
was read at boot) keeps its entry, so the apply opens a tab for it again.

`PanelStore.restorePersistedLayout` replaces the workspace layout with the
persisted one. A panel already in the layout that no entry binds to (its entry was
not stored, its key matched nothing, or the legacy case above) is kept at the end
of the strip, with the width it has, instead of dropping out of the layout, where
it would have become a sidebar tab. DevTools panels are not kept: boot closes them.
The restore that a workspace activation starts for a window's workspace runs after
the boot restore, because activations during boot wait on `startupRestored` (see
"Restart keeps what Firefox restored" in [workspaces.md](workspaces.md)). Pinned
panels re-attach through the same `panelKeyToTabId` and `urlToTabId` maps that
`planPanelRestore`'s result fills, in `pinnedPanels.recoverTabIdsAfterPanelRestore`
(a pin with a stored `panelKey` binds by key, so it follows the tab that carries
it), so a pin binds to the restored tab and not to a copy.

Limits. A key can only be as current as the last marker rewrite: a layout change
followed within milliseconds by a quit or crash can leave the markers and the
stored entries one change apart, and a key then binds the wrong tab.

## Panel actions

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
- `panel/setHeaderHidden`: persists a per-tabId side-panel or sub-panel header
  hidden flag without broadcasting an immediate `panels/sync`; chrome already
  toggled the live `data-bento-header-hidden` attribute.

`emitPanelsSync` in `extensions/bento-tools/src/background.ts` resolves live tab
ids to `{ tabId, url, favIconUrl, widthPx, headerHidden }`, includes `layout`,
`panelStatusByTabId`, workspace-scoped main width, strip scroll, pinned tab
ids, saved-panel count, and optional `scrollToPanelTabId`, then broadcasts
`panels/sync`.

## Panel state pitfalls

- Do not write shell stores as the source of truth. `PanelStore` owns layout and
  persistence.
- The shell mirror (`extensions/bento-shell/src/state/panels.ts`) returns its
  existing state when `apply` receives the same ids, in the same order after
  deduping, as the hydrated workspace's set. Every settings toggle re-emits
  `panels/sync`, and a fresh Map would re-render `TabList` and refilter every
  tab for no change. Order counts because `CommandPalette` iterates the Set, so
  a panel reorder must replace it.
- Do not emit `panels/sync` after every width write. Chrome already applied the
  live width inline; a sync round-trip can clobber an in-flight drag with stale
  persisted values.
- Do not emit `panels/sync` after every header-hidden write. Chrome already
  applied the live `data-bento-header-hidden` attribute; tools only persists,
  and later sync payloads carry `headerHidden` back.
- Do not use tab ids as durable storage identifiers. Persist URLs plus
  `panelKey`; tab ids are runtime-only.
- Do not start a second `Persistence.#flush` while one is running. Each flush
  awaits a `browser.tabs.get` per panel before its `storage.local.set`, so two
  overlapping flushes can finish out of order and an older snapshot (and its
  strip-scroll record) overwrites the newer state. The fix is the single-flight
  queue in `Persistence`: one write in flight, newest queued snapshot wins. Route
  new triggers through `flushNow` or `schedule`; never call `#flush` directly or
  add a second writer of `bento.panels`. Pinned panels have the same shape of race.
  Their queue is the same, but `PinnedPanelsStore` also resolves each pin's tab at
  change time, so it adds a generation guard, a per-pin record of the freshest
  metadata (tab reads and store updates) that survives superseded calls, and a
  durability barrier for awaited persists; see
  "Pinned-panel persistence ordering" in [panel-widgets.md](panel-widgets.md).
- Do not persist private-window state. Panel entries and layout slots
  (`bento.panels`), parked panel URLs, parked sidebar tabs
  (`bento.parkedWorkspaceTabs`, including titles), and pinned panels
  (`bento.pinnedPanels`: URL, title, favicon) all skip private tabs.
  `PinnedPanelsStore.#resolveAndPersist` reads each pin's tab when a change is
  made and skips `tab.incognito` tabs, remembering their ids, because its
  closed-tab fallback would otherwise write the in-memory URL, title, and
  favicon after the tab is gone. A pin whose tab is already gone on its very
  first read still falls back to the metadata its caller passed to `add`. A new storage path
  that records tab URLs, titles, or favicons must apply the same check where it
  resolves a live tab (`tab.incognito`) or a closing-window snapshot
  (`TabRegistry.isPrivate`, valid only while the closing listeners run). The
  other `storage.local` writers in `bento-tools` were audited and hold no tab
  data: workspaces, tab folders (user-chosen names), settings, native-operation
  and session records, graph journal and rollback state (ids and hashes plus the
  backup JSON being restored), and the graph publication (already filtered by
  `tab.incognito`). `BackupStore` builds each snapshot from live state, skips
  incognito tabs when it resolves URLs, and omits private panels, pins, and
  layout slots; it does not copy stored state. Data written by earlier builds is
  not scrubbed. The `shell/hello` handler has no private check, so a private
  window whose shell sends it claims an unclaimed workspace or creates a
  default-named one in `bento.workspaces` (a name, not browsing data).
- Do not call `persistCurrentState` from a high-frequency listener. Panel URL
  changes used to flush the whole graph on every event (one `tabs.get` per panel
  plus two or three storage calls each); they now use
  `schedulePersistCurrentState`. Keep `persistCurrentState` for discrete
  mutations and callers that must await durability.
- Keep panel markers synced after add, remove, reorder, and restore. Closed-tab
  restore depends on marker root indexes and containing root ids, and the restart
  binding depends on the marker's `panelKey`, which changes whenever a panel ahead
  of it comes or goes (`panelLayout/removeVerticalGroup` and the missing-panel
  cleanup in `emitPanelsSyncNow` sync too).
- Do not clear a panel's `bento.isPanel` marker in the `tab/close` path. Firefox
  needs that tab session value to survive into the closed-tab entry so
  `Cmd+Shift+T` can route the restored tab through
  `maybeRestorePanelFromMarker`. Clear the marker only when the tab stays open
  as a normal tab, such as `panel/remove` or explicit panel promotion.
- A close that Firefox does not commit (beforeunload "Stay") must put the tab
  back. The close paths capture a `CloseUndo` before `markClosing` and
  `PanelStore.remove` drop the workspace, folder, panel layout slot, width and
  header-hidden state, and `restoreKeptTab` replays it through
  `TabRegistry.unmarkClosing`, `assignWorkspace` (with `preserveFolderId`),
  `PanelStore.insertAtRestoreLocation`, `setWidth` and `setHeaderHidden`, then
  `syncPanelMarkers` and `emitPanelsSync`. Keep capturing before the first
  mutation: after `remove` the restore location and width are gone. A subdivision
  child restores next to its former group when that group still exists and at
  its former root index otherwise.
- A user-restored tab can carry Bento's `bento.closingTab` marker from the
  original close path because Firefox preserves WebExtension session values
  through closed-tab restore. Clear that closing marker before assignment or
  panel insertion. Otherwise the created-tab workspace backfill guard treats the
  restored tab as still closing and removes it again. This applies to normal
  tabs as well as panels. `TabRegistry.unmarkClosing` must also suppress stale
  async hydration reads that may have observed the old marker before it was
  removed.
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
- `animatePanelEnter` runs on the Mux `reveal` role and clears its inline styles
  through `afterMotion` (the `transitionend`, or the measured time as fallback; the
  wait is keyed `enter` per panel), not a fixed timer. The width one-shots of
  `applyPanelWidth` and the workspace-switch main-panel width use the same role and
  clear their inline `transition` the same way; `applyPanelWidth` re-syncs splitters
  and the strip scrollbar in that completion, after its own width writes.
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
- In `bento-no-side-panels` mode, do not create the main-content gutter with
  padding on `#bento-side-panel-host` or with host pseudo-elements. macOS live
  window resize became choppy when no-panel host padding, rounded child
  clipping, or frame shadow were each tested in isolation. The working shape
  uses Firefox's native structure: keep
  `#bento-side-panel-host` unpadded and `overflow: visible`, create the real
  gutter with margins on the direct `[data-bento-main-panel]`, and put the
  rounded clip plus frame paint on the native
  `#tabbrowser-tabpanels > .browserSidebarContainer`. The current no-panel
  frame uses `border-radius: var(--bento-panel-corner-radius)`,
  `box-shadow: var(--bento-panel-frame-shadow)` (the elevation shadow only; the hairline is
  the tabbox's `::after` overlay, above the page), and `overflow: clip` on that
  native container. The moved `#tabbrowser-tabbox` and its child
  `#tabbrowser-tabpanels` must paint `--bento-panel-strip-bg` in the
  `bento.chrome-theme` layer in no-panel mode; that token deliberately resolves
  to neutral-5 only while `bento-no-side-panels='true'`. Otherwise Firefox's
  static tabbox/tabpanels backing can show as a sharp square corner behind the
  rounded main-content clip. Because `browserSidebarContainer` owns the
  clip, neutralize the direct child `.browserContainer` radius/overflow in
  no-panel mode; otherwise the main page has two rounded clipping layers during
  window/sidebar resize, which reintroduces choppy live resizing. Exception:
  when Firefox sets
  `:root[inDOMFullscreen]`, the
  fullscreen override must clear the strip host and browser-wrapper radii so
  video fullscreen is not clipped by the normal main-content or panel frame.
  This CSS structure is necessary but not sufficient: live window/sidebar/panel resize
  must also keep chrome measurement observers and expensive frame paints out of
  the hot path. While `:root[bento-window-resizing='true']` or
  `:root[bento-sidebar-resizing='true']` or
  `:root[bento-panel-resizing='true']`, splitter-affordance, sidebar-divider,
  toolbar-navigation, and strip-scrollbar observers defer geometry reads until
  the `bento-resize-settled` event. Do not globally override
  `--bento-panel-frame-shadow` during live resize; panel-view frames should keep
  their normal elevation so panel-view window/sidebar resize can be evaluated
  independently from the no-panel performance path. In no-side-panels mode, the
  native `#tabbrowser-tabpanels > .browserSidebarContainer` frame keeps
  `box-shadow: var(--bento-panel-frame-shadow)` throughout live window/sidebar
  resize. Privileged native about pages such as
  `about:preferences` and `about:settings` make this regression visible first;
  every settings browser has its embedded viewport geometry fixed, is
  layer-preserved, and is docshell-paused during live window, sidebar, and panel
  resize, including when it belongs to a background tab. Release the fixed
  geometry before restoring the prior render-layer and docshell-active state so
  the page performs one final layout at the settled size.
  `pnpm run chrome:resize-check` enforces this guard after chrome token
  generation.
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
  eagerly assign it to the workspace as a normal tab, activate it directly with
  `browser.tabs.update`, emit a window-scoped `panels/sync`, then remove the old
  main tab with the delayed close path. Do not rely on
  `TabRegistry.snapshot()` during this transition; native `tabs.onRemoved` and
  registry removal deltas can be ordered differently.
- Promotion only considers panels that are still open and not closing
  (`livePanelIds`). A panel closed in the same tick as the last sidebar tab is
  marked closing but stays in `PanelStore` until its own close handler gets
  there, so the leftmost "panel" can already be dead. `closeMainTabWithPanelPromotion`
  then removed it, failed to activate it, and re-inserted it as a ghost; the
  `tabs.onRemoved` last-tab handler later tried to promote the same dead tab
  (`promote-panel activate failed: Invalid tab ID`) and returned without
  switching, which left tools on that workspace while Firefox had selected a tab
  of another one. With no live panel, the handler falls through to the
  delete-and-switch branch (or window close) like any other empty workspace. The
  same filter applies to `cleanupWorkspaceAfterTabMove` and to the `tabs.onDetached`
  promotion that covers tear-out.
- Window-close teardown (`Cmd+Shift+W`) is not the same as deleting workspace
  contents. While another regular window stays open, the closing window first
  hands its live tabs to it (see "A window that closes while another regular window
  stays open" in [workspaces.md](workspaces.md)): panel entries are keyed by
  workspace and tab id and survive the move, so `planWorkspaceParking` leaves the
  layout of a workspace alone when any of its panel tabs lives in another window,
  and the parking below covers what could not move and the last window.
  `TabRegistry` keeps a private URL cache and emits one
  `onWindowClosing` snapshot before it drops the closing window's tab ids.
  `background.ts` parks sidebar tabs in `bento.parkedWorkspaceTabs` and asks
  `PanelStore.parkWorkspaceWithResolvedUrls` to convert live panel tab ids into
  persisted URL/layout entries (a workspace whose persisted entries are still unapplied
  keeps them and drops only its live layout). Workspace activation restores parked sidebar tabs
  before the empty-workspace newtab fallback and restores parked panels through
  the normal `restorePanelsForWorkspace` path (`planPanelRestore` keeps it from
  opening a tab for a slot a marker-restored panel already fills). At a browser start (not
  a tools reload) the parked
  sidebar-tab lists of workspaces Firefox restored tabs for are dropped, not
  replayed (see "Restart keeps what Firefox restored" in
  [workspaces.md](workspaces.md)), so only a workspace with no restored tab
  restores its list, and the later-activation replay still consumes matching live
  tabs by URL before creating any. Matching by URL is not what makes startup safe:
  a replay that matched before the restored tabs were hydrated found none of them.
  Do not let removed-tab deltas or `emitPanelsSync` prune closing-window panel ids
  before this parking step runs.
  Deleting a workspace removes its parked sidebar tabs, panel entries, strip
  scroll, and queued activation preferences; closing a window drops that window's
  queued activation preferences.
- Do not replay a parked sidebar-tab list at startup for a workspace whose tabs
  Firefox restored. Cmd+Q parks every workspace of every closing window, so the
  lists exist after every restart, and the replay matched parked addresses before
  the restored tabs were hydrated, when a tab with a real browser (the selected
  tab, every pinned tab) can still read `about:blank`. Replaying created a second
  copy of the tab (re-pinned when the parked entry was pinned), the order Firefox
  restored looked reverted around it, and the replay or the activation fallback
  selected the workspace's first tab instead of the one selected at quit. The decision is membership in a window that came back
  from the session (`parkedWorkspacesToDiscard`), made after
  `hydrateWorkspaceIds` and before the boot backfill, and activations during boot
  wait for it (`startupRestored`). The same wait keeps the activation's panel
  restore behind the session-marker restore.
- Do not open a tab for a persisted panel entry only because no tab shows its URL,
  and do not bind an entry by address or position when the marker carries its key.
  A panel Firefox restored through its marker can fail to match by address: a
  pinned panel's browser reads `about:blank` until SessionStore has set its saved
  address, and any panel may have navigated away. The old URL fallback then opened
  a second copy that took the slot, left the original out of the layout, and gave
  the pinned panel the copy to re-attach to. A layout-order fallback for the leftovers fixed that
  but bound subdivision leaves that share a `rootIndex` in the wrong order (widths,
  header state and pins followed the wrong tabs), bound a panel that had navigated
  to another entry while a duplicate was opened, and let a sidebar tab at a
  pending panel's address take its entry and drop the real panel. `panelKey` in
  the marker replaced it; do not bring the order fallback back. Keep the marker
  restore ahead of `restorePanelsForWorkspace` at startup (activations wait on
  `startupRestored`); run it first and the layout is empty, so every unreadable
  panel is opened again. A panel with no restored tab at all still opens from its
  URL.
- Do not let the marker sync renumber keys before the persisted entries are
  applied. Read a marker's key at the moment the marker is read and keep it
  (`captureKey`, and never replace it by a later read); the layout at that point
  is partial, so a rewritten marker would carry keys that match no entry. For an
  inactive workspace whose panel addresses cannot be read, the stored entries stay
  as they are while the sync rewrote the markers with the partial numbering, and
  after two restarts a subdivision's top and bottom panels were swapped. `sync`
  therefore skips a workspace with unapplied persisted entries; do not write
  markers for it before `restorePanelsForWorkspace` has bound them.
- Do not write a workspace's entries from its live layout while its persisted entries
  are unapplied. The marker sync alone was not enough: once the panels' addresses were
  readable, a persistence flush rebuilt the entries from the temporary layout (the
  panels that came back, numbered from the first one in marker order), so a restored
  top and bottom subdivision that was never opened saved `panel-0` as the bottom
  panel while the top tab's marker still said `panel-0`. The next restart bound the
  bottom entry to the top tab, and the saved subdivision and widths were gone.
  `Persistence.#flush` skips a layout whose workspace still has an entry in the
  persisted map, and `parkWorkspaceWithResolvedUrls` keeps that entry and drops only
  the live layout. A regression test must give the panels readable addresses
  (`PanelMarkerSync.test.ts`): a permanent `about:blank` stub hides this because the
  flush writes nothing for a blank panel.
- Keeping an unapplied workspace's entries must not keep the entry of a panel the user
  closed. With only the two guards above, closing a marker-restored panel while its
  workspace stayed unapplied left the entry in storage, and activating the workspace
  later opened the closed panel as a new tab. `PanelMarkerSync.tabRemoved`
  drops the entry and its layout node on a tab removal that is not `isWindowClosing`.
  Keep the two apart: dropping entries on a window close would lose every panel of a
  workspace nobody opened (the entries are the only record of them), and a prune of
  missing tabs at restore must not drop them either. The tests
  (`PanelMarkerSync.test.ts`) close a panel with and without `isWindowClosing`.
