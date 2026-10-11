// Lifecycle channel between overlay documents, the documents that send them a
// payload, and chrome.
//
// Chrome creates most overlay documents on demand or at idle, not at window
// startup (docs/core-functionality-technical.md, "Overlay documents"). A message
// sent to an overlay whose React tree has not subscribed yet is lost:
// BroadcastChannel and the frame-script relays chrome uses do not queue. So:
//
// - An overlay announces once that its subscriptions exist (signalOverlayReady).
//   That is a BENTO_OVERLAY_READY title for chrome, which holds an open and any
//   payload it sends itself until then, and a 'ready' message here for senders.
// - A document that sends a payload (overlayRequest.ts) keeps it and posts it
//   again on 'ready', until the overlay acknowledges it ('ack'), a newer request
//   replaces it, or chrome cancels the open ('cancel', sent when a hide or Esc
//   arrives while the open still waits for the document).
//
// One extension origin serves every window, so each message names the chrome
// window it belongs to and receivers ignore other windows'.

import { useEffect } from 'react';
import { sendChromeTitle } from './chromeTitle';
import { readWindowIdFromHash } from './windowId';

export const OVERLAY_READY_PREFIX = 'BENTO_OVERLAY_READY';
export const OVERLAY_LIFECYCLE_BUS_NAME = 'bento-overlay-lifecycle';

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

type LifecycleMessage =
  | { kind: 'ready'; overlay: OverlayName; windowId: number | null }
  | { kind: 'ack'; overlay: OverlayName; windowId: number | null; requestId: number }
  | { kind: 'cancel'; overlay: OverlayName; windowId: number | null };

// Fixed for the document's life: the hash chrome stamps on the frame URL.
const windowId = readWindowIdFromHash();

function isLifecycleMessage(data: unknown): data is LifecycleMessage {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Partial<LifecycleMessage>;
  if (typeof message.overlay !== 'string') return false;
  if (message.kind === 'ack')
    return typeof (message as { requestId?: unknown }).requestId === 'number';
  return message.kind === 'ready' || message.kind === 'cancel';
}

function broadcast(message: LifecycleMessage): void {
  if (typeof BroadcastChannel === 'undefined') return;
  const channel = new BroadcastChannel(OVERLAY_LIFECYCLE_BUS_NAME);
  channel.postMessage(message);
  channel.close();
}

/** Announces that this overlay document is subscribed and can receive an open. */
export function signalOverlayReady(overlay: OverlayName): void {
  broadcast({ kind: 'ready', overlay, windowId });
  sendChromeTitle(`${OVERLAY_READY_PREFIX}_${Date.now()}`);
}

/** Call from the overlay's top-level component, after the effects that subscribe. */
export function useOverlayReadySignal(overlay: OverlayName): void {
  useEffect(() => {
    signalOverlayReady(overlay);
  }, [overlay]);
}

/** Receiver side: tells senders that every request up to `requestId` is handled. */
export function acknowledgeOverlayRequest(overlay: OverlayName, requestId: number): void {
  broadcast({ kind: 'ack', overlay, windowId, requestId });
}

export interface OverlayWatcher {
  /** The overlay in this window announced it can receive. */
  onReady(): void;
  /** The overlay in this window handled every request up to `requestId`. */
  onAck(requestId: number): void;
  /** Chrome dropped the open of this window's overlay while it was still waiting. */
  onCancel(): void;
}

const watchers = new Map<OverlayName, OverlayWatcher>();
let lifecycleChannel: BroadcastChannel | null = null;

function onLifecycleMessage(event: MessageEvent): void {
  const data: unknown = event.data;
  if (!isLifecycleMessage(data) || data.windowId !== windowId) return;
  const watcher = watchers.get(data.overlay);
  if (!watcher) return;
  if (data.kind === 'ready') watcher.onReady();
  else if (data.kind === 'ack') watcher.onAck(data.requestId);
  else watcher.onCancel();
}

/** Sender side: one watcher per overlay per document (a later call replaces it). */
export function watchOverlayLifecycle(overlay: OverlayName, watcher: OverlayWatcher): void {
  if (typeof BroadcastChannel === 'undefined') return;
  if (!lifecycleChannel) {
    lifecycleChannel = new BroadcastChannel(OVERLAY_LIFECYCLE_BUS_NAME);
    lifecycleChannel.addEventListener('message', onLifecycleMessage);
  }
  watchers.set(overlay, watcher);
}
