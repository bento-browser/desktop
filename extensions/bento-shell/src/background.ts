// Bento Shell — background entry point.
//
// Two responsibilities:
// 1. Hold the long-lived port to bento-tools (cross-extension). This works
//    reliably from a background context.
// 2. Bridge events to the chrome-mounted shell document via a same-origin
//    BroadcastChannel. We can't use runtime.connect from a chrome-mounted
//    extension page (cross-process restrictions silently swallow the
//    connection), but BroadcastChannel works across all same-origin contexts
//    regardless of process boundaries.
//
// Reconnect logic: built-in addons load alphabetically, so bento-shell starts
// before bento-tools. On a fresh profile the first connect attempt fires
// before tools' onConnectExternal listener exists — the port disconnects
// immediately. Persistent profiles avoid this because the addon system
// hot-loads both quickly. We retry with backoff so fresh profiles work too.

import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';
import { isAudienceEvent, type AudienceEvent } from '@shared/audience-event';
import { splitWindowLocalSettings, type WindowLocalSettings } from '@shared/windowLocalSettings';
import { PrivateWindowSettings } from './bridge/privateWindowSettings';
import { NativeModeStateOwner } from './bridge/nativeModeState';
import type { NativeModeStateReply } from '@shared/settings-client-protocol';
import { SettingsRelay } from './bridge/settingsRelay';
import type { BusDown } from './bridge/shellBus';
import { isDocumentLocalAction } from './bridge/shellBus';

const CHANNEL_NAME = 'bento-shell-bus';
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;

const channel = new BroadcastChannel(CHANNEL_NAME);

interface BentoChromeEvent<T> {
  addListener(listener: (value: T) => void): void;
}

/** One upward message from the BentoShellBus hub. Window id and privacy come
 * from the chrome window hosting the document, never from the page. `documentId`
 * is null for an action raised by chrome itself. */
interface BentoChromeBusMessage {
  documentId: string | null;
  windowId: number;
  isPrivate: boolean;
  /** Names one browser run (the hub mints it at load); see BentoShellBusParent.sys.mjs. */
  sessionId: string;
  message: unknown;
}

interface BentoChromeAPI {
  onBusMessage: BentoChromeEvent<BentoChromeBusMessage>;
  postToDocument(documentId: string, message: BusDown): Promise<boolean>;
  replyModeState(requestId: string, response: NativeModeStateReply): Promise<boolean>;
}

const bentoChrome = (browser as unknown as { bentoChrome: BentoChromeAPI }).bentoChrome;
const backgroundInstanceId = crypto.randomUUID();

let toolsPort: browser.runtime.Port | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let firstMessageReceived = false;

let lastBooted: Event | null = null;
// Per-workspace — panels are workspace-scoped, so a single "latest" cache
// would lose workspaces beyond whichever fired most recently. Hello-replay
// walks every entry so a freshly-mounted document gets the full picture.
// Entries are dropped when their workspace is removed (see
// pruneRemovedWorkspaces) so replays never resurrect deleted workspaces.
const lastPanelsSyncByWorkspace = new Map<string, Event>();

function pruneRemovedWorkspaces(event: Event): void {
  if (event.type === 'workspaces/changed') {
    for (const delta of event.deltas) {
      if (delta.kind === 'removed') lastPanelsSyncByWorkspace.delete(delta.id);
    }
  } else if (event.type === 'workspaces/snapshot') {
    // Authoritative list: also heals a panels/sync that raced a removal.
    const live = new Set(event.workspaces.map((workspace) => workspace.id));
    for (const workspaceId of lastPanelsSyncByWorkspace.keys()) {
      if (!live.has(workspaceId)) lastPanelsSyncByWorkspace.delete(workspaceId);
    }
  }
}

// ---- Event fan-out and the private-window relay ----------------------------
//
// Documents in regular windows hear the bus over BroadcastChannel. Documents in
// private windows (BroadcastChannel is partitioned away from this page) hear it
// through the BentoShellBus relay, one targeted message per document. Every
// tools event leaves through fanOutEvent, which is where audiences are enforced:
// - a regular document never receives an event addressed to a private window;
// - a private document receives global events (settings, boot, saved panels,
//   search results) and events addressed to its own window, nothing bound to the
//   regular workspaces;
// - externalMerge/* never reaches a private document;
// - a private window sees the settings with its own sidebar collapse, hidden state
//   and colour mode over the saved ones (see PrivateWindowSettings).

/** Events tied to the regular workspaces. Tools wraps them in an audience; one
 * that arrives unwrapped is treated as regular so it can never reach a private
 * document. */
const WORKSPACE_BOUND_EVENTS = new Set<Event['type']>([
  'tabs/snapshot',
  'tabs/changed',
  'workspaces/snapshot',
  'workspaces/changed',
  'panels/sync',
  // Names a tab and a window, so it is as private as the workspace that holds them.
  'panel/focusedChanged',
  'pinnedPanels/snapshot',
  'pinnedPanels/changed',
  'tabFolders/snapshot',
  'tabFolders/changed',
]);

/** Private-window documents that said hello, by hub document id. */
const relayDocuments = new Map<string, { windowId: number }>();
/** Private windows whose shell/hello already went to the current tools port. */
const toolsHelloSent = new Set<number>();
/** Each private window's own sidebar collapse, hidden state and colour mode. */
const privateSettings = new PrivateWindowSettings(backgroundInstanceId);
const modeStateOwner = new NativeModeStateOwner({
  instanceId: backgroundInstanceId, privateSettings,
  send: (message) => {
    if (!toolsPort) return false;
    try { toolsPort.postMessage(message); return true; } catch { return false; }
  },
  reply: (requestId, response) => { void bentoChrome.replyModeState(requestId, response).catch(() => {}); },
});
browser.windows.onRemoved.addListener((windowId) => {
  privateSettings.close(windowId);
  modeStateOwner.dropPending(windowId);
});
/** The Settings overlay document of every window, regular or private. */
const settingsRelay = new SettingsRelay({
  instanceId: backgroundInstanceId,
  toTools: (message) => {
    if (!toolsPort) return false;
    try {
      toolsPort.postMessage(message);
      return true;
    } catch (error) {
      console.warn('[bento-shell] settings request to tools failed:', error);
      return false;
    }
  },
  toDocument: (documentId, message) => bentoChrome.postToDocument(documentId, message),
  privateSettings,
  applyLocalSettings: applyWindowLocalSettings,
});

function isWithheldFromPrivateDocuments(event: Event): boolean {
  return event.type.startsWith('externalMerge/');
}

function privateWindowIds(): Set<number> {
  return new Set(Array.from(relayDocuments.values(), (document) => document.windowId));
}

/** Drops a closed private document; the last one of a window takes the window's
 * own settings and hello record with it. */
function forgetRelayDocument(documentId: string): void {
  const document = relayDocuments.get(documentId);
  if (!document) return;
  relayDocuments.delete(documentId);
  if (privateWindowIds().has(document.windowId)) return;
  toolsHelloSent.delete(document.windowId);
  // A document reload is not a private-window close. The native window owns it.
}

function postToRelayDocument(documentId: string, message: BusDown): void {
  void bentoChrome
    .postToDocument(documentId, message)
    .then((delivered) => {
      if (!delivered) forgetRelayDocument(documentId);
    })
    .catch((error: unknown) => {
      console.warn('[bento-shell] relay delivery failed:', error);
    });
}

function fanOutEvent(event: Event, audience: AudienceEvent['audience'] | 'all'): void {
  const effective =
    audience === 'all' && WORKSPACE_BOUND_EVENTS.has(event.type) ? 'regular' : audience;
  if (effective === 'all' && event.type === 'tools/booted') lastBooted = event;
  if (event.type === 'settings/snapshot' || event.type === 'settings/changed') {
    privateSettings.saved(event.settings);
  }
  // Global notices only: these three events are never addressed to one window.
  if (effective === 'all') settingsRelay.notice(event);
  if (effective === 'regular') {
    if (event.type === 'panels/sync') lastPanelsSyncByWorkspace.set(event.workspaceId, event);
    pruneRemovedWorkspaces(event);
  }
  if (effective === 'all' || effective === 'regular') {
    channel.postMessage({ kind: 'event', event });
  }
  if (effective === 'regular' || isWithheldFromPrivateDocuments(event)) return;
  for (const [documentId, document] of relayDocuments) {
    if (effective !== 'all' && document.windowId !== effective.privateWindowId) continue;
    postToRelayDocument(documentId, {
      kind: 'event',
      event: forWindow(event, document.windowId),
    });
  }
}

/** A settings event as a private window sees it: its own values over the saved ones. */
function forWindow(event: Event, windowId: number): Event {
  if (event.type !== 'settings/snapshot' && event.type !== 'settings/changed') return event;
  const settings = privateSettings.view(windowId, event.settings);
  return settings ? { ...event, settings } : event;
}

/** A private window changed its own sidebar or colour mode: only that window's
 * documents hear it (the sidebar and overlays, and its Settings document), and
 * nothing is saved. */
function applyWindowLocalSettings(windowId: number, local: Partial<WindowLocalSettings>): void {
  const settings = privateSettings.update(windowId, local);
  if (!settings) return;
  const message: BusDown = { kind: 'event', event: { type: 'settings/changed', settings } };
  for (const [documentId, document] of relayDocuments) {
    if (document.windowId === windowId) postToRelayDocument(documentId, message);
  }
  settingsRelay.postToWindow(windowId, message);
}

/** A private window's own settings update from its sidebar: the window-local keys stay
 * here. Whatever else the update carried goes on to tools as an ordinary settings update. */
function applyPrivateSettingsUpdate(windowId: number, action: object): void {
  const { changes } = action as { changes?: Parameters<typeof splitWindowLocalSettings>[0] };
  if (!changes || typeof changes !== 'object') return;
  const { local, rest } = splitWindowLocalSettings(changes);
  if (Object.keys(local).length > 0) applyWindowLocalSettings(windowId, local);
  if (Object.keys(rest).length > 0) {
    forwardActionToTools({ ...action, changes: rest, __windowId: windowId });
  }
}

function forwardActionToTools(action: object): void {
  const actionType = (action as { type?: string }).type;
  if (!toolsPort) {
    console.warn('[bento-shell] action dropped — tools port not connected:', actionType);
    return;
  }
  try {
    toolsPort.postMessage(action as Action);
  } catch (err) {
    console.warn('[bento-shell] forward to tools failed:', err);
  }
}

/** Tells tools a private window exists so it creates the window's Private
 * workspace. Sent once per tools port; the window id is the hub's. */
function sendPrivateWindowHello(windowId: number): void {
  if (!toolsPort || toolsHelloSent.has(windowId)) return;
  toolsHelloSent.add(windowId);
  forwardActionToTools({ type: 'shell/hello', windowId, __windowId: windowId });
}

function handleRelayHello(documentId: string, windowId: number, helloId: unknown): void {
  if (typeof helloId !== 'string') return;
  relayDocuments.set(documentId, { windowId });
  privateSettings.open(windowId);
  postToRelayDocument(documentId, { kind: 'ack', helloId });
  // Same bootstrap as the BroadcastChannel hello, minus what is bound to the
  // regular workspaces: the joiner asks tools for its own window's state when it
  // sees the replayed boot.
  if (lastBooted) {
    postToRelayDocument(documentId, {
      kind: 'event',
      event: lastBooted as Event,
      replayFor: helloId,
    });
  }
  sendPrivateWindowHello(windowId);
}

function handleBusMessage({
  documentId,
  windowId,
  isPrivate,
  sessionId,
  message,
}: BentoChromeBusMessage): void {
  if (!message || typeof message !== 'object') return;
  if (modeStateOwner.request({ documentId, windowId, isPrivate, sessionId, message })) return;
  const data = message as {
    kind?: unknown;
    helloId?: unknown;
    action?: unknown;
    request?: unknown;
  };
  // The Settings overlay uses the relay in every window; identity is the hub's.
  if (documentId && data.kind === 'settings-hello') {
    settingsRelay.hello(documentId, { windowId, isPrivate, sessionId }, data.helloId);
    return;
  }
  if (documentId && data.kind === 'settings-request') {
    settingsRelay.request(documentId, { windowId, isPrivate, sessionId }, data.request);
    return;
  }
  if (documentId && data.kind === 'document-closed') {
    settingsRelay.forget(documentId);
  }
  // Apart from the Settings overlay, only private windows use the relay for the bus;
  // regular windows keep the BroadcastChannel path.
  if (!isPrivate) return;
  if (data.kind === 'hello' && documentId) {
    handleRelayHello(documentId, windowId, data.helloId);
    return;
  }
  if (data.kind === 'document-closed' && documentId) {
    forgetRelayDocument(documentId);
    return;
  }
  if (data.kind === 'action' && data.action && typeof data.action === 'object') {
    const action = data.action as { type?: unknown };
    if (typeof action.type !== 'string' || isDocumentLocalAction(action)) return;
    if (action.type === 'settings/update') {
      applyPrivateSettingsUpdate(windowId, data.action);
      return;
    }
    // The window is whatever chrome says; a field the page set is overwritten.
    const stamped: Record<string, unknown> = { ...action, __windowId: windowId };
    if (action.type === 'shell/hello') stamped.windowId = windowId;
    forwardActionToTools(stamped);
  }
}

bentoChrome.onBusMessage.addListener(handleBusMessage);

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTools();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connectTools(): void {
  const port = browser.runtime.connect('bento-tools@bento.app', {
    name: SHELL_TOOLS_PORT,
  });
  toolsPort = port;
  firstMessageReceived = false;

  port.onMessage.addListener((message: object) => {
    if (toolsPort !== port) return;
    if (!firstMessageReceived) {
      firstMessageReceived = true;
      reconnectDelay = RECONNECT_BASE_MS; // reset backoff on healthy port
    }
    // A Settings answer belongs to the one document that asked, never to the fan-out.
    if (modeStateOwner.result(message) || settingsRelay.result(message)) return;
    if (isAudienceEvent(message)) fanOutEvent(message.event, message.audience);
    else fanOutEvent(message as Event, 'all');
  });

  // A tools restart forgot every private window's Private workspace; a live
  // tools/booted does not make the documents say hello again.
  toolsHelloSent.clear();
  for (const windowId of privateWindowIds()) sendPrivateWindowHello(windowId);

  port.onDisconnect.addListener(() => {
    if (toolsPort === port) toolsPort = null;
    modeStateOwner.dropPending();
    settingsRelay.dropPending();
    // Always retry. On fresh profiles tools may not be listening yet; on
    // long-running sessions it may have been reloaded via dev-reload.
    scheduleReconnect();
  });
}

connectTools();

// Dev reload: Alt+Shift+R rebuilds extension state from disk. Release builds
// define the flag as false so this handler is compiled out, and the installer
// drops the manifest command (scripts/dev-reload.mjs).
declare const __BENTO_DEV_RELOAD__: boolean;
if (__BENTO_DEV_RELOAD__) {
  browser.commands.onCommand.addListener((command) => {
    if (command === 'dev-reload') browser.runtime.reload();
  });
}

// Document → background → tools (Actions) and document hello-replay.
channel.addEventListener('message', (msg) => {
  const { data } = msg;
  if (!data || typeof data !== 'object') return;

  if (data.kind === 'action') {
    // Client-internal actions stay on the bus — they're consumed by
    // another shell document (the menu overlay iframe) and have no
    // tools-side handler, so forwarding them produces a benign but
    // noisy "unhandled action" warning in the tools console on every
    // kebab menu open. The Action protocol union doesn't include
    // these intentionally; treat anything matching the prefix as
    // bus-only.
    if (isDocumentLocalAction((data.action ?? {}) as { type?: unknown })) return;
    forwardActionToTools(data.action as Action);
    return;
  }

  if (data.kind === 'hello') {
    // New document came online — replay just enough state for it to
    // bootstrap. The cached tabs/workspaces/settings snapshots are
    // DELIBERATELY NOT broadcast: BroadcastChannel sends to every
    // listener (joiner AND existing docs), and the bg's cache for
    // those three lags behind live state — `tabs/changed` deltas
    // update each document's mirror store directly, but they DO NOT
    // update the cached snapshot. So a tab created via tab/openUrl
    // sits in every doc's store but is missing from the cache until
    // the next explicit tabs/requestSnapshot resolves. Replaying the
    // cache here would broadcast that stale value over the channel,
    // each existing doc would run applySnapshot (which REPLACES
    // byId, not merges), and the freshly-created tab would vanish
    // from the sidebar — re-appearing only when the joiner's own
    // requestSnapshot dispatch comes back. Symptom: opening a
    // settings/palette/confirm overlay wipes recently-created tabs
    // out of the sidebar for a few frames.
    //
    // The joiner re-fetches tabs/workspaces/settings via its own
    // useToolsPort handler on receipt of the replayed tools/booted (it
    // dispatches tabs/requestSnapshot etc.); tools answers with a fresh
    // snapshot that's broadcast to the whole channel, idempotent
    // for existing docs whose state already matches.
    //
    // panels/sync IS replayed because its cache stays in lock-step
    // with tools: every panel mutation triggers an emit, the bg
    // captures each emit per workspace, so the cached value reflects
    // current state. No staleness window.
    //
    // Replays are tagged `replayFor: helloId`. BroadcastChannel still
    // delivers them to every document, but each document drops replays
    // tagged for someone else, so a join costs the other N-1 documents
    // no store updates, snapshot requests, or BENTO_PANELS title writes.
    const replayFor = typeof data.helloId === 'string' ? data.helloId : undefined;
    if (lastBooted) channel.postMessage({ kind: 'event', event: lastBooted, replayFor });
    for (const event of lastPanelsSyncByWorkspace.values()) {
      channel.postMessage({ kind: 'event', event, replayFor });
    }
    return;
  }
});
