# Palettes and the floating address bar

Part of the [technical notes index](../core-functionality-technical.md).

## Command Palette

`extensions/bento-shell/src/components/CommandPalette/CommandPalette.tsx` builds
its tab and panel results from the same tab and panel mirrors used by the
sidebar, then renders them through Mux UI's `CommandPalette` recipe and
`useCommandPalette` filtering/grouping hook. Panel tab ids from
`usePanelsStore.byWorkspace` are excluded from the Tabs section and listed in a
separate Panels section. Normal tab results dispatch `tab/activate`; the tools
handler activates the tab's owning workspace for the source window before
focusing the Firefox tab. Panel results dispatch `panel/focus`; tools activates
the panel's workspace and emits `panels/sync` with `scrollToPanelTabId` so chrome
scrolls/focuses the side panel in place.

Do not make palette panel results call `tab/activate`. A panel tab is still a
Firefox tab internally, but activating it as the selected browser tab demotes the
mental model: the content appears in the main slot or can be rejected by the
panel-marker bounce logic. Panel navigation must remain a panel-strip operation.

Do not return freshly-created object arrays directly from Zustand selectors in
the palette. The palette runs in a persistent chrome overlay frame; an unstable
external-store snapshot can spin the React tree or crash the palette frame before
the overlay paints. Subscribe to stable store references such as
`usePanelsStore((s) => s.byWorkspace)` and derive object arrays with `useMemo`.

Palette command records carry Mux UI `title`, `subtitle`, `keywords`, `group`,
`shortcut`, and `action` fields. The full command palette remains title-oriented
even though `TabSnapshot.url` exists for address autocomplete; do not add URL
matching here unless the command-palette UX is intentionally widened.

Commands that act on chrome write a `BENTO_*` sentinel through `sendChromeTitle`
from the palette overlay document, and the mount script routes it in
`handlePaletteFrameTitle` (`bento-palette-frame`): the Settings commands send
`BENTO_OPEN_SETTINGS_` and `BENTO_OPEN_SETTINGS_PRIVACY_`, and the Actions-group
"Merge browser session" command sends `BENTO_OPEN_MERGE_PALETTE_`. That handler
accepts the merge title from the palette frame as well as from the shell frame,
and `showMergePalette()` dismisses the command palette itself. The Settings
sentinels open the Settings palette overlay (`showSettingsPalette()`, which dismisses
the command palette; the privacy one opens on the protection level list), described in
[overlay-documents.md](overlay-documents.md) and
[privacy-search.md](privacy-search.md#settings-palette-shell-side). A
Settings group appears in the results only while the query is not empty: the command
palette holds a static index of the Settings palette's flat control rows
(`CommandPalette/settingsIndex.ts`: id, label, group and search words, no values and
no settings state, because the palette chunk is size-ratcheted; `settingsIndex.test.ts`
keeps it equal to `controlRows`). Choosing one writes `BENTO_OPEN_SETTING:<row id>:<ts>`;
`handleSettingsTargetTitle` checks the id against a pattern and opens the Settings
palette with it as the show's `target`, and the Settings document resolves it
(`SettingsPalette/targets.ts`): a number or choice setting opens its own list after its
category, the privacy rows and shortcuts their lists, and a switch or the search-engine
link its category with the label typed in. `SettingsPalette/categories.ts` supplies the
same ancestry for root-search drilldowns. An id the document does not know opens the
category-only first list. Once a ready snapshot arrives, Settings checks that every
ancestor has a visible opener; a target hidden by build, private-window or privacy/search
hydration gates also falls back to that root. A show received before the first snapshot
keeps its requested target until that validation. Readiness validates the current path
and query, preserving search, Back and breadcrumb actions taken while loading. Stable control ids and title IPC are unchanged.
Opening any of the command palette, workspace palette, merge palette or Settings palette
dismisses the others. See [session-merge-backups.md](session-merge-backups.md) for the other
open paths.

Settings opened from the command palette (the Open Settings and Privacy commands, a
Settings result) carries `origin: 'palette'` in its show message: `handlePaletteFrameTitle`
and `handleSettingsTargetTitle` pass it to `showSettingsPalette(target, origin)`, and every
other opener (app menu, onboarding) passes none. The Settings document then starts its path
with "Command palette" and enables Back at its first list. That Back, or the path's
"Command palette" button, writes `BENTO_SETTINGS_BACK_TO_PALETTE_<ts>` (constant kept equal
to the mount script's `SETTINGS_BACK_TO_PALETTE_PREFIX` by `settings-palette/titles.test.ts`);
the settings-frame title handler calls `showPalette()`, which dismisses Settings. The command
palette document stays loaded, so it shows with the query it had.

### Row highlight

The command palette, address bar and Settings palette share one highlight
(`components/primitives/useRowHighlight.ts`, `RowHighlight.css`): rows paint no fill of their
own, and the list carries a single slab, a pseudo-element of the scrolling list, that slides
(transform and block/inline size at half the Mux `state` duration, 125 ms in RC4, with the
same spring easing) to the row holding the virtual focus. Colour and opacity keep the full
state pair (250 ms in RC4), including coordinated mode fades. First placement and stage
changes are instant; reduced motion disables the transition.
The hook only measures: a `MutationObserver` on `data-muxui-state-focused` writes the row's box
into `--bento-row-highlight-*` custom properties, from `offsetTop` and `offsetLeft` so the
popup's enter transform does not skew it. The slab anchors at the physical `left: 0` because
those offsets are physical: a logical inline-start anchor sat at the right edge in RTL, shifted by
the row's offset (`RowHighlight.test.ts` keeps the rule). Pointer hover moves that same focus through React
Aria's `shouldFocusOnHover` (passed as a props object, `FOCUS_ON_HOVER`), so the pointer
and the keyboard never show two highlights. Its colour is `--bento-palette-highlight-bg`
(light neutral-30, pressed neutral-40; dark neutral-14, pressed neutral-18), resolved at each
explicit theme scope for a darker fill in both modes. Higher semantic neutral steps darken
light mode but lighten dark mode. The slab takes its height from the row
(`offsetHeight`), so rows of different heights need nothing more: the Settings palette's
two-line option rows and the focused protection level, which grows by its benefits and
caveats, make the slab change size as it moves, on the same half-duration geometry timing.

Pitfalls:

- Mux RC4 replaces React Aria's unprefixed state attributes. Observe and query
  `data-muxui-state-focused` (the number editor follows `data-muxui-state-current`),
  and suppress row fills and detect presses through the matching public state names.
  Legacy selectors leave the slab hidden and Mux's pale row fill visible. A static
  fixture with manually supplied legacy attributes missed this; verify real consumers.
- Clear is reachable with Tab, but a remaining keyboard activation issue was reproduced in
  both palettes in isolated Chromium: with a nonempty query, press ArrowDown, Tab to Clear,
  then Enter or Space. Focus returns to the input without clearing the query. The shared
  `IN_TAB_ORDER` helper does not resolve that sequence; native Firefox reproduction is unverified.
- React Aria moves focus on hover only when its last input modality is the pointer, and it
  learns that from `pointermove`, which arrives after the `pointerover` that starts the hover:
  the first row entered after a key press took no focus. The hook dispatches a synthetic
  `pointermove` on the document from a capturing `pointerover` listener so the modality is
  known first. Remove that shim and the first hover after typing shows no highlight.
- A list that appears under a stationary pointer must not take the hover, and the first real
  movement must hand it back. The browser reports the element under the pointer after a layout
  change (a `pointerover`, and the `pointerout` of the element the pointer was on, with the old
  coordinates), React makes `onPointerEnter` from them, and React Aria moves the focus to that
  row, so an enum opened on the wrong option (Enter then applied it) and Back landed on the wrong
  row. The hook keeps a hover gate per list (`pointerGate.ts`, one `PointerTracker` per
  document): closed when the list appears, opened by the first trusted `pointermove`,
  `pointerover` or `pointerout` whose coordinates differ from the last seen, or by a press. A
  boundary event with no position to compare does not become the baseline (the `pointermove`
  that follows it in the same spot is the first real movement). All of this is on the document in
  the capture phase, before React's listeners:
  - While the gate is closed, the over and out events that touch the list (target or
    `relatedTarget` inside it) are stopped. Stopping `pointerover` alone is not enough: the
    `pointerout` of an element outside the list names the row entered.
  - Once it is open, a synthetic `pointermove` is sent for those events so React Aria's last
    input is the pointer. It must be on the document, not the list: after keyboard input the
    pointer may enter the list from outside (the Close button), and React handles that element's
    `pointerout`, which carries the enter, before any listener on the list sees the next event.
  - When the gate opens, the hover the stopped events never made is made: a synthetic
    `pointerover` on the row under the pointer (`elementFromPoint`), so it takes the focus at
    once, also when the pointer only moved a pixel inside it.
    The command palette keeps its hover: its list is one element that opens on the first real move,
    and under a pointer already in place no row takes the focus until then.
    `scripts/check-palette-hover.mjs` runs these cases in Chromium against Ladle (not in CI); the
    tracker's logic is in `pointerGate.test.ts`.
- Rows must sit above the slab (`position: relative`, also the section headings), or the
  slab covers their text while it slides past.
- The slab is measured, not CSS-positioned from a row: a stage that keeps no focus of its
  own (the number editor with presets; a slider page has no list) follows `[data-current]` instead (`useRowHighlight`'s selector),
  and the Settings list is remounted per stage and per show so its first placement is
  instant.

### Esc: chrome sees the key first

Pitfall: the parent process receives the key events of a remote overlay `<browser>`
before its document does, with the `<browser>` element as `event.target`. The chrome-level
Esc listener (`attachPaletteEscListener`) runs in the capture phase, so an overlay whose
document handles its own Esc must be skipped there, or chrome consumes the key and hides the
overlay from every stage. The menu overlay already did this ("a menu that was delivered
handles its own Esc"); the Settings palette did not, and Esc closed Settings from the
second stage, from a number editor and from a command palette result, although its footer
said "Esc back". Chrome now takes Esc for the Settings host only for an open still waiting
for its document, or when the event's target is not `bento-settings-palette-frame`
(focus left elsewhere in the window); otherwise it returns and the document steps back or
clears a search, and closes from its first list.

How to test it: key events sent inside the content process (a frame script, `content`
`dispatchEvent`) skip the chrome listener and cannot show this. Send the key from the
parent (Marionette `WebDriver:PerformActions` in the chrome context, or
`windowUtils.sendKeyEvent` in the chrome window) with the overlay frame focused, and log
`event.target.id` from a capturing window listener. `scripts/overlay-surfaces.test.mjs`
covers the listener with the frame id as the target.

Inside the Settings document the Esc handler is a capturing `keydown` listener on the
window, not an `onKeyDown` on the field: the focus can be on Back, a path button, Close or
Clear, and React Aria's own Esc handling on the modal would close the dialog from any of
them. It calls `stopPropagation` so neither that nor the SearchField's Esc (which clears
its value) runs.

## Sidebar Tab And Panel Search

`extensions/bento-shell/src/components/TabList/TabList.tsx` owns the inline
sidebar search field shown from the fixed action row beside the New menu.
The result set is derived locally from the shell mirrors: `useTabsStore` provides
all tab snapshots, `usePanelsStore((s) => s.byWorkspace)` classifies panel tab
ids by workspace, and `useWorkspacesStore` supplies workspace order, icons, and
theme ids. A tab matches when the trimmed, lowercased query is a substring of
its display title (`customTitle`, then `title`) as typed, or when the query with
its own leading scheme removed is a substring of the URL with its scheme
removed. The test is `matchesTabSearch()` in
`extensions/bento-shell/src/components/TabList/tabSearch.ts`, covered by
`tabSearch.test.ts`. A missing or empty URL falls back to title-only, and a
query that is only a scheme (`https://`, `about:`) skips the URL test. Result
order and the 50-result cap are unchanged.

Each result row has two text lines when the tab has a domain: the title, then the
domain in a smaller muted style. `searchResultDomain(url)` in the same file
returns it: the exact hostname for `http:` and `https:` URLs (`www.` kept, no
port or credentials), the URL as-is for `about:` URLs, and `undefined` for
everything else (`moz-extension:`, `data:`, `blob:`, `file:`, empty or
unparsable), so those rows stay single-line at `--bento-tab-row-height`. It
tests the scheme before calling `new URL`, so a megabyte `data:` URL is never
parsed (a 50 MiB one took 20 to 50 ms per matching keystroke when it was).
`TabList` stores it as `TabListSearchResult.domain`, renders it in
`.bento-tab-list-search__domain` inside `.bento-tab-list-search__text` (under the
title), and adds the `bento-tab-list-search__result--with-domain` modifier, which
sets `--bento-search-result-height` to
`--bento-tab-list-search-result-height-with-domain` (2.75rem). The domain size,
line gap and row height are `--bento-tab-list-search-*` tokens. The row's
accessible name is the Button's `aria-label`, title first, with the domain
appended when there is one (`Tab: Dashboard in Work, mail.google.com`), so
same-titled tabs on different sites are distinguishable.

When `searchOpen` is true, the search field covers the fixed action row. When
the trimmed query is non-empty (and the layout is expanded and no expand
choreography is running, see "Rail Search square"), `TabListPane` skips rendering
normal virtualized display rows and the action overlay renders matching results into
the pane below the field. This avoids leaving tabs, folders, pinned sections, or creation
controls visible behind the filtering surface. The clear affordance clears a
non-empty local query, refocuses the search input, and returns the pane to the
normal virtualized row path. When the trimmed query is empty it calls
`onCloseSearch()` instead, exactly like Esc, and its `aria-label` reads "Close
search" rather than "Clear search".

Selecting a regular-tab result calls `TabList`'s normal `onActivate` prop so it
uses the same tools dispatch and chrome scroll-to-main sentinel as a visible
sidebar tab row. Selecting a panel result dispatches `panel/focus` with the
result workspace id so the panel strip scroll/focus path stays the source of
truth. The result marker color comes from the generated workspace theme metadata in
`extensions/bento-shell/src/theme/presets/index.ts`; the active document theme
must not be mutated to preview search results.

Cross-workspace tab result activation depends on a tools-side preferred-tab
handoff. `protocol-handler.ts` records the explicitly requested tab through
`preferWorkspaceActivationTab()` after `WorkspaceStore.activate()` succeeds.
`background.ts` consumes that preference inside `handleWorkspaceActivation()`
before falling back to `lastActiveTabByWorkspace` or the first workspace tab.

Load-bearing pitfall: do not remove this handoff or replace sidebar-search tab
selection with a bare `tab/activate` dispatch that bypasses `TabList.onActivate`.
Cross-workspace activation emits a workspace `activated` delta, and the
background workspace-activation handler may run its "restore the workspace's
last visible tab" fallback in the same turn as the explicit tab activation. If
the search result is a tab inside a folder in another workspace, that fallback
can otherwise reactivate an unrelated non-folder tab from the destination
workspace, leaving the requested folder tab selected in state but not visible in
the main content slot. Regression check: put a tab inside a folder in workspace
B, search for it from workspace A, click the result, and confirm workspace B
opens with that exact folder member in the main content slot.

Pitfall: `matchesTabSearch()` strips a leading `scheme:` and optional `//` from
the URL before matching. Matching the raw URL makes "http" or "https" list every
tab, and "about" or "moz-extension" list every internal page. Do not match the
raw `tab.url`. It strips the query's own prefix for the URL test only, so a
pasted full URL such as `https://github.com/andrew` finds
`https://github.com/andrew/repo`; the title test keeps the query as typed. If the
stripped query is empty (`https://`, `about:`) the URL test is skipped, or every
tab would match. The query strip is narrower than the URL strip: only `scheme://`
or a leading `about:`. Real tab URLs always start with a scheme, but a typed
`host:port` such as `localhost:3000` also looks like `scheme:`; stripping it
would test `3000` and list unrelated tabs (`https://example.com/items/3000`).
Do not reuse the URL regex on the query. `data:` URLs skip the URL test, since
they carry the page itself (a 50 MiB one took about 25 ms per scan, on every
keystroke) and only their title is matched.

Pitfall: the grid for the result row is on Mux's `.muxui-button__label`, not the
Button (see
[../mux-ui-component-customisations.md](../mux-ui-component-customisations.md)).
The title and domain share one `.bento-tab-list-search__text` flex column in the
third (`minmax(0, 1fr)`) column and each ellipsizes on its own; do not make the
domain a fifth grid item or the kind label is pushed by long domains.

### Search trigger and field motion

The trigger is a Mux `Button` (ghost, `sm`) with the search icon and a `Search tabs`
label, inside `span.bento-tab-list__search-trigger` (which carries the `title`).
Its accessible name stays the `aria-label` "Search tabs and panels". At rest it is
the 2rem square; hovering it, or keyboard focus-visible on it, widens it leftward
to `--bento-tab-list-search-peek-width` (7.1875rem, icon, gap, the label and the
New button's inline padding), while the New button (`flex: 1`) shrinks by the
same amount so the bar keeps its width. The label never fades: it is always
opaque and the button's clip uncovers it (below). Mux's button
ring uses native `:focus-visible` (React Aria also sets `data-focus-visible`);
Bento uses `:focus-visible`. In the collapsed rail the trigger is the Search square
under New (see "Rail Search square" below).

One variable drives all the geometry. `.bento-tab-list__new-actions` sets
`--bento-tab-list-search-trigger-width` to the row height and, through
`:has(.bento-tab-list__search-trigger:hover, .bento-tab-list__search-button:focus-visible)`,
to the peek width. The trigger's `width`, the action highlight's `left` and
`width` (by its `data-target`, see [workspaces.md](workspaces.md)), and the closed
search field row's `margin-inline-start` all read it and each transition their
own property with Mux's reveal spring pair,
`--muxui-semantic-motion-reveal-transition-spring-duration` with
`--muxui-semantic-motion-reveal-transition-spring-easing` (400 ms sampled
`linear()` spring, bounce 0; it looks settled by about 200 ms, its
`-spring-visual-duration`). The field row's `padding-inline-start` and the clear
button's open `scale` use the same pair. They start in the same style recalc with
the same pair, so they stay in lockstep with no JS measuring. Opacity fades run on
`--muxui-semantic-motion-state-transition`: the input and clear button fade in
after one `state` duration and out with no wait.

The label is clipped, not faded. The button is `overflow: clip` with
`overflow-clip-margin: content-box` and `padding-block: 0`, so its children are
cut at the inline padding (the content edge, `width - inset`), not at the border.
At rest the label starts 29.2px in (8px inset, 16px icon, 5.2px gap), past the
24px content edge of the 2rem square, so none of it shows; as the trigger widens
the edge moves right and uncovers the label from its first letter, at every
frame with no extra transition. The ring (a `box-shadow`) and the pressed fill
belong to the button itself, so its own overflow does not clip them.

The overlay (`.bento-tab-list-search`) is always mounted so closing can animate.
`TabListPane` sets `data-open` while `searchOpen` is true and `inert` otherwise.
Closed, it is `pointer-events: none` and `visibility: hidden`, and the
`visibility` transition runs for the reveal spring's full duration (400 ms,
tail included) so it stays visible while it closes; open, `visibility: visible`
applies at once, so the open effect's `focus()` works. The box
that grows is the field row
itself, by `margin-inline-start`: `0` open, and closed
`calc(100% - var(--bento-tab-list-search-trigger-width))` with its
`padding-inline-start` at the trigger's icon inset, so a closed (hidden) field
row has exactly the trigger's rect, peeked or not, and an open starts from, and
a close returns to, wherever the trigger is. The row's own background, radius and
ring therefore draw correctly on every frame and the icon in its leading column
rides the left edge (its inset moves from the trigger's 8px to the field's
`--space-2xs` as it grows). Its `overflow: hidden` clips the grid while the row
is narrower than its columns, and its `opacity` fades in over the
`state` role on open and out, after the spring's visual duration, once the slide
has all but covered the trigger on close (the spring's tail is 3% of the move and
runs under the fade). While open, the trigger stays visible for one
`state` duration under the fading row (no icon blink) and then hides. The clear button sits in a
`.bento-tab-list-search__clear` wrapper that fades and scales in at the right end,
where the trigger sat, so Mux's own button transitions stay untouched. Under
`prefers-reduced-motion: reduce` no width, margin or slide transitions run; only
the short fades do.

Pitfalls:

- Do not unmount the overlay when closed, and do not drop `inert`. Unmounting
  cuts the close animation; without `inert` the input and clear button stay
  focusable and clickable while the overlay is visible for the close.
- Do not animate the field with `clip-path` or measure the trigger in JS. A clip
  cuts the ring, radius and background off the grown box, and a measured rect is
  the mid-transition box. Keep the closed margin on the same variable the trigger
  reads, or the field starts from the wrong place when the trigger is peeked.
- Keep the closed `visibility` transition at least as long as the field row's
  geometry transition (both the reveal spring pair, so 400 ms). The visual
  duration is too short for it: the hide would cut the spring's tail. A shorter
  one hides the field mid-close.
- Keep `gap: 0` on the Search button, and the label's own `margin-inline-start` as the only
  icon-to-label spacing. A newer Mux's content wrapper is an inline-flex with `gap: inherit`
  (the published one is inline and has no gap), so a Button gap would add to the margin: the
  label sat 5.2px late and its end was cut at the peek's clip edge ("Searc|h"). Setting the
  Button's gap, not the wrapper's class name, works in both. Check the label's right edge
  against the clip edge (the 84px button minus its inline padding) while hovered, in the
  published Mux and in the local one.
- Keep `padding-block: 0` on the Search button. Mux's block padding (about 9.35px)
  leaves a content box of about 13px, and the content-box clip would cut the 16px
  icon top and bottom.
- The trigger's visibility hand-off on open stays on `state`: it hides once the
  field row is opaque (also 120 ms), and the row covers the trigger's box for the
  whole spring, so it needs no spring-length wait.
- The trigger's icon is inline in Mux's content span, like the New button's, so
  its label shares New's baseline. That puts the trigger icon 1.14px above the
  field row's centered icon; the swap happens under a `state`-role cross-fade. Do not
  turn the span into a flex container to center it: the label then sits about
  2px above "New".
- Esc and the other close paths leave focus on the page, as before; the input is
  inert, so the browser drops focus rather than returning it to the trigger.
- Verified in Chromium and in Playwright's Firefox build, both through
  Ladle (peek, label clip, open and close timing). The built Bento app's Gecko
  behaviour of `:has()`, `inert`, the `visibility` delay and the highlight start
  is unverified; see the manual checks in [manual-regression-areas.md](manual-regression-areas.md#sidebar-search-peek-and-grow).

### Rail Search square

State. `TabList` (the outer component, so a workspace switch keeps it) holds one
`SearchState` (`{ open, query, folded }`, `components/TabList/searchState.ts`, covered by
`searchState.test.ts`). `searchOnRailChange` is the rule: collapsing an open field closes
it and keeps a typed query (parked; a whitespace-only one is dropped) and sets `folded`;
expanding reopens a parked query. `TabList` applies it during render when
`sidebarCollapsed || sidebarHidden` (the setting, as App reads it) changes, not in an
effect: the collapse choreography measures the rows in the commit that starts it
(`railLayout.ts`), and rows are not rendered while a query filters, so the filter must be
off in that same commit. Parked is `!open && query`; the rail trigger carries
`data-parked`. `handleCloseSearch` closes only an open field (a blur of the inert, folded
field must not wipe the parked query). Pressing the Search square while the setting says
collapsed dispatches the same `settings/update` as the footer toggle
(`sidebarHidden: false, sidebarCollapsed: false`) and opens the field; the input takes
focus (with `preventScroll`, or its clipped row scrolls and shifts the icon) once the
layout is expanded.

The expand case. Rows stay rendered for any collapse or expand phase and the results
replace them when it ends: `useRailTransitioning()` (`sidebar/railPhase.ts`, true while
`data-bento-rail-transition` has any value) keeps `searchFiltering` off, because the phase
measures the rows once at its start. "Any phase", not only `expand`: expanding during a
collapse reopens a parked query in a render that still sees the collapse's attribute, and
filtering then would unmount the rows before the expand is measured (zero row offsets).
The results appear when the phase ends without a fade.

Layout. In the rail the sticky action area is two slots tall
(`--bento-tab-list-actions-height`: row, row gap, row), the trigger is a 32px square
under New with no peek (the `:has()` peek rule and the open-field hide rule are scoped to
the expanded layout), and the overlay is `display: none`. The action highlight is one
square tall and `data-target` picks its `top`; `placeAction` also writes the fresh show's
`top`. The custom scrollbar starts under the two squares. A parked query shows the
field's ring (`--bento-tab-list-search-ring`, on the wrapper so the button keeps its own
focus ring) and a dot (`--bento-tab-list-search-dot-*`) that fades in as the folded field
hands over to the square. The rail's vertical rhythm is one `--bento-sidebar-section-gap`
between squares: the workspace switcher's rail end padding (`app.css`) is the gap above
New, the same as New to Search and Search to the first row (the scroller's start padding).
Put it on the switcher, not on the sticky actions, because the action highlight's `top`
is relative to that box.

Choreography. The Search trigger and the field row are measured rail parts (`search` and
`field` in `railLayout.ts`; both offsets are `shift(expanded.search, rail.search)` minus the
list region's, so the field row IS the trigger once it has shrunk onto it). In a collapse or
expand the trigger translates between its expanded place and its rail slot, instead of
fading. While the field is open (or `data-folding` during a collapse) the trigger is hidden
and the field row is the moving part (`TabList.css`, unlayered, because it overrides the
closed field's styles). Timing, in fractions of the reveal spring S (all on the spring pair,
delays as `calc()` fractions). The square's across move (`translate`) takes the whole pair
(S), not the 0.6 S of the other moves: it travels 150 to 250 px against 15 to 30 for the
other items, and at 0.6 S it did not keep pace with chrome's host edge (which slides on S):
the plain square ran up to 63 px ahead of the edge in a collapse, sat up to 60 px beyond it
(clipped by the strip for about 190 ms) in an expand, and a folding field was clipped by up
to 97 px for about 120 ms. At S, starting with the phase, it keeps a constant 8 to 10 px gap
to the edge in both directions (measured with every animation paused and sought at 4 ms
steps), so it is never wiped by the edge and never ahead of it. Its down move (`transform`)
stays 0.6 S with no delay, the list region's timing (the region starts S/32 after, a delay
the plain square leaves out), so it rises and settles with the list without overshooting the
rows. No delay on across also holds it off New: the list's rise takes New's row away before
the square reaches New's column (in a collapse its top never gets above the Search slot, 5 px
under the New square), and in an expand the square is clear of the icon's column about 14 ms
in, before the icon starts moving (its delay is S/16); New's label has faded in a collapse by
the time the square reaches it and has not appeared yet in an expand (its delay is 0.15 S).
Collapse with a field: the input, clear button and results fade on `state`; the field shrinks
toward the trigger at the right end of its row with its right edge fixed, as an Esc close does
(`bento-rail-fold-in`: `margin-inline-start` to `calc(100% - trigger width)` with
`width: auto`, and the icon inset, 0 to 0.3 S), while its across move runs from the start, so
the right end rides the edge from the first frame and the square it becomes forms inside the
strip (at 0.3 S it is a square about 9 px from the edge) and rides on to the slot. Down starts
S/32, with the list region. Its fill (and its ring, unless a query is parked) fades over the
whole ride (S). The turn from the shrink (centre moving right) to the ride (moving left) is a
sign change of the centre's speed, at about 30 ms. Expand with a parked query is the same
run backwards: across and down start at once (0), the unfold runs 0.125 S to S (0.875 S
long, on the same curve as the across move but later, so the field's left end never gets ahead
of the square: with the previous 0.3 S unfold the left edge reached 49 px left of its final
place at 100 ms, off the strip, and slid back; at 0.875 S the lowest it gets is the final
place), the input and clear button fade in at 0.4 S.
The plain trigger (no field shows) has no shrink to wait for: it moves across and down
together from the start in both directions (no delays). While a collapse folds a field the
hidden trigger keeps the field row's timing (`data-rail-folding`, set by `railLayout.ts` for
the phase: across 0, down S/32, the same durations), so a reversal into an expand that parks
nothing starts the trigger where the row was. The square never covers New's plus or its label (0 overlapping frames at 1 ms steps); in an
expand its rounded top-left corner can touch New's notional 32 px square by up to 0.8 px for
about 3 ms, which is not drawn. The
field row ends the collapse as the parked square (ring kept, fill gone)
or as the plain trigger, so the handoff when the phase ends is unseen; `data-folding`
clears as soon as the rail layout is reached. Every rule that reads it is keyed on
`html[data-bento-rail-transition]` being `collapse` or `expand`, and on
`:is([data-folding], [data-open])` in both phases: TabList's state flip commits before the
controller flips the phase on a reversal, and the field's animations must keep running
across that gap to be read. Reduced motion runs no phase.

Reversal. A reversed phase starts where the running one left the field: `capture()` in
`railLayout.ts` reads the square's and field row's computed translate, margin, icon inset
and text opacity, `begin()` writes them as `--bento-rail-seed-*` on those elements, and the
keyframes (`bento-rail-to-x/-y`, `from-x/-y`, `fold-in/out`, `fold-text-out`) start from
them. Without the seed an animation replaced on the phase flip starts from the underlying
style: expand with a parked query reversed 150 ms in restarted the collapse from the
full-width field (right edge 39 to 292 px in one frame).

The collapse button. An empty open field closes on an outside pointerdown or a blur,
which would play the normal close (a retract toward the trigger) before the collapse
starts. For a pointer press on the footer's collapse button
(`[aria-label="Collapse sidebar"]`, a selector shared by convention with `App.tsx`) the
outside-pointerdown close skips it and sets a ref that the blur close honours until the
pointer comes up (the press also blurs the input, and Gecko on macOS gives the blur no
`relatedTarget`). Keyboard focus on that button is not exempt: tabbing to it closes an
empty field like tabbing anywhere else, so focus leaving it cannot strand an open field.

Pitfalls:

- Do not move the search state update into an effect: it runs after the choreography has
  measured, and a filtered list has no rows to measure.
- Do not read the layout (`useRailViewport`) for the park/reopen rule: it flips after the
  viewport narrows, long after the choreography started.
- Keep the field's fold CSS unlayered and keyed on the phase attribute: layered
  `bento.app` rules lose to the closed field's unlayered rules.
- Do not key the field's phase animations on a single state attribute (`data-folding` only
  in a collapse, `data-open` only in an expand): the state flips a commit before the phase
  does, the animations are cancelled in between, and `capture()` then reads the field's
  base style (margin 253 px) as its seed.
- Start the plain trigger's across and down together: a delayed across (0.175 S, there to let
  an open field shrink first) left a closed trigger crawling for four frames, then jumping.
  Only a folding field waits (its row has its own delays; the trigger hides behind it).
- In an expand the trigger must leave New's column before New's icon comes down onto it: a
  later across than down overlapped the two squares by 2.6 px for a frame.
- The shrink is `margin-inline-start` (right edge anchored), not a width or scale: an
  animated width keeps the left edge fixed, so the field would grow past the trigger.
- The result rows must stay out of the rail: an open field with a query in the rail
  (pressed in the rail with a parked query) keeps filtering off until the layout is
  expanded and no collapse or expand phase is running.
- Hold the rows for any phase, not only `expand`: reversing a collapse mid-phase reopens
  a parked query in a render that still sees `collapse`, and filtering then unmounts the
  rows before the expand measures them (zero row offsets, no choreography).

## Floating Address Bar

`extensions/bento-shell/src/components/AddressBar/AddressBar.tsx` is a separate
chrome overlay entry hosted at `address-bar.html`, mounted dynamically by
`ensureOverlayHost` in `src/browser/base/content/bento-shell-mount.js`. The
chrome keybinding intercepts `Cmd/Ctrl+L`, `Cmd/Ctrl+E`, and `Cmd/Ctrl+T` in
capture phase, opens the overlay, and sends the mode to the addrbar frame
through a frame script that posts on `BroadcastChannel('bento-addrbar-bus')`
from the content global. `Cmd/Ctrl+E` is also forwarded by the `BentoKey`
content actor so the current-tab address dialog opens while web content owns
focus. `Cmd/Ctrl+L` and `Cmd/Ctrl+E` open the palette over the expanded sidebar's
address row when it is on screen (an open request to the row, with a centered
fallback), and `Cmd/Ctrl+T` always opens it centered; the request, the anchored
header and the grow are in
[address-entry.md](address-entry.md#open-request-cmdl-and-cmde). Empty new-tab opens read `text/plain` from the global clipboard in
chrome, sanitize it with Firefox URL bar paste handling when available, resolve
it through `Services.uriFixup`, reject keyword-search results, and forward only
`http`/`https` specs as `clipboardUrl`. `resolveClipboardUrlSuggestion` first
reads `browser.urlbar.suggest.clipboard` at call time and returns without
touching the clipboard unless the pref is enabled. It checks
`Services.prefs.getPrefType` first: a boolean pref uses its value, a missing
pref takes Firefox's own default (true), and any other type (or a failed read)
disables the read. Do not call `getBoolPref(name, true)` for this gate, because
Firefox returns the supplied default for a wrong-typed pref. Do not gate on
`browser.urlbar.clipboard.featureGate`: that pref controls Firefox's own
clipboard provider rollout, while this suggestion is an intentional Bento
feature. Manual check: with the pref false, `Cmd/Ctrl+T` shows no clipboard row
for a copied URL and the pasteboard is not read; with the pref true, the row
appears.

The overlay uses the same shell-to-tools port as the rest of Bento. Query
actions use `addrbar/query`; `addrbar/results` echoes both query and opaque
request id. The store accepts only the latest registered pair. Empty queries
independently fetch Recently Closed, Recent History and Top Sites, capped at two
rows each in that order; unavailable/empty groups have no headings. Closed tabs
are scoped to the trusted current window/private status, retain separate session
ids even at equal URLs, and use native session restoration after revalidation.
The correlated restore result closes only the open that requested it; failure
shows a status and refreshes results. See
[address-entry.md](address-entry.md) for eligibility, hydration/reveal, retained
user-close membership, and deleted-workspace/folder fallback.

Typed queries retain history/bookmark normalized-URL deduplication and ranking
by host prefix, recency, visit count and bookmark matches. They also include
active-workspace open tabs/panels and the synthetic search/open row. Favicons are
best-effort: open tabs and top sites can provide them, while history/bookmark
APIs do not. Empty new-tab opens append Clipboard and Saved Panels after the
three primary groups; saved panels still dispatch `panel/openAt`. No open-tab or
open-panel rows are built for empty input.

All rows use public Mux `CommandPalette` parts and the shared highlight. Recent
rows show domains and compact elapsed timestamps, with Reopen on the focused
closed row. Top Sites use one line so six primary rows fit the 512-by-378 anchored
popup; the list scrolls in shorter windows or for optional suggestions. Empty
Enter honors Mux's focused option. Typed Enter retains synthetic submission.

Navigation stays chrome-owned. For current-tab mode, the addrbar frame writes
one `BENTO_ADDRBAR_NAVIGATE_*` title sentinel with a UTF-8-safe base64 payload.
Legacy callers may still encode a plain string. New address-palette submissions
encode JSON shaped like `{ value, searchEngineId? }`; chrome decodes either
shape, validates `searchEngineId`, and resolves through `Services.uriFixup` with
`FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP | FIXUP_FLAG_FIX_SCHEME_TYPOS` by default. If
the payload carries an engine id and the value is not URL-like, chrome
initializes Firefox `SearchService`, calls
`SearchService.getEngineById(id).getSubmission(value).uri.spec`, and loads that
one URL without mutating the default search engine. Any import, lookup, or
submission failure falls back to the existing URI-fixup route. For new-tab mode,
chrome dispatches `tab/openUrl` with ordinary resolved specs so bento-tools
creates the tab in the source window and eagerly assigns it to the active
workspace. Resolved `about:` and `chrome:` specs instead use
`gBrowser.addTrustedTab()` from chrome, because WebExtension `tabs.create`
rejects privileged internal pages such as `about:preferences`; the existing
tabs-created listener still assigns the resulting tab to that window's active
workspace.
After a successful current-tab or new-tab submission, chrome schedules
`scrollPanelToLeftmost` for the main panel and clears restored-main auto-scroll
suppression so the panel strip reveals the main content slot even if the user
submitted while viewing side panels.

Load-bearing pitfalls:

- Submit sends exactly one navigate sentinel. Do not also send
  `BENTO_CLOSE_ADDRBAR_*`; chrome's navigate handler already hides the overlay,
  and the extra title is one more handler run.
- Do not remove the explicit main-slot reveal after submit. Current-tab address
  loads do not necessarily change `gBrowser.selectedTab`, so the reconcile-time
  selected-tab auto-scroll path may not run.
- Do not route privileged new-tab address submissions through WebExtension
  `tabs.create`. Firefox rejects internal pages such as `about:preferences`
  there; keep the chrome-owned trusted-tab path for resolved `about:`/`chrome:`
  specs.
- Do not rebuild open tab/panel rows for empty address input. Empty input should
  keep recent-history behavior but must not eagerly walk every open tab/panel to
  construct autocomplete rows.
- Do not drop `TabSnapshot.url` from normal snapshots/deltas without removing
  URL autocomplete from the address palette. URL-clearing deltas are required so
  blank/internal placeholder transitions do not leave stale URL matches.
- Open tab and panel rows must be filtered by `useActiveWorkspaceIdForWindow`
  and the source `windowId`. The full command palette can list cross-workspace
  tabs because it labels workspace context and `tab/activate` switches
  workspaces first; the floating address bar is a browser-surface replacement
  and should not show inactive workspace tabs as local open tabs.
- Panel classification must use only the active workspace panel id set. A tab id
  that is a panel in another workspace must still be treated as a normal tab for
  this workspace's address autocomplete.
- New-tab submissions must create the tab inactive, eagerly assign it to
  `ctx.workspaces.getActiveId(ctx.sourceWindowId)`, then activate it. Passing
  `active: true` directly to `browser.tabs.create` lets Firefox fire
  `tabs.onActivated` before Bento has written the workspace assignment, which
  can make the tab appear in another workspace.
- Panel rows must dispatch `panel/focus`, never `tab/activate`, for the same
  reason as command-palette panel rows.
- Do not route the one-shot address picker through
  `privacy/setDefaultSearchEngine`, `SettingsStore`, or any Firefox default
  search mutation. It only affects the submitted non-URL search.
- Do not rely on WebExtension `search` or `omnibox` APIs for live default-engine
  suggestions in this custom overlay. They can execute searches or provide
  extension-owned keyword suggestions, but they do not expose Firefox's live
  default-engine suggestion stream to an arbitrary React UI.
