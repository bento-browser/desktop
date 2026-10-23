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
new emissions while existing notes complete their fade-out (each note removes
itself through `afterMotion` on its animation end, with a timer fallback sized from
the computed animation, so a note never outlives a changed duration). Menu particles use
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
on a single collapsed-width path. The token is rem-based and chrome's root font
size is not the shell's, so the chrome token sheet pins it in px (see
[Shell-sized lengths](../chrome-tokens.md#shell-sized-lengths)), and the mount sheet
rounds it to whole CSS pixels (`--bento-rail-width`, `round(..., 1px)`): the host is
52 px against the shell's 51.8 px reading, inside the rail switch's 1 px slack, and the
collapse choreography lays its rail read out at the rounded width. The host's width never transitions;
collapse and expand are the transform slide in
[Sidebar collapse and expand](#sidebar-collapse-and-expand).
Cmd/Ctrl+S is handled in `src/browser/base/content/bento-shell-mount.js` from a
capture-phase keydown listener because Firefox's `key_savePage` binding is
reserved for Bento. The handler reads `sidebarShortcutBehavior` from the latest
`BENTO_PANELS` payload. In `collapse` mode it toggles
`BentoSettings.sidebarCollapsed` and clears `sidebarHidden`; chrome shows the
change as the slide described below. In `hide` mode it
sets both `sidebarHidden=true` and `sidebarCollapsed=true`; the next shortcut
press clears both so the sidebar returns expanded. Both directions are the
slide described below; the hidden state itself is `.bento-sidebar-hidden` on
`#bento-shell-host`, `#bento-shell-splitter`, and
`#bento-shell-splitter-affordance`: it pins the host to the collapsed rail width,
cancels its hbox footprint with an equal negative right margin, translates the
rail off the left edge, and hides the splitter. A window capture
`pointermove`/`mousemove` handler (`attachHiddenSidebarHoverReveal`) toggles
`.bento-sidebar-hidden-revealed` while the pointer is within 12 px of the left edge or
over the host (host `pointerenter`/`pointerleave`, a short grace timer and window blur
hide it again), so the
collapsed rail slides over the content without changing the content layout. The slide
(`transform`, in and out through the one `.bento-sidebar-hidden` transition) runs on
the Mux `reveal` role's spring pair, 400 ms with no overshoot, like the push below;
there is no fade or delay, and `HIDE_GRACE_MS` (120 ms) is the pointer-leave grace
before the class goes, not a copy of a motion duration. A re-hover or a leave
mid-slide reverses the running transition from where it is.
While `sidebarHidden` is true, the divider, toolbar-navigation, and
bookmarks-toolbar alignment paths must treat the sidebar width as zero even
during hover reveal.
Expanded tab scrolling relies on the virtualizer's visible-range updates and
the native scrollbar. `TabListPane` reads the shell's rail visual state
(`useRailViewport`, the `data-bento-collapsed` attribute below) and skips its custom-scrollbar
pixel metrics, React state updates, and hide timer while expanded. Those updates
belong to the collapsed custom scrollbar, which remains responsible for thumb
position, hover visibility and pointer dragging. A layout effect synchronizes
current metrics when collapsing after an expanded scroll; the existing resize
observer keeps them current as the pane changes size. Expanding clears a pending
hide timer and scrolling visibility state. Keep the virtualizer, row slots,
active-tab reveal and folder anchoring independent of that pixel-only state.
Verify fine and large up/down direction changes, collapse at a nonzero scroll
position, thumb alignment/dragging, and return to expanded mode without a jump.

The end of the list can be covered by a floating sidebar card (the merge progress
card). `.bento-shell-app__list-region` holds `TabList` and the `SidebarCards`
container laid over its end; the container reports its reach (card height plus the
offset above the footer and the gap below the last row) to `useSidebarCardsStore`,
and `TabListPane` gives it to the virtualizer as `paddingEnd` and `scrollPaddingEnd`.
The padding is part of the virtualizer's total size, not CSS on the scroller, so
`getTotalSize()`, the viewport height, `scrollHeight` and the collapsed custom
scrollbar's metrics all include it; `scrollToIndex` for the active or revealed row
stops above the card. With no card the padding is 0. The search results list takes the
same inset as its end padding (`padding-block-end` on `.bento-tab-list-search__results`,
set inline from `useSidebarCardsStore`), and the cards sit above the pane's sticky bar
(`z-index` 4 against its 3), so a card stays visible and clickable over the results.
The results' `max-height` is the room from below the search field to the pane's bottom
edge: the pane is a size container (`container-type: size`, safe because `inset: 0`
fixes its size) and the rule reads `100cqh` minus what sits above the list. It was
`100vh` minus a row, which let the list run past the pane, whose `overflow: hidden`
clipped the last results (about 120 px at a 1004 px window) with or without a card.
Verify with a long list scrolled to its end, in the expanded sidebar and the
rail, that the last row clears the card, with the search open and a query matching
many tabs that the last result scrolls fully above it, and that the card appearing and
leaving moves no row it does not have to.

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
`useHoverHighlight.ts` (`useRowHoverHighlight`) positions it imperatively. Each
row wrapper carries `data-row-start` (the same offset as its `translateY`),
`data-row-indented` and `data-row-inert` (from `rowHighlightProps`). A delegated
`mouseover` on the viewport finds the wrapper under the pointer and sets the
highlight's inline `transform: translateY()` plus `data-indented` /
`data-visible`; `mouseleave` removes `data-visible`. Hover changes touch refs
and DOM attributes only, so neither `TabListPane` nor the rows re-render.
`TabList.css` does the rest: the fill is `--bento-surface-hover`, the height and
radius match a row, `data-indented` applies `--bento-tab-folder-indent`, and
`html[data-bento-collapsed='true']` makes it the centered square of the
collapsed rail. The slide (`transform`) and the opacity fade both run on the Mux
`state` role (120 ms, `ease`), chosen over `reveal` (200 ms) and `interaction`
(150 ms) from a side-by-side prototype, so the slide between rows is a stated
exception to `state` being a colour and opacity role. The slide exists only
under `[data-visible]`, so a fresh show appears in place and only fades in.
Width and margin do not transition: they follow the rail and the folder indent
at once. The action highlight stays on the `reveal` spring pair.
`prefers-reduced-motion: reduce` keeps only the fade.
Tab and folder rows no longer have a plain `:hover` background. Active rows are
opaque and cover the highlight, and selected rows are translucent and composite
over it.

The New and Search buttons of the action bar (`.bento-tab-list__new-actions`)
get a second, separate highlight with the same fill, so the two never share an
element and never cross the boundary between the bar and the list: leaving the
bar fades its highlight out while the list highlight fades in on the row under
the pointer. `useHoverHighlight.ts` holds one engine for both
(`useRowHoverHighlight`, `useActionHoverHighlight`); each supplies a target
selector and a `place` function. The action highlight is
`.bento-tab-list__action-highlight` (`aria-hidden`), the first child of the bar,
painted behind the positioned buttons. Its geometry is CSS's, not a measured
rect, because the Search trigger widens on hover and the New button shrinks with
it with a transition (see [palettes-and-address-bar.md](palettes-and-address-bar.md#sidebar-tab-and-panel-search)).
`place` sets `data-target` (`new` or `search`) and `TabList.css` gives each
target its final box from `--bento-tab-list-search-trigger-width`, the bar's
variable that holds the Search trigger's width right now: New is `left: 0` and
`100%` minus that width minus the bar gap; Search is at `100%` minus that width
with that width. The highlight transitions `left` and `width` with
`--muxui-semantic-motion-reveal-transition`, the same role the trigger, the
New button and the closed search field row use, so all of them land together.
A fresh show is
the one case that is not a pure CSS target: `place` writes the hovered button's
current box inline as the starting position (the trigger has only just begun to
widen), the hook flushes and sets `data-visible`, and `settleAction` removes the
inline `left` and `width` so CSS carries the highlight to the final box in step
with the button. Height, radius and fill come from CSS (`100%`,
`--muxui-semantic-shape-radius-s`, `--bento-surface-hover`). It is disabled
during a tab or folder drag, while the search field covers the buttons
(`searchOpen`), and while the New menu is open, so the button's open fill is not
stacked on the hover fill. In the collapsed rail the bar is one square holding
the New button and the Search trigger is `display: none`: the highlight is the
full square (`left: 0`, `width: 100%`, snapped, no geometry transition), and a
Search target with no box hides the highlight. Both buttons paint no hover fill
of their own (the Mux button hover override in
[../mux-ui-component-customisations.md](../mux-ui-component-customisations.md)).
`.bento-tab-list__new-action-button[data-bento-menu-open='true']` keeps its
`--bento-surface-active` fill, which paints over the highlight.

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
delay (one `state` duration, written as `calc()` over the Mux token so the motion
check sees no raw time; zero while the mask applies) so the title stays masked
while the buttons fade out.

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
row. For the action bar, hover New and Search and move between them (the
highlight glides, and once settled equals each button's box, including the
widened Search trigger), enter the bar directly over Search (the highlight
starts on the square trigger and widens with it, not already wide), leave the
bar, move from the bar into the first row (the two highlights cross-fade), open
Search (the highlight stays hidden), and toggle `data-bento-collapsed` on
`<html>` with the pointer still over New. Real Bento (the shell in the sidebar frame) still needs a manual
hover, scroll and pointer-exit pass.

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
takes the `runtime.onStartup` signal (`createBrowserStartup().browserStarted()`,
`tabs/BrowserStartup.ts`; there is no second signal). Firefox fires that event right after the background
script's first run (`background-first-run`, `ext-backgroundPage.js`), so on a
real start it has long arrived when the decision runs after the settle wait. When
bento-tools reloads under a running browser (Alt+Shift+R, or an install or update
while the browser runs) it does not fire, and then nothing is dropped, as before
this change: the lists stay and replay on the next activation, which waits for the
hydrate and so sees loaded tabs. That case is the reason for the gate. An update
picked up during the browser's own startup can keep the `APP_STARTUP` reason (the
add-on manager starts bootstrapped add-ons with it unless they were newly
installed or enabled, `XPIProvider.sys.mjs`), so the event can fire there; that is
a real start, and dropping the lists of restored workspaces is right. A window
that closed earlier in the session hands the tabs it can move to a surviving
window and parks the one it cannot; after a tools reload the surviving window
counts as restored, and dropping the list would lose that parked tab. If
`onStartup` has not arrived by the decision point, nothing is dropped either,
which falls back to that same behaviour (a possible duplicate instead of a lost
tab). One case remains: a crash
restart is a real start, so when it restores only some windows, a workspace with
a tab in a restored window still loses its list, even when the list holds a tab
of a window that closed earlier in the session and was not restored. That tab is
not replayed. The WebExtension `Tab.url` is `browser.currentURI.spec`
(`ext-tabs-base.js`). A lazily restored tab reports its session address from the
start, because the lazy browser's `currentURI` reads it from the session state. A
restored tab with a real browser, which is the selected tab and every pinned tab
(`Tabbrowser` skips `createLazyBrowser` for them), reads `about:blank` only until
SessionStore has set its saved address (`#restoreHistory` calls
`SessionStoreUtils.restoreDocShellState`, which sets it on the docshell before any
load); after that it reports the real address even while it is pending. The old
failures came from ordering: the replay and the activation ran before the restored
tabs were hydrated, so matching parked entries by address found none of the tabs a
user notices first.

Ordering matters as much as the rule. `restoreFromSession` activates each
restored window's workspace before the settle wait and `hydrateWorkspaceIds`, and
the activation handler (`handleWorkspaceActivation`) ran one frame later. It saw
only the restored tabs whose workspace was already known, so it could not tell a
workspace with restored tabs from an empty one, and it could find no selected tab
among the workspace's tabs and select the first. The handler now waits on
`startupRestored`, which `bootReady` releases (`releaseStartupActivations`) after
it has hydrated the tabs, dropped the parked lists, restored panels from their
session markers and restored the global workspace's panels. An activation that
arrives during boot, including a fresh window's `assignAvailable`, waits at most
the boot time; one that arrives after the release is a later activation and
behaves as before (parked list replay, selection, empty-workspace tab). A failed
boot releases the wait too.

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
A can wait while its window switches to B, and then both run. Each activation
takes the next generation of its window when it is requested, before it waits
(`createActivationGenerations`, `workspaces/ActivationGuard.ts`; the global
fallback counts as a window of its own, and a closed window forgets its number).
The handler revalidates after the hold and after each await that precedes moving,
creating or selecting a tab (the cross-window move, the parked-list restore, the
adoption read, and the tab read inside `activateNonPanelTab`), and goes on only
while it still holds its window's latest generation and the window's workspace is
still the activation's (`isActivationCurrent`, which asks `getActiveId` for the
window, or the global fallback when there is no window). The generation is what
tells A, B, A apart: the workspace matches for both A's, and an empty A would get
one new tab from each. Otherwise it returns without touching tabs or panels, and
the activation that replaced it does the work. A skipped activation leaves its
workspace's persisted panels unrestored until its next activation, which is what
a lazy workspace does anyway.

The parked-list restore takes the list before it awaits, so a superseded restore
must not keep opening tabs from it (`restoreParkedEntries`,
`panels/ParkedRestore.ts`). It asks `stillCurrent` before each entry; once
superseded it opens and selects nothing more, and the entries it has not started
go back into the parked list (`returnParkedWorkspaceTabs`, ahead of anything
parked since) for the next activation of the workspace to restore in the window
that owns it by then. Tabs it opened earlier are already assigned to the
workspace. The one whose create was still in flight when the restore was
superseded is handed to the window that owns the workspace now
(`findOwningWindow`, then `moveWorkspaceTabsToWindow`): a window that claimed the
workspace in the meantime has already run its own stray-tab move, so nothing
else would collect that tab. With no owner it stays, like any tab of a workspace
its window switched away from, and the next activation of the workspace moves it.
That claiming window found the parked list empty (the superseded restore had
taken it) and may show a new tab for the workspace until the next activation
restores the rest.

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
(`!nativeTab.linkedPanel`, `ext-browser.js`) reports it as `discarded: false`.
The extension API has no other sign of it. `tabs.Tab` has no pending flag, and
SessionStore sets the saved address on the browser before any load:
`#restoreHistory` runs `SessionStoreUtils.restoreDocShellState`, which calls
`SetCurrentURIForSessionStore` and fires a location change, so within moments of
the restore `Tab.url` is the real address and `status` is `complete`, and before
then it reads `about:blank`: no value of either tells a pending tab from a loaded
one. Only chrome sees the `pending` attribute
(`SessionStore.#restoreTab` sets it, `#markTabAsRestoring` clears it when the
content restore starts), so the mount script unloads these tabs
(`attachRestoredPinnedTabUnload` and `shouldUnloadRestoredPinnedTab` in
`src/browser/base/content/bento-shell-mount.js`), with
`gBrowser.discardBrowser(tab)` and no force. That swaps the pending real browser
for a lazy one, the same call the sidebar's "Unload tab" makes through
`browser.tabs.discard`. The tab keeps its session state, so selecting it loads its
page and history as before.

The signal is `SSTabRestoring`, which SessionStore dispatches on a tab as the last
step of its history restore: `#restoreHistory` waits for
`SessionStoreUtils.restoreDocShellState`, `onResolve` then runs
`#listenForNavigations`, and `#restoreHistoryComplete` dispatches the event. It
bubbles, so the mount script listens on its window. For a pinned target it waits
one task (`setTimeout(..., 0)`), checks the tab again, and only then discards it
(under the pref gate below) or, for a panel the window renders, loads it. Two facts fix that timing. `SSWindowRestored` fires before each
pinned tab's `restoreDocShellState` promise resolves, and a browser discarded by
then comes back: `onResolve` calls `#listenForNavigations` on the now lazy browser,
whose default getter re-inserts it (`#insertBrowser`, the "[bug 1345098] Lazy
browser prematurely inserted" path in `Tabbrowser.sys.mjs`), loaded, within
seconds. And the extra task lets a load that starts inside the dispatch clear
`pending` first (a lazy browser's `reload` listens for the same event, and
`#restoreTabContentStarted` removes the attribute), so the re-check skips that tab.

The unload therefore lands a few hundred milliseconds after `SSWindowRestored`: in
one dev launch `SSWindowRestored` was at 1555 ms and 25 discards fell between
1703 ms and about 1930 ms, all still unloaded 20 seconds later. At a startup
`sessionstore-windows-restored` follows `SSWindowRestored` at once
(`#sendRestoreCompletedNotifications`) and starts the bento-tools background page
(`ExtensionParent.browserStartupPromise`, `ext-backgroundPage.js`), so bento-tools'
first `tabs.query` can still report a pinned tab as loaded. The discards then reach
it as `tabs.onUpdated` changes (`TabBrowserDiscarded` makes the `discarded`
property change in `ext-tabs.js`, and `TabRegistry` forwards the difference), and
the rows dim shortly after they first appear. No message to bento-tools, readiness
gate or wait is involved.

The scope is every restore of a tab with a real browser, in any window: a startup,
a reopened closed window (`undoCloseWindow`), "Restore previous session" and
`setBrowserState`/`setWindowState`, all through `#restoreWindows`, and the restore
of a macOS app whose last window was closed. That one runs in
`#initializeWindow` (`#restoreLastWindow`): it calls `#restoreWindow` directly and
only notifies the `sessionstore-single-window-restored` observer, so it never
dispatches `SSWindowRestored`, but each pinned tab it restores still goes through
`#restoreTab` and `#restoreHistory` and dispatches `SSTabRestoring` (derived from
the source, not run in Bento). A pending tab has not loaded in this launch, so
nothing the user was using is unloaded, and a selected tab is never touched.

`shouldUnloadRestoredPinnedTab` accepts a tab that is `pinned`, carries `pending`,
is not `selected`, and is neither `soundplaying` nor `sharing` (hidden tabs
included, so the pinned tabs of workspaces the window is not showing are unloaded
too). `Tabbrowser.#mayDiscardBrowser` (without force) also refuses a
selected or closing tab, a tab with an open dialog or a `beforeunload` handler
that vetoes, and a tab that is already lazy (its browser is not connected), but not
an audible or sharing one, so those two checks are Bento's. The unload acts only
while `browser.sessionstore.restore_on_demand` and
`browser.sessionstore.restore_pinned_tabs_on_demand` are both true
(`pinnedRestoreOnDemand`), the condition under which `TabRestoreQueue.shift` and
`willRestoreSoon` leave pinned tabs pending. With either pref false the queue
loads pinned tabs in turn, and the ones it has not reached yet are `pending` after
the restore too; discarding one removes it from the queue
(`#cleanUpRemovedBrowser` ends in `#resetLocalTabRestoringState`), so it would
never load at startup. With the gate,
turning the pref off unloads nothing. A failure logs
`[bento-shell-mount] restored pinned tab unload failed` and never throws.

Panels the window already renders are not unloaded; they are loaded
(`currentPanelTabIds`, the tab ids of the active workspace's panels from
`panels/sync`). At a startup bento-tools sends the panels after its boot, a few
hundred milliseconds after the restore, which is about when the pinned tabs' own
restores resolve, so a panel tab is found rendered only when `panels/sync` has
arrived by then. A pinned tab that backs a panel and was unloaded first is found by
the reconciler with no `linkedPanel`: `materializePanelTab` calls `insertBrowser`
and, because it had to materialize the tab, `reload()`, so the panel loads and
renders as before. Unloading first costs one extra reset of a tab that had not
loaded, so keep the reload on materialization (see
[chrome-panel-rendering.md](chrome-panel-rendering.md)).

A rendered panel that is still `pending` when its `SSTabRestoring` task runs is
loaded by the same handler, with `tab.linkedBrowser.reload()`
(`shouldLoadRestoredPinnedPanel`: pinned, `pending`, with a `linkedPanel`, and a
rendered panel). Nothing else would load it. `materializePanelTab` reloads a pending
tab only when it had to insert the browser or its address is still blank; a pinned
tab has a real browser and, once `restoreDocShellState` has set its saved address,
a real address, so a panel rendered between that and the discard task has both
conditions false, and the unload skips it because it is rendered. The panel would
stay blank. That is most likely in a window opened while the shell is already
running (a reopened closed window, a second window, the macOS last-window reopen),
where the panels are already known when the tabs restore. The reload works because
`onResolve` in `#restoreHistory` registers `#listenForNavigations` immediately
before `#restoreHistoryComplete` dispatches the event, and the listener's
`OnHistoryReload` calls `#restoreTabContentForBrowser`, which treats a load that
SessionStore did not start in a pending tab as the start of the restore, removes
`pending` and loads the saved history entry (derived from the source, not run in
Bento). A reload issued before `onResolve` (the `about:blank` branch of
`materializePanelTab`) finds no listener, so `NotifyOnHistoryReload` does not veto
it and the docshell reloads on its own; whether that loads the restored history
entry was not run. It can leave `pending` set (the listener only sees a load that
starts after `onResolve`), which is why the handler reloads a rendered panel that is
still `pending` instead of trusting an earlier reload. This
branch does not check the restore-on-demand prefs: a rendered panel must be loaded
whichever they are, and a tab the `TabRestoreQueue` has already started is no longer
`pending`. Only the discard waits for `pinnedRestoreOnDemand`.

An unloaded tab reports
`discarded: true` (`TabSnapshot.discarded`), the row shows in the sleeping style,
and `SleepPolicy` skips pinned and discarded tabs, so the idle sweep never puts a
woken pinned tab back to sleep.

Source of truth: SessionStore in the parent process; persistence path:
`sessionstore-backups/recovery.jsonlz4`; no Bento store reads or writes the pref
or the `pending` attribute. Pinned-panel backing tabs are native pinned tabs too.
Manual check: see [manual-regression-areas.md](manual-regression-areas.md).

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

## Sidebar collapse and expand

State and bridge: tools owns `BentoSettings.sidebarCollapsed` and `sidebarHidden`;
the shell mirrors them and sends them back to chrome in the `BENTO_PANELS` title
payload; `applyChromeSidebarCollapsed` in `bento-shell-mount.js` receives them and
`bento-shell-mount.css` ("Sidebar push") animates. Nothing is persisted by the
slide. A toggle is the setting changing; every other payload repeats the same
value and does nothing.

A private window does not use the saved values: its collapsed and hidden state (and
its colour mode) are its own, held by the shell background and substituted into the
settings its documents receive, so the same payload path applies them to that window
only. See "Window-local sidebar state" in [shell-chrome-bridge.md](shell-chrome-bridge.md#private-windows-the-bentoshellbus-relay).

The slide ("push") makes the sidebar and the page one strip. Layout changes once
per toggle, only `transform` animates (the strip does not fade; the rail colour does,
see "Rail colour" below), and every slide (the host, the
shell frame, the page group, the bookmarks toolbar, the divider, Back/Forward/Reload and
the band) runs on the Mux `reveal` role's spring pair: `--muxui-semantic-motion-reveal-transition-spring-duration`
(400 ms) and `-spring-easing` (a sampled `linear()` curve, bounce 0, so no
overshoot), written as separate values in the `animation` shorthand. The keyframes
are `from`/`to` only, so the curve applies once over the whole move; Bento has no
motion tokens of its own. To go back to the plain `reveal` pair (200 ms, `ease-out`),
change the spring tokens in the `:root[bento-sidebar-push...]` block of
`bento-shell-mount.css` to `reveal-transition-duration` and `-easing`. `delta` is the
host's width (expanded, or the rail's for a hide from the rail)
minus the layout space the host holds at the narrow end (the rail, or 0 when the
sidebar was hidden or is being hidden).

The root attribute `bento-sidebar-push` names the direction: `collapse` (expanded to
rail), `expand` (rail to expanded), `hide` (to hidden) and `show` (the expand out of the
hidden state, `delta` the whole expanded width). Every `expand` rule in the sheet also
names `show` except the shell-document ones below (a test keeps it that way).

- The host keeps its width for the whole slide and holds only the narrow
  end's layout space through `margin-right: -delta`, stacked over the page
  (`:root[bento-sidebar-push]`, `z-index: 5`). The page lays out once, at its final
  geometry. The one exception to "host over page" is `#bento-strip-container`
  (`:root[bento-sidebar-push] #bento-strip-container { z-index: 6 }`): it is the stacking
  context that holds the main frame, the panel frames and their drop shadows
  (`--bento-panel-frame-shadow`, about 40 px wide beside the card), and that shadow spills
  left into the host's area. Stacking the strip one level above the host keeps the shadow
  painting over the host exactly as it does outside a push (the strip's `z-index: 1` over
  the host's `auto`), so its width and darkness do not change during the slide or at the
  settle, in both the no-side-panels view and the panel view, and with the Panel shadows
  setting off nothing is added. The page group abuts the host's moving edge (same keyframe
  timing, opposite directions), so the strip's opaque background covers none of the host.
  The splitters and the affordance (pointer events off for the slide), the chrome divider
  line (`z-index: 3`) and the host with its `::after` edge line keep their levels; the
  hidden host's reveal (`z-index: 7`) is outside a push and unchanged; the overlay hosts
  (`z-index` 99994 and up) stay above everything.
- The page group is every in-flow child of `#browser` right of the host (the
  splitters, a native sidebar, the panel strip), found by computed style rather
  than a fixed id list, plus the splitter affordance and `#PersonalToolbar`
  (which starts at the strip's left edge). The overlay hosts and the hidden hover
  zone are absolute and stay put.
- Collapse: the host goes from `translateX(0)` to `translateX(-delta)` and the page
  group from `translateX(delta)` to 0, so nothing moves at the first frame. The host
  keeps its expanded width for the whole slide; when the slide ends, one style change
  snaps it to the rail (the collapsed class, margin and transforms gone). Expand
  mirrors it: the host is widened and margined at once, starts at `translateX(-delta)`
  while the page group goes from 0 to `delta`; the end drops the margin and transforms in
  one frame, so the page lays out once to its narrower geometry. The shell relies on
  both timings (the host is as wide as the expanded layout for the whole slide).
- The shell document stays still while the edge moves (collapse and expand only).
  `:root[bento-sidebar-push='collapse'|'expand'] #bento-shell-host` clips its content
  (`overflow: clip`, which works on the XUL vbox with the remote `<browser>` child), and
  `#bento-shell-host > #bento-shell-frame` animates the opposite translation on the same
  keyframe timing (`bento-sidebar-push-frame-collapse`: 0 to `delta`;
  `-frame-expand`: `delta` to 0). Host and frame run as two compositor animations with
  one start time, so their translations sum to 0 on every frame and the shell's pixels
  never move: a collapse clips the stationary document from the right as the strip
  narrows, an expand reveals it as the strip widens. While the document is wider than
  the visible strip, its own right border (`border-inline-end` of `.bento-shell-app`, 1px
  in `--bento-sidebar-divider-color`) is clipped away, so `#bento-shell-host::after`
  draws a 1px line in the same colour at the host's right edge for the slide
  (`:root:not([bento-no-side-panels='true'])`, since the shell's border is transparent
  without side panels). It is a pseudo-element on the host, so it moves with the host on
  the compositor, and it lands where the shell's border is at the settle frame (the last
  pixel column of the rail, or of the expanded host), so nothing changes then.
- Rail colour (collapse and expand only; hide and show switch at once). The rail is one
  surface with the window controls and the gap around the page when the window has side
  panels, so its colour is the toolbar's main colour (`--bento-toolbar-main-bg`, defined
  once in `bento-tokens.css`, neutral-5 with no side panels, where nothing changes). Chrome:
  `bento-sidebar-rail` on the root is the target state (the host is, or is sliding to, the
  rail). `applyChromeSidebarCollapsed` sets it from the collapsed target: in
  `startSidebarPush`, next to the `bento-sidebar-push` attribute and after the toolbar
  commit's layout reads (so one style change carries both and every colour starts from where
  it was), at the settle, and on the instant path. A hide leaves it for the settle, since the
  sidebar leaves. `:root[bento-sidebar-rail]` makes `--bento-toolbar-sidebar-bg` the main
  colour, which the window, `#browser` and `#appcontent` gradients read (they switch at once;
  the host covers them) and `#bento-shell-host`'s background follows (`transition:
background-color` on the spring pair while a collapse or expand runs). The toolbar
  surfaces (`#navigator-toolbox`, `#TabsToolbar`, `#nav-bar`) read a registered `<color>`
  property, `--bento-toolbar-left-bg` (`@property`, not inherited), because a gradient
  stop cannot transition: it is `--bento-toolbar-sidebar-bg` and is transitioned on the same
  pair, so the colour left of the split fades with the slide and only those elements
  restyle per frame. The `#nav-bar::before` band takes it with `inherit` (it is created at
  the push start, so a transition of its own would have nothing to start from) and follows
  the toolbar's value. The chrome divider line (`#bento-sidebar-chrome-divider`) fades to
  `transparent` in the rail look, and the host's edge line (`#bento-shell-host::after`)
  fades out with a collapse and in with an expand through opacity animations (the
  pseudo-element is created at the push start, so a transition could not start from the
  other colour); both end states then have no line, and the shell's own right border is
  transparent in the rail look (below), so nothing appears or vanishes at the settle.
  Shell: the rail look is `--bento-brand-bg` (and `--bento-surface-hover-solid`, its
  composite) re-pointed at `--bento-toolbar-main-bg` on `.bento-shell-app`, with the right
  border transparent, when the phase is `collapse`, or `data-bento-collapsed='true'` and
  the phase is not `expand` (app.css), so it follows the target like chrome (the shell
  starts a collapse about 30 ms before chrome and chrome an expand about 30 ms before the
  shell). The app, header, workspace switcher, list region (painted always, so it has a
  colour to leave) and footer paint `--bento-brand-bg`, and `railTransition.css` declares
  `transition: background-color` on the spring pair on them only while
  `data-bento-rail-transition` is present, `measure` included: an expand drops
  `data-bento-collapsed` in its measure step, and the colour must start leaving the rail in
  that flush. Theme and mode changes happen without the attribute, so they stay instant.
  The footer backdrop (`::before`, created at the phase start) takes `background-color:
inherit` from the footer, which is what fades. The tab list band and the workspace
  switcher square move to `--bento-rail-band-fill` and `--bento-rail-square-base` (neutral-18
  with side panels, reset in `.bento-shell-app--no-side-panels` to neutral-12 and neutral-5,
  the old values), constant rather than following the look: the rail band
  (`::after` in a phase) and the square (`::before`) are the rail's own parts and must keep
  their colour while they fade out in an expand.
- The sequence is `startSidebarPush` and `settleSidebarPush`; the end is
  `afterMotion` on the host's slide animation (never a copied duration): it reads the
  animation's computed duration and delay, 400 ms with the default tokens, and waits
  for that animation's `animationend` or a timer 50 ms past it. It ignores the timing
  function, so the `linear()` spring changes nothing in script.
  `settleSidebarPush` is also the interruption: a toggle during a slide settles it at
  its final state first (margin, transforms, classes, root attribute and custom
  properties all gone), then starts the new slide from there.
  The first apply at boot, `prefers-reduced-motion: reduce`, an unmeasurable rail
  and any toggle that stays hidden switch instantly, as before. Under reduced motion
  the hidden rule's own transform transition is off too
  (`@media (prefers-reduced-motion: reduce)` after the hidden rules), so hide, show
  and the hover reveal are all instant.
- Hide is a collapse to a narrow end of 0 (`:root[bento-sidebar-push='hide']`, the
  same keyframes), and show is the matching expand (`'show'`, the expand keyframes).
  Hide and show move the host alone: no frame counter-translation, no clip, no edge line,
  no fade. Hide mode keeps `sidebarCollapsed` true, so a sidebar that is a
  rail already hides with no collapsed change: `applyChromeSidebarCollapsed` starts the
  slide for the toggle into the hidden state, not only for a collapsed change, and
  `applyChromeSidebarHidden`, which the payload runs next, leaves the host's class to
  the slide. The host keeps the width it has (expanded or rail) and the page lays out
  at its final geometry at the start; the splitter and its affordance take their hidden
  state at once for that reason. The host is completely out of the window at the far end
  (the end of a hide, the start of a show), so the switch between the shell's expanded
  and rail layouts is unseen there. `settleSidebarPush`
  puts `.bento-sidebar-hidden` and `.bento-sidebar-collapsed` on in the one style
  change that drops the transforms, with the hidden rule's transform transition held
  off for that change (an inline `transition: none`, restored after a layout flush),
  and hides the divider line. The end state is the one a boot into the hidden state
  has. The hover reveal and its own transform transition (the spring pair, as above) are
  unchanged, except that `reveal` ignores the pointer while a push runs, so a pointer at the left edge cannot
  leave the revealed class waiting for the class that lands at the end. Showing out
  of the hidden state is a `show` push with `delta` equal to the whole expanded width.
- The expanded width is computed (inline width inside the min and max the sheet
  pins), not measured: measuring would flush layout at the intermediate geometry
  and hand the page's browsers a size they never keep.
- The toolbar band follows the same edge. `commitToolbarForSidebarPush` commits its
  final geometry at the start through the hooks the sidebar splitter drag drives
  (divider, toolbar split, Back/Forward/Reload offset, bookmarks offset), and the
  CSS slides each from where it was: the divider line by transform; Back, Forward,
  Reload and the panel navigator by a transform from the old offset to the new one
  (the same transform mode a live drag uses, margin back at the end); the toolbar's
  sidebar-coloured segment, whose boundary is a gradient, by a `#nav-bar::before`
  that covers the difference between the old and new split. The backgrounds behind
  the host keep the wider split for the slide. The bookmarks toolbar is positioned
  by a margin and slides with the page group, whose layout is the final one on a
  collapse and the initial one on an expand, so a collapse commits its offset at
  the start while an expand keeps the initial offset and applies the final one in
  the frame the push settles. The hooks read the host through
  `sidebarHostLayoutBox`, which removes the host's own translation and measures the
  strip's inset from the host's margin box, so a push out of the hidden state
  (host parked at `translateX(-100%)`, margin-right `-rail`) prepares from the
  layout origin. A hide commits the hidden toolbar (hooks run with the hidden flag
  set: no navigation offset, bookmarks offset 0, split 0) and a push out of the hidden
  state a shown one. The divider line is 1 px just left of the strip's edge; where it
  is absent at one end it counts as at the edge of a strip at 0 (`-1`), so its shift
  is the whole delta in or out. A hide lays it out at `-1px`, shown, and
  `settleSidebarPush` hides it.
- While `bento-sidebar-push` is on the root, `isBentoChromeLiveResizing()` is true,
  so the divider, toolbar navigation, bookmarks alignment, affordance and strip
  scrollbar observers hold off. Their pending animation frames are cancelled when a
  push starts (a settle that interrupted the previous slide queued them) and each
  frame callback checks `isBentoSidebarPushing()` itself, since the scheduling
  guard only runs when the frame is queued. The bookmarks toolbar's mutation
  observer, which the push's own class change triggers and which bypasses that
  guard, skips the offset read while a push runs and still updates the height. The end runs one refresh: the settled event, the
  flat panel layout, splitters, overlays and strip scrollbar against the final
  untransformed geometry.
- Audit of reads that can run during the slide. Group-internal geometry
  (`syncInterPanelSplitters`, `computePanelLayoutGeometry`, `viewportRectForLayoutRect`)
  is translation-invariant: widths and `clientWidth` ignore transforms, and
  positions are differences between rects under the same transformed ancestor, so
  the flat layout the `#tabbrowser-tabpanels` observer computes at the first layout
  is already final. Reads that mix the group with the host, toolbar or window
  (`rectOverlapsBentoSidebar`, the toolbar updaters, popup anchoring from
  `getBoundingClientRect`) describe the painted geometry at that instant and are
  redone at the end; interactions during the 400 ms are not guarded.
- Shell: the rail layout is `data-bento-collapsed` on `<html>`, and it follows the
  width the shell is rendered at. `observeRailViewport`
  (`extensions/bento-shell/src/sidebar/railViewport.ts`) watches the app root with a
  `ResizeObserver` and sets the attribute in the same frame the viewport is at most
  `--bento-tab-strip-width-collapsed` (plus 1 px of slack for the frame's
  whole-device-pixel rounding) wide, so chrome's width snap alone switches the shell:
  at the end of a collapse, at the start of an expand. The setting only drives what is semantic: the footer toggle's label, icon
  and the tooltips. Components that need the state in script (`TabList`'s scroll
  metrics) read the attribute through `useRailViewport`. Hidden mode also renders at
  the rail width.

Shell choreography ("Cascade"). While chrome slides the host and counter-translates the
frame, the shell's contents move between their expanded and rail places, so the rail
appears by reorganising instead of fading. The shell's settings mirror receives a toggle
before chrome does (`App` dispatches `settings/update`; the same `BENTO_PANELS` payload
reaches chrome later), and the choreography persists nothing.

- The phase is its own state, separate from the setting and from the rail visual state:
  `data-bento-rail-transition` on `<html>` is `collapse` or `expand` while one runs, and
  `measure` around the synchronous reads and the settle (transitions off, no visuals).
  `createRailTransition` (`extensions/bento-shell/src/sidebar/railTransition.ts`) owns
  it; `App` feeds it the settings mirror from a layout effect (the first snapshot is the
  boot state and starts nothing) and gives it the `observeRailViewport` callback, so the
  controller also writes `data-bento-collapsed`. `createRailTransitionDom`
  (`railLayout.ts`) is its DOM side: reads, offsets, delays, the end wait.
- Collapse starts on the setting flip, before chrome moves (about 30 ms before the push
  in a build), unless the change enters or leaves the hidden state, reduced motion is on
  or the shell is already the rail. With transitions off it reads the expanded boxes,
  lays the shell out as the rail for one synchronous read (the app root at
  `measureRailWidth()` rounded to whole pixels, the host's settled rail width, with
  `data-bento-collapsed` set (which also drops the root's divider border width, so its
  content box is that whole width, as in the settled rail), then both restored, and the list's `scrollTop` put back if
  the shorter rail list clamped it), writes the offsets and the per-row delays, and sets
  the phase. The layout stays the expanded one; every element animates to its rail place
  and holds it. The phase ends in the resize-observer callback that sees the rail width
  (about 25 ms after chrome's settle): offsets and phase cleared and
  `data-bento-collapsed` set in one style change, with transitions held off until that
  style is flushed. The frozen end equals the rail, so the switch is not seen. If the
  viewport never narrows, a timer (`afterMotion` on a `bento-rail-hold` animation of
  twice the spring duration) settles at whatever width the viewport last reported.
- Expand records the rail boxes at the setting flip while the shell is still the rail,
  and starts in the resize-observer callback that sees the wide width (chrome widens the
  host at the start of its slide; the resize reaches the shell about 30 ms later):
  `data-bento-collapsed` cleared, expanded boxes read, offsets written and the phase
  set, all before paint, so the first frame is the rail. The scroll position the
  shorter expanded list may clamp (an expand from the bottom of the rail) is in the
  expanded read and carried by the list viewport's offset, so rows still start at their
  rail places. It ends with `afterMotion` on the hold animation (one spring duration).
- Interruption mirrors chrome: a toggle during a phase settles it at its end state and
  starts the new one. An expand during a collapse never gets a resize (chrome settles
  at the rail and widens in one go), so it starts at once from the rail boxes the
  collapse measured. A rail width reported during an expand (chrome's collapse ended
  after the shell's expand began) shows the rail and waits for the next widen.
- Offsets: positions are rounded to device pixels before differencing (a translated icon
  then lands on the pixel its settled layout snaps to; exact fractional offsets blurred
  it, see the pitfalls), and each offset
  is relative to the nearest moving ancestor (main column, list region, scroller,
  list viewport for the scroll change, row). Rows share geometry: one plain tab row, one
  folder child (indented) and one folder row are measured and their offsets go on the
  app root as inherited `--bento-rail-*` properties the row rules read; when the window
  holds only one kind of tab row, the other's offsets are derived from it and the
  `--bento-tab-folder-indent` width, which the rail drops. Single elements get inline
  `--bento-rail-x/-y`. The
  per-row and footer stagger delays are inline `animation-delay` values over the spring
  token (see the Motion section of `mux-ui-component-customisations.md`). Cost is one
  read of a few boxes plus one box per rendered row at the toggle; nothing runs per frame
  and nothing lays out during the slide. With 300 tabs at 60 Hz, shell frames during a
  phase were 16.7 ms (none over 20 ms); visible moves and fades run on the compositor
  except the list viewport (too tall for it, and still unless the scroll position
  changes) and rows in the overscan outside the scroller's clip.
- Rendering (`railTransition.css`): the list region rises over the address bar as one
  opaque layer above the header, with the New bar's own background off so the rising
  rows show under its lower padding; the footer stays above with a backdrop
  (`::before`, the rail footer's height, carrying the divider) that rises from the
  expanded footer; a private window's band slot (`.bento-shell-app__workspace-switcher--private`)
  is lifted to `z-index: 4` for the phase only, since the band keeps its solid fill and the
  rising list region and folding address bar would otherwise paint over its lower edge (the
  footer, also 4, comes later in the document); the switcher's fill fades while the rail square fades in under the
  moving avatar; the active row draws a cap the size of the rail square over a tail that
  retracts under it, clipped by the row; folder outlines and the pinned and folder band
  cross-fade to the rail square; the hover and action highlights are hidden. The
  `transition: none` rule on the switcher trigger and tab rows keeps their background
  transitions from animating the phase's own background changes, and the list scroller
  has `overflow-anchor: none` for the phase.
- What React mounts in the list region during a phase (a workspace switch swaps the tab
  list pane; the virtualizer can add rows) is caught by a `MutationObserver` on the
  region that lives only for the phase: a new pane's scroller, viewport and New icon get
  the phase's offsets, and every phase animation in the added subtree is finished
  (`finishAdded` in `railLayout.ts`), so it holds the phase's end state (the rail places
  in a collapse, the expanded ones in an expand) instead of starting late and still
  moving at the switch.
- The Downloads anchor (`observeFooterButtonEdges`, `sidebar/footerAnchor.ts`) skips
  readings while `data-bento-rail-transition` is on and measures again when it goes:
  the footer resizes at the start of an expand while the buttons are still translated
  at their rail places, and nothing resizes when the translation ends.
- Known snaps at the switch, not choreographed: a multi-selected (not active) row's
  tint and outline, an audible or muted row's favicon (the speaker control moves it, and
  the shared row offset does not know), an open sidebar search and sidebar cards (both
  fade out and the rail form appears at the switch), the footer toggle's icon, which
  follows the setting, and the active row's highlight when a collapse starts in a
  workspace with no tab rows and a populated workspace mounts before the switch (the
  stored row offsets are zero, so the new rows hold their expanded form). The rail's
  content box is the host's whole 52 px (`app.css` drops the divider border's width in the
  rail), so the avatar, rail squares, New icon and rows sit on whole pixels (x 10, 18) at
  any device pixel ratio. What stays at a ratio of 1: the footer buttons' expanded places
  are fractional (x 108.3, 145.5, 182.7 ...), so their held end differs from the rail by up
  to 0.5 px in layout while painting on the same pixel, and the active row's square
  corners and a favicon's sampling differ by a few anti-aliased pixels (46 to 54 in the
  rail strip, see the pitfalls). With
  pinned panels (39.6 px wide) the main column sits at a fractional x and row text
  renders at another sub-pixel offset for the whole phase. At a ratio of 2 the collapse
  end frame matched the settled rail exactly.
- Hide, show, the hover reveal, the first apply at boot and reduced motion run no phase:
  the viewport alone switches the layout.

Ladle: the story "App / Collapse choreography (chrome push)" reproduces the push (host
clip and frame counter-translation on the same tokens, chrome starting after the shell's
commit, settle on `afterMotion`), with slow motion, pinned panels, a folder, an active
row and a long list; `dir=collapse|expand&t=<ms>` freezes a frame (the motion tokens are
scaled 100x first, so no end timer fires while frozen), `state=rail`, `pinned=1`,
`panels=none` (no side panels: the rail stays on the brand background) and `scroll=<px>`
set up the other cases. The story's window paints chrome's main colour around the page and
reproduces the host's fading edge line, so the rail look and its fade are visible there;
"App / Collapsed (narrow rail)" and "App / Collapsed, no side panels" are the static pair. In a Bento build, the checklist in
[manual-regression-areas.md](manual-regression-areas.md) (the collapse choreography
item) and the manual verification below.

Manual verification (a Bento build; the unit tests cover the sequencing only):
in the collapsed rail, the host's computed width is the shell's `measureRailWidth()`
(51.8 px) rounded to whole pixels (52 px), the app root is 52 px wide with no border
(`getComputedStyle` `borderInlineEndWidth` is `0px`; the avatar frame, rail squares and tab rows start at x 10),
the New button is centred in the rail, and the pinned and folder band
behind the folder squares is 32 px wide; collapse and expand with Cmd+S at the
default width and after resizing the sidebar to its minimum and maximum; press Cmd+S repeatedly (ten times, quickly, then wait):
the sidebar, page, toolbar band and footer end in the last state with no stuck
offset, opacity or class (`document.documentElement.hasAttribute('bento-sidebar-push')`
is false in the Browser Toolbox Console); with panels open, the panels are aligned
with their splitters after each toggle; with the bookmarks toolbar shown; in hide
mode, hide from the expanded sidebar and from the rail (the page, toolbar controls and
divider slide with the sidebar, the sidebar does not fade, the final frame has no jump),
hover-reveal, and show (the divider enters with the strip's edge, not static at its final
position), Cmd+S again mid-slide in both directions, and ten quick presses; with the OS
reduced-motion setting on (no slide; in hide mode the hide, the show and the hover
reveal are instant, with no rail slide over the page after the page has moved);
collapse and expand with side panels open and with none (`bento-no-side-panels`): the
shell's pixels do not move while the strip's right edge slides, the strip does not fade, a 1px
line in the sidebar divider colour follows the edge (absent with no side panels) and fades
out with a collapse and in with an expand, and the frame after the settle matches the last
frame before it at the edge column (with a shell that reorganises during the slide, the
rest of the sidebar too); hide and show are a plain slide (no clip, no line, no frame
animation); the rail colour: with side panels, the collapsed rail, the window controls and
the gap around the page are one colour with no line on the rail's right edge, the toolbar's
left segment, the host, the divider and the edge line fade together with the slide (raise
the spring tokens as above and read `--bento-toolbar-left-bg` and the shell's
`.bento-shell-app` background at several `currentTime` values), the tab list band and the
workspace switcher square are neutral-18, with no side panels the rail stays neutral-5 and
nothing changes colour, and hide, show, boot, reduced motion and theme or mode changes switch
the colour with no fade, in every theme, light and dark, and with contrast "more";
to watch a push slowly, raise `--muxui-semantic-motion-reveal-transition-spring-duration`
on the chrome root and on the shell's `<html>` (the plain `-reveal-duration` no longer
moves it; the hover reveal's slide-over runs on the same token; scale the `state` and
`dismiss` durations by the same factor to keep the shell's fades in step). To freeze a
frame, use the raised tokens and set `currentTime` on `document.getAnimations()` in both
documents after pausing them (Browser Toolbox Console for chrome, a frame script for the
shell), then screenshot; pausing alone is not enough, see the pitfall on the settle timer.
In a build,
`document.getAnimations()` during a push lists the host's and the frame's slide with
`isRunningOnCompositor` true for both, and the two translations sum to 0 on every frame; hover the left edge of a hidden sidebar and
move away: the slide-over takes the spring duration each way, with no overshoot, and a
re-hover mid-slide reverses it smoothly; cold start collapsed and expanded (no animation); a long tab list scrolled
partway, collapsed and expanded (the custom scrollbar matches the rail).

## Private window workspace

Each private window has one temporary workspace named "Private". It exists to give
the window's tabs an owner without letting a private window touch the persisted
workspaces.

- Source of truth: `WorkspaceStore.#privateByWindow` (`workspaces/WorkspaceStore.ts`).
  It is a separate map on purpose, so every loop over the persisted workspaces
  (snapshot, persistence, fallback and replacement picks, ownership) is regular-only
  by construction. `ensurePrivate(windowId)` creates it, `forgetPrivateWindow` drops
  it. It is created when tools first sees the window announced as private
  (`createWindowRegistry`'s `onWindow` hook, before the window counts as live, so no
  message for it is handled earlier) and again on the window's `shell/hello`; it is
  discarded on `windows.onRemoved`. After a tools restart the next `shell/hello`
  recreates it with a new id and the window's private tabs are adopted into it.
- Id: `private:<uuid>`. `isEphemeralWorkspaceId` (`workspaces/ephemeral.ts`) is the
  one predicate every persistence boundary asks: `WorkspaceStore` (never in
  `snapshot()` or `persistCurrentState`), `panels/Persistence.ts` (layouts, main
  widths, strip scroll), `tabFolders/Persistence.ts`, `pinnedPanels/Persistence.ts`,
  `PanelMarkerSync.sync`, `parkTabsForClosingWindow`, and `TabRegistry.assignWorkspace*` (no `bento.workspaceId` session value).
  Window values (`bento.activeWorkspaceId`) are never written for a private window.
- Membership: a private tab is never assigned like a regular one (ordinary assignment
  and adoption skip it). It joins its window's Private workspace in memory when it is
  created, when the workspace is created (existing private tabs), and when it moves to
  another private window (`browser.tabs.onAttached`).
- Audiences: the Private workspace, its tabs and its `panels/sync` reach only that
  window's documents; regular documents never see them, and a private window's lists
  show only its own Private workspace (no pins or folders). Tools sends them wrapped
  in an `AudienceEvent` (`messaging/audience.ts`; the tab delta batch is split with
  `TabRegistry.privateWindowOf`, decided when the delta is queued because a removed tab
  is already forgotten at delivery). Snapshot requests are answered to the audience
  of the asking window.
- Chrome-bound changes: chrome learns the sidebar collapse, colour mode and other
  settings from the `BENTO_PANELS` payload of a `panels/sync`, so a settings or
  saved-panels change re-fires `panels/sync` for `WorkspaceStore.shownWorkspaceIds()`
  (the global fallback, each window's active workspace and each private window's
  Private workspace). Walking `getActiveIdByWindow()` alone is regular-only and leaves a
  private window's chrome on the old collapse state and colour mode (the sidebar frame
  changes, the host does not). The sleep policy's protected panel tabs use the same set.
- Audience of a `panels/sync` is decided before its reads await (`sendWorkspaceEvent` in
  `messaging/audience.ts`) and checked again after: a private window can close while
  `browser.tabs.get` is pending, which forgets its Private workspace, and a lookup after
  the await would then call its panels regular and send their URLs and titles to every
  regular window. An ephemeral workspace whose window is gone sends nothing.
- A tab moved between two private windows (`TabRegistry.#onAttached`) is a `removed`
  delta to the old window's documents and a full `created` to the new window's: each
  keeps its own list, and an `updated` about an unknown tab is ignored.
- Existence: `WorkspaceStore.has` is regular-only and stays so for workspace mutations;
  `hasForWindow(id, windowId)` is what panel operations use (focus from the palette, strip
  scroll, restoring a panel after a cancelled close prompt): a private window has exactly
  its own Private workspace.
- Session values: a private tab's name stays in memory (`TabRegistry.rename`, and the clear
  on navigation), and `setPanelMarker` / `setDevtoolsPanelMarker` write nothing for an
  ephemeral workspace, whoever calls them.
- `panel/focusedChanged` names a tab and a window, so tools answers it to the asking
  window's audience (`replyToSource`) and the shell background lists it among the
  workspace-bound events, so one that arrives unwrapped is regular-only.
- Refusals (`crossesPrivateBoundary` in `messaging/protocol-handler.ts`, dropped with
  a warning): from a private window, anything under `workspace/`, `backup/`,
  `externalMerge/`, `tabFolder/`, `pinnedPanel/`, plus `tab(s)/assignWorkspace`,
  `tabs/moveToNewWorkspace`, `tabs/setFolder`, `pinnedPanels/reorder` and
  `savedPanels/save` (the shared bookmarks and backups); from a regular
  window, assigning a tab to a Private workspace or moving a private tab. Panel, pin and
  folder actions also name tabs by id (`namedTabIds`): a regular window naming a private
  tab is refused, and a private window naming a tab that is not in its own window (a
  regular tab, another private window's, or an unknown id) is refused. A cross switch
  is also refused by the store: `activate` is a no-op between a private window and any
  regular workspace.
- Actions that name a group or slot rather than a tab cannot be checked by that guard, so
  the handler searches only the source window's own workspace: `panelLayout/setGroupRatio`
  (and the other layout actions, which already pass the window's workspace) never finds a
  group of another window's or a private window's workspace (`PanelStore.setGroupRatio`
  takes the workspace id).
- A private tab that goes away is a removal for its window, also when it moved to another
  private window. `dropRemovedTabFromPanels` (`panels/RemovedTab.ts`) removes it from every
  workspace's panels and publishes each affected workspace through the audience helper,
  not only the regular workspace the global active id names, so the old private window's
  panels (and the strip the shell re-sends for a window-local sidebar change) do not keep
  a panel whose tab left. `TabRegistry` records a tab's privacy before it queues any delta
  for it, including the create-on-unknown path of an `onUpdated` that arrives while
  `init()` reads session values, because a delta's audience is fixed when it is queued.
- Close: the workspace, its panels and its remembered active tab are dropped; no
  regular workspace's ownership or tabs change.
- Manual verification: open a private window, check the sidebar lists the "Private"
  workspace and its tabs, a regular window lists only its own workspaces, then close the
  private window and confirm `browser.storage.local` (`bento.workspaces`, `bento.panels`,
  `bento.tabFolders`, `bento.pinnedPanels`, `bento.parkedWorkspaceTabs`) holds no
  `private:` id.
- Sidebar UI ("Marked window"): `state/privateWindow.ts` `usePrivateWindow()` is true
  when the document's frame URL carries `#bentoPrivate=1` (known before any snapshot) or
  the window's active workspace has `private: true` (the same state Ladle seeds with
  `seedPrivate()`). In `App.tsx` it swaps the workspace switcher for
  `components/PrivateBand`, drops `PinnedPanels`, and removes `move-to-workspace`,
  `move-selected-to-new-workspace` and `move-to-folder` from the tab context menu. The
  command palette (`CommandPalette.tsx`) omits the Workspaces commands and "Merge browser
  session". The mount script skips the panel header's "Pin this panel" button
  (`BentoPrivateBrowsingUtils.isWindowPrivate(window)`). Nothing can reach the workspace
  switcher, edit-workspace or theme picker overlays from a private window, and tools
  refuses their actions regardless. The Private workspace has no `themeId`, so the
  document and chrome resolve the Default theme.
- `PrivateBand` is one Mux `Button` (the band) in a Mux `Popover` (the note,
  `modal={false}`, `placement="bottom-start"`); the fill is the Mux neutral step 90 with
  its paired `-fg`, which inverts with the page's mode without a theme scope, and the
  note overrides the popover's own strong (inverted) surface with the raised one, so the
  band stays the only inverted block. In the rail (`rail`, from the sidebar-collapsed
  setting; the layout itself follows `html[data-bento-collapsed]`) the shell frame is
  52 px wide and would clip a popover, so the note is the chrome-side rail tooltip
  (`useRailTooltip`, `BENTO_RAIL_TOOLTIP`, see "Tooltip document" in
  [overlay-documents.md](overlay-documents.md)) on hover and keyboard focus. The band is
  not part of the collapse choreography's moves or fades: the glyph's start inset
  (`--bento-private-band-inset`, half of the rail width minus the glyph size) centres it in
  the rail in both layouts, so it never moves, and the gap to the text is the same inset, so
  the text starts at the rail's edge. The text stays at full opacity: in a collapse the
  strip's narrowing edge (chrome's push) clips it away, in an expand the widening edge
  reveals it, and at the settle the rail layout (text hidden) drops nothing that was still
  visible. The band's block fills the sidebar width and is wiped by the same edge. Its slot
  starts `--bento-panel-top-inset` below the frame's top, so the band is level with the main
  panels, which start one gutter token (`--space-3xs`, rounded as the no-panels frame margin
  is) below the toolbar. The token is a rem length and chrome's rem (11px) is not the shell's
  (16px), so chrome stamps its root font size on a private window's sidebar frame URL
  (`#bentoChromeRem`, `chromeRemPx` in the mount script) and `boot.js` turns it into
  `--bento-chrome-rem-scale` before first paint; the inset is the same token, scaled,
  rounded. The root font size comes from chrome's `global.css`, which a cold window (the
  first private window of a session) has not applied when the mount script first runs, so
  `setBentoShellSrc` holds a private window's frame until the document `load` event while a
  stylesheet link has no sheet (`chromeSheetsApplied`); reading at that point stamped the
  16px default and left the band 2px below the panels. It does not follow the panel gap setting (`panelSplitterSizePx`): the
  panels' top is that token in both split (strip padding) and no-panels (frame margin) modes.
- Manual verification (expanded, note open, rail; dark and light): the band reads
  "Private" over "Nothing here is saved." at the top of the sidebar; click it and the note
  appears under it, Escape or a click outside closes it; collapse the sidebar and the band
  is the glyph alone, hover it for 400 ms and the note shows beside the rail; no workspace
  switcher, no pinned rail, no "Pin this panel" button on a side panel, and the tab menu
  has no workspace or folder entries; the command palette has no "Switch to" or "New
  workspace" rows; a regular window next to it is unchanged.

## Workspace pitfalls

- Do not give tab or folder rows their own plain `:hover` background, and do not
  mix `--bento-surface-hover` into a row state that composites over the hover
  highlight. The highlight already supplies that tint: a selected row's `:hover`
  background mixing it in again stacked it twice and read darker than a plain
  hovered row. A selected hover is the accent over `transparent`.
- Do not paint an opaque backstop (a gradient of `--bento-surface-hover-solid`,
  the selected tint or `--color-60`) behind a tab row's hover actions. It appears
  with `:hover` over the `state` duration and disappears on its own, while the
  highlight needs the longer `reveal` duration to slide in, so moving along the button
  column showed solid hover-colored blocks ahead of and behind the gliding
  highlight, with the button hover fills sitting on them. Mask the title instead
  (see above). The mask width must match the actions' real width: if the action
  count or the button size changes, change `--bento-tab-row-action-count` or the
  `--bento-tab-row-action-*` tokens, and check a long title still fades before the
  first button and that the active row (one button) does too.
- Do not set the highlight's position (its `transform`, or the action
  highlight's `data-target` and inline starting box) and `data-visible` in the
  same style pass. The slide transitions come from the after-change style, so a
  fresh show would glide in from the last row (or from New to Search).
  `useHoverHighlight` writes the position, flushes style (`offsetHeight`), then
  sets `data-visible`; the slide, width and margin transitions live under
  `[data-visible]` for the same reason.
- Do not derive the hovered row from scroll math or a cached pointer position.
  The highlight follows `mouseover` on the row wrappers, and relies on Gecko's
  synthesized mouse move to re-target a stationary pointer after a scroll, a
  folder collapse or a row removal. Without `mousemove` there is no fresh
  coordinate to cache. That synthesized move is not guaranteed to land promptly
  (headless Gecko re-targeted after a removal in one run and not within 500 ms in
  another), so the worst case is a hidden highlight until the pointer next moves.
- Do not let the New and Search buttons paint Mux's ghost hover fill. The action
  highlight is their hover fill, and Mux's `color-mix(... surface-contrast 10%)`
  on top of it read about twice as dark as a hovered row (measured: a hovered row
  pixel 250,247,245 to 235,231,229, the double fill 215,211,209). The buttons set
  `--muxui-button-background-hover: transparent`; do not fight the `:hover` and
  `[data-hovered]` selectors instead.
- Do not size the action highlight from a measured rect, and do not let a fresh
  show use the final geometry. A one-time measurement kept the expanded width
  (248.8px on a 32px button) after the sidebar collapse resized the bar without
  a React commit, and a rect read while the Search trigger is mid-transition is
  neither its start nor its end box. The final box comes from CSS and the bar's
  `--bento-tab-list-search-trigger-width`, which also follows a resizing bar
  because it is a percentage. But a fresh show over Search that took the final
  (peeked) box straight away appeared 52px wider than the trigger that was still
  widening (measured: highlight 84px against a 40.7px trigger 40 ms in), so it
  starts on the trigger's current box and the transition carries both. The
  container's `ResizeObserver` remains only to hide a Search target that has
  lost its box (the collapsed rail).
- Do not let the highlight outlive its row. Anything that unmounts, fades
  (`data-row-inert`) or drags the hovered row must go through the hook's
  post-commit sync, or the highlight sits at a stale offset after a reorder,
  removal or folder collapse.
- Do not drive the shell's rail visuals from the `sidebarCollapsed` setting or
  from the order of the title IPC. The setting reaches the shell before chrome
  starts the slide, and a push keeps the shell at its expanded width until chrome
  narrows the host, so a setting-driven rail layout would show at the wrong time
  (the icon-only rows at the first frame of a collapse, while still 300 px wide). The
  attribute follows the viewport width; keep only semantic things (labels,
  tooltips, the toggle icon) on the setting. A story that shows the rail sets the
  frame width the token names, as chrome sets the host's.
- Do not size shell-laid-out geometry in chrome from a rem shell token. Chrome's root
  font size is the system UI font (11 px on macOS, `font: message-box`), the shell's is
  16 px, so `--bento-tab-strip-width-collapsed` (`calc(2rem + 2 * 0.61875rem)`) was
  51.8 px in the shell and 35.6 px as the chrome host. The shell's rail then had a
  15.2 px content box: the New button sat 8.4 px right of centre and the pinned and
  folder band was 15.2 px wide behind 32 px squares. The chrome token sheet now
  pins the token in px at `--font-size-root`; add any other rem token chrome sizes
  shell-laid-out geometry from to `SHELL_SIZED_TOKENS` in the generator. Compare
  `getComputedStyle(document.getElementById('bento-shell-host')).width` in the Browser
  Toolbox with `measureRailWidth()` from `railViewport.ts` after changing the token or
  its inputs, and on a new platform. The rail switch needs the host no wider than the
  shell's reading plus the 1 px slack, so a chrome rem above the shell's would keep the
  expanded layout in a rail-sized host.
- Do not read `getBoundingClientRect` of the host or the page group during a push
  and treat it as layout geometry: it includes the transforms. A callback queued
  with `requestAnimationFrame` must check the guard when it runs, not only when it
  is scheduled, and any read of the host that can happen while it is hidden or
  pushed goes through `sidebarHostLayoutBox`. Mixed reads (a
  group rect compared with the host, toolbar or window) belong in code that is held
  off by `isBentoChromeLiveResizing()` and refreshed in `syncGeometryAfterSidebarPush`,
  or must read untransformed values. Group-internal reads are fine.
- Do not add a `transition` on `#bento-shell-host`'s width, or an animation of the
  rows' width, padding or gap between the layouts, to "smooth" the snap. Layout
  would run per frame again, the chrome observers would rerun the flat panel layout
  per frame, and the shell would show the rail layout partway. The width snaps at one
  frame boundary of the slide, and what the shell shows across it is the shell
  choreography described above.
- Do not give the shell frame its own timing or distance for the counter-translation,
  and do not drop the host's clip. The frame's animation uses the host's `delta` and
  the same spring pair, so the two translations sum to 0 on every frame (check
  `getComputedStyle` of both in a `requestAnimationFrame` loop); a different curve or
  duration makes the shell document drift against the edge. Without the clip the part of
  the document beyond the strip covers the page. The frame is not a layout box for the
  slide: it keeps the host's full width until the settle.
- Do not flip `bento-sidebar-rail` before the push's layout reads or apart from the
  `bento-sidebar-push` attribute, and do not key the colour on the settled
  `bento-sidebar-collapsed` class: a collapse keeps the host wide until the slide ends and
  an expand widens it at the start, so the settled class would switch the colour at the
  wrong end. A flush between the reads and the two attributes also starts the fade from
  the wrong value. The colour follows the target.
- Do not transition a gradient stop, or `background-color` of an element a push creates:
  the toolbar's colour is the registered `--bento-toolbar-left-bg` (non-inherited, so only
  the toolbar surfaces restyle per frame; an inherited registered property would restyle the
  whole chrome tree every frame of the slide), and the pseudo-elements the push creates
  (`#nav-bar::before`, `#bento-shell-host::after`, the shell footer's `::before`) take
  their colour from a parent that transitions (`inherit`) or run an opacity animation.
  Declare the shell's colour transitions only under `[data-bento-rail-transition]`
  (`measure` too), never on the elements always, or a theme change would fade.
- The colour transition declares `transition` on `#navigator-toolbox`, `#TabsToolbar` and
  `#nav-bar`, which replaces Firefox's own transition list there for the push. Keep
  `#navigator-toolbox:not([fullscreenShouldAnimate])` in that selector: upstream's
  `transition: 0.8s margin-top ease-out` on `[fullscreenShouldAnimate]` is the fullscreen
  toolbox reveal, and pressing Cmd+S while it ran cancelled it and snapped the toolbox. Do
  not widen the list of elements without checking what upstream transitions they carry.
- Do not draw the rail's right edge line: `.bento-shell-app`'s border, the chrome divider
  and the push edge line all go in the rail look (with side panels). Dropping only the
  shell's border leaves the chrome divider, which paints the same pixel above it.
- Do not bring back a host fade to hide the shell's layout switch (the old
  `.bento-sidebar-push-fade` and fade keyframes are gone). It only masked a shell that
  switched layout at the settle with the document in motion; the shell document now stays
  still and handles its own reorganisation.
- Do not raise the host above the page group's strip container for the slide without
  accounting for the card's drop shadow (issue #85). The host's `z-index: 5` in
  `:root[bento-sidebar-push]` painted the opaque host (a background, and `overflow: clip` on
  a collapse or expand) over the shadow that spills left from the main frame and the panel
  frames into the host's area: for the whole slide the shadow was cut from about 40 px to
  about 7 px (the strip's own gutter) and snapped back to 40 px in the first frame after the
  push ended, in rail and hide modes alike, with Settings active too. A manual sidebar drag
  has no push attribute, so it never showed it. The strip container's push-time
  `z-index: 6` is the fix; any new element that must paint over the host during a push needs
  the same check. Found by measuring the shadow's width beside the card in screen
  recordings of the slide. Guard: the static test in `scripts/mount-sidebar-push.test.mjs`
  keeps the strip's push level above the host's. To check a change or a Firefox bump,
  compare the shadow beside the card in recorded frames of a collapse, expand, hide and
  show against the settled state (see the Sidebar push entry of
  `docs/firefox-core-touchpoints.md`). The edge line is the one thing that can still differ:
  the host's `::after` line sits under the shadow during a collapse or expand, and the chrome
  divider (`z-index: 3`, above the strip outside a push) draws it above the shadow once
  settled.
- A new push direction needs every direction selector and branch audited, not only the
  CSS: the page group, the `#nav-bar::before` band, Back/Forward/Reload,
  `#PersonalToolbar`, `SIDEBAR_PUSH_SLIDE_ANIMATION`, `expands` in `startSidebarPush` and
  the expand branch of `settleSidebarPush`. `show` was added by auditing each `expand`
  one (it shares the expand keyframes and band, and the bookmarks offset it applies at
  the settle).
- Do not freeze a push for inspection by pausing its animations alone. The settle also
  runs from `afterMotion`'s timer (the measured duration plus 50 ms), so the push ends
  and removes the animations even while they are paused. Raise the spring duration token
  on the chrome root first (30 s leaves time for several screenshots), pause, then
  step `currentTime`. The shell's phase has the same trap (the collapse's fallback at
  twice the spring, the expand's `afterMotion`), so raise the token on the shell's
  `<html>` too. Finish chrome's animations before the shell's on a collapse: finishing
  the shell's hold animation first fires the fallback, which settles at the expanded
  width the viewport still reports.
- Do not measure the expanded width for an expand by flushing layout after the
  collapsed class is removed (`sidebarExpandedWidth` computes it). Do not call
  anything that reads layout between removing the class and adding the margin: the
  page's browsers would receive the intermediate size.
- Do not hide the sidebar by adding `.bento-sidebar-hidden` at the start of the
  toggle. The class pins the host to the rail with `margin-right: -rail`, so the page
  jumps into the freed space in one frame (measured: host 300 px to the rail, main panel
  left 305 to 5 in one frame) while only the rail's transform transitions. Hide is a
  push (`direction` `hide`, narrow end 0) and the class lands in the frame the push
  settles; `applyChromeSidebarHidden` must not settle a hide push it belongs to, and a
  hide must start when `sidebarCollapsed` already matched (hide from the rail).
- Do not let the hidden class's transform transition run when it lands at the end of a
  hide: the before-change transform is the finished animation's `-delta`, so the host
  would transition from there. The settle holds the transition off for that change.
- Do not default the divider's shift to 0 when it has no previous position. A show
  from the hidden state read the hidden divider as absent, and the 1 px line sat static
  at its final left for the whole slide, cutting through the sliding panels. An absent
  line is at the edge of a strip at 0, which makes its shift the whole delta, in on a
  show and out on a hide.
- Do not select on `:root[bento-sidebar-hidden='true']`. `applyChromeSidebarHidden`
  sets the attribute with `toggleAttribute`, which writes an empty value, so
  `='true'` never matches (use `:root[bento-sidebar-hidden]`). A
  `#bento-sidebar-hidden-hover-zone` strip at the left edge was gated on that selector
  and stayed `display: none` for its whole life; it was removed, not fixed, because
  showing it would put a 12 px pointer-capturing strip over the left edge of web
  content whenever the sidebar is hidden and block clicks there. The window pointer
  handler reveals the sidebar without catching pointer events.
- Do not leave the hidden rule's transform transition live under reduced motion. The
  no-slide hide (`prefers-reduced-motion: reduce`) moves the page at once and then
  toggles `.bento-sidebar-hidden`, so the transition would play the rail sliding
  out over the finished layout. A `prefers-reduced-motion: reduce` block after the
  hidden rules turns it off, which also makes the hover reveal instant.
- Do not read the rail layout by toggling `data-bento-collapsed` without the `measure`
  phase on: the attribute change would start the switcher's and the rows' background
  transitions, which then run from the rail values back to the expanded ones after the
  read.
- Do not settle by removing the phase attribute in the same style change that brings
  back the rows' and trigger's transitions: the active row's background (transparent
  during the phase) would transition back in over the `state` duration at the snap.
  Settle with `measure` on, flush style, then remove it.
- Keep the rail `display: none` rules out of the phase: Gecko has
  `layout.css.display-animations.enabled` off, and the phase keeps the expanded layout,
  fading what the rail hides.
- Pseudo-elements inside `:is()` are dropped: list `::before`/`::after` selectors on
  their own.
- Do not measure the row offsets from plain tab rows only. With only folder children in
  the virtual window (an open folder holding every tab, or scrolled past its header)
  there is no plain row, its offset read as zero and the rows moved against the list's
  rise instead of to their rail places, with no stagger; folder children also need their
  own offset because the rail drops their indent. `tabRowShifts` derives either kind
  from the other.
- Do not let the footer anchor read the Downloads button during a phase or only on
  footer resizes: after an expand the last resize happened at its start, with the button
  still at its rail place, so Firefox's automatic downloads panel opened above the old
  rail spot.
- Do not let elements mounted mid-phase run their animations from their mount time
  (see `finishAdded` above), and do not rely on the offsets written at the phase start
  reaching a pane mounted later: a new scroller without its own `--bento-rail-x/-y`
  inherits the list region's and moves twice.
- Do not lay the collapse's rail read out at `measureRailWidth()` (51.8 px) unrounded.
  Chrome settles the host at 52 px, so centred items (avatar, New icon, footer buttons)
  ended the collapse 0.1 px left of their settled places, which the device-pixel rounding
  turned into a 1 px jump at the switch at a ratio of 1 (measured: footer buttons at
  x 8.5 to 9.3 against 9.5; 737 differing pixels in the rail strip against 498 after
  rounding the width, the rest anti-aliasing).
- Do not give the rail's content box less than the host's width. The shell's root keeps
  a 1 px divider border (transparent in the rail), so the rail was a 51 px content box in
  the 52 px host and a 32 px control sat at x 9.5. At a ratio of 1 the held end of a
  collapse (and the start of an expand) moves items by whole device pixels while the
  settled rail paints the half pixel its own way, so the switch stepped. Measured on
  the held row against the first rail row (`getBoundingClientRect`, 5 runs, identical):
  avatar frame, rail square, active-row cap and tab row x 10 to 9.5; New icon and favicons
  17.9 to 17.5; footer toggle icon 18.3 to 17.5; footer divider 792.0 to 792.4; and the
  52 px strip differed by 575 to 579 pixels between the held end and the settled rail (avatar
  letter anti-aliasing, the active row's square and favicons a pixel apart; the settled
  rail itself had the avatar at x 10 and the rows at 9). The rail read was not the cause:
  `readAsRail` at 52 px measured what the settled rail has (main 51, avatar 9.5, New icon
  17.5, toggle 9.5), so a width mismatch (51 against 52) is not it. `border-inline-end-width: 0`
  under `data-bento-collapsed` (`app.css`) makes the box 52 px; the same measurement gives
  avatar and tab row 0, New icon and favicons 0.1, footer icons up to 0.5 (their
  expanded places are fractional and paint on the same pixel), 46 to 54 differing pixels
  (active-row square corners and one favicon's sampling), and the expand start mirrors it
  (0.5 to 0, 0.8 to 0.3). At a ratio of 2 the numbers were already this small and are
  unchanged. Pixels: held end taken with the frame pinned at its expanded width and the
  spring slowed, settled rail from a normal collapse, both `screencapture` of the window.
- Do not make the offsets exact to close the layout gap. Unrounded offsets (with the 51 px
  box) zeroed the layout steps but a translated icon then sits off the pixel grid its
  settled layout snaps to: the strip differed by 289 pixels, 128 of them the footer toggle's
  icon (compositor translation at a fractional offset blurs it), where rounded offsets
  paint the footer on identical pixels.
- Do not leave scroll anchoring on the list scroller during a phase. An expand from the
  bottom of the rail clamps the scroll position (the expanded list has less to scroll)
  and offsets the list viewport by the change; anchoring took that translate for a
  layout shift and scrolled the list by the same amount again (measured: `scrollTop`
  10577 to 10494 at the clamp, then to 10411 and drifting back while the offset
  animated, so the rows started 83 px off their rail places). `overflow-anchor: none` on the
  scroller under `data-bento-rail-transition` keeps it at 10494.
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
- Do not start the workspace fade's `bento-workspace-stabilizing` timer from an
  uncancelled frame. `performWorkspaceSwitchFade` removes the curtain class in a
  `requestAnimationFrame` and starts the stabilize timer there. With a measured
  zero-length fade the swap runs at once, so two switches could both queue a frame
  before either ran; each frame then assigned `__workspaceFadeCleanupTimer` without
  clearing the earlier handle. The first timer was unreachable:
  `cancelWorkspaceFadeForMainOnly` left it pending, and after a new switch it ended
  suppression early (and cleared the newer timer's handle). The frame handle is
  now `__workspaceFadeCleanupFrame`. A new switch, `clearWorkspaceFadeClasses` and
  the cancel all go through `cancelWorkspaceFadeCleanup`, which cancels the frame
  and the timer, and the frame callback clears any timer before it starts one.
  Covered by `scripts/mount-motion.test.mjs`.
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
  drop `attachRestoredPinnedTabUnload` from the mount script. Firefox restores a
  pinned tab with a real browser (`createLazyBrowser` excludes `tabData.pinned`),
  so with `browser.sessionstore.restore_pinned_tabs_on_demand` on it is pending but
  `tabs.Tab.discarded` (`!linkedPanel`) is false, and the sidebar draws it as
  loaded until clicked.
- Do not detect a pending pinned tab through the WebExtension API, and do not
  unload it from bento-tools. A pending tab reports its real address once the
  history restore has run (SessionStore sets the saved URI before any load), so a
  test for `url === 'about:blank'` matched nothing, and bento-tools can only act
  after the shell is connected. Only the `pending` attribute tells a pending tab
  from a loaded one, and only chrome reads it.
- Do not discard a pinned tab before its `SSTabRestoring`, on `SSWindowRestored`
  for example. The history restore is still running then: when the
  `restoreDocShellState` promise resolves, `onResolve` runs `#listenForNavigations`
  on the browser, and on the now lazy browser that touches the default getter that
  re-inserts it (`#insertBrowser` from the lazy getter from `#listenForNavigations`
  from `onResolve` in `#restoreHistory`). The first version unloaded inside the
  `SSWindowRestored` dispatch; every `discardBrowser` returned true and
  `linkedPanel` went away, but within 5 seconds every one of those browsers was
  back, loaded, and no row stayed dimmed. Check `linkedPanel` 20 seconds after
  launch, not right after the discard. Keep the one task after the event too: a
  load that starts inside the dispatch (a lazy browser's `reload` listens for the
  same event) clears `pending`, and the re-check relies on that. Do not send the
  unload to bento-tools as a message: it could act only after the shell connected.
  The price is that the first `tabs.query` can report a tab as loaded; the discard
  then arrives as a `tabs.onUpdated` change.
- Do not unload a pinned tab on the strength of `pinned && pending` alone. Keep the
  `pinnedRestoreOnDemand` gate: with `browser.sessionstore.restore_on_demand` or
  `restore_pinned_tabs_on_demand` false the queue loads pinned tabs in turn, and
  after the restore the ones it has not reached are pending too; unloading one
  removes it from the queue, so a user who turned the pref off would find their
  pinned tabs never loading at launch. Keep the selected, `soundplaying` and
  `sharing` checks: `discardBrowser` without force refuses a selected tab but not
  an audible or sharing one.
- Do not leave a pending pinned tab that the window renders as a panel to
  `materializePanelTab` and the unload alone. A pinned tab has a real browser, so
  once SessionStore has set its saved address the reconciler sees a real address and
  no need to insert the browser, `materializePanelTab` does not reload it, and the
  unload skips it because it is rendered: the panel stays blank until something else
  loads it. Most likely in a window opened while the shell is running. The
  `SSTabRestoring` handler loads such a panel with `linkedBrowser.reload()`
  (`shouldLoadRestoredPinnedPanel`), after `onResolve` has registered the listener
  that turns the reload into the content restore, regardless of the restore-on-demand
  prefs. Keep it in that handler: a reload before `onResolve` is not intercepted
  (`#listenForNavigations` does not exist yet). Test it with a panel pinned in a
  workspace, then a reopened closed window or a second window: the panel must show
  its page without a click.
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
  the unload skips the selected tab, so it cannot unload a tab those paths
  selected.
- Do not replay parked tabs, or create, move or select any tab, at startup for a
  workspace Firefox restored tabs for, and do not decide it from `Tab.url`.
  A restored tab with a real browser (the selected tab, every pinned tab) reads
  `about:blank` until SessionStore has set its saved address, and the replay ran
  before the restored tabs were hydrated, so an address match found none of them
  and `tabs.create` opened a second copy: the symptom was a duplicate tab where a
  moved tab used to be, a restored order that looked reverted, and the workspace's
  first tab selected instead of the one selected at quit. Every Cmd+Q
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
  in `restoreParkedEntries` and `activateNonPanelTab`. Take the window's generation
  (`activationGenerations.begin`) as the handler's first statement, before the
  `await startupRestored`, and keep it in `isCurrent()` next to the workspace
  check: with the workspace alone a window that went A, B, A resumed both A
  handlers, and an empty A got two blank tabs.
- Do not let a superseded parked-tab restore open the rest of its list. It took
  the whole list before awaiting, so after restoring A in window 1, switching
  window 1 to B and claiming A in window 2, it went on creating A's remaining
  tabs in window 1, where the new owner's stray-tab move had already run. It now
  stops at the next entry, returns the entries it did not start to the parked
  list, and hands the tab whose create was in flight to the owning window. Do not
  drop the hand-over or return the entries elsewhere than the parked list: the
  tab is the only one the owner's move cannot see, and the entries are the only
  copy of those tabs.
- Do not run the workspace activation handler during boot before the restore has
  finished. `restoreFromSession` activates a restored window's workspace before
  `hydrateWorkspaceIds`, so an activation that runs at once sees restored tabs
  without a workspace: it reads the workspace as empty or finds no selected tab in
  it, and its panel restore runs before the session markers are read. Activations
  wait on `startupRestored` until `bootReady` has hydrated the tabs, dropped the
  parked lists and restored the panels; keep the release after the global
  workspace's panel restore.
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
