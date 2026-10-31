# Shell to chrome bridge

Part of the [technical notes index](../core-functionality-technical.md).

Chrome-bound state travels through title IPC because WebExtension UI documents
cannot directly mutate Firefox chrome.

Chrome receives titles from Firefox's `pagetitlechanged` event, not from
polling. Whenever a top-level document in a chrome `<browser>` changes its
title, `WindowGlobalParent::RecvUpdateDocumentTitle` stores the new title in
the parent and dispatches a chrome-only, bubbling `pagetitlechanged` event on
the embedding `<browser>` element. `attachPaletteCloseListener()` in
`bento-shell-mount.js` installs one capture-phase `window` listener that looks
up `event.target.id` in a frame-id to handler table (shell, palette, merge
palette, workspace palette, address bar, confirm, edit-workspace, welcome,
embedded import, menu, workspace switcher, and panel trailer frames), checks
that the frame is showing its expected Bento document (a `moz-extension://` URL
whose host is the bento-shell add-on's `mozExtensionHostname`, or the
`chrome://browser/content/bento-migration-host.html` URL for the non-remote
embedded import frame; otherwise the title is ignored and logged once per
frame), reads `frame.contentTitle || ''`, drops a title equal to that frame's
last seen title, and calls the same `BENTO_*` prefix handler the old interval and
`requestAnimationFrame` pollers called. The shell frame, which carries
`BENTO_PANELS`, is one more table entry, so there is no per-frame timer and no
idle wakeup.

Why the event is reliable for these frames: the dispatch happens in the parent,
for every extension-process and in-process top-level frame, whenever the
content process reports a changed title; it adds no visibility, focus, or
layout dependency beyond the document reporting its title (the old pollers had
the same one). `RunDOMEventWhenSafe` dispatches synchronously from the IPC handler unless
script is blocked, after the parent-side title is updated, so `contentTitle` is
the title that triggered it.
The table is keyed by id on a window-level listener, so frames created after
mount (the panel trailer and the lazily created overlay frames), reloaded frames, and
frames that switch process need no re-attachment; they keep the same `<browser>`
element and every Bento page has a static `<title>`, so each load normally fires an
event that resets the per-frame dedupe. `DOMTitleChanged`, which earlier code
tried and found unreliable, is dispatched inside the content process and does
not reach chrome for remote frames; do not confuse the two.

The channel is a single title slot per document, and the content process
reports it to the parent from a runnable queued by the first write, reading the
title when that runnable runs. A write made before then replaces the pending
title, so chrome never gets a `pagetitlechanged` for the replaced value. That
covers two writes in one synchronous block and also a write in an earlier task
followed by another task that was already queued (the next bus message, a React
effect flushed in a microtask). The event removes the polling window, not that
loss.

Every producer in a shell document therefore sends titles through
`sendChromeTitle` (`bridge/chromeTitle.ts`) instead of assigning
`document.title`. The writer sets the first title immediately and holds any
title sent before the report has run. It releases the next title from a private
`MessageChannel` (one per document, created on first use and reused): each write
is followed by `port1.postMessage(null)`, and the `port2` message handler writes
the next held title. The write dispatches the report runnable and the
postMessage dispatches the delivery runnable afterwards. Both are
Normal-priority main-thread dispatches that run in dispatch order, so each title
is reported before the next one is written. Titles reach chrome in send order
with no drops and no polling; the per-frame dedupe in chrome still drops a title
identical to the previous one, which is why sentinels keep their timestamp
suffix. The chrome receive path and the
`BENTO_*` wire format are unchanged. ESLint (`no-restricted-syntax` in
`eslint.config.mjs`) rejects `document.title =` anywhere under
`extensions/bento-shell/src` except the writer.

The ordering rests on Firefox engine behavior (also listed in
`docs/firefox-core-touchpoints.md`; the functions named here are byte-identical in the
154.0, 157.0.1 and 158.0 sources): `Document::NotifyPossibleTitleChange`
(`dom/base/Document.cpp`) dispatches the report runnable synchronously from the
title write, and `DoNotifyPossibleTitleChange` reads the title when it runs;
`MessagePort::Dispatch` (`dom/messagechannel/MessagePort.cpp`) dispatches the
delivery runnable at `postMessage` time on an unshipped entangled port with
`NS_DispatchToCurrentThread`. Neither runnable sets a priority
(`ThreadEventTarget::Dispatch` puts both in the Normal queue) and equal-priority
main-thread tasks run in creation order (`Task::PriorityCompare` in
`xpcom/threads/TaskController.h`). A timer cannot give this guarantee:
`TimeoutManager::RunTimeout` (`dom/base/TimeoutManager.cpp`) selects every
expired timeout before running any callback and runs them in one executor task,
so a `setTimeout(0)` created after an earlier zero-delay callback joins that
batch and can write the next title before the report runs. The port's handler
must be assigned with `onmessage` (which starts the port); an
`addEventListener('message')` listener would not receive messages until
`start()`.

The writer holds only an in-document queue and persists nothing; `bento-tools`
stays the source of truth and each `BENTO_PANELS` forward is rebuilt from the
shell mirrors. `bridge/fakeChromeTitle.ts` models the same engine rules (one
FIFO task queue carrying the report, MessagePort deliveries and the timer
executor, and a timer executor that fires all expired timeouts in one task), so
`bridge/chromeTitle.test.ts` fails a timer-based writer.

Manual verification: with a profile whose welcome flow is hidden but not
completed (`welcomeSeen` false), open the Browser Toolbox Console and paste a
capture-phase `pagetitlechanged` listener on `window` that logs
`event.target.id` and `event.target.contentTitle` for `bento-shell-frame`, then
reload only the sidebar frame. The log must contain at least one
`BENTO_PANELS:` title whose decoded payload carries the settings fields
(`uiColorMode`, `sidebarCollapsed`, ...) as well as the `BENTO_OPEN_WELCOME_`
titles, and the panel strip must show the saved panels.

The main channel is `BENTO_PANELS:<ts>:<base64-json>`, written by
`useToolsPort.ts` when a `panels/sync` event matches the shell document's active
workspace for its window. The payload carries:

- workspace id and optional window id;
- panel array;
- layout tree and layout status map;
- workspace theme id;
- UI color mode;
- sidebar collapsed state;
- custom panel sizes, preserving the Settings-defined drag order for the panel
  header custom widths menu;
- default panel width, mirrored into the main content slot minimum width;
- panel cycle wraparound setting;
- panel shadow setting;
- persisted strip scroll;
- pinned panel tab ids for the active workspace;
- saved panel count;
- optional panel id to scroll into view.

The panel shadow setting toggles `bento-panel-shadows-disabled` on both
`gBrowser.tabpanels` and `#bento-strip-container`. Split-view panels read the
class from `tabpanels`; the no-side-panels, tabs-only main content slot reads it
from the strip container because its shadow is applied outside `tabpanels`.
The relevant chrome styles live in `src/browser/base/content/bento-shell-mount.css`.
`:root` defines
`--bento-panel-frame-outline-shadow` (the hairline, drawn by each frame's `::after`
overlay above the page) and `--bento-panel-frame-shadow` (the elevation shadow on the
frame); the disabled class sets `--bento-panel-frame-shadow` to `none`, and the hairline
stays.
Do not use live resize root attributes (`bento-window-resizing`,
`bento-sidebar-resizing`, or `bento-panel-resizing`) to override the shared
shadow token globally. Keep
`scripts/check-chrome-resize-guard.mjs` wired into token import paths so token
bumps cannot suppress full elevation shadows during live resize.
All panel-like chrome surfaces that should respect the setting must use
`var(--bento-panel-frame-shadow)` rather than `var(--shadow-l)` directly.
The no-side-panels main-content frame must not add a live window/sidebar resize
override; its `.browserSidebarContainer` keeps the same
`var(--bento-panel-frame-shadow)` declaration before, during, and after the
gesture. The scoped no-panel resize guard enforces that full-shadow path.
This includes ordinary split-view panel frames, subdivided-panel descendants, and
the absolute layout chooser wrapper
`#bento-side-panel-host > .bento-layout-chooser`. The chooser wrapper is the
surface shown after `Subdivide panel`; if it uses `var(--shadow-l)` directly,
the bottom chooser area keeps a drop shadow even when Panel shadows is off.
The same chooser is focusable and participates in panel cycling. It receives the
same `bento-panel--focused` / `bento-panel--cycle-focused` classes as panel
containers and paints its ring through `.bento-subdivision-chooser::after`.
Flat-layout chooser overlays are stamped with `data-bento-chooser-id` and
`data-bento-owner-tab-id` so focus and the bottom navigator marker can map the
overlay back to its owning top-level panel.

Chooser cycling fix: Cmd/Ctrl+Shift+arrow cycling, Shift-wheel cycling, and the
content-key bridge all call `navigatePanels()`, which reads `getPanelCycleTargets()`. In
flat layout, that target list must be built from `currentPanelLayout` via
`getFlatLayoutPanelCycleTargets()` / `appendLayoutCycleTargets()` rather than
from DOM attributes. Flat layout sets no subdivision DOM attributes and renders
choosers as absolute `.bento-layout-chooser` overlays, so the DOM is not a
source for chooser cycle targets. If this regresses, the visual focus ring may
exist, but Cmd/Ctrl+Shift+Left/Right and Shift-wheel will skip the chooser
entirely.

Other title channels still exist for one-off chrome actions, such as opening
overlays, focusing a pinned panel, moving tabs, and scrolling back to main.

Process-wide listener pitfall: `bento-shell-mount.js` runs once per browser
window, but `AddonManager.addAddonListener` (a strong process-wide `Set`) and
`PlacesUtils.observers.addListener` (a strong process-wide JS listener list)
keep each listener, and every window its closure captures, alive until quit.
`attachReloadListener()` and `attachSidebarAddressSnapshotListeners()` therefore
remove their listener in a window `unload` handler, using the same listener
object (and, for Places, the same event-type list). Any new per-window
registration on a process-wide registry (observer service, Places,
AddonManager, preference observers, window mediators) must do the same or
register once per process. The ExtensionsUI observer topics and the `BentoKey`
window actor are intentionally process-wide singletons and are registered
once. Manual check: in the Browser Toolbox Console, wrap the add/remove methods
above to count live Bento listeners, open a second window, close it, and
confirm the count returns to its prior value.

`setFrameSrc` retries while the extension policy (`WebExtensionPolicy.getByID`)
or the chrome window id is unresolved. The window id branch retries every 50 ms,
capped at `SET_FRAME_SRC_MAX_RETRIES`, then loads without the window id. The
policy branch backs off instead (50 ms doubling to a 2 s ceiling) so a slow cold
start still loads every frame, and gives up after about 30 s
(`SET_FRAME_SRC_POLICY_GIVE_UP_MS`) with one `giving up after N ms` warning per
frame, leaving that frame unloaded instead of polling forever. The two budgets
are separate: waiting for the policy does not consume window id retries.

## Shell bus bootstrap

All shell documents in all windows (the 12 entries that call `initToolsPort()`:
sidebar, address bar, panel trailer, workspace switcher, edit workspace,
confirm, welcome, menu, workspace palette, merge palette, palette, panel
navigator tooltip) in regular windows share one
`BroadcastChannel('bento-shell-bus')`. `bento-shell/src/background.ts` owns the
only port to `bento-tools` and relays events and actions both ways. Documents in
private windows cannot use that channel; see
[Private windows: the BentoShellBus relay](#private-windows-the-bentoshellbus-relay).

- Live boot: when the port connects, `bento-tools` sends `tools/booted`, then
  the six snapshots (tabs, workspaces, settings, pinnedPanels, tabFolders,
  savedPanels), then one `panels/sync` per workspace. Every document that is
  already listening receives them and sends no snapshot requests.
- Late join: a document posts `{ kind: 'hello', helloId }`. The background
  replays the cached `tools/booted` and the last `panels/sync` per workspace,
  tagged `replayFor: helloId`. `BroadcastChannel` still delivers the replay to
  every document, but each one drops replays tagged for another id, so a join
  costs the other documents no store update, snapshot request, or
  `BENTO_PANELS` title write. The joiner requests the six snapshots once, on
  the replayed boot, and only if it had not already seen a live boot. Tools
  answers each request with a snapshot broadcast to every document.
- Chrome forwarding is order independent: the sidebar writes `BENTO_PANELS`
  only for its window's active workspace, which it learns from the workspace
  snapshot, and the payload embeds the settings snapshot (every settings field
  `handlePanelsTitle` in `bento-shell-mount.js` reads: `uiColorMode`,
  `sidebarCollapsed`, `sidebarHidden`, `sidebarShortcutBehavior`,
  `defaultPanelWidthPx`, `customPanelSizes`, `panelCycleWraparound`,
  `panelShadowsEnabled`, `panelCornerRadiusPx`, `panelSplitterSizePx`) and the
  workspace theme. A replayed `panels/sync` can arrive before any of them, so
  the sidebar keeps the latest incomplete sync per workspace
  (`pendingPanelsSync` in `bridge/useToolsPort.ts`): held while the active
  workspace is unknown, or kept after a forward that went out before settings
  had hydrated. `workspaces/snapshot`, `workspaces/changed`, and
  `settings/snapshot` or `settings/changed` re-forward the pending sync for the
  active workspace, so the last write always carries the full payload. A
  forward with every input present clears the entry, so live boot and later
  settings changes (which tools answers with its own `panels/sync`) write
  nothing extra. Pending syncs for other workspaces are discarded.
- Cache pruning: the background drops a workspace's cached `panels/sync` on a
  `workspaces/changed` removal delta and on any `workspaces/snapshot` that
  lacks it, so replays never resurrect deleted workspaces.
- `emitPanelsSync` in `bento-tools/src/background.ts` is coalesced per
  workspace and target window within one task
  (`panels/PanelsSyncScheduler.ts`); the one-shot scroll target survives the
  merge. Boot and restore paths that must not continue before the broadcast has
  gone out call `emitPanelsSyncNow` directly.

Message counts for one window with N documents joining one at a time after
tools booted (`bridge/busBootstrap.test.ts`, N = 12 with the tooltip): 72
snapshot requests and 468 snapshot deliveries. Measured at N = 11, before the
tooltip joined: 66 and 396, and before the guard 396 requests and 3036
deliveries, because every replayed `tools/booted` made every document request
all six snapshots again. With all 12 documents listening when tools boots: 0
requests. Documents that chrome creates lazily (next section) join late, so
each one costs a 6-request snapshot burst when it is created instead of at
window startup.

Manual verification: in the bento-shell background console (about:debugging,
Inspect), attach a `BroadcastChannel('bento-shell-bus')` listener that counts
messages with `kind === 'action'` and an `action.type` ending in
`/requestSnapshot`, and messages with `kind === 'event'` and an `event.type`
ending in `/snapshot`, then open a window. A document that joined after tools
booted adds 6 requests; documents that were listening at boot add none.

Bus bootstrap pitfalls:

- Do not replay the background's cached tabs, workspaces, or settings
  snapshots on `hello`. The cache lags live state (deltas do not update it), and
  every document would `applySnapshot` the stale value, dropping recently
  created tabs from the sidebar for a few frames.
- Do not make documents request snapshots on every `tools/booted`, or accept a
  replay that is not tagged for them. Each replay would fan out six full
  snapshot requests per document, and each reply is broadcast to all documents:
  requests grow with the square and snapshot deliveries with the cube of the
  document count, and both multiply across windows.
- Do not gate the joiner's `panels/sync` replay on the live-boot check. The
  joiner is already ready when the replayed `panels/sync` messages arrive, and
  they are its only source of panel state for non-active workspaces.
- Do not drop a `panels/sync` because the sidebar's active workspace is still
  null, and do not forward it once and forget it. Hello replays are targeted,
  so no later overlay's `hello` re-broadcasts panels, and chrome would keep
  showing main only until the next panel change or workspace switch. The
  forwarded `BENTO_PANELS` payload must be re-sent when any of its inputs
  hydrate (active workspace, settings, workspace theme): a forward that beat
  the settings snapshot left `sidebarHidden`, custom size presets, and panel
  cycle wraparound at chrome defaults, because settings hydration sent no
  replacement. Covered for all six arrival orders by
  `bridge/busBootstrap.test.ts`, "sidebar forwarding of panels to chrome".
- Do not put a timer in front of `emitPanelsSync`. Callers time follow-up work
  against the emit (the 80 ms delay before closing the old main tab after a
  panel promotion), and chrome reconciles against stale panel payloads if the
  close beats the sync.
- Snapshot replies are not targeted at the requester. Tools' `ctx.send`
  broadcasts, requests carry no correlation id, and `savedPanels/snapshot` is
  also emitted unsolicited, so matching replies to requesters by order would
  mis-tag broadcasts. Targeting needs a request id in `Action` and `Event`.

## Private windows: the BentoShellBus relay

Firefox partitions `BroadcastChannel` by `privateBrowsingId`, even for one
extension origin. A shell document in a private window therefore never reaches the
(regular) shell background over `bento-shell-bus`: the sidebar stayed at
"connecting...", the palette showed no workspace data and the merge palette never
listed sources. Two private windows do share one partition, so the channel still
works between documents of private windows.

Private windows use a relay; regular windows keep the `BroadcastChannel` hot path
unchanged. The one exception is the Settings overlay, which uses the relay in every
window (see "The Settings overlay on the relay" below).

- Transport choice: `setFrameSrc` stamps `#bentoPrivate=1` on every frame URL of a
  private window. `bridge/useToolsPort.ts` reads it (`readPrivateFromHash`) and
  picks its transport in `bridge/shellBus.ts`: `createChannelTransport` or
  `createRelayTransport`.
- Actor pair `BentoShellBus` (`src/browser/actors/BentoShellBusChild.sys.mjs`,
  `BentoShellBusParent.sys.mjs`), registered once per process by
  `registerShellBusActor` in the mount, on `moz-extension://*/*` with the DOM event
  `bento-bus-up` (`capture`, `wantUntrusted`: the page dispatches it, and Firefox
  defaults `wantUntrusted` to false). The child moves JSON strings only: the
  document hands one to the child as the `detail` of a `bento-bus-up`
  `CustomEvent`, and messages back arrive as `bento-bus-down`. No content object
  crosses the boundary.
- Identity comes from chrome. The parent actor accepts only a document whose URI
  host is the bento-shell extension's and whose top browsing context is hosted by a
  `navigator:browser` window (`browsingContext.top.topChromeWindow`;
  `embedderElement.ownerGlobal` is null for these frames). It derives the window id
  (`windowTracker.getId`) and privacy (`PrivateBrowsingUtils.isWindowPrivate`)
  there and mints a `documentId` per document. The page supplies only the message.
  The hub also stamps every upward record with a `sessionId` it mints when the module
  loads (one per browser run); the Settings relay hands it to tools in the `caller`
  block, where it scopes durable-operation ownership. The child actor forwards an upward
  string of up to 22 MiB, which counts the serialized message (see privacy-search.md).
- Hub: the parent module exports `BentoShellBusHub` (up listener, backlog while nothing
  listens of at most 128 records and 24 Mi characters of document messages, oldest
  dropped first, `postToDocument`, `postFromChrome`). The
  chrome-bridge experiment exposes it as `bentoChrome.onBusMessage` and
  `bentoChrome.postToDocument(documentId, message)`, in both copies
  (`src/experiments/chrome-bridge/` and the tracked `experiments/chrome-bridge/`,
  copied by `vite.config.ts`) plus `schema.json`. Every user of the hub imports it
  as `resource:///actors/BentoShellBusParent.sys.mjs`, the URL the actor is
  registered with: `resource://app/actors/...` loads a separate module instance
  with its own state.
- Handshake: the document repeats `hello` (250 ms doubling to 2 s) until the
  background answers `{ kind: 'ack', helloId }`. The background owns a private
  window's `shell/hello`: it sends one per window to tools, again whenever the tools
  port reconnects, so a tools restart recreates the window's Private workspace. A
  repeated `hello` is idempotent.
- Background fan-out (`fanOutEvent` in `bento-shell/src/background.ts`) is where
  audiences are enforced. Tools wraps workspace-bound events in an `audience/event`
  envelope (`AudienceEvent` in `_shared/audience-event.ts`): `'regular'`
  reaches the `BroadcastChannel` documents and the replay cache, `{ privateWindowId }`
  reaches only that window's relay documents. A private document therefore receives
  global events (settings, privacy, boot, saved panels) and its own window's state,
  never the regular tabs, workspaces, panels, pins or folders, and never `backup/*`
  or `externalMerge/*`. A workspace-bound event that arrives unwrapped is treated as
  regular (`WORKSPACE_BOUND_EVENTS`, which includes `panel/focusedChanged`: it names a
  tab and a window, and tools answers it to the asking window's audience). Regular
  documents never see an event addressed to a private window.
- Window-local sidebar state: a private window's sidebar collapse, hidden state and
  colour mode (`WINDOW_LOCAL_SETTING_KEYS` in `_shared/windowLocalSettings.ts`) live
  in the shell background's memory, one entry per private window
  (`bridge/privateWindowSettings.ts`), and are never saved. A window's entry is made
  at its first relay `hello` from the latest saved settings, so a new private window
  starts from the regular values at that moment, and it is dropped when the window's
  last relay document closes. `fanOutEvent` puts the window's entry over the saved
  values in every `settings/snapshot` and `settings/changed` that goes to that
  window's relay documents (`forWindow`). A `settings/update` that arrives through
  the hub (Cmd+S raised by chrome, the collapse button, the footer colour control) is
  split by `applyPrivateSettingsUpdate`: the window-local keys update the entry and
  go as one `settings/changed` to that window's documents only, the remaining keys go
  to tools as an ordinary update. Tools also drops the three keys from a private
  source (`settings/update` in `protocol-handler.ts`) and refuses `settings/reset`
  from one, so a page that bypasses the background cannot change the saved values.
  Chrome learns the values through the `BENTO_PANELS` payload like in a regular
  window; because tools never sees a private window's own change and so does not
  re-fire `panels/sync`, the private sidebar re-sends its last forwarded
  `panels/sync` (without the scroll hint) when one of the three values changes
  (`lastPanelsForChrome` in `useToolsPort.ts`). Colour mode is also announced between
  a window's own documents: `useFirefoxTheme` names the window in its
  `resolved-color-mode` broadcast and, in a private window, reads and listens to a
  per-window `resolved-color-mode@<id>` key, because all private windows share one
  `BroadcastChannel` partition and one `localStorage`. The unscoped keys remain the
  first-paint hint `boot.js` reads.
- Identity of actions: for every message that arrives through the hub the background
  overwrites `__windowId` (and a `shell/hello` payload window) with the hub's window
  id. A window id the page puts in its URL hash or actions is ignored.
- The Settings overlay on the relay: the Settings document (`settings-palette.html`)
  says `{kind: 'settings-hello', helloId}` and sends each request as
  `{kind: 'settings-request', request}` in every window, regular or private. The
  background (`bridge/settingsRelay.ts`, `SettingsRelay`) keeps these documents apart
  from the private sidebar documents (`relayDocuments`), takes the identity from the
  hub (`{documentId, windowId, isPrivate, sessionId}`, never from the page: a `caller` field the
  page adds is dropped) and forwards the request to tools on the authenticated port as
  a `settings-client/request`. It puts its own id on the wire (`requestId`) and maps
  tools' `settings/result` back to the asking document under that document's own id,
  delivered with `postToDocument` as `{kind: 'settings-result', result}`; a result is
  never part of the fan-out. A request on a port that is down is answered at once with
  `internal_error`; pending requests are dropped when the port disconnects (the
  client's own deadline and `operation/status` polling cover them), and when the
  document closes. A request from a document that is not registered registers it, so a
  background reload does not strand an open Settings document. Profile-wide change
  notices (`settings/changed`, `privacy/changed`, `searchEngines/changed`) reach every
  registered Settings document (a private window's with its own values over the saved
  ones), so a change in one window shows in the others' open palettes.
  A private caller's Bento color mode is the window's own: tools strips
  `WINDOW_LOCAL_SETTING_KEYS` from the update of a private overlay caller (it still
  saves the rest), and on the successful result the background applies the window-local
  part to the window's entry, tells the window's other documents (the sidebar and
  overlays, with `applyWindowLocalSettings`) and puts the window's colour mode over the
  `snapshot/get` and `settings/update` results the Settings document reads. Tools
  refuses backup operations, notice acknowledgement and `settings/reset` from a private
  caller (`isPrivateForbiddenOperation`), so the document's hidden rows are not the
  only guard.
- Document-local actions (`menu/open`, `ui/*`) stay on a plain `BroadcastChannel`
  inside the private partition, in the document (`localChannel`) and in chrome's
  `BentoShellAction` frame script. Only tools-bound actions use the relay. Chrome's
  own `dispatchShellAction` in a private window posts those to the hub once
  (`postShellActionThroughBusHub`), never per receiving frame.

Pitfalls:

- The Settings overlay must say `settings-hello` (not `hello`) and must not send
  tools-bound `action`s: a `hello` from a private document is a private sidebar and
  makes tools create the window's Private workspace. A regular document's relay
  traffic is ignored unless it is a Settings message.
- Do not create a `BroadcastChannel` in the shell background for private documents
  or expect one document-level channel to reach it.
- Do not import the hub through two URL spellings (see above), and do not read
  `embedderElement.ownerGlobal` in the actor. The removed shell document registry
  was imported as `resource://app/actors/...` by the mount and as
  `resource:///actors/...` by the experiment: documents registered in one instance
  and the experiment read the other, which was always empty, so the document
  handshake and the targeted per-document channel never ran and no document ever
  received a graph publication. Nothing failed, because every consumer treated an
  empty list as normal; imports and restores still ran the publication bookkeeping
  (a tab read and three `bento.graphPublication.v1` writes) for zero recipients. To test a
  shared parent module, import it through both spellings in the Browser Toolbox
  Console and compare the two exports.
- A content-process actor (`BentoKeyChild`, `BentoShellBusChild`, any new
  `*Child.sys.mjs`) must be copied into the dev app as a real file, with its parent
  module beside it: add a `copy_content_actor` line in
  `scripts/sync-builtin-addon-symlinks.sh`. A dev build otherwise leaves the file a
  symlink chain into `src/browser/actors`, which the content-process sandbox cannot
  read (read paths cover the app bundle, not the checkout), so the load fails
  (`Failed to load resource:///actors/BentoShellBusChild.sys.mjs`) and every relay
  document, private windows included, never connects. Packaged builds copy the
  files through `moz.build` and are unaffected. `scripts/bento-build.test.mjs`
  fails when any actor under `src/browser/actors` stays a symlink after the script.
- Do not send a private window's workspace-bound state with `send`: tools wraps it
  (`messaging/audience.ts`), and the fan-out is the only place that decides the
  audience.
- A relay document that never says hello gets nothing; the retry loop is the only
  recovery for an actor that attached after the document's first `bento-bus-up`.
- Do not send a private window's sidebar or colour change to tools, or read those
  three values from the unsubstituted saved settings in a private document. A
  background reload (Alt+Shift+R in a dev build) drops the per-window entries; the
  windows start again from the saved values.
- The Settings palette's colour mode row in a private window writes only that
  window's own mode (the domain drops the window-local keys of a private
  `settings/update`); the saved value, and so the regular windows, stay as they are.

Manual verification: open a private window, then in the Browser Toolbox Console
import `resource:///actors/BentoShellBusParent.sys.mjs` and attach a listener with
`BentoShellBusHub.onUp`: each private document's `hello` shows `isPrivate: true` and
the window's id; the same list for a regular window's documents shows nothing,
because regular windows do not use the relay.

Settings overlay on the relay: open Settings from the app menu in a regular and a
private window. In the Browser Toolbox Console, `BentoShellBusHub.onUp` shows a
`settings-hello` with the hub's `windowId` and `isPrivate` for each; from the private
window's Settings document, a dispatched `bento-bus-up` with a `settings-request` for
`backup/getContext` answers `private_window_forbidden`, whatever `caller` it carries.

Window-local sidebar state: with two private windows and a regular window open,
collapse the sidebar and switch the colour mode in one of them (Cmd+S, the collapse
button, the footer colour control). Only that window changes; the others do not,
and after quitting the saved settings (`browser.storage.local`, `settings` key of
bento-tools) hold only what regular windows set.

## Direct colour mode signal (tools to chrome)

A light/dark flip does not wait for the title IPC. `bento-tools` calls
`browser.bentoPrivacy.notifyUiColorMode(mode, stamp)` in the first line of its `settings.onChange`
handler, once per change of the saved `uiColorMode` (`createChromeColorModeSignal` in
`settings/ChromeColorModeSignal.ts`; a failed or missing call is logged and the handler goes
on). The experiment (`extensions/bento-tools/experiments/bento-privacy/api.js`, with the same
shape as `consumeAddPanelGrant`: a chrome-facing method in the existing `bentoPrivacy`
namespace, so no manifest change and no version bump) validates the value (`light`, `dark` or
`system`) and fires a `bento-ui-color-mode-set` `CustomEvent` (`detail` is `{ mode, stamp }`, `stamp` is `null` when it is not a valid
`{ run, seq }` and carries `flipAt` only when that is a finite number; the schema marks `flipAt`
optional, so an older caller just sends no time) at every `navigator:browser` window. The mount script's `handleUiColorModeSet` (next to
`applyChromeColorMode`) calls `applyChromeColorMode(mode, stamp)`; Auto resolves in chrome as it
does for the payload. It is not a shell-bus message: the hub and the relay reach shell
documents, not chrome windows, and a chrome window is not a registered document.

- Timing: the shell documents apply the same pref from their settings store's `subscribe`; the
  stamp's `flipAt` (below) makes chrome and every document start the fade at one scheduled
  instant instead of when each heard of the change (theming.md, "Mode flip fade").
- Scheduled flip: `SettingsStore` sets `flipAt` (`Date.now()` plus `COLOR_FLIP_LEAD_MS`) on the
  stamp whenever `uiColorMode` changes, and the stamp carries it on every route: the direct
  event, `settings/changed` and `settings/snapshot` (`colorStamp`), the sidebar's
  `uiColorModeStamp` in `BENTO_PANELS` (a private window's payload drops it: its mode is its own and
  never scheduled), and into the shell store as `colorFlipAt` next to `current`. Chrome
  (`setChromeColorMode`) and each shell document (`applyModeWithFade`) prepare the flip in the
  next animation frame (the mode and the fade attribute go on, with `--bento-mode-fade-delay`
  set to the time left until `flipAt`, which is turned once, on receipt, into a deadline on the
  document's monotonic clock, so a step of the system clock cannot move it) and announce it at
  the first frame at or after `flipAt` (the window's overlays through the resolved-mode
  broadcast, `about:preferences` through `bento-ui-color-mode`); an Auto choice is resolved again
  when the flip is prepared. A late message, a missing `flipAt`, the first application, an
  unchanged mode and a hidden window apply at once, and an OS appearance change under Auto is never
  scheduled. A request is either joined to the waiting flip or replaces it: a later request that
  resolves to the mode the waiting flip already shows (the `BENTO_PANELS` payload that arrives inside
  the lead, or Dark followed by Auto resolving to dark) joins it, keeps its earlier deadline and takes
  over the newest write and announcement, so the mode is announced once, at that deadline; a request
  for the other mode, or an OS change that makes the waiting mode wrong, replaces it with its own
  `flipAt` and the stale mode is never announced. The stamp-order rule below runs first, so a dropped
  message can neither join nor replace. The stamp's `flipAt` is not recorded by
  `acceptChromeColorStamp`: only `{ run, seq }` orders messages, so a stale `flipAt` can never be
  replayed. Nothing about it is persisted.
- Cached schema: a profile can still hold an older `notifyUiColorMode` schema whose `stamp` has
  only `run` and `seq` (built-in add-on metadata is cached by version and this change adds no
  version bump). That schema does not ignore `flipAt`: Firefox rejects the call for an unexpected
  property, so the send fails and is only logged, and the direct event is lost (the
  `BENTO_PANELS` route still carries the stamp, with its `flipAt`, later).
  `createChromeColorModeSignal` therefore retries a failed send that carried
  `flipAt` once with `{ run, seq }` only; the event then reaches chrome without a time and
  applies at once. Both failures are logged, together, only when the retry fails too, and nothing
  is retried again (a stamp with no `flipAt` is not retried at all).
- Hidden window: a window that is hidden when the change arrives applies it at once, without a fade
  (a hidden window gets no animation frames). A window that hides while a prepared or running fade is
  active drops the fade attribute and delay at once, announces a not yet announced mode once, and never
  repeats an announcement; see theming.md, "Mode flip fade".
- Rules: a private window ignores the event (its mode is its own, in memory, and reaches chrome
  through its own sidebar's `BENTO_PANELS`). A window whose mount script is not running yet
  misses the event, which is fine: `BENTO_PANELS` carries `uiColorMode` and applies it at
  startup, without a fade (the first application in a window never fades). The payload is the
  backstop for a lost event and for every other chrome-bound setting; its later
  `applyChromeColorMode` call finds the mode already applied or its flip waiting and joins it, so
  one flip makes one fade and one announcement.
- Order: the two routes can deliver out of order (a payload serialised before the flip, held in
  `sendChromeTitle`'s queue, reaches chrome after the event), so the mode carries a stamp
  `{ run, seq }` (`ColorStamp` in `extensions/_shared/protocol.ts`). `SettingsStore.colorStamp()`
  returns the run id of this tools run (new for every run) and a `seq` that starts at 1 when the
  store is constructed and rises with each change of the saved `uiColorMode`; the stamp exists
  from the start of a run, so the initial snapshot and its first payload are ordered too. Tools
  adds it as `colorStamp` to `settings/snapshot` and `settings/changed` and to the direct event;
  the sidebar writes the newest (another run replaces the kept one) into each `BENTO_PANELS`
  payload as `uiColorModeStamp`. Chrome's rule: nothing recorded, anything applies; another run
  applies and replaces the record; the same run applies unless `seq` is lower than the record;
  a message without a valid stamp is dropped once a stamp is recorded. It never reads a clock and
  nothing is persisted, so a tools restart (clock changes included) cannot make chrome reject a
  legitimate change. The exact rule and the one restart case that is only corrected on the next
  message are in theming.md, "Mode flip fade". A payload with the same stamp and mode is a
  no-op, so the backstop never cancels or restarts a running fade.
- Why not the existing surfaces: the title channel is the slow leg (a microtask-scheduled
  `emitPanelsSync`, then `browser.tabs.get` per visible panel, then the shell relays the payload
  through its `document.title`); the bus hub and `postToDocument` address documents, not
  windows. A dedicated `BENTO_COLOR_MODE` title was removed earlier because it raced
  `BENTO_PANELS` (see Title IPC pitfalls); this event does not use the title, but the two do race (the payload is
  slower and can be older), which is why the stamp exists; both write the same attribute
  through the same function.
- Verify: flip the mode in a regular window with a private window open. The regular window's
  root takes `data-color-mode` and a single `data-bento-mode-fade` set; the private window's
  `bento-ui-color-mode-set` listener sees each event and its root stays as it was.

## Page error signal (chrome to tools)

`TabSnapshot.pageError` is set while a tab's top-level document is one of Firefox's own pages for a
failure, and absent otherwise. The WebExtension tabs API says nothing about the page, and the
signals Firefox does give are unreliable: a tab on an error page keeps the failed address as its URL,
and its favicon is a stand-in that a website can declare too (the `global` chrome package is content
accessible, and `FaviconLoader.sys.mjs` accepts `chrome:` favicons after
`checkLoadURIWithPrincipal`), so a favicon proves nothing. The state comes from the document the
tab's browser actually shows.

Mapping from the browser's document (`browser.documentURI`, scheme `about:`, path and `e` query
parameter) to `pageError`:

- `crashed`: `about:tabcrashed`; `about:restartrequired` (a build-ID mismatch, which sets the same
  attribute); and the `crashed` attribute on the tab while the page document is still loading.
- `certificate-warning`: `about:certerror`; `about:neterror` with `e=nssBadCert` or
  `e=nssFailure2` (the cases where `aboutNetError.mjs` and the identity panel's
  `_isCertErrorPage` use the certificate treatment).
- `blocked`: `about:blocked` (Safe Browsing, `urlclassifier.alternate_error_page`);
  `about:restricted` (parental controls); `about:neterror` with `e=blockedByPolicy`.
- `unavailable`: `about:httpsonlyerror`; any other `about:neterror`.

The `blockedByPolicy` and `nssFailure2` mappings are judgement calls: Firefox titles the first "Blocked
Page" and gives the second its certificate icon, and Bento follows. Everything else on
`about:neterror` (DNS, refused, timeout, offline, proxy, and so on) is `unavailable`. Other pages,
such as `about:sessionrestore` or a website that declares a Firefox error icon, report nothing.

Path, with `bento-tools` the producer and no mount script or Firefox patch involved:

- `extensions/bento-tools/experiments/bento-tab-state/api.js` (the `bentoTabState` experiment, schema
  next to it) registers a callback with `EveryWindow` (`resource:///modules/EveryWindow.sys.mjs`),
  which runs it in each browser window once its startup is done and in every window opened later.
  Per window it keeps two event sources: `gBrowser.addTabsProgressListener` (top-level
  `onLocationChange` only, for every tab, selected or not) and one `MutationObserver` on
  `gBrowser.tabContainer` (subtree, `crashed` attribute only). That one container holds every tab of
  the window: pinned and unpinned tabs, tabs in groups and the panel tabs of a split view. Both
  sources re-derive the tab's state from `documentURI` and the attribute and fire
  `onPageErrorChanged(tabId, pageError | null)` when it differs from the last value told to this
  extension (a `WeakMap` per tab element, so a navigation that changes nothing sends nothing). The
  WebExtension tab id is `extension.tabManager.getWrapper(tab).id`. No timer and no per-tab listener.
- When a window starts being watched, its tabs that already show such a page are reported at once
  (forced past the "last told" check, because the receiver may have dropped an earlier event). A
  window is only watched after its delayed startup, so this covers a tab that crashed or failed to
  load before then, and a tab adopted into a new window, whose document is swapped in while that
  window loads.
- `getPageErrors()` returns `[{ tabId, pageError }]` for the tabs of every ready window and records
  the answer as told.
- `TabRegistry` (`tabs/TabRegistry.ts`) subscribes first in `init()` (before `tabs.query`), then calls
  `getPageErrors()` once the tabs are stored and sets every tab's state from it (a tools restart
  while a tab shows an error page still shows it). `#onPageErrorChanged` ignores an event that repeats
  the state, sets or deletes `pageError` on the snapshot and queues an `updated` delta
  `{ pageError }` (`pageError: null` when it ends). The delta goes to the audience of its tab,
  so a private tab's state reaches only its private window's documents. `onCreated` for a tab the
  registry already tracks keeps the state. An event for a tab `onCreated` has not delivered yet
  (the experiment can fire first, as `tabs.create` can resolve first) is kept in
  `#pendingPageErrors` and applied when the tab arrives, then dropped on `onRemoved`.
- The state is cosmetic. If the experiment is missing or throws, `TabRegistry` logs
  `page-error events unavailable` or `page-error read failed` and goes on without it.
- Manifest: the experiment schema is cached per add-on version, so
  `extensions/bento-tools/manifest.json` was bumped to 0.1.14 (0.1.13 shipped the earlier
  `crashed` boolean API). Edits to `api.js` alone are read fresh.

What flips it and what clears it:

- Crashed: Firefox puts the crashed-tab page in the tab: a selected tab whose content process dies
  (`about:crashcontent`), or a tab that crashed in the background once it is selected (a background
  crash revives the tab as an unloaded `about:blank` tab and defers the page until
  `SessionStore.#maybeRestoreTabContent` runs for it on selection or split-view activation, so a
  background crash does not set the state until then). `sendToTabCrashedPage` sets the attribute
  right after it asks the docshell for the page, so the attribute reports first and the
  location change (`LOCATION_CHANGE_ERROR_PAGE`) confirms it. The tab's progress listener is new
  after the switch to a non-remote browser and withholds location changes until it sees the first
  real request, which the crashed-tab page's own load is.
- Error pages: the docshell loads `about:<page>?e=...&u=<failed address>` into the tab. A remote
  browser stores that document's URI (`BrowserParent::RecvOnLocationChange` calls
  `updateForLocationChange` just before it notifies listeners), so the tabs listener reads the new
  document. `nsIWebProgressListener.idl` documents that on an error page `document.documentURI` is
  the redirected location.
- Clears on any location change to another document (reload, navigation, URL typed, Restore Tab and
  Restore All Crashed Tabs through `reviveCrashedTab`, a switch to a new content process), and when
  the tab closes (`tabs.onRemoved`). Restore Tab removes the attribute before the new document
  loads, so the state clears at the location change that follows, a few milliseconds later, not at
  the attribute change.
- A moved tab keeps its state: `swapBrowsersAndCloseOther` swaps the docshell, which keeps the
  crashed-tab page, but does not copy the attribute to the new tab element. The document still says
  `about:tabcrashed`. A tab moved into an existing window is re-read by `TabRegistry.#onAttached`
  (`getPageErrors()` after the swap). A tab torn out into a new window gets `onAttached` before the
  swap, which `browser-init.js` does as that window loads (at once for a non-remote tab such as the
  crashed-tab page, on the first paint for a remote one). The new window is not ready yet, so that
  read can clear the state; the new window's watch reports it again once its startup is done, a
  fraction of a second later.

Pitfalls:

- A website can declare a `chrome://global/skin/icons/warning.svg`, `info.svg` or `blocked.svg`
  favicon, so no state may come from the favicon. The earlier favicon heuristic showed a normal
  HTTPS page with such an icon as a certificate warning. `about:restricted` also keeps the website
  URL and uses `warning.svg`, which the same heuristic read as a certificate warning. Only the
  document decides.
- A tab copies `crashed` onto its own children by attribute inheritance (`.tab-icon-stack`,
  `.tab-icon-image`, `.tab-icon-overlay`, `.tab-audio-button`, `tab.js` `inheritedAttributes`), so the
  subtree observer also sees records for those elements. The callback keeps only records whose target
  `gBrowser.isTab()`; without that filter `getWrapper` would mint a tab id for an icon element.
- `getWrapper` returns nothing for a tab mid-adoption and for one the extension may not access; both are
  skipped, never given an id.
- A tab in a window that has not finished its startup is not in `getPageErrors()`; that window's
  watch reports it later. Do not treat a missing tab as proof the state ended before then.
- `onLocationChange` is delivered for every top-level navigation of every tab. The "last told" check
  is what keeps the experiment silent for the ones that change nothing; `getPageErrors()` must keep
  updating it, or a state read on attach would never be cleared by the next navigation.
- A cleared state is `pageError: null` in the delta, never `undefined`. A private window's relay
  (`BentoShellBusParent.sys.mjs`) JSON-serialises messages, which drops an `undefined` property, so the
  shell would merge an empty change and keep the old icon and tint. Snapshots omit the field, and the
  shell's tabs store deletes it when a `null` arrives. Any code reading `pageError` must treat `null`
  like absent.
- `getPageErrors` and `onPageErrorChanged` use the same tab ids as the tabs API and `TabSnapshot.id`.

Verify (built app, tools background console or the sidebar): see the checks in
[firefox-core-touchpoints.md](../firefox-core-touchpoints.md#page-error-state-bento-tab-state-experiment).

## Title IPC pitfalls

- Title writes coalesce: a title replaced before the content process reports it
  never produces a `pagetitlechanged` in chrome. This is not limited to one
  synchronous block. Reload of a profile with `welcomeSeen` false lost
  `BENTO_PANELS` because the settings snapshot handler forwarded the full
  `BENTO_PANELS` payload and, in the same task, the React welcome effect (flushed
  in a microtask) assigned `BENTO_OPEN_WELCOME_<ts>` over it, so chrome never
  saw the settings or panel state. Always send titles with `sendChromeTitle`
  (`bridge/chromeTitle.ts`), never `document.title =`; the writer is covered by
  `bridge/chromeTitle.test.ts` and the welcome case by `bridge/busBootstrap.test.ts`
  ("first-run welcome request follows in the same task"). A new producer in any
  shell document (overlay frames included) needs no workaround for ordering
  against other titles.
- Do not release held titles from `setTimeout(0)`, `setInterval`, or a promise.
  A zero-delay timeout created after an earlier one joins that timeout's
  executor batch, which can run the next write before the report runnable (a
  timer-based writer loses `BENTO_PANELS` to a zero-delay welcome callback this
  way). The `MessageChannel` release is dispatched after the report. A microtask
  runs before the report, so it is worse.
- Do not reintroduce separate title writes
  for chrome-bound settings that can ride inside `BENTO_PANELS`; one payload is
  still cheaper for chrome than several reconciles.
- `BENTO_PANELS` is the canonical chrome state payload for panel visibility,
  layout, theme, color mode, sidebar collapsed/hidden state, sidebar shortcut
  behavior, and related active workspace chrome state. Any extra sidebar title
  channel must be sparse: emit
  only for a real event/state transition, never on ordinary renders, snapshots,
  or empty steady state. Before `sendChromeTitle`, a harmless-looking repeated
  sentinel such as an empty selection payload could overwrite `BENTO_PANELS`
  before chrome's `pagetitlechanged` handler read it, leaving the main content
  visible but hiding all side panels. The writer now delivers both, but every
  extra title still costs a chrome handler run and a queued task.
- If a title channel needs a clear/reset signal, send that reset only after the
  channel previously sent a non-empty/non-default value. Do not continuously
  announce "nothing selected", "closed", "default", or similar no-op state.
- `uiColorMode` intentionally rides inside `BENTO_PANELS`; separate
  `BENTO_COLOR_MODE` writes previously raced panel sync at boot.
- Only the sidebar entry should push workspace theme changes to chrome. Other
  shell entries share `document.title` for their own sentinels and can stomp the
  theme signal.
- The shell forwards `panels/sync` to chrome only for the active workspace in
  that window. Tools may broadcast panel state for every workspace so shell
  mirrors can filter tab lists during workspace transitions.
- Activation-triggered `panels/sync` may carry a target `windowId`. If the
  shell has not resolved an active workspace yet, it may accept that payload for
  the matching window even before its local workspace mirror has applied the
  activation delta; this keeps the first chrome theme/color payload from being
  dropped when a new window auto-creates a workspace because all existing
  workspaces are occupied.
- Do not reintroduce `setInterval` or `requestAnimationFrame` title polling.
  The chrome window listens to `pagetitlechanged` once; polling every frame
  cost about 90 timer callbacks per second per window plus a callback at the
  display refresh rate, forever, including minimized windows (chrome timers are
  not background-throttled). Add a new title-IPC frame by registering its id and
  handler in the table inside `attachPaletteCloseListener()`, not by adding a
  timer or a per-element listener.
- Title handlers only run for a frame whose `currentURI` is its own Bento page,
  so a frame that navigates somewhere else cannot drive chrome by setting
  `document.title`. Each frame in the table must keep loading only Bento pages
  (`moz()` URLs, or the migration host for the embedded import frame); if a
  frame legitimately needs another origin, change the check rather than
  removing it. A rejected title logs `ignoring title from unexpected document`
  once per frame in the Browser Console.
- Handlers run synchronously inside Firefox's IPC handler for the title update.
  Keep them non-blocking: no nested event loops such as modal prompts and no
  synchronous waits. Reloading the frame that just wrote the title from inside
  its own handler is the case to check first if a handler ever misbehaves.
- Listen for `pagetitlechanged`, never `DOMTitleChanged`. `DOMTitleChanged` is a
  content-process event and does not reach chrome for remote frames. The
  parent-side event only fires for top-level browsing contexts and only when the
  title differs from the previous one for that document, so keep the timestamp
  suffix on sentinels that can repeat.
- The handler reads `frame.contentTitle`, not an event payload (the event has
  none). It normally sees the title that triggered the event because the
  dispatch is synchronous in the IPC handler; do not move the read behind a timer or
  microtask, or two quick writes collapse into the later one.

## Chrome to tools: SessionStore tab values

Chrome code that must tell bento-tools something about a tab, without a port message
whose order against WebExtension events is unknown, writes a tab value in the key space
WebExtensions use: `SessionStore.setCustomTabValue(tab, 'extension:bento-tools@bento.app:<key>',
JSON.stringify(value))`, which tools reads back with `browser.sessions.getTabValue(tabId,
'<key>')` (`ext-sessions.js` stores `JSON.stringify(value)` under `extension:<id>:<key>`).
The mount script already reads `bento.workspaceId`, `bento.closingTab` and the window's
`bento.activeWorkspaceId` this way. `bento.handover` is the one value chrome writes: when
a closing window adopts its tabs into another window (see
[workspaces.md](workspaces.md)), it appends a hop `{ from, to, at }` to the list on each
returned tab (a tab handed on again carries its earlier hops), so `tabs.onDetached` and
`tabs.onAttached` can tell it from a drag. The value must be written after `adoptTab`
returns (SessionStore moves a tab's values to the adopting twin on `TabOpen`, and deletes a
pending tab's when its state is restored). The mount drops the hops older than 15 s, or
timed in the future, as it appends one; tools only reads the value and never writes or
deletes it. It matches each side of a hop once, only while the hop is under 15 s old and
no older than the tools instance's uptime on the monotonic clock (`tabs/Handover.ts`).
The events reach tools asynchronously, so a value written in the same task as the
adoption is there when they are handled.
