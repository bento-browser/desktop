// Cross-process confirm-overlay bridge.
//
// Pattern mirrors the command palette: the AlertDialog is hosted in its own
// chrome-mounted <browser> (confirm.html) so the modal covers the whole
// browser window — not just the sidebar. Sidebar code calls requestConfirm()
// to (a) broadcast the payload to the confirm content via BroadcastChannel
// and (b) signal chrome (via document.title sentinel) to reveal the overlay
// frame. The confirm content listens, renders the AlertDialog, dispatches
// the confirm payload's action on accept, and signals chrome to hide on
// dismiss.
//
// New BroadcastChannel name (separate from 'bento-shell-bus' which is the
// tools port) so the confirm payload doesn't collide with action/event
// traffic to bento-tools.

import type { Action } from '@shared/protocol';
import { sendChromeTitle } from './chromeTitle';
import { createShowBus, type OverlayRequest } from './overlayRequest';

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

const confirmBus = createShowBus<ConfirmPayload>(CONFIRM_BUS_NAME, 'confirm');

/** Open the chrome confirm overlay with the given payload. Safe to call
 * before the overlay's document exists: chrome creates it on the first open,
 * and the request is posted again when the document announces it is ready
 * (overlayRequest.ts). The request is for this document's window only, and a
 * newer request for the same window replaces it. */
export function requestConfirm(payload: ConfirmPayload): void {
  if (!confirmBus.request(payload)) {
    console.warn('[bento-shell] requestConfirm: no BroadcastChannel — cannot open');
    return;
  }
  // Timestamp suffix so successive opens always change the title string
  // (and therefore are picked up by the chrome script's title poll).
  sendChromeTitle(`${CONFIRM_OPEN_PREFIX}_${Date.now()}`);
}

/** Subscribe to confirm requests for this window. Called by the confirm
 * content's main.tsx; returns an unsubscribe. The handler sees each request
 * once and never an older one, so the payload the dialog shows, and the action
 * its button dispatches, always belong to the newest request. */
export function subscribeToConfirmRequests(
  handler: (payload: ConfirmPayload, request: OverlayRequest) => void,
): () => void {
  return confirmBus.subscribe(handler);
}
