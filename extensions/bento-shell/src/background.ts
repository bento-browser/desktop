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

console.log('[bento-shell] boot (background)', new Date().toISOString());

const channel = new BroadcastChannel(CHANNEL_NAME);

let toolsPort: browser.runtime.Port | null = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let firstMessageReceived = false;

let lastBooted: Event | null = null;
let lastTabsSnapshot: Event | null = null;
let lastWorkspacesSnapshot: Event | null = null;
let lastSettingsSnapshot: Event | null = null;
// Per-workspace — panels are workspace-scoped, so a single "latest" cache
// would lose workspaces beyond whichever fired most recently. Hello-replay
// walks every entry so a freshly-mounted document gets the full picture.
const lastPanelsSyncByWorkspace = new Map<string, Event>();

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  console.log('[bento-shell] reconnecting to tools in', reconnectDelay, 'ms');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTools();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function connectTools(): void {
  console.log('[bento-shell] connecting to bento-tools…');
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
    console.log('[bento-shell] tools said:', event.type);
    if (event.type === 'tools/booted') lastBooted = event;
    if (event.type === 'tabs/snapshot') lastTabsSnapshot = event;
    if (event.type === 'workspaces/snapshot') lastWorkspacesSnapshot = event;
    if (event.type === 'settings/snapshot') lastSettingsSnapshot = event;
    if (event.type === 'panels/sync') {
      lastPanelsSyncByWorkspace.set(event.workspaceId, event);
    }
    channel.postMessage({ kind: 'event', event });
  });

  port.onDisconnect.addListener(() => {
    console.log(
      '[bento-shell] tools port disconnected (firstMessageReceived=',
      firstMessageReceived,
      ')',
    );
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
    if (!toolsPort) {
      console.warn('[bento-shell] action dropped — tools port not connected:', data.action?.type);
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
    // New document came online — replay the cached state so it doesn't
    // have to wait for the next delta from tools.
    console.log(
      '[bento-shell] document hello — replaying state (panels for',
      lastPanelsSyncByWorkspace.size,
      'workspaces)',
    );
    if (lastBooted) channel.postMessage({ kind: 'event', event: lastBooted });
    if (lastTabsSnapshot) channel.postMessage({ kind: 'event', event: lastTabsSnapshot });
    if (lastWorkspacesSnapshot)
      channel.postMessage({ kind: 'event', event: lastWorkspacesSnapshot });
    if (lastSettingsSnapshot) channel.postMessage({ kind: 'event', event: lastSettingsSnapshot });
    for (const event of lastPanelsSyncByWorkspace.values()) {
      channel.postMessage({ kind: 'event', event });
    }
    return;
  }
});
