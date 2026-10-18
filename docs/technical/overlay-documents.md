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

| Overlay (frame id `bento-<name>-frame`) | Document                                             | Opened by                                                                                            | Strategy                   | What the open depends on                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirm`                               | `confirm.html`                                       | `BENTO_OPEN_CONFIRM` from sidebar, switcher, or workspace palette                                    | eager (window startup)     | Payload on `bento-confirm-bus`, named for its window; the document exists before any user action can request it                                             |
| `edit-workspace`                        | `edit-workspace.html`                                | `BENTO_OPEN_EDIT_WORKSPACE` from sidebar or switcher                                                 | eager (window startup)     | Payload on `bento-edit-workspace-bus`, named for its window                                                                                                 |
| `workspace-switcher`                    | `workspace-switcher.html`                            | Sidebar trigger, `BENTO_OPEN_WORKSPACE_SWITCHER`                                                     | eager (window startup)     | Payload on `bento-workspace-switcher-bus`, named for its window; the host stays laid out so `window.screenLeft` is right                                    |
| `addrbar`                               | `address-bar.html`                                   | `Cmd/Ctrl+L/E/T`, native urlbar focus or click, `BentoKey:AddrbarOpen`, sidebar `BENTO_OPEN_ADDRBAR` | idle, 1st                  | Open message from chrome through the `BentoAddrbarOpen` frame script onto `bento-addrbar-bus`, named for its window; `BENTO_ADDRBAR_READY` reveals the host |
| `palette`                               | `palette.html`                                       | `Cmd/Ctrl+Alt+P`, sidebar `BENTO_OPEN_PALETTE`                                                       | idle, 2nd                  | Nothing: the dialog stays open inside the document, chrome only toggles the host                                                                            |
| `menu`                                  | `menu.html`                                          | `showChromeMenu` (sidebar, trailer, panel and splitter menus)                                        | idle, 3rd                  | `menu/open` on `bento-shell-bus` through the `BentoShellAction` frame script, with chrome's `__windowId`                                                    |
| `workspace-palette`                     | `workspace-palette.html`                             | Sidebar or switcher `BENTO_OPEN_WORKSPACE_PALETTE`                                                   | first use                  | Nothing                                                                                                                                                     |
| `merge-palette`                         | `merge-palette.html`                                 | Sidebar footer `BENTO_OPEN_MERGE_PALETTE`                                                            | first use                  | Open and close messages through the `BentoMergePaletteLifecycle` frame script onto `bento-merge-palette`, named for its window                              |
| `welcome`                               | `welcome.html`                                       | `BENTO_OPEN_WELCOME` from the sidebar and from the welcome document                                  | first use (first run only) | Resume step hash, read from the environment at window startup                                                                                               |
| `embedded-import`                       | `chrome://browser/content/bento-migration-host.html` | Welcome import step                                                                                  | first use                  | None: a non-remote chrome page with no handshake, src set on every open                                                                                     |
| `panel-navigator-tooltip`               | `panel-navigator-tooltip.html`                       | Hover or focus on a panel navigator button                                                           | first hover                | Label payload through the `BentoPanelNavigatorTooltip` frame script (`content.postMessage` into this frame's own window), sent again on readiness           |

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
  starts the navigation once, and runs `run` as soon as the overlay is ready: at
  once for a ready one, else on the announcement. `run` does the reveal (dim, host
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
the menu and address bar at 7 s, the window id chrome stamps).
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
