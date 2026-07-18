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
import type { ShellClientToTools } from '@shared/shell-client-protocol';
import { isTargetedShellEvent } from '@shared/shell-client-protocol';

const CHANNEL_NAME = 'bento-shell-bus';
const RECONNECT_BASE_MS = 200;
const RECONNECT_MAX_MS = 5000;

const channel = new BroadcastChannel(CHANNEL_NAME);

interface BentoChromeDocument {
  mountToken: string;
  clientInstanceId: string;
  role: 'primary' | 'auxiliary';
  windowId: number;
  isPrivate: boolean;
  registryRevision: number;
}

interface BentoChromeEvent<T> {
  addListener(listener: (value: T) => void): void;
}

interface BentoChromeAPI {
  bindBackground(details: { newBackgroundInstanceId: string }): Promise<{
    currentGeneration: number;
  }>;
  listDocuments(): Promise<BentoChromeDocument[]>;
  onDocumentMounted: BentoChromeEvent<BentoChromeDocument>;
  onDocumentChanged: BentoChromeEvent<BentoChromeDocument>;
  onDocumentRemoved: BentoChromeEvent<BentoChromeDocument>;
}

const bentoChrome = (browser as unknown as { bentoChrome: BentoChromeAPI }).bentoChrome;
const backgroundInstanceId = crypto.randomUUID();
const documentChannels = new Map<
  string,
  {
    channel: BroadcastChannel;
    record: BentoChromeDocument;
    heartbeat: ReturnType<typeof setInterval>;
  }
>();

function sendShellMessage(message: ShellClientToTools): void {
  if (!toolsPort) return;
  try {
    toolsPort.postMessage(message);
  } catch (error) {
    console.warn('[bento-shell] shell-client message failed:', error);
  }
}

function registerDocumentWithTools(record: BentoChromeDocument): void {
  sendShellMessage({
    type: 'shell-client/register',
    shellBackgroundInstanceId: backgroundInstanceId,
    clientInstanceId: record.clientInstanceId,
    mountToken: record.mountToken,
    role: record.role,
    windowId: record.windowId,
    audience: record.isPrivate ? 'private' : 'regular',
    registryRevision: record.registryRevision,
  });
  sendShellMessage({
    type: 'shell-client/ready',
    shellBackgroundInstanceId: backgroundInstanceId,
    clientInstanceId: record.clientInstanceId,
    windowId: record.windowId,
    registryRevision: record.registryRevision,
  });
}

function attachDocument(record: BentoChromeDocument): void {
  if (!record.mountToken || !record.clientInstanceId) return;
  const existing = documentChannels.get(record.mountToken);
  if (existing) {
    existing.record = record;
    registerDocumentWithTools(record);
    return;
  }
  const documentChannel = new BroadcastChannel(`bento-shell-doc:${record.mountToken}`);
  documentChannel.addEventListener('message', (message) => {
    const data = message.data as
      | {
          type?: string;
          backendInstanceId?: string;
          publicationId?: string;
          graphRevision?: number;
          registryRevision?: number;
        }
      | undefined;
    if (data?.type !== 'document/graph-applied') return;
    if (
      typeof data.backendInstanceId !== 'string' ||
      typeof data.publicationId !== 'string' ||
      typeof data.graphRevision !== 'number'
    ) {
      return;
    }
    void bentoChrome.listDocuments().then((documents) => {
      const current = documents.find(
        (document) => document.clientInstanceId === record.clientInstanceId,
      ) as
        | (BentoChromeDocument & {
            lastAppliedTuple?: {
              backendInstanceId?: string;
              publicationId?: string;
              graphRevision?: number;
            } | null;
          })
        | undefined;
      const tuple = current?.lastAppliedTuple;
      if (
        !current ||
        !tuple ||
        tuple.backendInstanceId !== data.backendInstanceId ||
        tuple.publicationId !== data.publicationId ||
        tuple.graphRevision !== data.graphRevision
      ) {
        return;
      }
      sendShellMessage({
        type: 'shell-client/action',
        clientInstanceId: current.clientInstanceId,
        windowId: current.windowId,
        action: 'graph/applied',
        backendInstanceId: data.backendInstanceId!,
        publicationId: data.publicationId!,
        graphRevision: data.graphRevision!,
        registryRevision: current.registryRevision,
      });
    });
  });
  const heartbeat = setInterval(() => {
    sendShellMessage({
      type: 'shell-client/heartbeat',
      shellBackgroundInstanceId: backgroundInstanceId,
      clientInstanceId: record.clientInstanceId,
      windowId: record.windowId,
      registryRevision: record.registryRevision,
    });
  }, 1000);
  documentChannels.set(record.mountToken, { channel: documentChannel, record, heartbeat });
  registerDocumentWithTools(record);
}

function detachDocument(record: BentoChromeDocument): void {
  const binding = documentChannels.get(record.mountToken);
  if (!binding) return;
  sendShellMessage({
    type: 'shell-client/hidden',
    shellBackgroundInstanceId: backgroundInstanceId,
    clientInstanceId: binding.record.clientInstanceId,
    windowId: binding.record.windowId,
    registryRevision: binding.record.registryRevision,
  });
  clearInterval(binding.heartbeat);
  binding.channel.close();
  documentChannels.delete(record.mountToken);
}

async function bindParentRegistry(): Promise<void> {
  await bentoChrome.bindBackground({
    newBackgroundInstanceId: backgroundInstanceId,
  });
  for (const record of await bentoChrome.listDocuments()) attachDocument(record);
  bentoChrome.onDocumentMounted.addListener(attachDocument);
  bentoChrome.onDocumentChanged.addListener(attachDocument);
  bentoChrome.onDocumentRemoved.addListener(detachDocument);
}

void bindParentRegistry().catch((error: unknown) => {
  console.error('[bento-shell] parent document registry unavailable:', error);
});

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
    if (isTargetedShellEvent(message)) {
      const binding = Array.from(documentChannels.values()).find(
        (candidate) => candidate.record.clientInstanceId === message.targetClientInstanceId,
      );
      const matches =
        binding &&
        message.shellBackgroundInstanceId === backgroundInstanceId &&
        binding.record.role === message.expectedRole &&
        binding.record.windowId === message.expectedWindowId &&
        (binding.record.isPrivate ? 'private' : 'regular') === message.expectedAudience;
      if (matches && binding) {
        binding.channel.postMessage({ type: 'document/targeted', envelope: message });
      }
      sendShellMessage({
        type: 'shell-client/delivery',
        deliveryId: message.deliveryId,
        targetClientInstanceId: message.targetClientInstanceId,
        disposition: matches ? 'routed' : binding ? 'binding-mismatch' : 'target-missing',
      });
      return;
    }
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

  for (const binding of documentChannels.values()) {
    registerDocumentWithTools(binding.record);
  }

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
    if (actionType === 'menu/open' || actionType?.startsWith('ui/')) return;
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
