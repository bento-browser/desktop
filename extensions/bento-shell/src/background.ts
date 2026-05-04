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

import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

const CHANNEL_NAME = 'bento-shell-bus';

console.log('[bento-shell] boot (background)', new Date().toISOString());

const toolsPort = browser.runtime.connect('bento-tools@bento.app', {
  name: SHELL_TOOLS_PORT,
});

const channel = new BroadcastChannel(CHANNEL_NAME);

let lastBooted: Event | null = null;
let lastSnapshot: Event | null = null;

toolsPort.onMessage.addListener((message: object) => {
  const event = message as Event;
  console.log('[bento-shell] tools said:', event.type);
  if (event.type === 'tools/booted') lastBooted = event;
  if (event.type === 'tabs/snapshot') lastSnapshot = event;
  // Broadcast to all document contexts at moz-extension://<uuid>/.
  channel.postMessage({ kind: 'event', event });
});

toolsPort.onDisconnect.addListener(() => {
  console.log('[bento-shell] tools port disconnected');
});

// Document → background → tools (Actions) and document hello-replay.
channel.addEventListener('message', (msg) => {
  const { data } = msg;
  if (!data || typeof data !== 'object') return;

  if (data.kind === 'action') {
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
    console.log('[bento-shell] document hello — replaying state');
    if (lastBooted) channel.postMessage({ kind: 'event', event: lastBooted });
    if (lastSnapshot) channel.postMessage({ kind: 'event', event: lastSnapshot });
    return;
  }
});
