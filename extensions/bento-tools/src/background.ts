// Bento Tools — background entry point.
//
// M0 scope: log boot, accept connections from bento-shell, respond with a
// pong so the shell can verify the bus is alive. M1+ replaces the inline
// handler with the protocol-handler module.

import { handle } from './messaging/protocol-handler';
import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

console.log('[bento-tools] boot', new Date().toISOString());

browser.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== SHELL_TOOLS_PORT) {
    console.warn('[bento-tools] rejecting unknown port name:', port.name);
    return;
  }
  console.log('[bento-tools] shell connected:', port.sender?.id);

  const send = (event: Event) => port.postMessage(event);
  send({ type: 'tools/booted', version: '0.0.0' });

  port.onMessage.addListener((message: object) => {
    handle(message as Action, send);
  });
});
