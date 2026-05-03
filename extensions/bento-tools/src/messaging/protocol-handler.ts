// Routes incoming Action messages from bento-shell to the appropriate
// tools-side handler. Each Action either fires a side effect (close tab,
// switch tab) or asks tools to broadcast state (snapshot).

import type { Action, Event } from '@shared/protocol';
import type { TabRegistry } from '../tabs/TabRegistry';

export interface HandlerContext {
  tabs: TabRegistry;
  send: (event: Event) => void;
}

export function handle(action: Action, ctx: HandlerContext): void {
  switch (action.type) {
    case 'ping':
      ctx.send({ type: 'pong', ts: Date.now() });
      return;
    case 'tabs/requestSnapshot':
      ctx.send({ type: 'tabs/snapshot', tabs: ctx.tabs.snapshot() });
      return;
    case 'tab/activate':
      browser.tabs.update(action.id, { active: true }).catch((err) => {
        console.warn('[bento-tools] tab/activate failed:', action.id, err);
      });
      return;
    case 'tab/close':
      browser.tabs.remove(action.id).catch((err) => {
        console.warn('[bento-tools] tab/close failed:', action.id, err);
      });
      return;
    default: {
      const _exhaustive: never = action;
      console.warn('[bento-tools] unhandled action:', _exhaustive);
    }
  }
}
