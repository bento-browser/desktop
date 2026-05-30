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

### Workspace pitfalls

- Do not render the same workspace in two windows unless the panel architecture
  has been changed to support that. The current chrome reconciler resolves panel
  tabs against a single window's `gBrowser`.
- Do not bypass `workspace/activate`. Per-window active state, conflict policy,
  and SessionStore persistence live in `WorkspaceStore`.
- Do not mutate `useWorkspacesStore` directly from React components. Dispatch a
  protocol action and let tools broadcast deltas.

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
- `panelLayout/subdivide`, `fillChooser`, `breakOut`, `removeVerticalGroup`,
  and `setGroupRatio`: mutate the layout tree.
- `panel/setWidth`, `panel/setMainWidth`, and `panel/setStripScroll`: persist
  chrome-measured layout state without broadcasting an immediate
  `panels/sync`.

`emitPanelsSync` in `extensions/bento-tools/src/background.ts` resolves live tab
ids to `{ tabId, url, favIconUrl, widthPx }`, includes `layout`,
`panelStatusByTabId`, main width, strip scroll, pinned tab ids, saved-panel
count, and optional `scrollToPanelTabId`, then broadcasts `panels/sync`.

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
- When removing a parent panel with descendants, close or remove descendant
  sub-panel tabs intentionally. Do not leave orphaned tabs in the panel layout.

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
  `panel/setWidth`; the main slot width persists through `panel/setMainWidth`.
- Chrome bridge: `bento-shell-mount.js` dispatches the width action only after
  drag end. The live drag must not wait for a `panels/sync` echo.
- Renderer path: flat layout uses absolute rects from
  `computePanelLayoutGeometry`. During pointer movement,
  `refreshFlatPanelLayoutFromLiveState` recomputes geometry with the live width
  override, reapplies panel rects, resyncs root splitters, and updates the strip
  scrollbar.
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
- Manual verification surface: checklist items 15 and 16, vertical and
  horizontal subdivision splitter drag.

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
