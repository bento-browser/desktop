# Overlay documents

Part of the [technical notes index](../core-functionality-technical.md).

Every overlay is a chrome-hosted `<browser>` that renders a full React and Mux
document in the shared extension process. The sidebar shell
(`#bento-shell-frame`) and the panel trailer (`#bento-panel-trailer-frame`, part
of the panel strip layout) load at window startup, and so do three overlays whose
payloads travel between documents: confirm, edit workspace, and the workspace
switcher. The other overlay documents are created at idle after the launch veil
lifts or on first use, so a window pays for the ones it opens instead of eleven
documents at startup (audit findings R-03, R-13, R-14, M-03).

| Overlay (frame id `bento-<name>-frame`) | Document                                             | Opened by                                                                                                                 | Strategy                   | What the open depends on                                                                                                                                                               |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirm`                               | `confirm.html`                                       | `BENTO_OPEN_CONFIRM` from sidebar, switcher, or workspace palette                                                         | eager (window startup)     | Payload on `bento-confirm-bus`, named for its window; the document exists before any user action can request it                                                                        |
| `edit-workspace`                        | `edit-workspace.html`                                | `BENTO_OPEN_EDIT_WORKSPACE` from sidebar or switcher                                                                      | eager (window startup)     | Payload on `bento-edit-workspace-bus`, named for its window                                                                                                                            |
| `workspace-switcher`                    | `workspace-switcher.html`                            | Sidebar trigger, `BENTO_OPEN_WORKSPACE_SWITCHER`                                                                          | eager (window startup)     | Payload on `bento-workspace-switcher-bus`, named for its window; the host stays laid out so `window.screenLeft` is right                                                               |
| `addrbar`                               | `address-bar.html`                                   | `Cmd/Ctrl+L/E/T`, native urlbar focus or click, `BentoKey:AddrbarOpen`, sidebar `BENTO_OPEN_ADDRBAR`                      | idle, 1st                  | Open message from chrome through the `BentoAddrbarOpen` frame script onto `bento-addrbar-bus`, named for its window; `BENTO_ADDRBAR_READY` reveals the host                            |
| `palette`                               | `palette.html`                                       | `Cmd/Ctrl+Alt+P`, sidebar `BENTO_OPEN_PALETTE`                                                                            | idle, 2nd                  | Nothing: the dialog stays open inside the document, chrome only toggles the host                                                                                                       |
| `menu`                                  | `menu.html`                                          | `showChromeMenu` (sidebar, trailer, panel and splitter menus)                                                             | idle, 3rd                  | `menu/open` on `bento-shell-bus` through the `BentoShellAction` frame script, with chrome's `__windowId`                                                                               |
| `workspace-palette`                     | `workspace-palette.html`                             | Sidebar or switcher `BENTO_OPEN_WORKSPACE_PALETTE`                                                                        | first use                  | Nothing                                                                                                                                                                                |
| `merge-palette`                         | `merge-palette.html`                                 | Command palette, Settings button, sidebar merge card (`BENTO_OPEN_MERGE_PALETTE`)                                         | first use                  | Open and close messages through the `BentoMergePaletteLifecycle` frame script onto `bento-merge-palette`, named for its window                                                         |
| `settings-palette`                      | `settings-palette.html`                              | App menu "Bento Settings", command palette `BENTO_OPEN_SETTINGS` and `BENTO_OPEN_SETTINGS_PRIVACY`, welcome Open Settings | first use                  | A `bento-settings-show` DOM event (stage for the privacy link) through the `BentoSettingsPaletteShow` frame script; requests and results travel the BentoShellBus relay, not a channel |
| `bookmarks`                             | `bookmarks.html`                                     | Sidebar and command palette `BENTO_OPEN_BOOKMARKS`, `Cmd/Ctrl+Shift+O` (Firefox's Library key, retargeted)                | first use                  | A `bento-bookmarks-show` DOM event (detail `{ focus }`) through the `BentoBookmarksViewShow` frame script; never opened in a private window                                                                 |
| `welcome`                               | `welcome.html`                                       | `BENTO_OPEN_WELCOME` from the sidebar and from the welcome document                                                       | first use (first run only) | Resume step hash, read from the environment at window startup; the import handoff messages through the `BentoWelcomeHandoff` frame script (see below)                                  |
| `embedded-import`                       | `chrome://browser/content/bento-migration-host.html` | Welcome import step                                                                                                       | first use                  | None: a non-remote chrome page with no handshake, src set on every open (its `BENTO_EMBEDDED_IMPORT_READY` title only gates the onboarding handoff)                                    |
| `panel-navigator-tooltip`               | `panel-navigator-tooltip.html`                       | Hover or focus on a panel navigator button                                                                                | first hover                | Label payload through the `BentoPanelNavigatorTooltip` frame script (`content.postMessage` into this frame's own window), sent again on readiness                                      |

The Settings palette is a palette-class overlay: `showSettingsPalette(stage)` dismisses
the command palette, the merge palette and the workspace palette (and each of them
dismisses it), reveals the host on the document's readiness announcement, and sends the
document its show. `OverlayName` and `useOverlayReadySignal` are kept equal to the
mount's table by `scripts/overlay-manager.test.mjs`. The show is not a channel message:
a frame script (`BentoSettingsPaletteShow`, loaded into the frame like the merge
palette's) dispatches a `bento-settings-show` CustomEvent with a JSON detail
(`{target: <root row id> | null, origin: 'palette' | null}`; the origin is the command
palette when it opened Settings, null for every other opener) on the document's window, so it reaches a private
window's document too. The same frame script turns a `BentoSettingsPaletteHide` message into a
`bento-settings-hide` event whenever chrome hides the overlay (Esc, the document's own close,
another overlay opening, an outside click), so an unfinished number edit is put back and its
timer stopped at once; no hide is sent before the first show. The document returns to its
first list (or the one the target names), and refreshes its snapshot, on each show. Its titles to chrome: `BENTO_CLOSE_SETTINGS_PALETTE_<ts>`
hides it; `BENTO_OPEN_MERGE_PALETTE_<ts>` opens the merge palette (which dismisses it);
`BENTO_OPEN_FIREFOX_SEARCH_SETTINGS_<ts>` hides it and opens `about:preferences#search`
in a new tab, or reuses an open Firefox Settings tab; `BENTO_SETTINGS_BACK_TO_PALETTE_<ts>`
(the back button at its first list, when the command palette opened it) shows the command
palette again, which dismisses Settings. Esc is handled by the document
while its frame has focus (clear a search, one list back, then close); the chrome-level Esc
handler returns for a key whose target is the Settings frame and only covers focus left
elsewhere in the window and an open still waiting for its document (the parent sees a remote
frame's keys first; see [palettes-and-address-bar.md](palettes-and-address-bar.md#esc-chrome-sees-the-key-first)). The document
talks to tools through the BentoShellBus relay, not the shell bus; see
[privacy-search.md](privacy-search.md#settings-palette-shell-side) and
[shell-chrome-bridge.md](shell-chrome-bridge.md).

Source of truth: `bento-tools` and the shell mirrors are unchanged; overlay
documents hold no persistent state. Chrome renderer path: the host `vbox`
elements stay in the window from startup (they are cheap, and the workspace
switcher and tooltip hosts must stay laid out); only the heavy part, the
`<browser>` and its document, is deferred. `patches/chrome-layout` still declares
the palette, merge-palette, confirm, and menu `<browser>` elements, so the
palette, merge palette, and menu only get their `src` later; the other hosts get
their `<browser>` from `createOverlayFrame` when first needed. Persistence path:
none.

## Lifecycle and readiness contract

`createOverlayManager` in `bento-shell-mount.js` (the `@bento-overlays` section,
evaluated by `scripts/overlay-manager.test.mjs`) owns one record per overlay:
`absent` (nothing requested), `loading` (navigation started), `ready`. An overlay
becomes ready only when its document announces itself, or at once for the one
page with no handshake (`embedded-import`).

- **An open is revealed, and its messages are sent, only on the real
  announcement.** `overlays.open(id, reason, run)` creates the frame if needed,
  starts the navigation once, and runs `run` after readiness and an acknowledged
  host-presentation update. `run` does the reveal (dim, host
  fade, focus) and the chrome-to-overlay sends that belong to the open (the menu
  payload, the merge palette nonce, the address bar open message), so both land on
  a document that can render and receive them. Chrome's sends are frame-script
  relays onto a `BroadcastChannel` inside the overlay's process; nothing queues
  there, and a message sent before the document subscribed is lost. Every `show*`
  function goes through `openOverlay(id, reveal)`.
- **There is no readiness fallback reveal.** If a document has not announced
  within 5 s (`OVERLAY_READY_STALL_MS`), the manager logs one error
  (`console.error`, `overlay <id> did not announce readiness`) and keeps the open
  pending. It does not reveal an overlay that cannot receive its message, which
  used to show an empty one. The open stays cancellable (see below). A late
  announcement runs the queued open once.
- **A pending open is an open overlay.** `overlays.hasPendingOpen(id)` is true
  while an open waits. Every dismissal, toggle, outside-click, and focus path asks
  `isOverlayOpen(hostId, isVisible, overlayId)`, which is "visible or pending".
  The Escape handler consumes Esc for a pending open and cancels it through the
  overlay's `hide*` function; `togglePalette` and `toggleMergePalette` close a
  pending open instead of queueing a second one; a pointer-down outside cancels a
  pending menu (and an address bar, as before). A menu that was delivered handles
  its own Esc, as on main. The welcome and embedded import overlays consume Esc
  without dismissing. Every `hide*` function calls `overlays.cancel(id)` first, so
  a hide that arrives while an open waits wins: the queue is dropped and a late
  announcement reveals and sends nothing. The queue lives until the announcement,
  `cancel`, or window teardown, and is keyed: a repeated open replaces the queued
  one (the welcome requests repeat), and the newest request is the one that runs.
- **Newest open wins.** Stack rules run when the open is requested, not when the
  document becomes ready: `showPalette`, `showWorkspacePalette`, `showMergePalette`,
  and `showAddrbar` close (or cancel a pending open of) the other palette-class
  overlays at that moment, so the order in which cold documents finish loading
  cannot let an older request cancel a newer one.
- **A hide waits for the fade the stylesheet configures.** The palette, workspace
  palette, merge palette, address bar, confirm, edit-workspace, welcome and embedded
  import hosts fade on the Mux `modal` role (inline for hosts `ensureOverlayHost`
  creates, `bento-shell-mount.css` for the three the patch declares). Each `hide*`
  sets opacity 0 and calls `hideOverlayHostAfterFade(host)`, which reads the host's
  computed opacity transition (`measureMotion`) and commits `display: none` and
  `hidden` on the `transitionend` or the measured time plus slack, only if the host
  is still hidden. A transition of 0 (reduced motion) hides at once; a host with no
  computed style waits for a fallback ceiling. Every reveal calls
  `cancelMotion(host, 'hide')`, so a reopen during the fade never meets a stale
  cleanup. The toolbar scrim and its stacked layers use the same helpers.
- **The address bar reveal timer starts at delivery.** `showAddrbar` prepares the
  host at once (laid out, invisible, not interactive) and queues `sendOpen` with
  `overlays.open`. `sendOpen` posts the open message and only then starts the 1.4 s
  safety reveal and the resend budget. A timer that started at the request cleared
  the pending open before a slow document could receive it, so a document that
  announced at 7 s opened as an empty, visible address bar. `BENTO_ADDRBAR_READY`
  from the document still reveals it early.
- **Announcing.** An overlay document announces once its subscriptions exist
  (`useOverlayReadySignal(name)` in `bridge/overlayReady.ts`, called by the
  top-level component of every overlay entry after its subscribing effects). It
  writes `BENTO_OVERLAY_READY:<name>_<ts>` through `sendChromeTitle`; the mount's
  title listener handles it for every overlay frame before the frame's own handler
  (it calls `overlays.markFrameReady`).
- **Eager and idle creation.** `overlays.startEager()` runs at window startup
  and creates confirm, edit workspace, and the workspace switcher, as before
  documents were lazy: their payloads travel document to document with no queue,
  and the documents exist before any user action can request them. `hideStartupVeil()`
  calls `overlays.onVeilLifted()` (first call only); the manager then creates the
  idle overlays (address bar, palette, menu) one at a time, in table order, each
  in a `requestIdleCallback` (timeout 1.5 s), and starts the next only after the
  previous announced or 2.5 s passed, so the extension process never loads several
  React documents at once. An overlay that was opened on demand first is skipped.
  There is no interval, no polling, and nothing runs after the queue is empty.

Not-yet-created frames, by code path:

- Open paths (`show*`, `showChromeMenu`, `showAddrbar`, `showEmbeddedBrowserImportFromWelcome`,
  the tooltip hover) call `ensure` or `open`. They are the only code that creates
  a frame.
- Hide, Escape, outside-click, toggle, and the visibility checks work on the
  host elements, which always exist, and treat a missing frame as nothing to do
  (`document.getElementById(frameId)?.`). A hide never creates a frame.
- Title handlers are keyed by frame id on one window-level listener, so a frame
  created later needs no attachment. Resize and geometry code moves hosts, never
  frames. No theme or color mode is pushed from chrome into an overlay: each
  document hydrates its own stores from the bus. `BentoKey` routes to chrome
  window events (`BentoKey:AddrbarOpen` to `openAddressEntry`), which go through
  `showAddrbar`.
- Dev add-on reload (`reloadFrames`) skips overlays that were never opened and
  marks started ones not ready until the reloaded document announces again.

- Window teardown: `overlays.dispose()` runs on `unload`; pending idle and stall
  callbacks and the queue die with the window.
- The welcome resume step (`BENTO_WELCOME_STEP_ENV`) is read and cleared at
  window startup, not when the welcome frame is created, as before.

### Parent-owned presentation for colour fades

Every hosted shell overlay starts with `bentoHostedOverlay=1` in its URL hash and
defaults to unpresented. Chrome owns the per-frame open/navigation generation.
Readiness permits a `BentoShellBus:HostPresentation` actor query; its synchronous
root update and document event must be acknowledged before reveal, focus, or open
payload delivery. Pending opens remain cancellable while the acknowledgement
waits. Older generations are ignored on both sides, and an actor uses its bound
document rather than a possibly retargeted `contentWindow` proxy.

The state stays presented throughout a native opacity exit. The completed hide
commits false together with `hidden`/`display:none`; reduced motion commits at
once. The workspace switcher keeps `display:flex` for coordinates, disables input
at hide-start, and commits hidden/false at opacity completion. A focused switcher
returns focus to the sidebar at hide-start (selected browser if the sidebar is
unavailable or fully hidden); outside-click focus is retained. Deferred overlay
focus checks the current generation. Menu hide and a
null tooltip payload are immediate. Tooltip shows and replays use the same ready
and presentation gate. An open that reloads is concealed until its replacement
document is ready and acknowledged; the address bar recreates its pending reveal
and resends its current open payload with a fresh id, rejecting an old document's
reveal message.

Every native-owned shell document also carries `bentoNativeMode=1`. Its installed
mode writer requests the shared per-window presenter before any local mutation.
Hidden documents settle their latest owner grant without animation-frame waits;
readiness waits for that first grant, and the shared reveal helper obtains current
mode before acknowledging host presentation. Presented documents participate in
the root capture/commit/submission barrier. Hide, reveal and navigation settle an
active cover safely. These states remain separate from `document.hidden`, which
can report visible under a hidden native host. Sidebar visibility and docshell
activity are unchanged. See [Hosted overlay presentation](theming.md#hosted-overlay-presentation)
for the shared presenter and remaining physical validation.

## Bookmarks view

The Bookmarks view (`bookmarks`, `bookmarks.html`) is a full-window view, not a modal.
Its host `bento-bookmarks-host` is a child of `#browser` like the others, created on first
use, at `z-index: 99000`: the lowest of the stack, so the palettes, the menu, the address
bar, confirm and the tooltip (99994 and up) open above it and never close it.
`scripts/overlay-manager.test.mjs` fails if a host stacks below it. Source of truth: none
here; the document's data is `bento-tools`' bookmarks store, which chrome never reads.

- **Opening.** `BENTO_OPEN_BOOKMARKS_<ts>` from the sidebar shell frame and the command
  palette frame, or `Cmd/Ctrl+Shift+O`. `showBookmarksView` refuses in a private window and
  while the Bookmarks manager is off in Settings (below), records the focused element and selected tab (unless the view is already open, which the
  root attribute or a waiting open says; the host stays visible through the fade-out),
  dismisses the command palette, merge palette, workspace palette and Settings, and goes
  through `openOverlay` like every other overlay.
  The reveal (on the document's readiness announcement) fades the host in, sets
  `bento-bookmarks-view` on `documentElement`, sends `BentoBookmarksViewShow` (a frame script
  that dispatches `bento-bookmarks-show` in the document, as Settings does) and focuses the
  frame. A repeated request while it is open shows it again and keeps the first request's
  focus record.
- **Refused under a prompt.** `showBookmarksView` returns, before it dismisses or records
  anything, while `isTabDialogShowing`: a browser the window shows (`gBrowser.selectedBrowsers`,
  so every panel of a split view) has the `tabDialogShowing` attribute, which Firefox's
  `TabDialogBox` sets when its first dialog (tab-modal prompt, content prompt, any tab dialog)
  opens and removes with the last. The view would cover a prompt that waits for an answer. A
  background tab's dialog does not count (selecting that tab closes an open view, below). The
  same check runs first in the reveal, so an open
  that waited for its document is cancelled (`hideBookmarksView({ immediate: true })`: the
  document gets no show and its presentation is taken back) when a tab with an open prompt got
  selected meanwhile. The command palette and the other overlays stay as they are on a refusal.
- **Focus against the overlays above it.** The view's document can finish loading after
  another overlay opened over it (the command palette, a menu, the address bar). The reveal
  asks `isOverlayAboveBookmarksViewShown`, which looks at the hosts in
  `BOOKMARKS_VIEW_HIGHER_OVERLAYS` (every overlay but the view and the always-laid-out
  tooltip; a test keeps the list equal to the overlay table): a host with `display` not
  `none` and `opacity` not `0` is on screen, and a host fading out is not. If one is, the
  reveal still shows the view but leaves the focus where it is, and the show goes out with
  `focus: false`. The `bento-bookmarks-show` event carries `detail: { focus: boolean }`,
  made in the page's realm (`content.wrappedJSObject.Object`, since a chrome object is not
  readable by the page): the document focuses its search field only for `focus: true`. If the
  frame script cannot build that object it still dispatches the event, without a detail, and
  logs the failure (a view that never shows is worse; the document then takes the focus).
  A pending overlay does not count; it takes the focus itself when it reveals. Nothing is
  decided once: a Show that waits for the frame's message manager is retried every 100 ms, and
  `sendBookmarksViewMessage` builds the message at each attempt (`focus` can only turn off:
  `focus && !isOverlayAboveBookmarksViewShown()`), and the frame's own focus, which lands on the
  next tick through `focusOverlayFrame(frame, mayFocus)`, is skipped if an overlay above has
  appeared by then.
- **Closing.** `BENTO_CLOSE_BOOKMARKS_<ts>` from the bookmarks frame, `Cmd/Ctrl+Shift+O`
  again, or Esc (below). `hideBookmarksView` removes the attribute at once, so the chrome is
  visible under the host's fade-out, sends `BentoBookmarksViewHide` (`bento-bookmarks-hide`;
  not sent before the first show, and a Show and a Hide share a generation counter, as in
  Settings), fades the host out with `hideOverlayHostAfterFade`, and returns the focus: to the
  element that had it when the view opened, or to the selected tab when that changed (a tab
  opened from the view) or when the opener was an overlay frame (the command palette, which
  the open closed). The focus moves only if no overlay above the view is on screen
  (`restoreBookmarksViewFocus`): with the command palette open over the view,
  `Cmd/Ctrl+Shift+O` closes the view and leaves the palette focused. The record of where to
  return is cleared either way, so it cannot go stale. Titles carry a timestamp because chrome
  drops a repeated title.
- **Tab dialogs.** Firefox draws a tab-modal prompt (the Leave/Stay prompt of a tab or
  window close, an auth prompt) and any other tab dialog (print preview) inside the page's
  `.browserSidebarContainer`, which the view hides, so nothing could answer it. Only a dialog
  in a tab the window shows is under the view (`shownBrowsers`: `gBrowser.selectedBrowsers`,
  every panel of a split view), and the view closes when one is showing:
  - `attachBookmarksViewDialogListener` listens on the window in the capture phase for
    `DOMWillOpenModalDialog` (PromptParent fires it before a prompt opens, on the prompting
    `<browser>` or on its window for a prompt in this process) and `dialogopen` (SubDialog fires
    it on the dialog overlay once the dialog is shown, for every tab dialog, also those without
    the first event). `closeBookmarksViewForDialog` acts only while the view is open (shown or
    waiting for its document) and only if the event's browser or overlay is inside a
    `.browserSidebarContainer` that belongs to a shown browser (`isPageContainerShown`); a
    window-level dialog (`gDialogBox`), a prompt of an overlay frame or a dialog of a background
    tab is left alone.
  - A dialog that is already open in a tab fires no event when the tab is selected: Firefox
    focuses the existing dialog (`_adjustFocusAfterTabSwitch`). `TabSelect` (listened to in the
    capture phase; `updateCurrentBrowser` sets the selected browser before it fires) and
    `TabSplitViewActivate` (Bento's panel reconcile and Firefox's split view fire it; handled on a
    timer, so the order against Tabbrowser's own listener does not matter) run
    `closeBookmarksViewForShownDialog`: `isTabDialogShowing` over `shownBrowsers`.
  - Event order for a Leave/Stay prompt of a background tab (a tab or window close): PromptParent
    fires `DOMWillOpenModalDialog` (the tab is not shown, so the listener only schedules another
    look: `recheckBookmarksViewDialogLater`); Tabbrowser's own capture listener for that event,
    which runs after the window's, selects the tab and fires `TabSelect` (no dialog yet); the
    event returns and `TabDialogBox` sets `tabDialogShowing`; the second look then sees a shown
    tab with a dialog. `dialogopen` follows once the dialog has loaded and closes the view
    if the look has not. A page `alert()` of a background tab that Firefox does not select
    (`tabForEvent.attention`) leaves the view open; selecting that tab runs `TabSelect`.
  Closing is `hideBookmarksView({ immediate: true })`: a pending open is cancelled, the root
  attribute goes, the host is set `display: none` with no fade (so `hideOverlayHostAfterFade`
  finishes at once and the document is told it is no longer presented), the document gets its
  hide, and no focus moves (the dialog takes it).
- **Esc.** The document owns it (an inline editor closes before the view). Like Settings,
  `attachPaletteEscListener` returns for a key whose target is `bento-bookmarks-frame` (or a
  delivered menu above it, which handles its own), and consumes Esc only for an open that
  still waits for its document or with the focus elsewhere in the window. The view is last in
  the Esc stack, so every overlay above it takes Esc first.
- **Cmd/Ctrl+Shift+O.** `retargetLibraryKeyToBookmarksView` removes the `command` attribute
  from Firefox's `manBookmarkKb` key (Show All Bookmarks, the Library), keeps its value on the
  key in `data-bento-library-command` (`LIBRARY_KEY_STOCK_ATTR`), and listens for the
  `command` event the key then raises on itself, as the `mainKeyset` keys without a command
  do. The key's letter follows the locale. The menu items and toolbar buttons keep
  `Browser:ShowAllBookmarks`, so the Library stays reachable; they still show the key's
  accelerator text. A private window keeps the stock key.
- **Bookmarks manager off.** `BentoSettings.bookmarksEnabled` arrives on every `BENTO_PANELS`
  payload and `handlePanelsTitle` passes it to `applyChromeBookmarksEnabled`, which acts only
  on a change of `currentBookmarksEnabled` (default `true`, so a window that has not heard from
  tools yet behaves as before). Off: a view that is open or waiting for its document closes
  through the usual `hideBookmarksView()` (fade, the document's hide, the focus returned unless
  an overlay above the view, such as the Settings palette the switch was flipped in, is on
  screen), and `restoreLibraryKey` removes the listener and the stock attribute and sets the
  `command` attribute back to its saved value, so the key is the stock Library key (the mount
  never names Firefox's command; a test keeps it that way). While it is off
  `showBookmarksView` returns first thing, before it dismisses a palette or records a focus, so
  the title routes, the key and `toggleBookmarksView` all refuse; hiding stays possible. On:
  `retargetLibraryKeyToBookmarksView` points the key at the view again (idempotent: one
  listener however often it is called). A window that finds its key only after the setting was
  off (`retargetLibraryKeyToBookmarksView` waits for `DOMContentLoaded`) leaves it stock. A
  private window never retargets or restores. The command palette hides "Open Bookmarks" for
  the same setting from its own store, and tools keeps serving the bookmarks, so nothing the
  user saved is lost or hidden from the data layer.
- **Chrome under the view.** The `:root[bento-bookmarks-view]` block in
  `bento-shell-mount.css` (next to the `inDOMFullscreen` rules) hides the shell host,
  splitters, divider, strip container, side-panel host, tabbox, trailer, strip scrollbar, flat
  layout extent and panel navigator, and every child of `#nav-bar` but
  `.titlebar-buttonbox-container`, with `visibility: hidden` (the `*` half covers children
  with their own visibility). `#PersonalToolbar` is `display: none`. The toolbar strip is one
  surface: both stops of the toolbar gradient take `--bento-brand-bg` (neutral-5), the colour the
  document paints, in every window (with or without side panels). The hidden chrome flips on a `visibility` transition of the
  `modal` role, so it hides when the host's fade-in ends and the view cross-fades over the
  browser (the strip's controls are the exception, see Top-bar motion). Entering the view fades
  both strip stops with it; leaving it does not (the attribute and the transition go together). Dragging the window in the strip is Firefox's
  own nav-bar drag, because only the top-level chrome document computes drag regions.
- **Host motion.** The host has no inline transition (`ensureOverlayHost` with
  `inlineFade: false`): `bento-shell-mount.css` gives `#bento-bookmarks-host` an `opacity`
  transition on the `modal-dismiss` role and `:root[bento-bookmarks-view] #bento-bookmarks-host`
  one on the `modal` role. The reveal sets the opacity and the attribute in one style flush, and
  a hide removes the attribute and sets the opacity in one, so the style a change arrives at
  picks the role: modal in, modal-dismiss out. Both rules have generated twins in
  `bento-chrome-theme.css` (`node scripts/fade-twins.mjs`), so opening or closing during a
  colour-mode fade keeps its opacity transition (an inline transition would lose to the fade's
  `!important` catch-all and jump). `scripts/mount-fade-css.test.mjs` checks the rules and
  both twins.
- **Top-bar motion.** The strip's controls are the direct children of
  `#nav-bar-customization-target`: Back, Forward, Reload (`#stop-reload-button`) and the panel
  navigator (`#bento-panel-nav`) on the left, the extension buttons on the right. Opening the
  view slides each up past the window's top edge (the window clips it) and fades it out on the
  `dismiss` role; closing slides it back and fades it in on `reveal`. The return is on the
  resting rule, so removing the attribute is what animates it.
  - Only these children move. The container is a sibling of `.titlebar-buttonbox-container`,
    never an ancestor, so nothing reaches the window buttons; `#nav-bar` and the toolbox are
    untouched.
  - The individual `translate` property carries the slide, not `transform`: the sidebar push and
    drag set `transform` on Back, Forward, Reload and the navigator, and a transition on it
    would animate the reset at the end of a push. The distance is `-100%` of the control plus
    twice `--bento-toolbar-top-inset`, so it clears the window edge at any density.
  - Stagger: each group starts at its outer edge, each control a step of 0.08 of the role's
    duration after the one before, up to three steps. The left controls are named by id (Back,
    Forward, Reload, navigator); the right group is counted from the last child
    (`:nth-last-child`), so a hidden trailing child shifts the counts but not the order. A rule
    per step, because `lint:motion` allows only plain numbers in a `calc()`; the two halves of
    each `:is()` never match one element (`:not()` lists the left ids), so no rule depends on
    source order. The way out and the way back stagger the same way.
  - The base rule still ends on `visibility: hidden` for the controls (no focus, hit-testing or
    no-drag regions over the strip). Its flip is an entry of the slide's transition: the
    dismiss duration with a delay of three steps, so it lands after the last control arrives. The
    return has no visibility entry, so the controls are visible from its first frame.
    `pointer-events: none` is on from the first frame of the way out.
  - Anything else the strip shows (the overflow button, a private window's indicator) keeps the
    plain `modal` visibility flip.
  - Reduced motion (`prefers-reduced-motion: reduce`; the chrome has no Mux reduced token set):
    no slide and no fade, the change is instant.
  - The generated twins in `bento-chrome-theme.css` keep the slide through a colour-mode flip
    (`node scripts/fade-twins.mjs`). `scripts/mount-fade-css.test.mjs` checks every step's
    entries and twins; `scripts/overlay-surfaces.test.mjs` fails on a rule that moves or fades
    anything in the strip but children of the container.
- **Address bar.** While the view is open the sidebar is hidden, so `Cmd+L` opens the centered
  address bar (`canAnchorAddrbarToSidebarRow`) instead of anchoring it to an invisible row.
- **Dev reload.** `overlayEntry`'s `suspend` removes the attribute for `bookmarks`, so the
  chrome returns while the document reloads, and the replayed open hides it again.

Pitfalls:

- Never hide, fade or transform (`transform`, `translate`, `scale`, `rotate`)
  `#navigator-toolbox`, `#nav-bar` or `.titlebar-buttonbox-container`, and never give one of
  their ancestors `opacity`, `transform`, `translate` or `filter`. macOS draws the traffic lights itself and Gecko places them from the
  rects of the window buttons inside `.titlebar-buttonbox`, which it registers only while they
  are laid out, visible and without an effect on an ancestor; otherwise the lights leave the
  window.
  `scripts/overlay-surfaces.test.mjs` reads the stylesheet and fails on such a rule, and on
  any `opacity` or transform-like declaration in a view rule that touches the toolbar outside
  `#nav-bar-customization-target`.
- The top-bar slide must stay on the children of `#nav-bar-customization-target`. A `#nav-bar >
  *` or `:not(.titlebar-buttonbox-container)` rule with `translate` or `opacity` would also
  select the button box, or an ancestor of it, and the traffic lights would leave the window.
- Do not put the slide on `transform`, and do not add a resting `transition` for `transform` to
  Back, Forward, Reload or the navigator: the sidebar push and drag set `transform` there and the
  transition would animate its reset.
- `lint:motion` rejects `var(--bento-...)` in a `transition-delay` or a `calc()` in a
  `transition`, so a stagger index cannot come from a custom property; each step has its own
  rule and its own twin.
- Hide with `visibility`, not `display`, except `#PersonalToolbar`. Boxes that keep their size
  fire no resize observer and persist no bogus width; the toolbar row is the one that has to
  go for the strip to be a single row.
- The mount script writes the toolbar gradient inline with `!important`, so a stylesheet can
  override only its custom-property stops (`--bento-toolbar-left-bg`,
  `--bento-toolbar-right-bg`).
- The host is transparent like every host: the view's document paints its own opaque
  background, and it has to override the shared `html, body, #root { background: transparent }`
  of the overlay entries.
- Do not close the view from the other overlays' stack rules. Only the open dismisses the
  palettes; the reverse would close the view under a command palette that was opened over it.
- The view hides the page area, where Firefox draws tab-modal prompts and tab dialogs. A
  Leave/Stay prompt that opened under the view made a tab or window close wait on an invisible
  prompt. The view closes for them (see Tab dialogs above); a new Firefox mechanism that draws
  page-level dialogs elsewhere, or outside `.browserSidebarContainer`, needs the same check.
- A dialog event is not the only way a prompt comes into view. Closing on any
  `.browserSidebarContainer` dialog dismissed the view for an `alert()` of a tab nobody sees, and
  not listening for `TabSelect` left it over a prompt that was already open in the tab the user
  switched to (Firefox reuses the dialog and fires nothing). Keep the shown-browsers test on the
  events and the `TabSelect` / `TabSplitViewActivate` look; do not drop either for the other.
- Opening the view over a prompt that already waits hides it: the check is `tabDialogShowing`
  on the shown browsers, which `TabDialogBox` owns. Its dialogs queue per browser, so a second
  prompt of the same tab keeps the attribute until the last one closes. A system print dialog
  hides the Firefox dialog on purpose (`hideDialog` removes the attribute), so the view may open
  then.
- A reveal and a close do not own the focus when another overlay is on screen above the view.
  The reveal of a view that was requested while loading stole it from a command palette opened
  meanwhile, and a `Cmd+Shift+O` close gave it to the page under a visible palette. Any new
  overlay joins `BOOKMARKS_VIEW_HIGHER_OVERLAYS`.
- An inline `transition` on a host loses to the colour-mode fade's `!important` catch-all, so an
  open or close during a flip jumps. The view's host fades from the stylesheet, where the twins
  generator can see the rules; do not add `transition` to its `ensureOverlayHost` call.
- A page can still intercept Cmd+Shift+O (the key is not reserved), as it could the Library.

Manual verification (macOS, regular window, `--jsdebugger` for the Browser Toolbox): open the
view from the sidebar and from the command palette (the palette closes), and with
`Cmd+Shift+O` with a web page focused (the Library window must not open; Bookmarks > Manage
Bookmarks still opens it). The traffic lights stay visible and in place, and clickable, while
it is open and after it closes, also while the top-bar controls slide; dragging the empty strip
moves the window. Opening: Back, Forward, Reload, the panel navigator and the extension buttons
slide up past the top edge, fading, each group from its outer edge; nothing is left in the strip
afterwards and no control is focusable (Tab) or clickable there. Closing: they slide back and
fade in, from the same edges, with no jump at the end. Repeat slowed down (Browser Toolbox
Console: set `--muxui-semantic-motion-dismiss-transition-duration` and
`--muxui-semantic-motion-reveal-transition-duration` on `document.documentElement.style`) to see
the order, with the sidebar dragged or pushed just before, with a colour-mode flip during the
slide, and with reduced motion (no slide, instant). Esc closes it from
its first screen and leaves an open inline editor first. `Cmd+L`, `Cmd+T` and `Cmd+Alt+P` open
their overlays above it, and Esc closes only those. Close it: the sidebar, panels and
bookmarks toolbar return without a shift, and the focus is back where it was. Repeat in light
and dark, with the sidebar collapsed and hidden, with several panels, with reduced motion, and
confirm a private window never opens it and keeps the stock `Cmd+Shift+O`.

Prompts in other tabs: with the view open over tab A, an `alert()` from a background tab B
(a page timer) leaves the view open; selecting B from the command palette then closes it and
shows B's prompt focused. With a `beforeunload` prompt left open in B (close B, leave the prompt
open, select A, open the view), select B from the command palette: the view closes at once. Close
a background tab that has a `beforeunload` handler with the view open (command palette or a
window close with several tabs): the view closes, the tab is selected and the Leave/Stay prompt is
visible. Repeat in a split view with the prompt in the second panel.

Dialogs and focus (same window, then repeat the first with the window close button): with a
`beforeunload` prompt showing in the selected tab (close the tab and leave the prompt open),
`Cmd+Shift+O`, the sidebar button and the command palette's Open Bookmarks do nothing. Open a page
with a `beforeunload` handler (type into a form on it so Firefox asks), open the view, and press
`Cmd+W` with the focus in the view: the view closes at once, the Leave/Stay prompt shows and
takes the focus. Repeat with the view requested from a cold start (first use of the session) so
the open is still waiting for its document when `Cmd+W` runs: the view never appears.
`Cmd+P` with the view open closes it and shows the print preview. Request the view (first use)
and press `Cmd+Alt+P` before it appears: the palette keeps the focus and the view appears
under it. With the palette open over the view, press `Cmd+Shift+O`: the view closes and the
palette stays focused; Esc then closes the palette and the page keeps working. The view's
search field is focused when it opens with nothing over it, and is not when it appeared under
the palette (the show event's `detail.focus` is `true` and `false`; if the field is never
focused, the frame script's `content.wrappedJSObject.Object` detail is not reaching the page).

## Onboarding import handoff

The welcome overlay and the embedded import host swap at one rectangle so the
dialog reads as reshaping into the wizard card (the full protocol, states and
fallbacks are in [first-run-import.md](first-run-import.md#import-handoff)). Three
overlay mechanics carry it:

- **The `BentoWelcomeHandoff` frame script.** Chrome posts one object to the welcome
  frame and the relay does `content.postMessage(object, '*')` into the welcome
  document (`postToWelcomePage`, same `data:` frame script pattern as the tooltip,
  loaded before every post because it installs once per frame script global). The
  page tells the messages apart by `kind`: `bento-welcome-handoff` carries a phase
  (`hide`, `restore`, `reveal`, `fade-out`, `fade-in`, `reset`) and the dialog's
  token (`postWelcomeHandoff`); `bento-import-sources` carries the Import step's
  browser report ([first-run-import.md](first-run-import.md#import-sources)), sent
  from `showWelcome`'s reveal, which runs on the page's ready signal, so the page's
  listener exists, and again whenever the page asks
  (`BENTO_IMPORT_SOURCES_REQUEST_<ts>`). Handoff phases are outside the overlay
  manager's `open` queue on purpose: they are only sent after the welcome page has
  itself reported (READY, HIDDEN, RESTORED titles), so a lost message is bounded by
  chrome's 1.5 s ceilings and the page's own 3 s recovery; a lost report is bounded
  by the page's 4 s ceiling.
- **`data-bento-import-handoff` on `#bento-embedded-import-host`.** While the
  handoff owns the host, `bento-shell-mount.css` makes its opacity changes instant
  (`transition: none !important`), so showing it over the identical dialog and hiding
  it at the end do not fade; removing the attribute restores the `modal` fade, which
  is also the fallback. `hideEmbeddedBrowserImport` always removes it and drops the
  handoff, which is what `restartToBrowserImportFromWelcome` relies on.
- **The host's own motion.** The card's geometry and content fades run in the host
  document (`bento-migration-host.css`), and the mount waits on them with
  `afterMotion` on elements of that in-process document (`api.card`, `api.content`),
  so no duration is repeated in script.

Pitfalls: never open the host visible and fade it for a handoff (the card would
cross-fade with the dialog and a second dialog shows around it); never hide the
welcome frame itself during the handoff (it carries the scrim); an esc or backdrop
click while the card moves must stay inert, so the host page suppresses Esc itself
and the card takes no pointer input until `settle()`.

## Window scoping of overlay buses

One extension origin serves every Bento window, and a `BroadcastChannel` reaches
every document of that origin in every window. So every message on an overlay bus
names the chrome window it is for, and a receiver ignores other windows'. The
window id is the one bento-tools already routes by: chrome's
`windowTracker.getId(window)`, stamped on each frame URL as `#bentoWindowId=<N>`
and read once per document by `bridge/windowId.ts` (`thisWindowId`,
`isForThisWindow`). An unknown id on either side (Ladle, the standalone preview, a
failed chrome-side lookup) accepts the message, as an unscoped bus always did.

| Bus                                             | Sender                                                                 | Window id carried as                                  | Receiver filter                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `bento-confirm-bus` `show`                      | `requestConfirm` in a shell document                                   | `windowId` (sender's hash)                            | `subscribeToConfirmRequests`                       |
| `bento-edit-workspace-bus` `show`               | `requestEditWorkspace` in a shell document                             | `windowId`                                            | `subscribeToEditWorkspaceRequests`                 |
| `bento-workspace-switcher-bus` `show`, `closed` | `requestWorkspaceSwitcher`, `notifyWorkspaceSwitcherClosed`            | `windowId`                                            | `subscribeToWorkspaceSwitcherRequests`, `...Close` |
| `bento-addrbar-bus` `open`                      | chrome, `BentoAddrbarOpen` frame script (`dispatchAddrbarOpen`)        | `windowId` from `getChromeWindowId()`                 | `subscribeToAddrbarOpenRequests`                   |
| `bento-merge-palette` `open`, `close`           | chrome, `BentoMergePaletteLifecycle` (`dispatchMergePaletteLifecycle`) | `windowId` from `getChromeWindowId()`                 | `subscribeToMergePaletteLifecycle`                 |
| `bento-shell-bus` action `menu/open`            | chrome, `BentoShellAction` (`dispatchShellAction`)                     | `__windowId`, the envelope bento-tools routes by      | `subscribeToMenuOpen`                              |
| `bento-menu-bus` `closed`                       | `notifyMenuClosed` in the menu document                                | `windowId`                                            | `subscribeToMenuClosed`                            |
| `bento-sidebar-address-bus`                     | chrome, `BentoSidebarAddress`                                          | `windowId` plus a per-window bridge token (unchanged) | `shouldAcceptSidebarAddressMessage` (unchanged)    |

Scoped by construction, no bus involved: the tooltip payload (`content.postMessage`
into the tooltip frame's own window), the panel trailer cycle focus and the panel
scroll relays (they act on the frame's own document), and the BENTO\_\* titles
(delivered per `<browser>` to its own window's chrome). Not changed here: the
sidebar's own handlers for `ui/renameRequest` and `ui/selectAllTabs` on
`bento-shell-bus` do not filter by window.

Before this, `useConfirm` posted bare payloads, so window B's confirmation reached
window A's confirm document and replaced the dialog whose action the user was
about to confirm. The chrome-originated sends had the same reach: one window's
`menu/open` replaced another's open menu payload, an address bar open overwrote
another window's open state, and a merge palette `close` reset another window's
merge palette. Chrome stamps `windowId` in `dispatchAddrbarOpen` and
`dispatchMergePaletteLifecycle` and the frame scripts forward it;
`dispatchShellAction` already stamped `__windowId`.

### Transport in private windows

The buses in the table above are `BroadcastChannel`s between chrome frame scripts
and overlay documents, and between documents. All of them stay on a plain
`BroadcastChannel`, which works inside a private window's partition (a frame script's
`content.BroadcastChannel` is created in the document's own partition). Only traffic
with the shell background, which lives in the regular partition, changes: overlay
documents of a private window talk to it through the `BentoShellBus` relay (see
[Private windows: the BentoShellBus relay](shell-chrome-bridge.md#private-windows-the-bentoshellbus-relay)).
Overlay documents have no `browser` API, so the relay is also the only way for them to
reach the background in any window.

## Menu-open state of the sidebar New button

The New menu is a chrome menu overlay request (`BENTO_SIDEBAR_CONTEXT_MENU`, see
[workspaces.md](workspaces.md)), so the sidebar cannot see it open or close. The
New `Button` in `TabList` shows its open fill (`data-bento-menu-open='true'`,
painted by `--bento-surface-active` in `TabList.css`, with `aria-expanded`) from
two shell-only signals, mirrored by `bridge/newMenu.ts` into
`useUiStore().newMenuContextId`:

- Open: chrome's `menu/open` bus action reaches every document of the extension
  origin, the sidebar included. Chrome passes the request's `items` through
  unchanged, so the sidebar recognizes its New menu by the ids in
  `NEW_MENU_ITEMS` (`new-tab`, `new-panel`) and stores that menu's `contextId`.
  Any other `menu/open` in the window (tab, folder, panel, splitter menus) clears
  it, which also covers a newer menu replacing the New menu.
- Close: the menu document posts `closed` with the `contextId` on
  `bento-menu-bus` for every way its menu goes away (an item chosen, Esc, a click
  outside, which Mux reports as `onOpenChange(false)`), next to the
  `BENTO_MENU_SELECT` and `BENTO_MENU_CLOSE` titles chrome gets.

Source of truth: the menu overlay document. The store is transient and never
reaches bento-tools. Manual verification: [manual-regression-areas.md](manual-regression-areas.md#new-menu-open-fill).

Pitfalls:

- The state follows the overlay, not the click. Setting it on press stuck the fill
  when chrome cancelled an open that was still waiting for the menu document (Esc
  or a click first), because no `menu/open` and no close notice ever follow.
- The two buses are not ordered against each other. A close notice only clears the
  menu it names, so an older menu's notice landing after a newer New menu opened
  leaves the newer one's fill.
- Keep the state out of `TabListPane`. A workspace switch remounts the pane (and
  keeps the outgoing one on screen during the slide) while the overlay stays up,
  so a local flag would drop the fill from a menu that is still open.
- Clicking New while its menu is open cannot reopen it: the menu host covers the
  whole `#browser` area, so the click lands on the overlay, dismisses the menu, and
  never reaches the button.
- Mux's own pressed fill is suppressed under `aria-expanded='true'`, so the open
  fill is the only one painted on the button while the menu is up.
- Closing on window deactivation is not implemented: React Aria ignores a blur
  with no related target, so the menu (and the fill) stays while Bento is in the
  background, as the menu always did.

## Tooltip document

The panel navigator tooltip document calls `initToolsPort()` like the other
shell documents, so `useWorkspaceTheme` and `useFirefoxTheme` have the workspace
and settings mirrors they read. Before this, its stores never hydrated, so it
kept the Default theme and the color mode from boot. `src/entries.test.ts` fails
for any entry that applies the workspace theme without joining the bus. Chrome
creates the document when a panel navigator button is hovered or focused (the
load overlaps the 400 ms hover delay) and sends the label payload again when the
document announces readiness.

The payload is `{ label, detail?, placement?, screenX, screenY, width, height }`:
the anchor in screen coordinates, an optional second line, and which side of the
anchor the Mux tooltip opens on (`bottom` by default, `end` for the rail). The rail
merge card is the second user. The shell frame is the 52 px rail there, so a Mux
`Tooltip` drawn in it wraps to the frame and clips; the overlay is a window-wide
document and does not. `components/MergeProgressCard/railTooltip.ts` writes
`BENTO_RAIL_TOOLTIP:<timestamp>:<base64-json>` (`{ action: 'hover' | 'focus' | 'hide',
label, detail, anchor }`, the anchor being the ring's rect in shell-frame
coordinates) through the serialized `sendChromeTitle` queue. A title branch of
`handleShellFrameTitle` calls `handleRailTooltipTitle`, which adds the shell
frame's rect and `mozInnerScreenX`/`Y` to the anchor, sets `placement: 'end'`, and
then takes the navigator tooltip's own path: `hover` goes through
`armPanelNavigatorTooltip` (the 400 ms delay), `focus` through
`showPanelNavigatorTooltipPayload` at once, `hide` through
`hidePanelNavigatorTooltip`. An immediate show clears a pending hover timer first, so a
label that changes inside the 400 ms hover delay is not overwritten by the older text.
No new overlay, document or surface kind, and no new
Firefox dependency (it reads the `mozInnerScreen*` values the navigator tooltip
already did). The card sends `hover` on pointer enter and `focus` only when the
focus is `:focus-visible` (a click's focus does not raise it), and `hide` on pointer
leave, blur, the rail expanding, the card starting its exit and unmounting; the
mount script also hides it in `showMergePalette()`. The tooltip is a separate
document in the page's colour mode, so it does not follow the card's inverted scope.
A changing count is not sent again, because each send is a title write; the title
text is, when it changes while the tooltip is up.

Manual verification (expanded and rail, light and dark): in the rail with a merge
running, hover the ring for 400 ms (tooltip beside it, outside the rail, title then
detail); move away (gone); Tab to the ring (shows at once) and Tab away (gone);
hover, then expand the rail (gone); hover, then click the ring (the merge palette
opens, tooltip gone).

## Measuring

`window.BentoOverlayStats` (Browser Toolbox Console, chrome window) returns a
snapshot: the veil lift time, the creation order, and per overlay the state,
strategy (`eager`, `idle`, `demand`), creation reason (`startup`, `idle`, `show`,
`hover`), creation and readiness times relative to the veil lift, load time, how
the overlay became ready (`signal`, `no-handshake`), whether an open is waiting
(`pendingOpen`), whether it was reported as not announcing (`stalled`), the number
of opens, and how long the first and the slowest open waited for readiness. It is
a getter: reading it costs one object, and nothing samples in the background.

Manual verification: launch a fresh profile with `--jsdebugger`, and in the
Browser Toolbox Console run `window.BentoOverlayStats`. Right after the window
shows, `created` is `['confirm', 'edit-workspace', 'workspace-switcher']` plus
later idle entries; within a few seconds it also lists `'addrbar'`, `'palette'`,
and `'menu'`, and the other overlays are `absent`. Open each on-demand overlay
once and confirm its entry shows `reason: 'show'`, `readyBy: 'signal'`,
`stalled: false`, and a `firstOpenWaitMs` well under the 5 s stall report.

Overlay document pitfalls:

- Do not send chrome-to-overlay messages outside the open's `run`. A frame-script
  relay onto a `BroadcastChannel` does not queue, and a lazily created document is
  not listening yet; `run` only executes on the real announcement.
- Do not reveal an overlay, or release its queued open, on a timer. A readiness
  fallback that revealed after 5 s showed an empty overlay and left a queued
  message with nowhere to go. Report the stall and keep the open pending.
- Do not repeat a fade duration in script for a hide timer (the old `*_TRANSITION_MS`
  constants). The overlay fades follow the Mux tokens, so a Mux theme or a role
  change would leave the constant clipping or lagging the fade; use
  `hideOverlayHostAfterFade` or `afterMotion`.
- Do not start a timer that can discard a pending open (the address bar's reveal
  fallback) before the message that open depends on has been sent. Start it at
  delivery.
- Do not post on an overlay bus without the target window id, and do not accept a
  message without checking it (`isForThisWindow`). The channels are shared by
  every window.
- Do not decide "is this overlay open" from the host visibility alone. A cold open
  has no visible host yet: use `isOverlayOpen` (visible or pending) in every Esc,
  toggle, outside-click, and focus path, and call `overlays.cancel(id)` from every
  hide.
- Do not apply stack rules when an overlay becomes ready. Apply them when the open
  is requested, or whichever document loads last cancels the other.
- Do not add replay, request ids, acknowledgements, or cancel relays between
  documents to make a lazily created sender-to-overlay payload arrive. They
  produced the failures this section removes (equal ids from two senders applied
  in the wrong order, a delayed cancel clearing a replacement request). A payload
  overlay that a user action can request at once is created at window startup
  instead.
- Do not call `ensure` or `open` from a hide, resize, or teardown path: it would
  create a document the user never asked for. Look the frame up and skip when it
  is null.
- Do not announce readiness before the effects that subscribe to the payload
  channel. Place `useOverlayReadySignal` after them in the same top-level
  component (effects of one component run in order; children run first).
  `src/entries.test.ts` requires the call in every overlay entry.
- A new overlay needs a row in the `createOverlayManager` table, a title handler
  entry for its frame id (the READY title is read before it), a `useOverlayReadySignal`
  call, and a name in `OverlayName`. `scripts/overlay-manager.test.mjs` fails when
  the table, the title handlers, and the shell names drift apart.
- The READY title is deduped per frame like every other title, so it keeps its
  timestamp suffix.

Tests: `scripts/overlay-manager.test.mjs` runs the real manager under fake timers.
`scripts/mount-motion.test.mjs` runs `measureMotion`, `afterMotion` and
`cancelMotion` against fake computed styles.
`scripts/overlay-surfaces.test.mjs` extracts the real `show*`, `hide*`, toggle,
Esc, outside-click, and `dispatch*` functions and the real overlay table from the
mount and drives them with a fake DOM and recording message managers (cold open
then Esc, palette then merge palette in both readiness orders, a stalled document,
the menu and address bar at 7 s, the window id chrome stamps, the Bookmarks view's titles, root
attribute, focus return, Esc, Library key and private-window refusal, and a guard on its
stylesheet rules).
`src/bridge/windowScope.test.ts` runs the real bridge modules for several windows
on an in-memory channel, and runs the frame scripts read from the mount into them,
including the two-window confirm case.

## Chrome overlay transparency

Chrome-mounted menu overlays such as the workspace switcher cover the whole
browser window so their popovers can escape the sidebar iframe. The host and the
overlay document must both stay transparent; the popover itself is the only
opaque surface.

Load-bearing details:

- `ensureOverlayHost` creates JS-owned overlay hosts with transparent XUL
  `vbox` and `<browser>` backgrounds. Static or theme-owned overlay hosts must
  also be listed as transparent in `bento-chrome-theme.css`.
- Chrome overlay HTML entries, including `workspace-switcher.html`,
  `workspace-palette.html`, `palette.html`, `edit-workspace.html`,
  `confirm.html`, `welcome.html`, and `panel-trailer.html`, must force `html`,
  `body`, and `#root` to
  `background: transparent !important`. The shell build uses
  `cssCodeSplit: false`, so unrelated entry CSS such as
  `theme/document-base.css` (the shared `html`/`body` background, color, font,
  and min-height) can arrive later in the shared `style.css` bundle and
  otherwise override plain transparent background declarations.
- Sidebar-owned menus that need to overhang the collapsed rail must route
  through the chrome-mounted menu overlay, not an iframe-local `Menu.Popover`.
  The sidebar New menu uses `BENTO_SIDEBAR_CONTEXT_MENU` with
  `placement: 'bottom start'` for this reason.
- Do not add an app-wide surface to menu overlay roots. If an overlay needs a
  content-area scrim, it should be drawn by that overlay's dialog/backdrop
  component, not by the page or chrome host background. If it is a modal scrim,
  pair it with `showOverlayToolbarScrim(owner)` / `hideOverlayToolbarScrim(owner)`
  in `bento-shell-mount.js` so the native toolbar and urlbar are dimmed too.
- The embedded import host (`bento-migration-host.html`, a non-remote chrome page in
  `#bento-embedded-import-frame`) is an overlay document too, and it links Firefox's
  `chrome://global/skin/in-content/common.css`. That sheet's
  `:root { background-color: var(--background-color-canvas); color-scheme: light dark }`
  outranks a plain `html, body { background: transparent }` and `html { color-scheme: light }`
  (specificity 0,1,0 against 0,0,1), and overriding `--background-color-canvas` on `body`
  alone does nothing because the root element cannot inherit it. The symptom was a solid
  `#1c1b22` fill that hid the onboarding dialog and its scrim, and was dark even in Bento
  light mode because `light dark` follows the OS. `bento-migration-host.css` now sets
  `background: transparent !important` on `html, body` and puts `color-scheme: light` on
  `html:root` (`html[data-color-mode='dark']` still selects dark).
