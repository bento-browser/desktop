// Bento Tools — background entry point.
//
// Owns the persistent state: tab registry, future workspace store, future
// keyboard registry. Accepts long-lived ports from bento-shell, sends an
// initial snapshot + tools/booted Event, then streams batched deltas.

import { handle } from './messaging/protocol-handler';
import { TabRegistry } from './tabs/TabRegistry';
import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

console.log('[bento-tools] boot', new Date().toISOString());

const tabs = new TabRegistry();
tabs.init().catch((err) => console.error('[bento-tools] TabRegistry init failed:', err));

browser.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== SHELL_TOOLS_PORT) {
    console.warn('[bento-tools] rejecting unknown port name:', port.name);
    return;
  }
  console.log('[bento-tools] shell connected:', port.sender?.id);

  const send = (event: Event) => {
    try {
      port.postMessage(event);
    } catch (err) {
      console.warn('[bento-tools] postMessage failed (port may be disconnected):', err);
    }
  };

  send({ type: 'tools/booted', version: '0.0.0' });
  send({ type: 'tabs/snapshot', tabs: tabs.snapshot() });

  const unsubscribe = tabs.onDeltas((deltas) => {
    send({ type: 'tabs/changed', deltas });
  });

  port.onMessage.addListener((message: object) => {
    handle(message as Action, { tabs, send });
  });

  port.onDisconnect.addListener(() => {
    unsubscribe();
  });
});
