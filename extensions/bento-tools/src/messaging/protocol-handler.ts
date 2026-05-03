// Routes incoming Action messages from bento-shell to the appropriate
// tools-side handler. M0 stub: only handles ping. M1+ adds tab/workspace/
// panel actions per §4.2 of the plan.

import type { Action, Event } from '@shared/protocol';

export function handle(action: Action, send: (event: Event) => void): void {
  switch (action.type) {
    case 'ping':
      send({ type: 'pong', ts: Date.now() });
      return;
    case 'tabs/requestSnapshot':
      // M1: send a tabs/snapshot. Stub for now so shell knows we received it.
      console.log('[bento-tools] tabs/requestSnapshot received (stub)');
      return;
    default: {
      const _exhaustive: never = action;
      console.warn('[bento-tools] unhandled action:', _exhaustive);
    }
  }
}
