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

const CHANNEL_NAME = 'bento-shell-bus';
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;

const channel = new BroadcastChannel(CHANNEL_NAME);

let toolsPort: browser.runtime.Port | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let firstMessageReceived = false;

let lastBooted: Event | null = null;
// Per-workspace — panels are workspace-scoped, so a single "latest" cache
// would lose workspaces beyond whichever fired most recently. Hello-replay
// walks every entry so a freshly-mounted document gets the full picture.
const lastPanelsSyncByWorkspace = new Map<string, Event>();

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
    const event = message as Event;
    if (!firstMessageReceived) {
      firstMessageReceived = true;
      reconnectDelay = RECONNECT_BASE_MS; // reset backoff on healthy port
    }
    if (event.type === 'tools/booted') lastBooted = event;
    if (event.type === 'panels/sync') {
      lastPanelsSyncByWorkspace.set(event.workspaceId, event);
    }
    channel.postMessage({ kind: 'event', event });
  });

  port.onDisconnect.addListener(() => {
    if (toolsPort === port) toolsPort = null;
    // Always retry. On fresh profiles tools may not be listening yet; on
    // long-running sessions it may have been reloaded via dev-reload.
    scheduleReconnect();
  });
}

connectTools();

// Dev reload: Alt+Shift+R rebuilds extension state from disk.
browser.commands.onCommand.addListener((command) => {
  if (command === 'dev-reload') browser.runtime.reload();
});

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
    const actionType = (data.action as { type?: string } | undefined)?.type;
    if (actionType === 'menu/open') return;
    if (!toolsPort) {
      console.warn('[bento-shell] action dropped — tools port not connected:', actionType);
      return;
    }
    try {
      toolsPort.postMessage(data.action as Action);
    } catch (err) {
      console.warn('[bento-shell] forward to tools failed:', err);
    }
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
    // useToolsPort handler on receipt of tools/booted (it dispatches
    // tabs/requestSnapshot etc.); tools answers with a fresh
    // snapshot that's broadcast to the whole channel, idempotent
    // for existing docs whose state already matches.
    //
    // panels/sync IS replayed because its cache stays in lock-step
    // with tools: every panel mutation triggers an emit, the bg
    // captures each emit per workspace, so the cached value reflects
    // current state. No staleness window.
    if (lastBooted) channel.postMessage({ kind: 'event', event: lastBooted });
    for (const event of lastPanelsSyncByWorkspace.values()) {
      channel.postMessage({ kind: 'event', event });
    }
    return;
  }
});
