// Bento Shell — background entry point.
//
// M0 scope: connect to bento-tools, log boot + the tools/booted event.
// M1+ moves connection responsibility into the React shell's
// useToolsPort hook (the chrome <browser> mount loads main.tsx which
// owns the port). Until then this background script exists so the
// shell→tools handshake is verifiable in M0 without the shell DOM.

import type { Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

console.log('[bento-shell] boot (background)', new Date().toISOString());

const port = browser.runtime.connect('bento-tools@bento.app', {
  name: SHELL_TOOLS_PORT,
});

port.onMessage.addListener((message: object) => {
  const event = message as Event;
  console.log('[bento-shell] tools said:', event);
});

port.onDisconnect.addListener(() => {
  console.log('[bento-shell] tools port disconnected');
});
