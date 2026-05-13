// Cross-process bridge for the workspace-switcher menu overlay.
//
// The menu is hosted in its own chrome-mounted <browser>
// (workspace-switcher.html) so it can render outside the sidebar — critical
// when the rail is collapsed to a 4rem-wide strip. Without this overlay
// the Tale UI Menu's popover renders inside the bento-shell-frame iframe
// and gets clipped at the iframe boundary. iframes can't paint outside
// their own bounds.
//
// Same shape as useConfirm / useEditWorkspace: BroadcastChannel for the
// payload, document.title sentinel for the show/hide signal that chrome
// reacts to.

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

interface ShowMessage {
  kind: 'show';
  payload: WorkspaceSwitcherOpenPayload;
}

interface ClosedMessage {
  kind: 'closed';
}

type BusMessage = ShowMessage | ClosedMessage;

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(WORKSPACE_SWITCHER_BUS_NAME);
  return channel;
}

/** Open the workspace-switcher menu overlay anchored to a trigger element.
 * Caller passes the trigger's bounding rect in its own window's coords +
 * the sidebar's screen position so the overlay can position the menu
 * exactly next to the trigger as it appears on screen. */
export function requestWorkspaceSwitcher(payload: WorkspaceSwitcherOpenPayload): void {
  const ch = bus();
  if (!ch) {
    console.warn('[bento-shell] requestWorkspaceSwitcher: no BroadcastChannel');
    return;
  }
  ch.postMessage({ kind: 'show', payload } satisfies ShowMessage);
  document.title = `${WORKSPACE_SWITCHER_OPEN_PREFIX}_${Date.now()}`;
}

/** Subscribe to workspace-switcher open requests. Called by the overlay's
 * main.tsx; returns an unsubscribe. */
export function subscribeToWorkspaceSwitcherRequests(
  handler: (payload: WorkspaceSwitcherOpenPayload) => void,
): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as BusMessage | undefined;
    if (data?.kind === 'show') handler(data.payload);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}

/** Overlay → sidebar: announce that the menu has closed (Esc, click-
 * outside, item action). Lets the sidebar trigger drop its "open" visual
 * state. The corresponding chrome hide is signalled via title-IPC by
 * the overlay too — this bus message is only for the sidebar's UI
 * mirror. */
export function notifyWorkspaceSwitcherClosed(): void {
  const ch = bus();
  if (!ch) return;
  ch.postMessage({ kind: 'closed' } satisfies ClosedMessage);
}

/** Sidebar subscription for overlay close notifications. */
export function subscribeToWorkspaceSwitcherClose(handler: () => void): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as BusMessage | undefined;
    if (data?.kind === 'closed') handler();
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
