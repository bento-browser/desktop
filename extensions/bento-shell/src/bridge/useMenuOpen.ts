// Chrome to menu-overlay open messages.
//
// Chrome's showChromeMenu sends `menu/open` as a shell action: the
// BentoShellAction frame script posts it on 'bento-shell-bus', which every
// document of the extension origin hears, in every Bento window. Chrome stamps
// each action with its window id (`__windowId`, the same envelope bento-tools
// routes by) and the menu document ignores another window's, so one window's
// menu cannot replace the payload of the menu another window has open.
//
// The way back is a close notice on its own bus (same shape as the workspace
// switcher's): the menu document announces that the menu it showed is gone, so
// the sidebar can drop the open state of the button that opened it. Chrome gets
// the same fact through the BENTO_MENU_SELECT / BENTO_MENU_CLOSE titles.

import type { ChromeMenuOpenPayload } from '../menu/ChromeMenu';
import { isForThisWindow, thisWindowId } from './windowId';

const SHELL_BUS_NAME = 'bento-shell-bus';
export const MENU_BUS_NAME = 'bento-menu-bus';

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

interface ClosedMessage {
  kind: 'closed';
  windowId: number | null;
  contextId: string;
}

let closedChannel: BroadcastChannel | null = null;
function closedBus(): BroadcastChannel | null {
  if (closedChannel) return closedChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  closedChannel = new BroadcastChannel(MENU_BUS_NAME);
  return closedChannel;
}

/** Menu overlay to sidebar: the menu opened as `contextId` is gone (item chosen,
 * Esc, or a click outside). A menu replaced by a newer open sends no notice;
 * the newer `menu/open` tells the sidebar. */
export function notifyMenuClosed(contextId: string): void {
  closedBus()?.postMessage({
    kind: 'closed',
    windowId: thisWindowId,
    contextId,
  } satisfies ClosedMessage);
}

/** Sidebar subscription for the overlay's close notices; returns an unsubscribe. */
export function subscribeToMenuClosed(handler: (contextId: string) => void): () => void {
  const channel = closedBus();
  if (!channel) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as ClosedMessage | undefined;
    if (data?.kind === 'closed' && isForThisWindow(data.windowId)) handler(data.contextId);
  };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}
