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

## Sidebar Tab And Panel Search

`extensions/bento-shell/src/components/TabList/TabList.tsx` owns the inline
sidebar search field shown from the fixed action row beside the New menu.
The result set is derived locally from the shell mirrors: `useTabsStore` provides
all tab snapshots, `usePanelsStore((s) => s.byWorkspace)` classifies panel tab
ids by workspace, and `useWorkspacesStore` supplies workspace order, icons, and
theme ids. The search is title-only by sidebar UX choice; do not add URL
matching here unless that surface is intentionally widened.

When `searchOpen` is true, the search field covers the fixed action row. When
the trimmed query is non-empty, `TabListPane` skips rendering normal virtualized
display rows and the action overlay renders matching results into the pane below
the field. This avoids leaving tabs, folders, pinned sections, or creation
controls visible behind the filtering surface. The clear affordance clears the
local query, refocuses the search input, and returns the pane to the normal
virtualized row path.

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

Pitfall: the grid for the result row is on Mux's `.muxui-button-content`, not the
Button (see
[../mux-ui-component-customisations.md](../mux-ui-component-customisations.md)).

### Search trigger and field motion

The trigger is a Mux `Button` (ghost, `sm`) with the search icon and a `Search`
label, inside `span.bento-tab-list__search-trigger` (which carries the `title`).
Its accessible name stays the `aria-label` "Search tabs and panels". At rest it is
the 2rem square; hovering it, or keyboard focus-visible on it, widens it leftward
to `--bento-tab-list-search-peek-width` (5.25rem, icon, gap, the label and the
New button's inline padding) and fades the label in, while the New button
(`flex: 1`) shrinks by the same amount so the bar keeps its width. Mux's button
ring uses native `:focus-visible` (React Aria also sets `data-focus-visible`);
Bento uses `:focus-visible`. The trigger is hidden in the collapsed rail.

One variable drives all the geometry. `.bento-tab-list__new-actions` sets
`--bento-tab-list-search-trigger-width` to the row height and, through
`:has(.bento-tab-list__search-trigger:hover, .bento-tab-list__search-button:focus-visible)`,
to the peek width. The trigger's `width`, the action highlight's `left` and
`width` (by its `data-target`, see [workspaces.md](workspaces.md)), and the closed
search field row's `margin-inline-start` all read it and each transition their
own property with `--bento-duration-spring` and `--bento-easing-spring`, the
Motion spring (perceptual 0.3s, bounce 0.15) sampled as `linear()`. They start in
the same style recalc with the same curve, so they stay in lockstep with no JS
measuring. Opacity fades are timed from the 0.3s perceptual duration, not the
550ms: the label, input and clear button fade in after `--bento-duration-fast`
over `--bento-duration-base` and out in `--bento-duration-fast`.

The overlay (`.bento-tab-list-search`) is always mounted so closing can animate.
`TabListPane` sets `data-open` while `searchOpen` is true and `inert` otherwise.
Closed, it is `pointer-events: none` and `visibility: hidden`, and the
`visibility` transition is delayed by `--bento-duration-spring` so it stays
visible while it closes; open, `visibility: visible` applies at once, so the
open effect's `focus()` and `select()` work. The box that grows is the field row
itself, by `margin-inline-start`: `0` open, and closed
`calc(100% - var(--bento-tab-list-search-trigger-width))` with its
`padding-inline-start` at the trigger's icon inset, so a closed (hidden) field
row has exactly the trigger's rect, peeked or not, and an open starts from, and
a close returns to, wherever the trigger is. The row's own background, radius and
ring therefore draw correctly on every frame and the icon in its leading column
rides the left edge (its inset moves from the trigger's 8px to the field's
`--space-2xs` as it grows). Its `overflow: hidden` clips the grid while the row
is narrower than its columns, and its `opacity` fades in over
`--bento-duration-fast` on open and out after the spring has covered the trigger
on close. While open, the trigger stays visible for `--bento-duration-fast` under
the fading row (no icon blink) and then hides. The clear button sits in a
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
- Keep the closed `visibility` delay at least `--bento-duration-spring`. A shorter
  delay hides the field mid-close.
- The trigger's icon is inline in Mux's content span, like the New button's, so
  its label shares New's baseline. That puts the trigger icon 1.14px above the
  field row's centered icon; the swap happens under a 100ms cross-fade. Do not
  turn the span into a flex container to center it: the label then sits about
  2px above "New".
- Esc and the other close paths leave focus on the page, as before; the input is
  inert, so the browser drops focus rather than returning it to the trigger.
- Verified in Chromium (Ladle) only. Gecko behaviour of `:has()`, `inert`, the
  `visibility` delay and the highlight start is unverified; see the manual
  checks in [manual-regression-areas.md](manual-regression-areas.md#sidebar-search-peek-and-grow).

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
