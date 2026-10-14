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

Sidebar drag handling in `TabListPane` classifies tab drops before falling back
to anchor-based reordering. A drop in slot `0` or within the current pinned run
dispatches `tab/setPinned` with `pinned: true`; dropping a pinned tab outside
that run dispatches `tab/setPinned` with `pinned: false`. `bento-tools` owns the
actual mutation in `extensions/bento-tools/src/messaging/protocol-handler.ts`,
where `tab/setPinned` calls `browser.tabs.update({ pinned })` and clears any
stale `bento.folderId` membership through `TabRegistry.setFolder`.

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
- A tab Bento moves between windows itself must go through `moveTabsToWindow`.
  Only the move's own record distinguishes it from a drag when the window
  switched workspace before the attach event (`releaseAdoptedTab`). The record
  (tab id to workspace and destination window) is made before `tabs.move` because
  the attach events can arrive before its promise resolves, then trimmed to the
  tabs the move reports: `tabs.move` skips some (a pinned tab moved to the end),
  and a user dragging one of those out later must not read as Bento's move. An
  attach to another window than the recorded one discards the record, and it
  expires after 10 s if the tab never attaches.
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
