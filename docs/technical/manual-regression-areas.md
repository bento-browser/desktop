# Manual regression areas

Part of the [technical notes index](../core-functionality-technical.md).

When changing core functionality, manually verify at least the affected subset:

- shell menus and submenus (kebab, context, New menu with nested items) in a
  running browser after any Vite chunking or Mux/React Aria change;
- sidebar collapse and expand with Cmd+S (the push slide; the checklist is under
  "Sidebar collapse and expand" in [workspaces.md](workspaces.md#sidebar-collapse-and-expand)),
  including repeated presses, reduced motion (hide, show and the hover reveal are
  instant, no rail slide after the page has moved) and a cold start collapsed, and in
  hide mode the hide (from the expanded sidebar and from the rail: the page, toolbar controls
  and divider slide with the sidebar, no jump at the end), the left-edge hover reveal
  (the slide-over takes the 400 ms spring each way, no overshoot) and the show (the divider enters with the strip's edge, never static at its final
  position), including Cmd+S again mid-slide;
- the collapse and expand choreography in the sidebar (the shell side of the push; Ladle
  story "App / Collapse choreography (chrome push)" for slow motion and frozen frames):
  at 0.25x and 1x, collapse and expand with the active tab near the top, inside a folder
  (indented) and scrolled out of view, with a folder and its band, with pinned panels on
  and off, with the list scrolled partway and scrolled to the end (an expand from the end
  clamps the scroll position), and with a workspace whose name is long. Watch for: no
  jump in the frame the rail appears (end of a collapse) or disappears (start of an
  expand); the avatar, New plus, favicons, folder icons and footer buttons travel straight
  to their places, top rows first and the toggle first; the address bar folds under the
  list and never shows through it; the active highlight retracts into its square and
  extends back out of it; the footer divider rises with the backdrop and no row shows
  under it; the hover highlight is hidden during the move and returns on the next pointer
  move; Cmd+S again mid-move in both directions and ten quick presses end in the last
  state with no offset left behind (in the Browser Toolbox Console,
  `document.documentElement.hasAttribute('data-bento-rail-transition')` is false in the
  shell document, and no element in it has an inline `--bento-rail-x` or
  `animation-delay`); with reduced motion on, and at a cold start, the switch is instant.
  Known snaps at the end of a collapse and the start of an expand: a multi-selected (not
  active) row's tint, an audible or muted row's favicon (the speaker control shifts it),
  a sidebar card fades instead of moving (an open sidebar search folds into the rail's
  Search square, see Sidebar search peek and grow, item 7);
- sidebar expand from the rail (Cmd+S), in a regular window with and without side panels
  and in a private window: no frame where the rail area is empty or shows a different
  colour strip at the start of the slide, and the rail items move straight from their rail
  places; the settled rail's avatar, New, Search, tab squares and footer buttons are centred
  in the 52 px rail; in hide mode the edge-hover reveal shows the rail correctly and show
  expands normally;
- the rail colour (with side panels the collapsed rail takes the toolbar's colour: one
  surface with the window controls and the gap around the page, no divider line on its right
  edge; the colour and the lines fade with a collapse or expand on the same spring as the
  slide, with no snap at either end, in the toolbar, the host and the shell; no side
  panels keep neutral-5 throughout; the tab list band is
  neutral-18 in the rail, and the round workspace avatar has no square fill or outline behind
  it (rest, hover, press, collapse and expand): no ring or corner of the expanded switcher
  card is left around the avatar during or after a collapse (the card's fill and its ring,
  Mux's button shadow, fade out together, and nothing is drawn behind the avatar from the
  moment its fill is gone), and an expand brings the ring in with the fill instead of at
  once; keyboard focus on the rail avatar still shows Mux's focus ring; hide, show, reduced motion, boot and theme changes are instant; the
  hide-mode edge-hover rail takes the toolbar's colour too), in a light and a dark theme and
  with contrast "more";
- workspace switch with different panel sets;
- workspace switch with saved strip scroll positions;
- first panel add in a workspace;
- panel add from main context menu and from panel context menu;
- panel trailer blank add and saved-panel add, and its width: the host's computed
  `width` is 256 px, and 284 px with more than eight saved panels, where the
  "More saved panels" select is not clipped;
- panel resize, including `about:preferences` or `about:settings` in a panel,
  main resize, and workspace switch after resize;
- panel reorder with grouped and ungrouped roots;
- subdivision create, fill, resize, break out, and remove;
- closing main tabs while panels exist;
- closing a sidebar multi-selection with Cmd/Ctrl+W and with the multi-select
  context-menu item;
- closing side panels with descendant sub-panels;
- closing a workspace's last sidebar tab and a panel in the same action (close the
  panel then immediately the tab, and the reverse; a multi-tab close): the window
  ends on a tab of the workspace tools reports, or on the next free workspace when
  nothing is left, never on another workspace's tab with the sidebar unchanged;
- deleting the workspace a window shows while a second window shows another
  workspace: the second window keeps its tabs, and the first window moves to a
  free workspace or closes when none is free; deleting it with a free workspace
  that has no tab yet (and, separately, with "close tabs" chosen) leaves the first
  window open on that workspace with one new tab;
- cold start with several restored windows and workspaces: after startup every
  restored tab is still in the workspace it was in last session (no tab moved to
  its window's workspace), and a window opened or torn out after startup still
  adopts its own tabs without a blank extra tab;
- a selection that lands on another workspace's tab without a workspace switch
  (select it from the Browser Console): the curtain lifts within about 1.5 s;
- tearing out the selected tab, a panel tab, a background tab, and a
  multi-selection from a workspace with panels (drag out, tab context menu "Move
  to New Window"): each moves into a new window with the same page, the new
  window has exactly one tab per moved tab and no blank extra tab, the moved tabs
  appear in the new window's sidebar, and the source workspace promotes a panel
  when its last sidebar tab left;
- closing a sidebar tab, a panel, and a pinned panel whose page has a
  `beforeunload` handler: "Stay" keeps the tab in its workspace and folder (a panel
  returns visible at its slot, width and header state) with no leftover closing
  marker; "Leave" closes it with normal succession. With the prompt left open,
  switch that window to another workspace and open the original workspace in a
  second window, then choose "Stay": the tab joins the workspace its window shows
  as a normal tab and the second window's layout does not gain a panel slot;
- two workspaces, the second with live tabs (a page with typed form text, a playing
  video, a pinned tab) and a panel: open a second window (it claims the second
  workspace and takes its tabs), then close it with Cmd+Shift+W, the close button,
  and `window.close()`: the tabs and panel of that workspace are the same live tabs
  (same tab ids, form text and playback intact) in the window that stayed, in the
  order they had, the closed window leaves no blank tab behind, and switching to
  the workspace shows them without reloading. Open a third window: it claims the
  workspace again and brings the tabs back, the pinned tab still pinned. With a
  single window, or on Cmd+Q, nothing is moved and the old behavior holds (tabs
  parked as addresses, session restore). Also check: a page opened by
  `window.open()` calling `window.close()` with two windows open closes only its
  tab; a close answered "Stay" by a tab's beforeunload prompt leaves the window as
  it was, and a second close request while that prompt is up hands nothing over;
  a DevTools toolbox open on the window's selected tab moves with it; with three
  windows, close two of them from one Browser Toolbox snippet (both `close()`
  calls in the same task): workspace, folder and panels of every moved tab survive
  both hops; dragging a handed-over tab to a
  third window and back within 15 s releases it like any drag; a discarded tab keeps
  its workspace after the move; deleting a workspace with "close its tabs" does not
  rescue the doomed tabs; a private window, a popup and a DevTools window never
  receive tabs;
- opening several windows in a row (`bv windows-cycle 3`): no
  `this.window.gBrowser is undefined` in the Browser Console, and every window
  gets its workspace from its first `shell/hello`;
- Cmd+Shift+T restore of a closed panel;
- Cmd/Ctrl+Shift+arrow panel traversal while content has focus, and plain
  Left/Right arrow behavior inside page content;
- Vimium or another content-key extension inside a panel;
- AMO install permission prompt from a panel;
- Dark Reader or another content-script extension inside a panel;
- video fullscreen from the main content slot and from a side panel while side
  panels are present, with the side-panel video visible and no Bento loading
  overlay, spinner, or neutral chrome background replacing it;
- theme switch and sidebar footer UI light/dark/Auto switch;
- the Firefox app menu from the sidebar footer button: "Bento Settings" sits
  directly above "Settings", once after repeated opens and in a second window;
  arrow keys reach it, and Enter or a click opens the Settings palette over the
  window and closes the menu; the command palette's Open Settings and Privacy
  commands and the welcome Open Settings button open it too (Privacy on the
  protection level list), in a regular and a private window, and the Settings
  palette closes when the command, workspace or merge palette opens; The footer has no Settings button
  in the expanded or collapsed rail (details in
  [sidebar-native-surfaces.md](sidebar-native-surfaces.md));
- the sidebar merge progress card: while a merge runs it floats over the end of
  the tab list, rows scroll under it and the last row scrolls clear, it opens the
  merge palette on a click or Enter, finished merges stay until the close button
  (or, in the rail, a click) clears them, and a new merge replaces them (details in
  [session-merge-backups.md](session-merge-backups.md));
- new windows with a persisted non-Default workspace theme: the sidebar shows
  that theme no later than the frame in which chrome lifts its launch veil
  (compare the `data-bento-theme` change with the veil lift over several windows;
  the first window of a launch waits for `bento-tools` and is slower);
- profile restart with panels, pinned panels, saved panels, widths, and scroll
  positions restored;
- profile restart with pinned tabs: pin one tab in each of two workspaces and
  leave a regular tab selected, quit, relaunch. Only the selected tab loads (and
  the shown workspace's panels); both pinned tabs are pending and dimmed (sleeping
  rows in the sidebar) shortly after launch, and still dimmed 20 seconds after
  launch. The unload runs a few hundred milliseconds after the restore, so a pinned
  row can show undimmed for that moment; a row that dims and then loads again means
  SessionStore re-inserted the browser (see the pitfall in
  [workspaces.md](workspaces.md)). In the Browser Toolbox Console, right after
  launch and again after 20 seconds,
  `gBrowser.tabs.filter(t => t.pinned).map(t => [t.hasAttribute('pending'), !!t.linkedPanel])`
  shows `[true, false]` for each of them (pending and unloaded), and from the
  bento-tools background page
  `(await browser.tabs.query({ pinned: true })).map(t => t.discarded)` is `true` for
  them. Clicking one loads the right page, the second after switching to its
  workspace, and Back works. A pinned tab shown as a panel in the active workspace
  may be unloaded when its restore finishes and is loaded again by the panel strip,
  or is loaded by the restore handler itself when the strip already renders it: it
  ends up loaded and renders its page normally, with no blank panel. Repeat with a
  pinned panel in the shown workspace after reopening a closed window (Cmd+Shift+N)
  and in a second window: the panel shows its page without a click, and
  `tab.hasAttribute('pending')` is false for it. A pinned tab that loaded (the
  selected one) is not dimmed. The audio and sharing skips cannot be reached from a
  real restore, because a restored tab has not played anything;
  `scripts/mount-restored-pinned-unload.test.mjs` covers them. Then press
  Alt+Shift+R with a loaded pinned tab open: it stays loaded, because the unload
  runs only when SessionStore restores a tab. On macOS, close the last window with
  Cmd+W (the app keeps running) and click the Dock icon: the pinned tabs of the
  window that comes back are unloaded too (derived from the source, not run). Then
  set `browser.sessionstore.restore_pinned_tabs_on_demand` to false in `about:config`
  and relaunch: Firefox loads the pinned tabs and none is unloaded or dimmed, the
  same with `browser.sessionstore.restore_on_demand` false. If a pinned tab that
  was not selected loads at launch, or one loads again after dimming, see the
  startup pitfalls in [workspaces.md](workspaces.md);
- restart keeps what Firefox restored. In a workspace with many tabs, drag one tab
  to the end of the list and select it, then quit with Cmd+Q and relaunch. Before
  quitting, note the window's tab count (Browser Toolbox Console:
  `gBrowser.tabs.length`). After the relaunch the count is the same (no duplicate
  of the moved tab or of any pinned tab), the moved tab is still last, and it is
  the selected tab, not the workspace's first tab. Repeat with a pinned tab
  selected at quit, with the selection in a second workspace of the window (switch
  to it before quitting), and with two windows on different workspaces: each
  window keeps its tabs, order and selection. A dev relaunch on the same
  profile behaves the same. The Browser Console has no
  `parked tab restore failed` lines;
- restart with panels: a workspace with three panels (one pinned, one in a
  subdivision), then Cmd+Q and relaunch. The sidebar shows no extra tab, no panel
  appears twice (compare the tab count before and after:
  `gBrowser.tabs.length` in the Browser Toolbox Console), the panels keep their
  order, widths and subdivision, and the pinned panel is still pinned (pin rail,
  kebab menu says Unpin) and is the same tab as the panel in the strip. A panel
  closed with Cmd+Shift+W of the only window before quitting is opened again once
  on relaunch;
- selection and switching at launch: quit with a panel of the workspace as the
  window's selected tab (Browser Toolbox Console: `gBrowser.selectedTab` is a
  panel's tab, not a sidebar tab) and relaunch: it is still the selected tab and
  the first sidebar tab is not selected over it. Relaunch with a window on one
  workspace and switch to another as soon as the window appears; the window ends
  on the second workspace with one of its tabs selected
  (`gBrowser.selectedTab` belongs to it), and no tab of the first workspace is
  selected a moment later. Do it again with an empty workspace as the first one
  and switch to the second and straight back: the window shows one tab for the
  first workspace, not two blank ones. Close a window with Cmd+Shift+W so its
  workspace's tabs are parked, show that workspace in another window and switch
  that window away and back at once: no tab of the workspace is left behind in a
  window that does not show it. The superseded-activation and superseded-restore
  decisions are covered by unit tests; this is the timing check, and it can pass
  without ever hitting the race;
- panel identity across a restart: in one workspace make three panels with
  different widths, subdivide the first one (a top panel and a bottom panel, the
  bottom one a different site and width), pin one of the others as a pinned panel,
  then Cmd+Q and relaunch. Each panel keeps its own width and header state, the
  top and bottom of the subdivision are not swapped, the pinned panel is still the
  same tab as the panel in the strip, and `gBrowser.tabs.length` is unchanged. Then
  navigate one panel to another site, quit and relaunch: it comes back on that
  site, in its slot, with no extra tab. Also open a sidebar tab on the same address
  as a panel that will be restoring at launch (a pinned panel), quit, relaunch: the
  panel is still the panel and the sidebar tab is still a sidebar tab. Do the
  subdivision in a second workspace and leave that workspace unopened across two
  quits and relaunches (it stays inactive, so its entries are not applied), then
  open it: the top and the bottom panel are still on their own sites and widths.
  The first launch after upgrading from a build whose markers have no panel key
  can show a pinned panel twice. The extra copy is not cleaned up: it stays, and
  later launches keep both, until you close it;
- a workspace whose window closed comes back: with two windows on different
  workspaces, close one with Cmd+Shift+W, then open its workspace in a new window
  (or the workspace switcher of the other window): its tabs are restored once, in
  order. Also close the only window with Cmd+Shift+W, quit, relaunch: the new
  window shows the workspace's tabs from the parked list, once each, and a window
  Firefox did restore does not get its tabs a second time;
- parked tabs survive a tools reload but not a restart: with two windows on
  different workspaces, give window A's workspace a loaded page and an empty New
  Tab (Cmd+T, leave it blank), then close window A with Cmd+Shift+W. The page moves
  to window B and the empty New Tab stays behind and is parked. With window B
  open, press Alt+Shift+R. The parked list stays
  (`await browser.storage.local.get('bento.parkedWorkspaceTabs')`, run from the
  bento-tools background page in the Browser Toolbox, still returns the
  workspace), and showing A's workspace in a window restores the New Tab once.
  Then Cmd+Q and relaunch:
  Firefox's restored tabs are not doubled, and a workspace with no restored tab
  still restores its list;
- after any Firefox update, the Browser Console shows
  `[bento-compat] probed N members on Firefox <platform version>` (the Gecko
  version, for example `158.0`) and no `[bento-compat] missing` lines.

If a regression touches these areas, record the cause and fix in this document
or in the relevant feature section before closing the task.

## Chrome submenu placement

The chrome menu overlay (`extensions/bento-shell/src/menu/ChromeMenu.tsx`)
composes public Mux `Menu.Submenu`, `Menu.Item`, `Menu.Popup`, and `Menu.List`
parts from serialized chrome menu payloads. Nested popups explicitly use
`placement="end-top"`, also the public submenu default in `@muxui/react@0.1.0-rc.4`.
Keep placement explicit: the former RC1 default could resolve below the item and
overlap subsequent root rows.
Verify in the `menu.html` overlay that pointer travel from a submenu trigger
reaches visible child rows, keyboard ArrowRight opens the child, and selection
preserves `BENTO_MENU_SELECT:<context>:<id>` for the chrome title handler.

## New menu open fill

The sidebar New button keeps its open fill while its chrome menu is up (mechanism
and pitfalls: [overlay-documents.md](overlay-documents.md#menu-open-state-of-the-sidebar-new-button)).
Verify in a running browser after a shell sync and Alt+Shift+R: open New and see
the fill; it clears on choosing an item, Esc, a click outside, and a click on New
itself (the menu closes and stays closed); with it open, switch workspace
(keyboard shortcut) and see the fill stay on the new list's button until the menu
closes; open New in two windows and see each button follow only its own menu;
open New in the collapsed rail.

## Sidebar search peek and grow

The sidebar Search trigger peeks on hover and its field grows out of it (mechanism
and pitfalls:
[palettes-and-address-bar.md](palettes-and-address-bar.md#search-trigger-and-field-motion)).
The built app is unverified for this feature: the checks so far ran in Chromium
and Playwright's Firefox build through Ladle. In a running browser after a shell
sync and Alt+Shift+R, with the sidebar expanded:

1. Hover the Search icon: it widens leftward on a spring (looks settled in about
   0.2s, fully at rest by 0.4s, no bounce) and the label is uncovered by the
   button's edge as it widens, never faded in. At rest no part of "Search tabs" shows
   beside the icon. The New button shrinks by the same amount, the bar keeps its
   width, and the hover highlight is exactly the widened trigger at every frame,
   including when you enter the bar directly over Search (it starts on the
   square). The focus ring (Tab to it) is not cut off.
2. Move the pointer between New and Search: the highlight glides and settles on
   each button's box; leaving the bar fades it and the trigger returns to the
   square.
3. Tab to the Search trigger: it peeks with the focus ring; Enter opens search.
4. Click Search, both from the square and while peeked: the field grows leftward
   over New from the trigger's current box, the placeholder and the clear button
   fade in just after it starts, the input is focused, and
   the trigger and highlight are gone.
5. Close it every way, each time starting from an empty and a non-empty query where
   they differ: Esc (clears the query), Enter on a result, click outside (closes
   only when empty), another window or app (closes only when empty), Tab out of
   the field (closes only when empty), and the clear button (with text it clears
   and refocuses without closing; on an empty field it closes). The field
   shrinks back onto the trigger and the trigger is clickable straight away;
   during the shrink New and the trigger still take clicks. Click the clear
   button on an empty field: search closes, as with Esc, and the button's
   accessible name reads "Close search"; type a character and the name reads
   "Clear search" again.
6. Open, close and reopen quickly: no jump, and the field always starts from
   where the trigger is.
7. Collapse the sidebar (rail): the Search square sits directly under New (same
   2rem box, same hover highlight, which glides between the two; no peek label),
   and the list starts one slot lower than it did with New alone. The gap above New
   (workspace button, or the Private band in a private window) equals the gap between
   New and Search and between Search and the first tab. Open search with
   an empty field, then collapse by the footer toggle and by Cmd+S: the field
   shrinks toward the trigger at the right end of its row (right edge fixed, like an
   Esc close) while the sidebar's edge carries it, and the square glides to the Search
   slot as the rows shift down one slot, without a stop where the two meet and without
   covering New's plus or its label; the square ends plain. With no field open the
   square starts moving at once (no pause then a jump), in both directions. In both
   directions the square stays about 10 px inside the strip's moving edge, never clipped
   by it and never racing ahead of it. Repeat with a query typed: the results swap back to rows in the
   first moments, the square ends with a ring and a dot, and no result rows are
   squeezed into the rail. Press the square in the rail (nothing parked): the
   sidebar expands, the square glides to the right end of the action row and the
   field opens focused. With a query parked, expand by the footer toggle, Cmd+S or
   the square: the square glides to the right end of the row, unfolds leftward into
   the field, and the results return when the expand ends. Esc, the clear button and
   Enter on a result still clear it; switching workspace in the rail keeps the dot.
   Open search then use the footer's collapse toggle with the mouse on an empty
   field: it folds, it does not close first (Tab onto the toggle instead: the empty
   field closes, like tabbing anywhere else). Collapse with a query, then expand a
   moment into the collapse (Cmd+S twice), and the reverse (expand with a parked
   query, Cmd+S twice a moment in): the rows keep their motion, the field reopens
   with the query (results back when the move ends), and the field or square carries
   on from where it is, with no jump of its edges or position.
8. With macOS Reduce motion on: widths, the field and the highlight change in one
   step; only fades remain.
9. Check light and dark, a 200px-wide sidebar (New keeps its label), and the New
   menu: opening it keeps the New fill and no highlight.
10. Type a domain (for example `github.com`) in the open field: tabs and panels
    on that domain are listed across workspaces, including subdomains. Type
    `https`: tabs are not all listed. Type `https://`: tabs are not all listed
    either (a scheme-only query skips the web address match).
11. Paste a full address of an open tab (for example
    `https://github.com/andrew/repo`): that tab is listed, and so is any tab
    whose address contains the part after the scheme.
12. Result rows show the page title with the site's domain on a second, smaller
    line (about 2.75rem tall; `www.` is kept, `about:` pages show their
    address). Long titles and long domains each end in an ellipsis without
    moving the "Tab" or "Panel" label. Hover a row: the close button sits
    centered over the taller row with the hover fill behind it.
13. A non-web page (for example a Bento settings or other extension page) shows a
    single line at the standard row height with no domain.

## Palette search headers

Command, merge and Settings palettes compose
public ClearButton and Close parts inside the search flex row. A scoped static
Close position prevents the sticky Input/Clear/Refresh row from covering its
pointer target. Verify pointer Close with empty/nonempty queries and Clear
reset before changing that geometry.

The controlled Input explicitly dismisses on Escape outside IME composition;
the RC SearchField can otherwise intercept the key without updating the leaf
query. Verify nonempty search, native Escape, and native Close in each palette.
Settings backup import uses a file input; verify invalid and oversize files, a
valid preview, and selecting the same file again after reopening.

## Workspace picker category focus

The published RC Tabs renderer can update the selected emoji category while
leaving DOM focus on an inactive tab. WorkspaceIconPicker uses the public root
ref and standard `tablist`/`tab` roles to follow the committed ARIA selection
in the selection effect. Animation-frame scheduling can delay the correction
in Firefox overlay windows, so it runs directly, only when focus is already in
that category list. It does not implement arrow selection or move focus from search/results/outside. Verify Home/End/arrows from
the current focused tab, Enter/Space keeping that selection, and search typing
preserving input focus when changing the package.
