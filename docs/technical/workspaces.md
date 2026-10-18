# Workspace implementation

Part of the [technical notes index](../core-functionality-technical.md).

Workspace metadata lives in `extensions/bento-tools/src/workspaces/WorkspaceStore.ts`.
Each workspace has an `id`, `name`, optional `themeId`, optional `icon`, and
`createdAt` timestamp.

The store tracks two active-workspace concepts:

- `#lastGlobalActiveId`: persisted fallback for legacy or not-yet-window-scoped
  callers.
- `#activeIdByWindow`: per-window active workspace map, persisted via
  `browser.sessions.setWindowValue`.

`workspace/activate` is scoped to the requesting window when the shell dispatch
has a `__windowId`. In the single-window case, the activation also refreshes
`#lastGlobalActiveId` so `pnpm run dev` relaunches can fall back to the
workspace that was visible when the browser quit, even if Firefox does not
restore that window's SessionStore value. When more than one window is tracked,
per-window activation does not change the global fallback. Bento currently
enforces one workspace per window. If another window already owns a workspace,
activation returns `conflict` and the handler focuses the owning window instead
of rendering the same workspace in two windows.

Shell-side workspace state is mirrored in
`extensions/bento-shell/src/state/workspaces.ts`. Use
`selectActiveIdForWindow` or `useActiveWorkspaceIdForWindow`; do not assume the
global fallback is the active workspace for every window.
Single-workspace editing uses `edit-workspace.html`; all-workspace management
uses `workspace-palette.html`, opened from the workspace switcher through the
`useWorkspacePalette` title sentinel. Both surfaces use
`components/WorkspaceThemePicker/WorkspaceThemePicker.tsx`, which composes the
public Mux UI `Popover` and `SearchField` components over local
`BENTO_THEMES` metadata. `scripts/sync-theme-presets.mjs` generates that metadata
from Bento's repo-local Default theme plus the standard and monochromatic
themes exported by `@muxui/react/themes`; the count is whatever the pinned
package ships. The picker groups those
collections and renders compact interactive Mux UI `Card.Button` options with
the component's standard selected state. Each option exposes the package
description in a `Tooltip` on hover/focus. Standard ids use `standard-*`;
monochromatic ids use
`monochrome-*`, which keeps both Terracotta variants distinct. Legacy unprefixed
workspace ids resolve to the matching monochromatic theme. Theme selection
writes stable `Workspace.themeId` values:
`edit-workspace.html` keeps the choice in draft state until Save dispatches
`workspace/update`, while `workspace-palette.html` dispatches
`workspace/update` immediately for the edited row. Theme search text stays local
to the picker and is not persisted or sent over the bridge. When the theme
popover opens, focus moves into its `SearchField`; that field uses `slot={null}`
to opt out of any surrounding input context so typing there stays local to the
picker.

`edit-workspace.html` and `workspace-palette.html` re-icon workspaces with the
shared emoji picker in
`components/WorkspaceIconPicker/WorkspaceIconPicker.tsx`. The picker adapts
Mux UI's Emoji Picker recipe with `Popover`, `SearchField`, and `ListBox` over
`emojibase-data`'s English dataset. Vite emits `en/data.json` and
`en/messages.json` as local extension assets, and the picker fetches them only
when opened so the workspace editor cold-start JS budget does not absorb the
emoji collection. Bento flattens base emoji and skin-tone variants into the same
selectable grid, maps Emojibase categories to icon-only lucide tab buttons,
renders Emojibase subgroup sections inside the active category tab, and uses
the Emojibase group/subgroup messages for labels and search. The emoji grid and
category tab strip hide native scrollbars to prevent first-open
vertical/horizontal scrollbar flashes while preserving internal scrolling.
Selecting an icon from the picker or pressing the icon control's overlaid clear
button still writes `changes.icon`: `edit-workspace.html` keeps the value in
draft state until Save dispatches `workspace/update`, while
`workspace-palette.html` dispatches `workspace/update` immediately for the
edited row. The shared `Workspace.icon` schema remains an optional string stored
in `bento.workspaces`.
Existing non-emoji strings are not migrated or rejected: the picker trigger
displays them as legacy custom icons, the overlaid clear button can clear them,
and the picker can replace them with an emoji. The emoji search field uses
`slot={null}`, and the popover contains Escape so the first Escape closes only
the icon picker before a second Escape can close the workspace editor dialog.
Workspace avatars that render emoji icons set `data-bento-emoji-icon="true"` in
the sidebar trigger and workspace switcher menu, then override the themed avatar
background to persistent white in both color modes. Initials and legacy custom
strings keep the workspace theme background. The sidebar workspace switcher
trigger keeps Mux UI's neutral button shape but overrides that variant's
background, border, and text colors with `--color-*` tokens so the control
follows the active workspace brand instead of the neutral palette. The trigger
is rendered as a fixed top sidebar section before the URL address field, so
workspace switching remains reachable after scrolling long tab lists.
`useWorkspaceHasPlayingAudio()` and `useWorkspaceIdsWithPlayingAudio()` derive
workspace-level audio state from the mirrored `TabSnapshot` map, including tabs
rendered as panels. `WorkspaceSwitcher` uses the first hook for its active
avatar and `workspace-switcher/main.tsx` uses the second for every menu row;
both render the shared `WorkspaceAudioParticles` layer only when a workspace has
an `audible && !muted` tab. The layer is positioned outside `Avatar.Root` so its
notes can float beyond the avatar's clipped bounds. It emits finite notes on the
same varied upward paths as panel navigator particles; an audio-off update stops
new emissions while existing notes complete their fade-out. Menu particles use
`--neutral-30` so they contrast with the menu surface.

The workspace editor is a chrome-mounted `Dialog` frame that reads
`useWorkspacesStore`, dispatches `workspace/update`, `workspace/activate`,
`workspace/create`, and `workspace/delete`, and keeps non-empty delete
confirmation in the normal confirm overlay above the still-mounted manager.
The dialog title is visible as "Edit workspaces". The manager does not render a
custom corner close icon; it uses the default `Dialog.Close` affordance plus the
footer text Close button. The Add workspace action lives at the bottom of the
scrollable workspace list, after the existing workspace rows. Workspace rows
render the icon picker as the first column and do not duplicate that icon beside
the name input. Rows share the icon-column width as their control block size so
the name input, icon trigger, theme trigger, status button, and delete button
stay visually level.
Rows are unframed: no row padding, border, outline, shadow, or fill; the parent
list gap is the row separator.
Workspace name fields keep draft text in local `WorkspacePalette` state while
typing and only dispatch `workspace/update` from blur, with Enter blurring the
field.

Sidebar tab multi-selection lives in
`extensions/bento-shell/src/components/TabList/TabList.tsx`. Selection is UI
state scoped to the active rendered workspace: Cmd/Ctrl-click toggles a row,
Shift-click selects a contiguous range, plain click activates the tab and clears
selection, and workspace switches clear selection. The sidebar mirrors selected
tab ids through `BENTO_SELECTED_TABS` title IPC because Firefox's reserved
Cmd/Ctrl+W close command is handled by chrome before the sidebar iframe can
reliably intercept it; chrome closes the mirrored multi-selection before falling
back to single active-tab close behavior. The mirror must only emit when a
selection exists, or once to clear a previously mirrored selection; repeated
empty-selection title writes can stomp `BENTO_PANELS` before chrome reads it and
hide the panel strip. `TabRow` only receives a `selected` visual prop; tab
assignment remains tools-owned.
`TabList` also renders the visible `New tab` and `New panel` controls in a
non-scrolling action header at the top of each pane, above the virtualized
scroller and immediately below `SidebarAddressBar`. `New tab` calls
`signalAddrbarOpen('newTab')` from `App.tsx`
so the floating address/search bar opens and no blank tab is created until the
user commits. Indexed context-menu commands still dispatch `tab/create` with a
Firefox tab-strip `index` when a command needs a specific insertion point.
`New panel` dispatches `panel/openAt` with `about:newtab`,
`sourceTabId: null`, and `position: 'end'`. Tab and panel creation stay
tools-owned and use the same active-window and active-workspace assignment paths
as other entry points. Because the action header is a flex sibling of the
scroller rather than a virtual row, virtualization cannot unmount it and tab
scrolling cannot move it. Collapsed sidebar mode keeps the New control visible
as a square icon-only button and hides the search trigger so the controls do not
crowd the collapsed rail. The action row and each favicon-only tab row keep the
same `--bento-tab-row-height` as expanded mode so toggling the sidebar keeps row
geometry predictable. The collapsed host width is
`--bento-tab-strip-width-collapsed`, which reserves the favicon-only control
width plus symmetric `--bento-sidebar-collapsed-inline-padding`; that collapsed
padding is intentionally larger than the expanded section padding so active
favicon buttons do not sit tight against the rail edges.
The workspace switcher is the exception to applying that padding on the section
wrapper: in collapsed mode `.bento-shell-app__workspace-switcher` must keep
`padding-inline: 0`, while `.bento-workspace-switcher__trigger` is locked to the
same square `--bento-tab-row-height` width/min/max/height as tab-row controls.
The rail breathing room comes from the host width, not from shrinking the
switcher wrapper's content box; adding left/right padding there makes the active
workspace avatar background look squeezed instead of square.
Keep the chrome host pinned directly to this token rather than layering on a
second chrome-local `calc()`/`max()` fallback; live sidebar/window resize relies
on a single collapsed-width path plus the `bento-sidebar-resizing` and
`bento-window-resizing` transition guards above.
Cmd/Ctrl+S is handled in `src/browser/base/content/bento-shell-mount.js` from a
capture-phase keydown listener because Firefox's `key_savePage` binding is
reserved for Bento. The handler reads `sidebarShortcutBehavior` from the latest
`BENTO_PANELS` payload. In `collapse` mode it toggles
`BentoSettings.sidebarCollapsed` and clears `sidebarHidden`. In `hide` mode it
sets both `sidebarHidden=true` and `sidebarCollapsed=true`; the next shortcut
press clears both so the sidebar returns expanded. Chrome applies
`.bento-sidebar-hidden` to `#bento-shell-host`, `#bento-shell-splitter`, and
`#bento-shell-splitter-affordance`, pins the host to the collapsed rail width,
cancels its hbox footprint with an equal negative right margin, translates the
rail off the left edge, and hides the splitter. A chrome-side
`#bento-sidebar-hidden-hover-zone` at the left edge, plus a window pointer-move
fallback, toggles `.bento-sidebar-hidden-revealed` while hovered so the
collapsed rail slides over the content without changing the content layout.
While `sidebarHidden` is true, the divider, toolbar-navigation, and
bookmarks-toolbar alignment paths must treat the sidebar width as zero even
during hover reveal.
Expanded tab scrolling relies on the virtualizer's visible-range updates and
the native scrollbar. `TabListPane` reads the existing effective collapsed
setting (`sidebarCollapsed` or `sidebarHidden`) and skips its custom-scrollbar
pixel metrics, React state updates, and hide timer while expanded. Those updates
belong to the collapsed custom scrollbar, which remains responsible for thumb
position, hover visibility and pointer dragging. A layout effect synchronizes
current metrics when collapsing after an expanded scroll; the existing resize
observer keeps them current as the pane changes size. Expanding clears a pending
hide timer and scrolling visibility state. Keep the virtualizer, row slots,
active-tab reveal and folder anchoring independent of that pixel-only state.
Verify fine and large up/down direction changes, collapse at a nonzero scroll
position, thumb alignment/dragging, and return to expanded mode without a jump.

Tab rows remain fully paintable while mounted. Do not add
`content-visibility: auto` or intrinsic-size placeholders to these already
virtualized rows: Gecko can translate an existing row background into view
before its skipped label and favicon are painted. The virtualizer keeps a
bounded fifteen-row overscan on each side so native asynchronous scrolling
has painted adjacent rows while React updates its range. This adds twenty
mounted rows compared with the previous five-row buffer at an interior scroll
position, without mounting the entire list. Verify native six- and fourteen-row
wheel steps, rapid reversals, and collapsed scrolling; capture moving window
frames because settled DOM screenshots miss one-frame blanks. Check the first
native wheel separately from warmed scrolling.

Folder expand/collapse records the clicked folder row's offset inside the
virtualized scroller before dispatching `tabFolder/setCollapsed`, restores that
offset on the next row-model render, and suppresses the pane's one-shot
active-tab auto-scroll for that render. Without this anchor, collapsing a folder
that contains the active tab can move the active row to a peek slot and make the
sidebar jump away from the clicked folder.
The reveal and active-tab auto-scroll effects are keyed by the semantic display
row layout, not the `rows` array reference. Waking a discarded tab can emit
loading, discarded, title, and favicon metadata before its activation delta;
those metadata-only renders must not scroll to the previously active tab before
the activation render reveals the clicked tab. Structural changes such as pin,
folder, reorder, and collapsed-peek changes still produce a new layout key and
retain the folder-anchor suppression path above.
The active/current sidebar tab row is styled in
`extensions/bento-shell/src/components/TabRow/TabRow.css` with Mux UI
`--color-60` and `--color-60-fg`, not neutral surface tokens, so the browser
current tab remains visually distinct from hover and multi-selection states.
The foreground override for active-row text and icons must stay unlayered
because Mux UI text, button, and icon utility styles are also unlayered; keeping
the override only inside `@layer bento.components` lets neutral utility colors
win.
Tab and folder label line boxes are centered by their row layout. The old
`top: 2px` text offset shifted Mux labels below the favicon center; keep that
offset removed and verify alignment in the isolated TabList Ladle story.
Sidebar audio controls are driven by `TabSnapshot.audible` and
`TabSnapshot.muted` from `extensions/bento-tools/src/tabs/TabRegistry.ts`.
`TabRow` renders the speaker button when either flag is true and dispatches
`tab/toggleMuted`; `extensions/bento-tools/src/messaging/protocol-handler.ts`
applies the mutation with `browser.tabs.update({ muted })`. Keep muted separate
from audible because muted media tabs must remain unmutable from the sidebar
even after Firefox stops reporting them as audible.
Panel-header audio controls use the same source state and action path. Tools
adds `audible` and `muted` to each `panels/sync` panel entry and re-emits
`panels/sync` when a panel tab's audio state changes; the shell forwards that
through `BENTO_PANELS`, and `bento-shell-mount.js` mirrors it in
`currentPanelAudioByTabId` for the chrome-injected header button beside Reload.
The top-toolbar panel navigator also consumes the same panel metadata. Normal and
grouped side-panel nav buttons toggle `.bento-panel-nav__icon--audible` and
their Lucide music-note particle overlay when any contained panel is
`audible && !muted`; the fixed main-slot button derives the equivalent state
from the selected Firefox tab's `soundplaying` and `muted` attributes. Both
paths must stay metadata updates on reused nav buttons, not navigator structural
signature input. The emitter must stop creating new notes when audio stops while
letting already-emitted finite particles finish their fade-out; do not remove the
particle layer abruptly for normal audio-off updates. The particle layer is
parented to `#bento-panel-nav`, not inside each favicon button or
`.bento-panel-nav__list`, because the favicon list is a horizontal scroll
container and clips child overflow.
`extensions/bento-shell/src/components/TabList/TabList.tsx` renders the New menu
and Search trigger in `bento-tab-list-pane__sticky-actions`, a fixed-height flex
sibling immediately before `bento-tab-list-pane__scroller`. The scroller alone
owns overflow and virtualization, so the action header stays immediately below
the persistent sidebar address row at every scroll offset. `displayRows.ts`
therefore contains only pinned tabs, folder/peek rows, and regular tabs; do not
reinsert creation controls into that virtual row model. `TabListPane` derives
the leading pinned/folder row count and exposes its height to `TabList.css` so
only that scrolling region receives the neutral-12 surface. When no pinned or
folder rows exist, the pseudo-element is omitted.

Manual verification must use a workspace long enough to scroll: record the
action header rectangle, scroll the pane substantially, and confirm its
rectangle is unchanged while the first visible tab changes. Repeat after
opening Search, and confirm the fixed row is replaced by the focused search
field and matching results without normal virtual rows remaining visible.

Plain row hover in the virtualized list is one sliding highlight, not a
per-row `:hover` background. `TabListPane` renders a single
`.bento-tab-list__hover-highlight` (`aria-hidden`) as the first child of
`.bento-tab-list__viewport`, so every row paints over it, and
`useRowHoverHighlight.ts` positions it imperatively. Each row wrapper carries
`data-row-start` (the same offset as its `translateY`), `data-row-indented`
and `data-row-inert` (from `rowHighlightProps`). A delegated `mouseover` on the
viewport finds the wrapper under the pointer and sets the highlight's inline
`transform: translateY()` plus `data-indented` / `data-visible`; `mouseleave`
removes `data-visible`. Hover changes touch refs and DOM attributes only, so
neither `TabListPane` nor the rows re-render. `TabList.css` does the rest: the
fill is `--bento-surface-hover`, the height and radius match a row, `data-indented`
applies `--bento-tab-folder-indent`, and `html[data-bento-collapsed='true']`
makes it the centered square of the collapsed rail. The slide (`transform`,
`--bento-duration-base` with `--bento-easing-snappy`), width and margin
transitions apply only under `[data-visible]`; opacity fades in and out with
`--bento-duration-fast`. `prefers-reduced-motion: reduce` keeps only the fade.
Tab and folder rows no longer have a plain `:hover` background. Active rows are
opaque and cover the highlight, and selected rows are translucent and composite
over it.

A tab row's hover actions (Convert to panel, Close tab) paint no background, so
the highlight, a selected tint or the active fill shows through the button area
and the button hover fills composite over it. `TabRow.css` hides the title under
the buttons with a mask instead of a backstop: while the actions are visible
(`.bento-tab-row:hover`, and the active row, where they are always shown) the
title's `mask-image` is transparent across the actions' width, ramping to opaque
over `--bento-tab-row-actions-fade` from the actions' left edge, which is the
fade the old gradient drew. The width is `--bento-tab-row-actions-inset` plus
`--bento-tab-row-action-count` (2, or 1 on the active row, which hides Convert)
times `--bento-tab-row-action-size`; the three `--bento-tab-row-*` tokens are in
`bento-tokens.css` and resolve to Mux tokens (`--muxui-control-size-sm`, the
size of an `IconButton size="sm"`, and the large and medium layout insets). The
actions' `padding-left` uses the same inset token. Short titles that end before
the buttons are unaffected. The mask is applied with the same selectors that set
the actions' `opacity: 1`, and its `mask-image` transition is discrete with a
delay (`--bento-tab-row-mask-linger`, 0 while the mask applies) so the title
stays masked for the 100 ms the buttons fade out.

The hook re-syncs in a layout effect after every `TabListPane` commit, using
the tracked wrapper's current data attributes, so the highlight follows its row
through reorders and sibling shifts and hides when that wrapper is gone (closed
tab, folder collapse, virtualizer recycling) instead of sitting at a stale
offset. Rows fading out (`removing`) set `data-row-inert`, which hides it early.
A drag (`dragSourceId` or `dragFolderId`) hides it and drops the tracked row;
search filtering unmounts it with the rows. The gap between rows keeps the
previous row highlighted, because the `mouseover` target there is the viewport
and is ignored.

Manual verification: use the TabList Ladle drag story (the only one that seeds
the workspace and panel readiness gates). Hover pinned, folder, indented and
regular rows, enter from outside the list, leave it, set
`data-bento-collapsed` on `<html>`, scroll a long list with the pointer still,
close the hovered tab, collapse the folder under a hovered child, and drag a
row. Real Bento (the shell in the sidebar frame) still needs a manual hover,
scroll and pointer-exit pass.

Sidebar drag handling in `TabListPane` classifies tab drops before falling back
to anchor-based reordering. A drop in slot `0` or within the current pinned run
dispatches `tab/setPinned` with `pinned: true`; dropping a pinned tab outside
that run dispatches `tab/setPinned` with `pinned: false`. `bento-tools` owns the
actual mutation in `extensions/bento-tools/src/messaging/protocol-handler.ts`,
where `tab/setPinned` calls `browser.tabs.update({ pinned })` and clears any
stale `bento.folderId` membership through `TabRegistry.setFolder`.

Restart keeps what Firefox restored. Firefox restores the windows, the tabs, their
order and each window's selected tab itself, and the session values Bento writes
bring back every tab's workspace, folder and custom title. Bento recreates,
moves and selects none of it. The one thing that used to undo this is the parked
tab lists: `parkTabsForClosingWindow` runs for every window a Cmd+Q closes and
parks the tabs of every workspace in it (`bento.parkedWorkspaceTabs`), so after a
restart the lists describe tabs Firefox has just restored. Replaying them opened
a second copy of every tab whose address Bento could not read yet, and selected
a restored tab. The rule: `bootReady` notes which windows came back from the
session with their workspace (`WorkspaceStore.restoreFromSession` returned an
id), and as soon as the restored tabs are hydrated (`hydrateWorkspaceIds`, then
`adoptionGate.settle()`) it drops the parked list of every workspace that has a
tab in one of those windows (`discardParkedTabsOfRestoredWorkspaces`, which asks
the pure `parkedWorkspacesToDiscard` in `panels/ParkedWorkspace.ts`), before the
boot backfill gives unassigned tabs a workspace. A workspace with no restored tab
(its window was closed and not restored) keeps its list, and the next activation
of it restores the tabs as before, at startup or later. A tab in a window that did
not come back from the session (the window a fresh start opens) does not count,
even when it already has a workspace. The decision uses workspace membership and
never `Tab.url`.

The drop happens only on a real browser start. `discardParkedTabsOfRestoredWorkspaces`
takes the `runtime.onStartup` signal the pinned-tab pass uses
(`createStartupPinnedTabDiscard(...).browserStarted()`, `tabs/PinnedTabRestore.ts`;
there is no second signal). Firefox fires that event right after the background
script's first run (`background-first-run`, `ext-backgroundPage.js`), so on a
real start it has long arrived when the decision runs after the settle wait. When
bento-tools reloads under a running browser (Alt+Shift+R, an install, an update)
it never fires, and then nothing is dropped, as before this change: the lists stay
and replay on the next activation, which waits for the hydrate and so sees loaded
tabs. That case is the reason for the gate. A window that closed earlier in the
session hands the tabs it can move to a surviving window and parks the one it
cannot; after a tools reload the surviving window counts as restored, and
dropping the list would lose that parked tab. If `onStartup` has not arrived by
the decision point, nothing is dropped either, which falls back to that same
behaviour (a possible duplicate instead of a lost tab). One case remains: a crash
restart is a real start, so when it restores only some windows, a workspace with
a tab in a restored window still loses its list, even when the list holds a tab
of a window that closed earlier in the session and was not restored. That tab is
not replayed. The WebExtension `Tab.url` is `browser.currentURI.spec`
(`ext-tabs-base.js`) and Firefox has no `pendingUrl`, so a restored tab that has a
real browser but is still restoring reports `about:blank`. That is the selected
tab and every pinned tab (`Tabbrowser` skips `createLazyBrowser` for them), the
tabs a user notices first, while lazily restored tabs report their session
address. Matching parked entries by address therefore misses exactly those tabs.

Ordering matters as much as the rule. `restoreFromSession` activates each
restored window's workspace before the settle wait and `hydrateWorkspaceIds`, and
the activation handler (`handleWorkspaceActivation`) ran one frame later. It saw
only the restored tabs whose workspace was already known, so it could not tell a
workspace with restored tabs from an empty one, and it could find no selected tab
among the workspace's tabs and select the first. The handler now waits on
`startupRestored`, which `bootReady` releases (`releaseStartupActivations`) after
it has hydrated the tabs, dropped the parked lists, restored panels from their
session markers and restored the global workspace's panels, right before the
pinned-tab pass (which picks its tabs before the held activations resume, and
runs unchanged after the panel restore). An activation that arrives during boot,
including a fresh window's `assignAvailable`, waits at most the boot time; one
that arrives after the release is a later activation and behaves as before
(parked list replay, selection, empty-workspace tab). A failed boot releases the
wait too.

Selection at startup. With the parked replay gone for restored workspaces,
nothing selects a tab unless Firefox's selected tab is outside the workspace.
`handleWorkspaceActivation` chooses a tab only when no tab of the workspace in
that window is `active` in the registry, and the boot check in `bootReady`
(after the panel restore from markers, before the persisted panel restore) only
when no tab of the global fallback workspace is active in any window
(`hasSelectedWorkspaceTab`, `workspaces/ActivationGuard.ts`). A selected panel of
the workspace counts as a selected tab: it is the page the user was on, shown in
the strip, and neither path selects a sidebar tab over it. Both read hydrated
state now. They still fire, and then select the remembered tab or the first
sidebar tab (`wsTabs[0]`, lowest index, which can be a pinned tab), when the
window's selected tab belongs to another workspace, or when the global fallback
workspace is shown in no window and none of its tabs is selected.

A held activation can be superseded. Activations that arrive during boot all
resume together when `bootReady` releases `startupRestored`, so one for workspace
A can wait while its window switches to B, and then both run. The handler
revalidates after the hold and after each await that precedes moving, creating or
selecting a tab (the cross-window move, the parked-list restore, the adoption
read, and the tab read inside `activateNonPanelTab`): if the window's workspace is
no longer the activation's (`isActivationCurrent`, which asks `getActiveId` for
the window, or the global fallback when there is no window), it returns without
touching tabs or panels, and the activation that replaced it does the work. The
parked-list restore, which takes the list before it awaits, still opens the tabs
but selects none of them once superseded. A skipped activation leaves its
workspace's persisted panels unrestored until its next activation, which is what
a lazy workspace does anyway.

Panels follow the same rule at startup: a panel tab Firefox restored with its
session marker keeps its slot and is never opened a second time by the persisted
URL fallback, whether or not its address is readable yet. The marker carries the
panel's layout key (`panelKey`), and each persisted entry binds to the restored
tab with its key before any address or position is considered, so a sidebar tab at
a pending panel's address cannot take the entry and two panels that share a marker
slot cannot swap (see "Panel session markers" in [panel-state.md](panel-state.md),
which also lists what a marker without a key loses on the first launch after an
upgrade).

Pinned tabs restore on demand after a restart. Firefox restores every pinned tab
at startup even with `browser.sessionstore.restore_on_demand` on, because
`TabRestoreQueue` (`SessionStore.sys.mjs`) puts pinned tabs, hidden or not, in a
priority bucket that it drains unless `browser.sessionstore.restore_pinned_tabs_on_demand`
is also true. `prefs/bento.js` sets that pref true (logged in
[firefox-core-touchpoints.md](../firefox-core-touchpoints.md)), so a pinned sidebar
tab stays pending until first selected. The tab selected at shutdown still loads,
because Firefox always restores it.

The pref alone leaves the sidebar showing pending pinned tabs as loaded.
`Tabbrowser.createTabsForSessionRestore` builds a restored tab lazily (no
browser, no `linkedPanel`) only when
`restoreTabsLazily && !select && !tabData.pinned`, so a pending pinned tab gets a
real browser, and the WebExtension `tabs.Tab.discarded` getter
(`!nativeTab.linkedPanel`) reports it as `discarded: false`. bento-tools
therefore discards those tabs once per browser launch, during boot and before the
sidebar first draws them. `background.ts` registers `browser.runtime.onStartup`
during its first script run (`createStartupPinnedTabDiscard`,
`tabs/PinnedTabRestore.ts`); Firefox registers that event only for the
`APP_STARTUP` startup reason (`ext-runtime.js`) and fires it once the background
page has loaded, so it does not fire on a dev reload (Alt+Shift+R), an install or
an update, when pinned tabs may be loaded and in use. `bootReady` calls the pass
right after the active workspace's panels are restored, which is hundreds of
milliseconds after the first script run (the settle wait alone is at least 300 ms),
so on a real startup the event has long arrived; if it has not, the pass does
nothing and the tabs stay as Firefox restored them. `pinnedTabsToDiscard` selects
tabs from the registry (minus closing and private tabs) that are pinned, not the
selected tab of their window, not already discarded, and not a panel in the layout
of an active workspace (`getActiveWorkspacePanelTabIds()`, the same shown-panel
set `SleepPolicy` protects): the mount script renders those panels straight away
(`materializePanelTab`), so a discard would only reload them. All picks are
discarded at once with `browser.tabs.discard`. That call resolves even when
Firefox declines, and Firefox never unloads a selected tab, so each tab is read
back and `TabRegistry.markDiscarded` records it only when it reports
`discarded: true`. A failure logs `[bento-tools] pinned tab discard failed` and
the others carry on. The discard keeps the tab's session state, so selecting it
loads its page and history as before. A discarded tab reports `discarded: true`
(`TabSnapshot.discarded`), the row shows in the sleeping style, and `SleepPolicy`
skips pinned and discarded tabs, so the idle sweep never puts a woken pinned tab
back to sleep.

Timing against the sidebar's readiness gate matters. The sidebar draws no tab rows
until its tabs store, tab-folders store and the active workspace's panels entry
have hydrated (`TabList.tsx`). bento-tools sends all three from one
`bootReady.then` block in its `runtime.onConnectExternal` handler (`tabs/snapshot`,
`tabFolders/snapshot`, then a `panels/sync` per workspace), so none reaches the
shell before `bootReady` resolves. The pass is part of `bootReady`: it starts
after the panel restore, runs alongside the stale-marker sweep, and is awaited at
the end, so the first `tabs/snapshot` already carries `discarded: true` and the
rows are dimmed from their first paint. `markDiscarded` writes the flag into the
registry the moment the discard is confirmed, rather than waiting for
`tabs.onUpdated`, which would reach the shell as a later update and dim the rows
one by one; the later event finds nothing left to change. The wait is capped at
`PINNED_DISCARD_WAIT_MS` (one second; a parallel pass is expected to take tens of
milliseconds, not measured) so a stuck discard cannot hold the sidebar back; the
pass then logs `[bento-tools] pinned tab discard still running` and a discard that
finishes later reaches the shell as an ordinary tab update.

The pass runs once, after boot settles. A tab restored later than the settle wait
(three seconds at most) stays loaded until selected, as before the pass existed,
and so does a pinned-panel tab of another window's workspace whose lazy panel
restore is still running when the pass starts (it is discarded, then loaded by the
panel strip). Source of truth: SessionStore in the parent process; persistence
path: `sessionstore-backups/recovery.jsonlz4`; no Bento store reads or writes the
pref. Pinned-panel backing tabs are native pinned tabs too: those of a workspace
the window is not showing stay pending and are discarded, while the shown
workspace's panels still load at startup because `materializePanelTab` (mount
script) inserts their browsers to render the strip. Manual check: see
[manual-regression-areas.md](manual-regression-areas.md).

The sidebar context menu is still rendered by chrome through
`BENTO_SIDEBAR_CONTEXT_MENU` in
`src/browser/base/content/bento-shell-mount.js`. When a selected row is
right-clicked, the shell payload includes `tabIds`; chrome dispatches
`tabs/reload` for "Reload X tabs", `tabs/moveToNewWorkspace` for the "Move
selected tabs to new workspace" item, or `tabs/assignWorkspace` for batch moves
to an existing workspace.
All sidebar context menus include "Reopen closed tab". Chrome dispatches
`tab/reopenClosed`, and bento-tools calls `browser.sessions.restore()` with no
session id so Firefox restores the most recent closed session entry. Existing
TabRegistry and panel-marker listeners classify the restored tab or panel after
SessionStore recreates it.
All sidebar context menus also include "Select all tabs". Chrome dispatches the
bus-only `ui/selectAllTabs` action; `TabList` consumes it directly and selects
the current `visualTabOrder`, so selection remains transient shell UI state and
continues to mirror through `BENTO_SELECTED_TABS`.
Right-clicking an unselected row does not mutate sidebar selection, because
doing so emits `BENTO_SELECTED_TABS` and can overwrite the context-menu title IPC
before chrome reads it.
For single rows, the shell includes "New tab below" with the clicked row's
`TabSnapshot.index`, includes "Mute tab" or "Unmute tab" from
`TabSnapshot.muted`, includes "Unload tab" disabled when `TabSnapshot.active` or
`TabSnapshot.discarded` is true, includes a "Close multiple tabs" submenu,
includes "Close tab", and includes "Convert to panel" only when the target row
is not the active tab. `TabList` passes its current `visualTabOrder` into the
context menu payload so "Close tabs above" and "Close tabs below" match the
visible sidebar order. "Close other tabs" precomputes every non-pinned tab
except the clicked tab. Chrome dispatches `tab/create` with `index + 1`,
`tab/toggleMuted`, `tab/unload`, `tabs/close`, `tab/close`, or `panel/add` for
those items. Bento-tools passes a valid `tab/create.index` to
`browser.tabs.create` while preserving the same source-window and eager
workspace assignment used by other blank-tab creation paths. `tab/unload`
re-reads the live Firefox tab and calls `browser.tabs.discard` only if the tab is
still inactive and not already discarded; the resulting `discarded` delta flows
back through `TabRegistry`.

Tab folders are workspace-scoped metadata in
`extensions/bento-tools/src/tabFolders/TabFolderStore.ts`, persisted through
`extensions/bento-tools/src/tabFolders/Persistence.ts` under
`browser.storage.local` key `bento.tabFolders` with a single backup slot.
Membership is stored on tabs with the `bento.folderId` sessions key in
`TabRegistry`, so closing a tab removes its membership without mutating folder
metadata. The wire protocol adds `TabSnapshot.folderId`, `TabFolder`,
`tabFolders/snapshot`, `tabFolders/changed`, `tabFolder/*` actions, and
`tabs/setFolder`. `TabFolderStore.create()` defaults folders to expanded for
user-created folders but accepts an explicit initial `collapsed` value for
system-created folders such as browser-session merge imports. Moving a tab to
another workspace clears folder membership in the same tab delta as the
workspace change. Moving a whole folder uses `tabFolder/assignWorkspace`: tools
updates each member tab's workspace while preserving that folder id, then moves
the folder metadata to the target workspace at the end of that workspace's
folder order.

Folder drops use the same `tabs/setFolder` action as the context menu. The shell
marks folder rows as drop targets and dispatches the folder id when a tab is
dropped on a folder row or into that folder's visible block. Tools validates the
folder workspace, demotes pinned sources with `browser.tabs.update({ pinned: false })`,
then writes `bento.folderId` through `TabRegistry.setFolder`. Dropping a folder
member outside its folder block dispatches `tabs/setFolder` with `folderId: null`.

The shell mirrors folder metadata in
`extensions/bento-shell/src/state/tabFolders.ts`. `TabList` builds a single
virtualized display-row list with
`extensions/bento-shell/src/components/TabList/displayRows.ts`: pinned tabs,
folder rows and visible folder members, action rows, then regular tabs. Stale or
foreign `folderId` values render as regular tabs because the row builder only
honors folder ids present in the active workspace's folder set. Collapsed
folders hide members except for the active member peek row. Sidebar selection,
Shift-range selection, close-selected, and the `BENTO_SELECTED_TABS` mirror use
the flattened visible tab order so hidden folder members cannot be acted on.
`TabListPane` derives each folder-row count from its workspace's panel-filtered
tab IDs, so the count follows live folder membership and matches the tabs that
can appear in the sidebar.

Folder and tab rename context-menu requests are `ui/renameRequest` bus actions
consumed by `extensions/bento-shell/src/state/ui.ts`; they must not be
forwarded to bento-tools. The shell background therefore treats `menu/open` and
all `ui/*` actions as bus-only. Chrome receives tab and folder context menus via
`BENTO_SIDEBAR_CONTEXT_MENU` in
`src/browser/base/content/bento-shell-mount.js`. Folder-only menu items must be
handled before the `hasTabId` guard because folder menus intentionally carry no
tab id. Rename requests initiated from the native chrome context menu must also
move focus back into the sidebar frame before broadcasting on
`bento-shell-bus`; `BENTO_SHELL_ACTION` frame script calls `content.focus()` for
`ui/*` actions so the shell's inline rename input can focus and select its text.
The folder row then retries `input.focus()`/`input.select()` briefly after
entering rename mode to cover React commit and browser focus timing.

Batch tab assignment is handled in
`extensions/bento-tools/src/messaging/protocol-handler.ts`. Tools creates the
new workspace through inactive `WorkspaceStore.create`, assigns each selected
tab through `TabRegistry.assignWorkspace`, activates the new workspace, removes
stale pinned-panel bindings, and runs the same empty-source-workspace cleanup
used by single-tab moves after the batch finishes. Creating the workspace
inactive prevents the activation orchestrator from seeing an empty workspace and
opening an unwanted blank tab before the moved tabs arrive.

## Workspace pitfalls

- Do not give tab or folder rows their own plain `:hover` background, and do not
  mix `--bento-surface-hover` into a row state that composites over the hover
  highlight. The highlight already supplies that tint: a selected row's `:hover`
  background mixing it in again stacked it twice and read darker than a plain
  hovered row. A selected hover is the accent over `transparent`.
- Do not paint an opaque backstop (a gradient of `--bento-surface-hover-solid`,
  the selected tint or `--color-60`) behind a tab row's hover actions. It appears
  with `:hover` over `--bento-duration-fast` and disappears on its own, while the
  highlight needs `--bento-duration-base` to slide in, so moving along the button
  column showed solid hover-colored blocks ahead of and behind the gliding
  highlight, with the button hover fills sitting on them. Mask the title instead
  (see above). The mask width must match the actions' real width: if the action
  count or the button size changes, change `--bento-tab-row-action-count` or the
  `--bento-tab-row-action-*` tokens, and check a long title still fades before the
  first button and that the active row (one button) does too.
- Do not set the highlight's `transform` and `data-visible` in the same style
  pass. The slide transitions come from the after-change style, so a fresh show
  would glide in from the last row. `useRowHoverHighlight` writes the position,
  flushes style (`offsetHeight`), then sets `data-visible`; the slide, width and
  margin transitions live under `[data-visible]` for the same reason.
- Do not derive the hovered row from scroll math or a cached pointer position.
  The highlight follows `mouseover` on the row wrappers, and relies on Gecko's
  synthesized mouse move to re-target a stationary pointer after a scroll, a
  folder collapse or a row removal. Without `mousemove` there is no fresh
  coordinate to cache. That synthesized move is not guaranteed to land promptly
  (headless Gecko re-targeted after a removal in one run and not within 500 ms in
  another), so the worst case is a hidden highlight until the pointer next moves.
- Do not let the highlight outlive its row. Anything that unmounts, fades
  (`data-row-inert`) or drags the hovered row must go through the hook's
  post-commit sync, or the highlight sits at a stale offset after a reorder,
  removal or folder collapse.
- Do not render the same workspace in two windows unless the panel architecture
  has been changed to support that. The current chrome reconciler resolves panel
  tabs against a single window's `gBrowser`.
- Do not leave a tab without its workspace when its close is cancelled.
  `markClosing` deletes `bento.workspaceId` and `bento.folderId` up front, so the
  close paths capture the binding first and give it back if the tab survives (a
  beforeunload "Stay"); see "Closing a tab that has a beforeunload prompt" in
  [chrome-panel-rendering.md](chrome-panel-rendering.md). A tab left with the
  closing marker disappears from the sidebar and is closed at the next launch.
  The rollback only restores workspace, folder and panel slot when the tab's
  window still shows the workspace it was closed from; otherwise the tab joins
  the workspace its window shows, as a normal tab. A workspace delete has no
  rollback (its tabs keep the marker if a prompt keeps them), and sub-panels and
  subdivisions come back as root panels.
- A tab can arrive in a window with another window's workspace (tear-out, drag
  between windows). Do not trust its `workspaceId` until `releaseAdoptedTab` has
  compared it with the workspace the destination window shows, and do not open a
  blank tab for a new window's empty workspace while the window holds unassigned
  tabs (`adoptableTabs`). See "Tear-out with panels present" in
  [chrome-panel-rendering.md](chrome-panel-rendering.md).
- `WorkspaceStore.delete` moves a window that showed the deleted workspace to
  the first workspace no window shows, and leaves the window without one when
  there is none. The old fallback was the first workspace in the map, whichever
  window showed it, so deleting a window's workspace could put two windows on
  the same workspace; workspace activation then moved the other window's tabs
  into the first window and both windows closed. The `workspace/delete` handler
  marks the doomed tabs closing before deleting, closes a stranded window (with
  `closeTabs`) or gives it a fresh workspace (nothing to close), and never relies
  on the first-in-map fallback.
- A workspace delete hands the window its replacement synchronously, but the
  replacement's tab and panels come from `handleWorkspaceActivation`, which the
  store's batched `activated` event runs later. Removing the doomed tabs in
  between made the last-tab handler see an empty replacement and delete it or close
  the window. `deleteWorkspace` therefore calls `WorkspaceStore.flush()` after the
  delete, which delivers the pending events now and resolves when the activation
  listener's runs have finished (the listener returns them), before it removes
  anything. That does not prove the replacement has a tab: the activation's own
  tab creation swallows its failure. `ensureReplacementTab` therefore checks for a
  live tab in the window and opens one itself, with its error propagated. If that
  fails too, the old tabs of the window are not removed; they leave the closing
  state and become normal tabs of the replacement (a panel of the deleted
  workspace loses its marker), so the window keeps working, and the failure is
  logged. The window stays marked in `WindowHandoffGuard` until the removals have
  settled (cleared in `finally`); the decision itself is `afterTabRemoved` in
  `workspaces/EmptiedWorkspace.ts`, which returns no action for a window that is
  handing off.
- Exactly one activation may run for a workspace a delete hands to a window.
  `WorkspaceStore.delete` also announces its global fallback workspace (no window),
  and when that is the window's replacement (the first workspace in creation order
  usually is) both events activate it; each run sees an empty workspace and creates
  a tab, so it ended up with two. Callers that activate the replacement themselves
  (`deleteWorkspace`, the last-tab handler, `cleanupWorkspaceAfterTabMove`) pass
  `{ announceFallback: false }`. Do not "fix" this by deduplicating activations by
  workspace id: a window-specific activation of the same workspace is then dropped
  when the global one came first, and the tabs of the new owner are never brought
  to it.
- A tab Bento moves between windows itself must go through `moveTabsToWindow`
  (or `moveWorkspaceTabsToWindow`, the pinned-first variant below).
  Only the move's own record distinguishes it from a drag when the window
  switched workspace before the attach event (`releaseAdoptedTab`). The record
  (tab id to workspace and destination window) is made before `tabs.move` because
  the attach events can arrive before its promise resolves, then trimmed to the
  tabs the move reports: `tabs.move` skips some (a pinned tab moved to the end),
  and a user dragging one of those out later must not read as Bento's move. An
  attach to another window than the recorded one discards the record, and it
  expires after 10 s if the tab never attaches.
- `tabs.move` only moves a pinned tab to a position inside or right after the pinned
  tabs and leaves one moved to the end where it is, so a workspace's tabs go through
  `moveWorkspaceTabsToWindow` (pinned ones first, to index 0, then the rest to the
  end). `handleWorkspaceActivation` uses it when a window claims a workspace whose
  tabs sit in another window; with a plain move to the end the pinned tabs stayed
  behind, pinned, in the wrong window.
- A window that closes while another regular window stays open hands its live tabs
  over in chrome, before it closes; bento-tools does not move them. Closing used to
  destroy every tab the window hosted: its workspace's and the hidden tabs of other
  workspaces that a workspace switch, or a window claiming a workspace, had left
  there. `parkTabsForClosingWindow` kept only their URLs and the next activation
  recreated them, losing page state, history, form text and playing media (open a
  second window, which claims an unowned workspace and takes its tabs, then close
  it). `tabs.move` cannot run once `tabs.onRemoved` reports `isWindowClosing`, so
  the move has to happen first, and only the mount script runs between the close
  request and the teardown. Source of truth and flow:
  - `handOverTabsBeforeClose` (mount script; see
    [chrome-panel-rendering.md](chrome-panel-rendering.md)) runs in the `close` and
    `DOMWindowClose` listeners, synchronously, with no way to cancel the close
    afterwards, and adopts every tab worth keeping into another regular window with
    `gBrowser.adoptTab`, in the order the tabs have. The docShell swap moves the live
    browsing context (page, history, media) into a new `<browser>` element of the
    destination and the tab id is kept, so the page is untouched. Worth keeping
    excludes `tab.isEmpty`, `tab.closing`, tabs bento-tools marked `bento.closingTab`
    (a workspace delete marks its doomed tabs and then closes the window, so they must
    not be rescued), the tab whose page called `window.close()` and tabs that are not
    remote (see "A tab adoptTab refuses" below). Container (`userContextId`) tabs are
    handed over normally: `adoptTab` creates the twin in the same container.
  - A blank tab holds the window open. Adopting a window's last tab closes the window
    from inside `adoptTab` (`swapBrowsersAndCloseOther` calls `window.close()`, which
    reaches the handler again) and returns before `TabClose`, so a DevTools toolbox,
    which follows `TabClose` `adoptedBy`, is not moved with that tab. The mount adds
    one selected `about:blank` tab before the first adoption: no adopted tab is the
    window's last or its selected one (no re-selection while tabs leave), each leaves
    through the ordinary `TabClose`, and the blank tab closes with the window.
    `about:blank` is not parked. The blank tab is a real tab for a moment: its
    `TabOpen` and `TabSelect` run the normal listeners (tools sees a created tab and
    an activation in the closing window, the mount's reconciler stays down because
    `handingOverTabs` is set), and it dies with the window. `addTab` returns null
    when it cannot make a tab, so the handover continues only with a connected
    blank tab and otherwise hands nothing over (the old parking). Do not close the
    leftover tabs explicitly instead: `tabs.onRemoved` runs `afterTabRemoved`, which
    closes windows and switches workspaces.
  - Each adopted tab gets the tab value `bento.handover`, a list of hops
    `{ from, to, at }` (window ids, timestamp) appended on the tab `adoptTab`
    returned; a tab handed on again carries its earlier hops. As it appends, the
    mount drops the hops older than 15 s and those timed in the future. bento-tools
    only reads the value (`wasHandedOver`, `tabs/Handover.ts`), in `tabs.onDetached`
    (`from`) and `tabs.onAttached` (`to`). A hop matches an event when it names that
    window, is under 15 s old, is no older than this tools instance's uptime (window
    ids repeat across runs, so a restored value must not match; the uptime is read
    from `performance.now()`, because comparing the hop's time with the wall time at
    load rejected every new hop once the clock moved back past it), and that side of
    it has not matched before. Every hop is needed: two windows closing in one task
    (window 2 into 1, then 1 into 3) write both hops before tools sees an event, and
    one overwritten value made the first events look like a drag and released the
    workspace, folder and panel slot. Each side matches once so a user dragging the
    tab out and back into the same window within the TTL is a drag, which holds only
    if every event spends its side: `releaseAdoptedTab` asks `wasHandedOver` even when
    a Bento move (`bentoTabMoves`) already accounts for the attach, and `onDetached`
    asks before its own checks. A side left unspent passed the later drag back into
    that window as the handover. Neither event is ordered against the other or
    against anything chrome sends, so a read never clears anything. Tools does not
    delete the value either: a cleanup that read it and removed it later deleted a
    hop chrome had appended in between. An expired hop stays on the tab (it rides the
    session file) until the next handover prunes it, and is ignored by its age.
  - A handed-over tab keeps its workspace, folder and panel slot
    (`releaseAdoptedTab` returns early; a drag releases them), does not promote a
    panel in the window it left (`onDetached`), and is not parked: `onAttached`
    already moved it out of the closing window in the registry. An attach event whose
    tab the registry already shows in another window is ignored, because a later
    event for that window releases it. The registry also re-reads the live `active`
    flag on attach, since an adopted tab is not selected and no activation event
    follows; a stale `active: true` made the later workspace activation choose no tab.
    That read is asynchronous, so `#syncActive` drops its answer when a newer attach or
    activation of the tab arrived meanwhile (a per-tab sequence) or the tab has moved to
    another window; otherwise an old snapshot overwrote a selection.
    Adoption emits no `tabs.onCreated`; the blank tab does, in the closing window.
  - Parking sees only the leftovers: the blank tab, empty tabs and closing tabs.
    `about:blank` is not parked as a sidebar tab, as before the handover existed; an
    empty New Tab page left behind is parked and comes back as a New Tab entry like it
    does when a window closes alone. When the workspace is shown again and live tabs
    of it exist (the handed-over pages), restoring a parked entry that opens a new tab
    does not take the selection, so the activation picks the remembered tab instead of
    the empty New Tab (`planParkedRestore`). `planWorkspaceParking` keeps the panel layout of
    a workspace when one of its panel tabs lives in another window
    (`hasPanelsInOtherWindow`) instead of rebuilding it from the leftovers' URLs, and
    parks a panel stranded in the closing window as a sidebar tab.
  - A tab `adoptTab` refuses. `adoptTab` first creates an empty twin tab in the
    destination; its `TabOpen` moves the tab's id (WebExtension) and custom tab values
    (SessionStore, which also deletes them from the source) to the twin. When
    `swapBrowsersAndCloseOther` returns false Firefox removes the twin and the
    source stays behind without either. It returns false for: a private mismatch
    (neither side of a handover is private), a Fission mismatch (`findHandoverSurvivor`
    requires the same `gFissionBrowser`), a non-remote source (the twin is always
    remote, so a parent-process page such as Settings is refused: the mount leaves
    non-remote tabs out of `keep`), a closing source tab (left out too), and a source
    tabbrowser with `#windowIsClosing` set. That flag is set only inside
    `_endRemoveTab` when the last tab of a window is closed (`Tabbrowser.sys.mjs`
    `:6806`, `:6905`) and from the result of `closeWindow(...)` (`:6620`, after it
    returns); neither the OS close button nor a script `window.close()` sets it, so
    it is false when the `close` and `DOMWindowClose` listeners run. In the one flow
    where it is true (the user closed the window's last tab), the window has no live
    tab left to hand over. A tab left out is never adopted, so it keeps its id and
    values and tools parks it when the window closes, as before the handover.
  - If `adoptTab` returns null or throws anyway, the mount logs `console.error` with
    the tab's title and address and moves on; it does not rebuild the tab. The
    consequence: after a refusal the tab's custom values (workspace, folder, title)
    went to the removed twin and its extension id is the twin's. Tools forgot that id
    when the twin was removed and `ext-browser.js` skips an adopted source tab when
    the window closes (`adoptedTabs`, `_handleWindowClose`), so the tab is not
    parked and a workspace reclaim cannot restore it. SessionStore does keep the
    closing window, with that tab, for Undo Close Window (see Known limits), but the
    tab comes back without its workspace. A throw after a successful swap leaves the
    tab in the survivor unmarked, so tools treats the move as a drag (the tab joins
    the survivor's workspace); a throw inside the swap can leave the empty twin in
    the survivor.
  - Pitfalls. A pending (not yet restored) tab comes out of `adoptTab` without its
    custom tab values: SessionStore moves them to the new tab on `TabOpen`, then
    `swapBrowsersAndCloseOther` restores the old tab's state, which no longer has
    `extData`, and `#restoreTab` deletes them. The mount writes them back from the
    state it took first. The handover value is written after `adoptTab` for the same
    reason. Bento's split-view markers are torn down first
    (`reconcilePanelsSplitView([])`, and the reconciler stands down), since the swap
    does not cope with them. A tab's own `window.close()` bubbles a non-cancelable
    `DOMWindowClose` from its browser element and the tabbrowser closes the window
    from inside it when the tab is the window's only one; that page asked to go and
    its tab is not handed over (`notePageClose` records the tab, which is looked up
    with `getTabForBrowser`). Only that tab is left out: a chrome close of the window
    in the same task still hands the others over.
  - Session history of an adopted tab (`adoptTabInto`). The swap collects the page's
    session history into the cache under the twin's permanent key
    (`browsing-context-did-set-embedder`), and `swapBrowsersAndCloseOther` then
    exchanges the two browsers' keys, so the history sits under the key of the old
    browser. SessionStore moves it across in `#onMoveToNewWindow`: on `TabClose` with
    `adoptedBy` it calls `TabStateFlusher.flush(oldBrowser)` (the promise from
    `browser.frameLoader.requestTabStateFlush()`) and copies the old browser's cached
    state, formdata and scroll included, to the twin when that settles. The promise
    belongs to the closing window, and nothing chained on it ran once that window was
    gone: the copy was skipped and
    `JSON.parse(SessionStore.getTabState(tab)).entries` of a handed-over tab stayed empty
    (also after a later `TabStateFlusher.flush` and 25 s) until its next navigation. The
    twin's own cache is empty until the page's next update (15 s,
    `browser.sessionstore.interval`), so a tab with a cached older history kept that and
    a recently opened or navigated one lost it. Effect: a quit right after a handover
    restored window 1 without the tabs (tools parked them, page state lost) and a
    `kill -9` lost them. A bare capture `DOMWindowClose` listener that calls `adoptTab`
    reproduces it. A promise created in the mount script's own window does not help (it
    is the closing window), one of the survivor does: for the `adoptTab` call the old
    frame loader shadows `requestTabStateFlush` with a function that returns
    `new survivor.Promise(...)` settling with the original, and the shadow is deleted
    in a `finally`. Do not recollect through `SessionStore.updateSessionStoreFromTablistener`
    instead: it drops updates unless given the browser's private epoch
    (`#browserEpochs`, not readable from script). Manual check: after a close, every
    handed-over tab's `JSON.parse(SessionStore.getTabState(tab)).entries.length` equals
    its history count without a navigation, and a quit right after restores each tab
    once in window 1 with its history.
  - Session write after a handover. A close only schedules SessionStore's write
    (`#onClose` to `SessionSaver.runDelayed`: not sooner than 2 s nor than the last write
    plus `browser.sessionstore.interval`, 15 s), and a tab's history reaches the parent
    cache up to one interval after it changes (`SessionStoreListener`). Before the
    handover, tools parked the closing window's tab URLs, which a crash relaunch
    restored; the handover skips parking, so a `kill -9` or crash seconds after a close
    lost every adopted tab that no earlier write held (tabs opened or navigated in the
    last ~15 s). `saveSessionAfterHandover` (mount script) closes the gap: when at least
    one tab was adopted, the closing window calls
    `survivor.__bentoSaveSessionAfterHandover(flushes)` with the survivor-realm flush
    promises `adoptTabInto` collected (the ones SessionStore's copy waits on). The
    survivor seals the batch in a timer task of its own, so requests that arrive before it
    (also ones started from a promise reaction, as `w1.close(); then(() => w2.close())`)
    share one write, then waits for the flushes (at most 2 s, so a flush that never settles
    cannot hold the write), then one task for the copy, which is a reaction to them, then
    calls `SessionSaver.run()`, unless the window closed or `Services.startup.attemptingQuit`
    is set (the quit writes the session itself). When the cap won, the write has gone ahead
    without the late tab's copy and `run()` has cancelled SessionStore's pending delayed
    save and reset its interval, so nothing else would write it for up to 15 s: each flush
    that settles after the cap gets a write of its own one timer task after it settles
    (settles that land before that task share it), with the same guards. The follow-up is
    per flush, not on all of them: waiting for the last one would keep a tab copied at 2.4 s
    out of the file until a flush that may never settle. Nothing is armed while flushes are
    outstanding (the cap timer is cleared, a follow-up timer only exists after a settle). A
    chain of closes ends in the last survivor's write, which holds the earlier windows'
    tabs. Source of
    truth: SessionStore in the parent process; persistence path:
    `sessionstore-backups/recovery.jsonlz4`. The write runs after the close has returned:
    collecting the state took about 1 ms for 3 and for 48 tabs, and the file was complete
    about 50 ms after the close for 3 tabs and 260 to 380 ms for 48 (the close itself takes
    about 240 ms there; the rest is the content-process flushes). Pitfalls: (1) called straight after
    `close()` it writes before the copy and saves no adopted tab; (2) the wait and the
    call must be the survivor's: promise reactions and timers of the closing window never
    run once it is torn down, so the closing window only calls into the survivor and
    holds nothing (no timer, no `then`); (3) do not hold or delay the close for it; (4)
    `SessionSaver.run()` also writes during shutdown, hence the quit check. Manual check:
    in a test profile open and navigate tabs in a second window, close it, `kill -9`
    0.3 s and 3 s later: the next launch restores each handed-over tab once, with history,
    workspace, folder and pin.
  - Close prompts. `permitUnload` throws "already running" for a tab that is already
    being asked, `CanCloseWindow` does not catch it, and a close that threw there goes
    ahead, so a close repeated while a beforeunload prompt is up reaches the handler
    with the question unanswered. The mount hands nothing over when any connected
    browser of the closing window reports `getInPermitUnload`, and does not choose a
    survivor that does, or one with `gDialogBox.isOpen`. That covers the window-modal
    closing-tabs warning (and any other dialog shown through `gDialogBox`) only: a
    tab-modal or content-modal prompt is covered through its beforeunload check, and
    other tab-modal dialogs and native OS dialogs are not detected.
    `windowUtils.isInModalState()` does not cover any of these (they put the page,
    not the chrome window, in a modal state).
  - Quit. A quit force-closes every window, and SessionStore collects them as they
    are, so nothing is handed over once `Services.startup.attemptingQuit` is true. It
    is set before the windows are closed; `Services.startup.shuttingDown` is still
    false then.
  - No hand-over without a survivor: a regular window (visible toolbar, not private)
    with a mounted shell, still open, not in a close prompt, and given a workspace by
    tools (`bento.activeWorkspaceId` window value, set after its `shell/hello`).
    Private windows, popups, DevTools and shell-less windows never receive tabs and
    never hand tabs over; with no survivor the tabs are parked as URLs as before.
  - Known limits. Undo Close Window: SessionStore saves a closing window when any
    tab it still holds is more than a transient blank entry (`#maybeSaveClosedWindow`
    and `#shouldSaveTabState`, `SessionStore.sys.mjs:2127`, `:7521`). After a clean
    handover only blank tabs remain (the blank tab, empty tabs), so there is nothing to
    reopen, and the handed-over tabs live in the window that took them, under their
    workspaces. A window that still holds a tab that was not handed over (a
    tools-closing tab, the tab whose page closed, a non-remote tab, a tab `adoptTab`
    refused) is saved with it and Undo Close Window reopens it; a tab that was never
    adopted keeps its values, a refused one does not. Individual adoption does not
    keep native tab-group membership or a multiselection; Bento's sidebar does not use
    either (folders are the `bento.folderId` value, which moves). Two windows closed
    in one task are fine: a window past its close request already reports `closed`, so
    the second close hands over to a third window or, with none, parks as before.
  - The first design held the close in chrome, asked bento-tools to `tabs.move` the
    tabs, then `windows.remove`d the window, with timers on both sides. Two review
    rounds kept finding races that all came from two independently timed owners of
    one close (moves during a quit, a destination that starts closing mid-move,
    incoming moves outliving their destination, a beforeunload "Stay" against an
    unanswered prompt, cancellation recovery racing a second close). Do not add a
    hold, acknowledgement or timer between chrome and tools to the close; the
    synchronous swap is what removes them.
- Do not ask Firefox about a window that no event or listing has announced yet.
  `windows.get` accepts the id of a window that is still starting and then throws
  inside Firefox's own code while it builds the result
  (`ext-browser.js: this.window.gBrowser is undefined`, logged in the Browser
  Console), and `shell-action-intake` dropped the shell's first message (its
  `shell/hello`) when the lookup failed. The shell frame of a new window can send
  that message before the window has a tab browser. `createWindowRegistry` learns
  windows from `windows.onCreated` (Firefox sends it once the window has loaded) and
  from a `windows.getAll()` at startup, makes a message for an unannounced window
  wait for the announcement, and probes with `windows.get` once, only after 20 s
  without one. Do not shorten that wait to a second or two: a slow first window
  (a busy machine, the first window of a launch) announces after the old 1.5 s
  grace, and the dropped `shell/hello` is never sent again, so the window stays
  without a workspace. The waiter entries are removed as they finish, so windows
  that never announce do not accumulate.
- Do not adopt or assign unassigned tabs while startup is unsettled. A restored
  tab looks unassigned until `hydrateWorkspaceIds` has read its session value, and
  a persistent write before that replaces the real workspace. The boot backfill is
  in-memory only for the same reason; adoption additionally requires a window
  created after the settle, a fresh session read, and no stored value on any tab
  of the window (`tabsToAdopt`).
- Do not bypass `workspace/activate`. Per-window active state, conflict policy,
  single-window restart fallback, and SessionStore persistence live in
  `WorkspaceStore`.
- Do not mutate `useWorkspacesStore` directly from React components. Dispatch a
  protocol action and let tools broadcast deltas.
- Do not persist sidebar selection in tools or shell stores. It is transient UI
  state for the currently rendered tab list, and hidden workspace selections
  would make batch context-menu actions unsafe.
- Do not reorder folders with `BENTO_TAB_MOVE`, `browser.tabs.move`, or
  Firefox tab-strip APIs. Folder order is storage-backed metadata and only moves
  through `tabFolder/reorder`.
- Do not implement sidebar pin/folder drag by mutating shell stores directly.
  Drops must dispatch `tab/setPinned` or `tabs/setFolder` so Firefox pinned state
  and `bento.folderId` session persistence remain authoritative.
- Do not rely on Firefox to report a pending pinned tab as discarded, and do not
  drop the startup discard in `background.ts`. Firefox restores a pinned tab with
  a real browser (`createLazyBrowser` excludes `tabData.pinned`), so with
  `browser.sessionstore.restore_pinned_tabs_on_demand` on it is pending but
  `tabs.Tab.discarded` (`!linkedPanel`) is false, and the sidebar draws it as
  loaded until clicked. The discard must stay startup-only (`runtime.onStartup`):
  on a dev reload, install or update the pinned tabs may be loaded and in use. It
  must skip a window's selected tab and the panels of active workspaces, which
  would otherwise be unloaded and immediately re-materialized.
- Do not move the startup discard after `bootReady` or make it wait for
  `tabs.onUpdated`. Run from a `runtime.onStartup` listener that waited for
  `bootReady`, and discarding tabs one at a time, it ran after the shell had
  already received its first `tabs/snapshot` and painted: the pinned rows showed as
  loaded, then dimmed one after another as each `tabs.onUpdated` arrived. The pass
  has to finish inside `bootReady` (before the `bootReady.then` that sends
  `tabs/snapshot`, `tabFolders/snapshot` and `panels/sync`), discard in parallel,
  and call `TabRegistry.markDiscarded` for each confirmed tab so that snapshot
  already has the flag. Keep the wait capped, and keep reading each tab back
  before marking it: `tabs.discard` resolves when Firefox declines.
- Do not wake a pending pinned tab to read its metadata. `tabs.get`, `tabs.query`
  and `sessions.getTabValue` leave it pending; `tabs.reload`, `tabs.update` with
  `active: true` or `url`, `tabs.create` with its address, and
  `gBrowser.insertBrowser` load it and undo
  `browser.sessionstore.restore_pinned_tabs_on_demand`. Startup paths that
  select a tab load it, pinned or not, and static reading finds two that can
  select a pinned tab (not run in Bento): the boot fallback in `background.ts` and
  `handleWorkspaceActivation` select `wsTabs[0]` (the registry sorts by index, so
  a pinned tab comes first) when no tab of the workspace is active, which at
  startup means Firefox's selected tab is outside the workspace (a selected panel
  of it does not count as outside). The third path,
  `restoreParkedTabsForWorkspace` selecting the first parked entry that a live tab
  already showed, no longer runs for a workspace Firefox restored tabs for (see
  "Restart keeps what Firefox restored"); it still runs for a workspace shown
  later, whose tabs are loaded or discarded and report their address. If a pinned
  tab loads at launch without having been the selected tab, check those first;
  the startup discard skips the active tab, so it cannot unload a tab those paths
  selected.
- Do not replay parked tabs, or create, move or select any tab, at startup for a
  workspace Firefox restored tabs for, and do not decide it from `Tab.url`.
  `Tab.url` is `about:blank` for a restored tab that is still restoring (the
  selected tab, every pinned tab; no `pendingUrl` exists), so an address match
  misses it and `tabs.create` opens a second copy: the symptom was a duplicate
  tab where a moved tab used to be, a restored order that looked reverted, and the
  workspace's first tab selected instead of the one selected at quit. Every Cmd+Q
  parks every workspace of every closing window, so the lists always exist after a
  restart and must be dropped (`discardParkedTabsOfRestoredWorkspaces`), keyed by
  windows that came back from the session, before the boot backfill gives unassigned
  tabs a workspace. Do not count a tab of a window that did not come back from the
  session: a fresh start's window already holds a blank tab that can carry the
  active workspace, and counting it would drop the list of a workspace whose
  window was closed and not restored. Drop only on a real browser start
  (`browserStarted()`, the `runtime.onStartup` signal). After a tools reload a
  surviving window that received handed-over tabs counts as restored, and the drop
  deleted the list holding the tab the closed window could not move. A crash that
  restores only some windows is the one case this still gets wrong.
- Do not let an activation act after its window moved on. Activations held during
  boot resume together, and the handler awaits tab moves, parked-tab restores and
  tab reads before it creates or selects tabs; an old one (A) used to select an A
  tab after the window had switched to B. Keep `isCurrent()` after the hold and
  after each such await, and keep the `stillCurrent` guard before the selections
  in `restoreParkedTabsForWorkspace` and `activateNonPanelTab`.
- Do not run the workspace activation handler during boot before the restore has
  finished. `restoreFromSession` activates a restored window's workspace before
  `hydrateWorkspaceIds`, so an activation that runs at once sees restored tabs
  without a workspace: it reads the workspace as empty or finds no selected tab in
  it, and its panel restore runs before the session markers are read. Activations
  wait on `startupRestored` until `bootReady` has hydrated the tabs, dropped the
  parked lists and restored the panels; keep the release after the global
  workspace's panel restore and before the pinned-tab pass, which picks its tabs
  before the held activations resume.
- Do not treat a stale `bento.folderId` as authoritative in the renderer. If
  the folder metadata is absent from the current workspace, render the tab as a
  regular tab.
- Do not split workspace moves and folder clearing into separate tab deltas.
  Cross-workspace moves must clear folder membership atomically with the
  workspace change.
- Do not move folder member tabs with the default `tab/assignWorkspace` path.
  Folder moves must preserve `bento.folderId` while changing workspace id, then
  move the folder metadata to the target workspace.
- Do not handle folder context-menu actions after the chrome handler's
  `hasTabId` guard; folder menus have no tab id by design.
- Do not rely on the inline rename component alone for focus after native
  context-menu commands. Chrome can keep focus outside the sidebar frame, which
  leaves only a visual outline on the folder row and prevents immediate typing.
  Keep the chrome bridge's `content.focus()` handoff for `ui/*` actions and the
  shell-side retry/select logic together.
