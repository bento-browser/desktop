// Cross-process bridge for the workspace-switcher menu overlay.
//
// The menu is hosted in its own chrome-mounted <browser>
// (workspace-switcher.html) so it can render outside the sidebar — critical
// when the rail is collapsed. Without this overlay the Mux Menu's
// popover renders inside the bento-shell-frame iframe
// and gets clipped at the iframe boundary. iframes can't paint outside
// their own bounds.
//
// Same shape as useConfirm / useEditWorkspace: BroadcastChannel for the
// payload, document.title sentinel for the show/hide signal that chrome
// reacts to.

import { sendChromeTitle } from './chromeTitle';
import { createShowBus, type OverlayRequest } from './overlayRequest';
import { readWindowIdFromHash } from './windowId';

export const WORKSPACE_SWITCHER_BUS_NAME = 'bento-workspace-switcher-bus';
export const WORKSPACE_SWITCHER_OPEN_PREFIX = 'BENTO_OPEN_WORKSPACE_SWITCHER';
export const WORKSPACE_SWITCHER_CLOSE_PREFIX = 'BENTO_CLOSE_WORKSPACE_SWITCHER';

export interface WorkspaceSwitcherOpenPayload {
  /** Trigger element's bounding rect in the SIDEBAR FRAME's coordinate
   * system (i.e. trigger.getBoundingClientRect() inside the sidebar
   * extension's window). The overlay translates these to chrome-window
   * coords by reading its own and the sidebar's screen positions —
   * see sidebarScreenX/Y below. */
  triggerRect: { x: number; y: number; width: number; height: number };
  /** Sidebar frame's screen position (window.screenLeft / screenTop).
   * Combined with the overlay's own screen position, lets the overlay
   * compute the trigger's position in chrome-window coords without
   * needing chrome-script involvement: chromeX = triggerRect.x +
   * (sidebarScreenX - overlayScreenX). */
  sidebarScreenX: number;
  sidebarScreenY: number;
}

interface ClosedMessage {
  kind: 'closed';
  windowId: number | null;
}

const switcherBus = createShowBus<WorkspaceSwitcherOpenPayload>(
  WORKSPACE_SWITCHER_BUS_NAME,
  'workspace-switcher',
);
// Fixed for the document's life: the hash chrome stamps on the frame URL.
const windowId = readWindowIdFromHash();

/** Open the workspace-switcher menu overlay anchored to a trigger element.
 * Caller passes the trigger's bounding rect in its own window's coords +
 * the sidebar's screen position so the overlay can position the menu
 * exactly next to the trigger as it appears on screen. The request is for this
 * document's window only; it is posted again if the overlay's document was not
 * ready yet (overlayRequest.ts). */
export function requestWorkspaceSwitcher(payload: WorkspaceSwitcherOpenPayload): void {
  if (!switcherBus.request(payload)) {
    console.warn('[bento-shell] requestWorkspaceSwitcher: no BroadcastChannel');
    return;
  }
  sendChromeTitle(`${WORKSPACE_SWITCHER_OPEN_PREFIX}_${Date.now()}`);
}

/** Subscribe to workspace-switcher open requests for this window. Called by the
 * overlay's main.tsx; returns an unsubscribe. */
export function subscribeToWorkspaceSwitcherRequests(
  handler: (payload: WorkspaceSwitcherOpenPayload, request: OverlayRequest) => void,
): () => void {
  return switcherBus.subscribe(handler);
}

/** Overlay → sidebar: announce that the menu has closed (Esc, click-
 * outside, item action). Lets the sidebar trigger drop its "open" visual
 * state. The corresponding chrome hide is signalled via title-IPC by
 * the overlay too — this bus message is only for the sidebar's UI
 * mirror. */
export function notifyWorkspaceSwitcherClosed(): void {
  switcherBus.channel()?.postMessage({ kind: 'closed', windowId } satisfies ClosedMessage);
}

/** Sidebar subscription for overlay close notifications of its own window. */
export function subscribeToWorkspaceSwitcherClose(handler: () => void): () => void {
  const ch = switcherBus.channel();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as Partial<ClosedMessage> | undefined;
    if (data?.kind === 'closed' && data.windowId === windowId) handler();
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
