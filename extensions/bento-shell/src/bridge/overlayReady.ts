// Readiness handshake for lazily created overlay documents.
//
// Chrome creates most overlay documents on demand or at idle, not at window
// startup (docs/core-functionality-technical.md, "Overlay documents"). A message
// sent to an overlay whose React tree has not subscribed yet is lost:
// BroadcastChannel and the frame-script relays chrome uses do not queue. Each
// overlay therefore announces that its subscriptions exist, once, in two ways:
//
// - A BENTO_OVERLAY_READY title. Chrome holds an open (and any payload chrome
//   itself sends to the overlay) until it arrives.
// - A message on 'bento-overlay-ready', for the documents that send a payload to
//   the overlay (sidebar, workspace switcher, workspace palette). They keep the
//   latest payload and send it again on that message, which covers a payload
//   posted before the overlay existed.
//
// Both carry the chrome window's id where it matters: one extension origin
// serves every window, so another window's overlay becoming ready must not
// release this window's payload.

import { useEffect } from 'react';
import { sendChromeTitle } from './chromeTitle';
import { readWindowIdFromHash } from './windowId';

export const OVERLAY_READY_PREFIX = 'BENTO_OVERLAY_READY';
export const OVERLAY_READY_BUS_NAME = 'bento-overlay-ready';
/** A payload older than this is not sent again: its open was long since abandoned. */
export const OVERLAY_RESEND_WINDOW_MS = 10_000;

/** Names match the chrome frame ids: `bento-<name>-frame`. */
export type OverlayName =
  | 'palette'
  | 'workspace-palette'
  | 'merge-palette'
  | 'addrbar'
  | 'confirm'
  | 'edit-workspace'
  | 'welcome'
  | 'workspace-switcher'
  | 'menu'
  | 'panel-navigator-tooltip';

interface ReadyMessage {
  kind: 'ready';
  overlay: OverlayName;
  windowId: number | null;
}

function isReadyMessage(data: unknown): data is ReadyMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Partial<ReadyMessage>;
  return message.kind === 'ready' && typeof message.overlay === 'string';
}

/** Announces that this overlay document is subscribed and can receive an open. */
export function signalOverlayReady(overlay: OverlayName): void {
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(OVERLAY_READY_BUS_NAME);
    channel.postMessage({
      kind: 'ready',
      overlay,
      windowId: readWindowIdFromHash(),
    } satisfies ReadyMessage);
    channel.close();
  }
  sendChromeTitle(`${OVERLAY_READY_PREFIX}_${Date.now()}`);
}

/** Call from the overlay's top-level component, after the effects that subscribe. */
export function useOverlayReadySignal(overlay: OverlayName): void {
  useEffect(() => {
    signalOverlayReady(overlay);
  }, [overlay]);
}

interface PendingSend {
  send: () => void;
  expiresAt: number;
}

const pending = new Map<OverlayName, PendingSend>();
let readyChannel: BroadcastChannel | null = null;

function onReadyMessage(event: MessageEvent): void {
  const data: unknown = event.data;
  if (!isReadyMessage(data) || data.windowId !== readWindowIdFromHash()) return;
  const entry = pending.get(data.overlay);
  if (!entry) return;
  pending.delete(data.overlay);
  if (Date.now() <= entry.expiresAt) entry.send();
}

/** Sends a payload again when `overlay` in this window announces it is ready.
 * Call right after the first post. Only the latest payload per overlay is kept;
 * an overlay that was already mounted never announces again, so the payload is
 * not sent twice in the normal case. */
export function resendWhenOverlayReady(overlay: OverlayName, send: () => void): void {
  if (typeof BroadcastChannel === 'undefined') return;
  if (!readyChannel) {
    readyChannel = new BroadcastChannel(OVERLAY_READY_BUS_NAME);
    readyChannel.addEventListener('message', onReadyMessage);
  }
  pending.set(overlay, { send, expiresAt: Date.now() + OVERLAY_RESEND_WINDOW_MS });
}
