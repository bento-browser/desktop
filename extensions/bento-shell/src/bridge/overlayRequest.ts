// Window-scoped, ordered payload delivery to an overlay document.
//
// The confirm, edit-workspace and workspace-switcher overlays receive a payload
// over a BroadcastChannel and chrome reveals them from a title. One channel
// serves every chrome window and every document that can send, so a bare post
// has three problems this module removes:
//
// - Window scope. Every message carries the sender's window id and a receiver
//   ignores other windows'. Before this, window B's confirmation replaced the
//   dialog window A was showing, because all windows' overlays listened to the
//   same channel.
// - Order. Each request has an id that grows with the wall clock across
//   documents. A receiver applies only requests newer than the last one it saw
//   and ignores duplicates, so a delayed replay cannot replace a newer request.
// - Delivery to a document that does not exist yet. Chrome creates the overlay
//   on first use, so the first post can be lost. The sender keeps its latest
//   request and posts it again when the overlay announces itself
//   (overlayReady.ts), until the overlay acknowledges it, a newer request
//   replaces it, or chrome cancels the open. There is no timeout: the request
//   lives as long as the open it belongs to.

import { acknowledgeOverlayRequest, watchOverlayLifecycle, type OverlayName } from './overlayReady';
import { readWindowIdFromHash } from './windowId';

export interface OverlayRequest {
  /** Grows with the wall clock across documents and strictly within one document. */
  id: number;
  /** The sending document, to tell two requests with the same id apart. */
  from: string;
  /** The chrome window the request is for. */
  windowId: number | null;
}

interface ShowMessage<P> {
  kind: 'show';
  payload: P;
  request: OverlayRequest;
}

const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const windowId = readWindowIdFromHash();
let lastRequestId = 0;

function newOverlayRequest(): OverlayRequest {
  // Date.now() * 1000 stays a safe integer until the year 2255.
  lastRequestId = Math.max(lastRequestId + 1, Date.now() * 1000);
  return { id: lastRequestId, from: documentId, windowId };
}

function isShowMessage<P>(data: unknown): data is ShowMessage<P> {
  if (typeof data !== 'object' || data === null) return false;
  const message = data as Partial<ShowMessage<P>>;
  const request = message.request;
  return (
    message.kind === 'show' &&
    'payload' in message &&
    typeof request === 'object' &&
    request !== null &&
    typeof request.id === 'number' &&
    typeof request.from === 'string' &&
    (request.windowId === null || typeof request.windowId === 'number')
  );
}

export interface ShowBus<P> {
  /** Posts a request for this document's window and keeps it until it is acknowledged,
   * replaced by a newer request, or cancelled. Returns null without BroadcastChannel. */
  request(payload: P): OverlayRequest | null;
  /** Calls `handler` for each request for this window that is newer than the last. */
  subscribe(handler: (payload: P, request: OverlayRequest) => void): () => void;
  /** The underlying channel, for messages other than show. */
  channel(): BroadcastChannel | null;
}

export function createShowBus<P>(busName: string, overlay: OverlayName): ShowBus<P> {
  let channel: BroadcastChannel | null = null;
  let pending: ShowMessage<P> | null = null;

  function bus(): BroadcastChannel | null {
    if (channel) return channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    channel = new BroadcastChannel(busName);
    return channel;
  }

  return {
    channel: bus,

    request(payload) {
      const ch = bus();
      if (!ch) return null;
      const request = newOverlayRequest();
      const message: ShowMessage<P> = { kind: 'show', payload, request };
      pending = message;
      ch.postMessage(message);
      watchOverlayLifecycle(overlay, {
        onReady: () => {
          if (pending) ch.postMessage(pending);
        },
        onAck: (requestId) => {
          if (pending && pending.request.id <= requestId) pending = null;
        },
        onCancel: () => {
          pending = null;
        },
      });
      return request;
    },

    subscribe(handler) {
      const ch = bus();
      if (!ch) return () => {};
      let latest: OverlayRequest | null = null;
      const listener = (event: MessageEvent) => {
        const data: unknown = event.data;
        if (!isShowMessage<P>(data) || data.request.windowId !== windowId) return;
        const { request } = data;
        const stale =
          latest !== null &&
          (request.id < latest.id || (request.id === latest.id && request.from === latest.from));
        if (!stale) {
          latest = request;
          handler(data.payload, request);
        }
        // Stale or not, the sender can stop sending this request.
        acknowledgeOverlayRequest(overlay, request.id);
      };
      ch.addEventListener('message', listener);
      return () => ch.removeEventListener('message', listener);
    },
  };
}
