// Cross-process confirm bridge.
//
// The AlertDialog is the confirm layer of the chrome-mounted workspace layers
// document (workspace-layers.html), so the modal covers the whole browser
// window, not just the sidebar. Another document (the sidebar, the workspace
// palette) calls requestConfirm() to (a) broadcast the payload on a
// BroadcastChannel and (b) signal chrome (via a document.title sentinel) to
// show the layer. The layers document listens, renders the AlertDialog,
// dispatches the payload's action on accept, and signals chrome to hide on
// dismiss. The switcher layer, in that same document, opens the confirm layer
// directly (workspace-layers/layers.ts): this module's channel never delivers
// to itself.
//
// New BroadcastChannel name (separate from 'bento-shell-bus' which is the
// tools port) so the confirm payload doesn't collide with action/event
// traffic to bento-tools.
//
// The channel reaches the confirm document of every Bento window, so each
// payload names the window it is for and a receiver ignores other windows'.
// Without that, window B's request replaced the dialog window A was showing.

import type { Action } from '@shared/protocol';
import { sendChromeTitle } from './chromeTitle';
import { isForThisWindow, thisWindowId } from './windowId';

export const CONFIRM_BUS_NAME = 'bento-confirm-bus';
export const CONFIRM_OPEN_PREFIX = 'BENTO_OPEN_CONFIRM';
export const CONFIRM_CLOSE_PREFIX = 'BENTO_CLOSE_CONFIRM';

export interface ConfirmPayload {
  title: string;
  description: string;
  /** Label for the confirming button (e.g. "Delete workspace"). */
  confirmLabel: string;
  /** Mux Button variant for the confirm button — typically 'danger' for
   * destructive ops. The Cancel button is always 'neutral'. */
  variant: 'danger' | 'primary';
  /** Action dispatched to bento-tools when the user confirms. The confirm
   * content uses the existing useToolsPort `dispatch` so it routes through
   * the same shell→tools port the sidebar uses. */
  action: Action;
}

interface ShowMessage {
  kind: 'show';
  /** The chrome window the request is for (windowId.ts). */
  windowId: number | null;
  payload: ConfirmPayload;
}

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CONFIRM_BUS_NAME);
  return channel;
}

/** Open the confirm layer with the given payload. The layers document is
 * created at window startup, so it listens before a user action can call this. */
export function requestConfirm(payload: ConfirmPayload): void {
  const ch = bus();
  if (!ch) {
    console.warn('[bento-shell] requestConfirm: no BroadcastChannel — cannot open');
    return;
  }
  ch.postMessage({ kind: 'show', windowId: thisWindowId, payload } satisfies ShowMessage);
  // Timestamp suffix so successive opens always change the title string
  // (and therefore are picked up by the chrome script's title poll).
  sendChromeTitle(`${CONFIRM_OPEN_PREFIX}_${Date.now()}`);
}

/** Subscribe to confirm-show payloads. Called by the workspace layers
 * document; returns an unsubscribe. */
export function subscribeToConfirmRequests(handler: (payload: ConfirmPayload) => void): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as ShowMessage | undefined;
    if (data?.kind === 'show' && isForThisWindow(data.windowId)) handler(data.payload);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
