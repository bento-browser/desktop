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

export const CONFIRM_BUS_NAME = 'bento-confirm-bus';
export const CONFIRM_OPEN_PREFIX = 'BENTO_OPEN_CONFIRM';
export const CONFIRM_CLOSE_PREFIX = 'BENTO_CLOSE_CONFIRM';

export interface ConfirmPayload {
  title: string;
  description: string;
  /** Label for the confirming button (e.g. "Delete workspace"). */
  confirmLabel: string;
  /** Tale UI Button variant for the confirm button — typically 'danger' for
   * destructive ops. The Cancel button is always 'neutral'. */
  variant: 'danger' | 'primary';
  /** Action dispatched to bento-tools when the user confirms. The confirm
   * content uses the existing useToolsPort `dispatch` so it routes through
   * the same shell→tools port the sidebar uses. */
  action: Action;
}

interface ShowMessage {
  kind: 'show';
  payload: ConfirmPayload;
}

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CONFIRM_BUS_NAME);
  return channel;
}

/** Open the chrome confirm overlay with the given payload. Safe to call
 * before the overlay's content has booted — the broadcast and the title
 * change race the chrome script's reveal, and the confirm content listens
 * for the payload as soon as its main.tsx runs. */
export function requestConfirm(payload: ConfirmPayload): void {
  const ch = bus();
  if (!ch) {
    console.warn('[bento-shell] requestConfirm: no BroadcastChannel — cannot open');
    return;
  }
  ch.postMessage({ kind: 'show', payload } satisfies ShowMessage);
  // Timestamp suffix so successive opens always change the title string
  // (and therefore are picked up by the chrome script's title poll).
  document.title = `${CONFIRM_OPEN_PREFIX}_${Date.now()}`;
}

/** Subscribe to confirm-show payloads. Called by the confirm content's
 * main.tsx; returns an unsubscribe. */
export function subscribeToConfirmRequests(handler: (payload: ConfirmPayload) => void): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as ShowMessage | undefined;
    if (data?.kind === 'show') handler(data.payload);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
