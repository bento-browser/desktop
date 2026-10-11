// Chrome to menu-overlay open messages.
//
// Chrome's showChromeMenu sends `menu/open` as a shell action: the
// BentoShellAction frame script posts it on 'bento-shell-bus', which every
// document of the extension origin hears, in every Bento window. Chrome stamps
// each action with its window id (`__windowId`, the same envelope bento-tools
// routes by) and the menu document ignores another window's, so one window's
// menu cannot replace the payload of the menu another window has open.

import type { ChromeMenuOpenPayload } from '../menu/ChromeMenu';
import { isForThisWindow } from './windowId';

const SHELL_BUS_NAME = 'bento-shell-bus';

export function subscribeToMenuOpen(handler: (payload: ChromeMenuOpenPayload) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(SHELL_BUS_NAME);
  channel.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object' || data.kind !== 'action') return;
    const action = data.action;
    if (!action || action.type !== 'menu/open') return;
    if (!isForThisWindow(action.__windowId)) return;
    // Validate enough of the payload to render. Bad payloads silently
    // drop: rendering nothing beats crashing the overlay frame.
    if (!action.contextId || !action.anchor || !Array.isArray(action.items)) return;
    handler({
      contextId: action.contextId,
      anchor: action.anchor,
      items: action.items,
      placement: action.placement === 'bottom start' ? 'bottom-start' : 'bottom-end',
    });
  });
  return () => channel.close();
}
