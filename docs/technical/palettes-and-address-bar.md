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
palette holds a static index of the Settings palette's root rows
(`CommandPalette/settingsIndex.ts`: id, label, group and search words, no values and
no settings state, because the palette chunk is size-ratcheted; `settingsIndex.test.ts`
keeps it equal to `rootRows`). Choosing one writes `BENTO_OPEN_SETTING:<row id>:<ts>`;
`handleSettingsTargetTitle` checks the id against a pattern and opens the Settings
palette with it as the show's `target`, and the Settings document resolves it
(`SettingsPalette/targets.ts`): a number or choice setting opens its own list, the
privacy rows and shortcuts their lists, and a switch or the search-engine link the first
list with the label typed in. An id the document does not know opens the first list.
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

The command palette and the Settings palette share one highlight
(`components/primitives/useRowHighlight.ts`, `RowHighlight.css`): rows paint no fill of their
own, and the list carries a single slab, a pseudo-element of the scrolling list, that slides
(transform and block-size on the Mux `interaction` pair) to the row holding the virtual
focus. The hook only measures: a `MutationObserver` on `data-focused` writes the row's box
into `--bento-row-highlight-*` custom properties, from `offsetTop` and `offsetLeft` so the
popup's enter transform does not skew it. Pointer hover moves that same focus through React
Aria's `shouldFocusOnHover` (passed as a props object, `FOCUS_ON_HOVER`), so the pointer
and the keyboard never show two highlights. Its colour is `--bento-palette-highlight-bg`
(two steps above Mux's item focus fill, both modes). The slab takes its height from the row
(`offsetHeight`), so rows of different heights need nothing more: the Settings palette's
two-line option rows and the focused protection level, which grows by its benefits and
caveats, make the slab change size as it moves, on the same `interaction` pair.

Pitfalls:

- React Aria moves focus on hover only when its last input modality is the pointer, and it
  learns that from `pointermove`, which arrives after the `pointerover` that starts the hover:
  the first row entered after a key press took no focus. The hook dispatches a synthetic
  `pointermove` on the document from a capturing `pointerover` listener so the modality is
  known first. Remove that shim and the first hover after typing shows no highlight.
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
the trimmed query is non-empty, `TabListPane` skips rendering normal virtualized
display rows and the action overlay renders matching results into the pane below
the field. This avoids leaving tabs, folders, pinned sections, or creation
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

Pitfall: the grid for the result row is on Mux's `.muxui-button-content`, not the
Button (see
[../mux-ui-component-customisations.md](../mux-ui-component-customisations.md)).
The title and domain share one `.bento-tab-list-search__text` flex column in the
third (`minmax(0, 1fr)`) column and each ellipsizes on its own; do not make the
domain a fifth grid item or the kind label is pushed by long domains.

### Search trigger and field motion

The trigger is a Mux `Button` (ghost, `sm`) with the search icon and a `Search`
label, inside `span.bento-tab-list__search-trigger` (which carries the `title`).
Its accessible name stays the `aria-label` "Search tabs and panels". At rest it is
the 2rem square; hovering it, or keyboard focus-visible on it, widens it leftward
to `--bento-tab-list-search-peek-width` (5.25rem, icon, gap, the label and the
New button's inline padding), while the New button (`flex: 1`) shrinks by the
same amount so the bar keeps its width. The label never fades: it is always
opaque and the button's clip uncovers it (below). Mux's button
ring uses native `:focus-visible` (React Aria also sets `data-focus-visible`);
Bento uses `:focus-visible`. The trigger is hidden in the collapsed rail.

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
applies at once, so the open effect's `focus()` and `select()` work. The box
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

## Floating Address Bar

`extensions/bento-shell/src/components/AddressBar/AddressBar.tsx` is a separate
chrome overlay entry hosted at `address-bar.html`, mounted dynamically by
`ensureOverlayHost` in `src/browser/base/content/bento-shell-mount.js`. The
chrome keybinding intercepts `Cmd/Ctrl+L`, `Cmd/Ctrl+E`, and `Cmd/Ctrl+T` in
capture phase, opens the overlay, and sends the mode to the addrbar frame
through a frame script that posts on `BroadcastChannel('bento-addrbar-bus')`
from the content global. `Cmd/Ctrl+E` is also forwarded by the `BentoKey`
content actor so the current-tab address dialog opens while web content owns
focus. Empty new-tab opens read `text/plain` from the global clipboard in
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
actions use `addrbar/query`; tools answers with `addrbar/results` and echoes the
query so the shell can discard stale async results. The tools search module
queries Firefox new-tab top sites for empty input, queries all history with
`browser.history.search({ startTime: 0 })` after typing, searches bookmarks with
`browser.bookmarks.search(query)`, filters bookmark folders out, dedupes by
normalized URL, and ranks host-prefix matches, history recency and visit count,
and bookmark matches. Favicons are best-effort: open tabs provide
`TabSnapshot.favIconUrl`, top-site rows can include `browser.topSites` favicons,
but history and bookmark APIs do not return favicons.
The React overlay renders typed-only active-workspace tab/panel rows, async
top-site/history/bookmark rows, an empty-new-tab clipboard URL row, and
synthetic search/open row through Mux UI's `CommandPalette` recipe and
`useCommandPalette` hook. Empty new-tab mode also renders saved-panel rows from
the saved-panel mirror and opens them through `panel/openAt`. Sorting is
disabled so the groups keep Bento's fixed order: clipboard when present, saved
panels, typed open tabs, typed panels, top sites or typed history/bookmarks, then
search/open. Empty query preserves top-site results but returns no
open-tab/open-panel autocomplete rows.

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
