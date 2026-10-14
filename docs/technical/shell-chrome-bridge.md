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
`--bento-panel-frame-outline-shadow` and `--bento-panel-frame-shadow`; the
disabled class overrides `--bento-panel-frame-shadow` to the outline-only value.
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
navigator tooltip) share one
`BroadcastChannel('bento-shell-bus')`. `bento-shell/src/background.ts` owns the
only port to `bento-tools` and relays events and actions both ways.

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
[workspaces.md](workspaces.md)), it marks each returned tab with `{ from, to, at }` so
`tabs.onDetached` and `tabs.onAttached` can tell it from a drag. The value must be written
after `adoptTab` returns (SessionStore moves a live tab's values on `TabOpen`, and deletes a
pending tab's when its state is restored), is read by both events without being consumed,
and expires after 15 s (`tabs/Handover.ts`). The events reach tools asynchronously, so a
value written in the same task as the adoption is there when they are handled.
