// Bento Shell — background entry point.
//
// Two responsibilities:
// 1. Maintain the long-lived port to bento-tools (cross-extension). This
//    works reliably from a background context.
// 2. Accept intra-extension connections from the chrome-mounted shell
//    document (which can't do cross-extension runtime.connect because
//    of process restrictions on chrome-embedded extension pages) and
//    relay events both ways.

import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

const DOCUMENT_PORT_NAME = 'shell-document';

console.log('[bento-shell] boot (background)', new Date().toISOString());

// ─── tools side ──────────────────────────────────────────────────────────────

const toolsPort = browser.runtime.connect('bento-tools@bento.app', {
  name: SHELL_TOOLS_PORT,
});

let lastBooted: Event | null = null;
let lastSnapshot: Event | null = null;
const documentPorts = new Set<browser.runtime.Port>();

function broadcastToDocs(event: Event) {
  for (const port of documentPorts) {
    try {
      port.postMessage(event);
    } catch (err) {
      console.warn('[bento-shell] broadcast failed (port closed):', err);
      documentPorts.delete(port);
    }
  }
}

toolsPort.onMessage.addListener((message: object) => {
  const event = message as Event;
  console.log('[bento-shell] tools said:', event.type);
  if (event.type === 'tools/booted') lastBooted = event;
  if (event.type === 'tabs/snapshot') lastSnapshot = event;
  broadcastToDocs(event);
});

toolsPort.onDisconnect.addListener(() => {
  console.log('[bento-shell] tools port disconnected');
});

// ─── document side ───────────────────────────────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== DOCUMENT_PORT_NAME) return;
  console.log('[bento-shell] document connected');
  documentPorts.add(port);

  // Replay last booted + snapshot so a freshly-loaded document gets the
  // current world state without having to wait for the next delta.
  if (lastBooted) port.postMessage(lastBooted);
  if (lastSnapshot) port.postMessage(lastSnapshot);

  port.onMessage.addListener((message: object) => {
    // Forward Actions from document to tools.
    try {
      toolsPort.postMessage(message as Action);
    } catch (err) {
      console.warn('[bento-shell] forward to tools failed:', err);
    }
  });

  port.onDisconnect.addListener(() => {
    documentPorts.delete(port);
    console.log('[bento-shell] document disconnected');
  });
});
