// Transports between a shell document and the shell background.
//
// Regular windows use the same-origin BroadcastChannel 'bento-shell-bus'. Firefox
// partitions BroadcastChannel by privateBrowsingId, so a document in a private
// window never reaches the (regular) background that way. It uses the
// BentoShellBus relay instead: the document hands a JSON string to the chrome
// actor as the detail of a 'bento-bus-up' CustomEvent, the actor forwards it to
// the parent-process hub, and the hub delivers it to the background through the
// chrome-bridge experiment (bentoChrome.onBusMessage). Messages back arrive as a
// 'bento-bus-down' CustomEvent. The hub, not the page, supplies the document's
// window id and privacy.
//
// Document-to-document traffic ('menu/open', 'ui/*', theme) keeps using a plain
// BroadcastChannel, which works inside the private partition.

import type { Event, WireAction } from '@shared/protocol';

export const BUS_CHANNEL_NAME = 'bento-shell-bus';

/** Document to background. */
export type BusUp =
  { kind: 'hello'; helloId: string } | { kind: 'action'; action: WireAction | { type: string } };

/** Background to document. `replayFor` marks a cached replay for one joiner; an
 * `ack` answers a `hello` once the relay is ready for the document. */
export type BusDown =
  { kind: 'event'; event: Event; replayFor?: string } | { kind: 'ack'; helloId: string };

export interface ShellBusTransport {
  post(message: BusUp): void;
  subscribe(listener: (message: BusDown) => void): void;
}

/** Actions consumed by other shell documents, never by tools or the background. */
export function isDocumentLocalAction(action: { type?: unknown }): boolean {
  const type = action.type;
  return typeof type === 'string' && (type === 'menu/open' || type.startsWith('ui/'));
}

export function createChannelTransport(): ShellBusTransport {
  const channel = new BroadcastChannel(BUS_CHANNEL_NAME);
  return {
    post: (message) => channel.postMessage(message),
    subscribe: (listener) =>
      channel.addEventListener('message', (message) => listener(message.data as BusDown)),
  };
}

export function createRelayTransport(target: EventTarget = window): ShellBusTransport {
  return {
    post: (message) =>
      target.dispatchEvent(new CustomEvent('bento-bus-up', { detail: JSON.stringify(message) })),
    subscribe: (listener) =>
      target.addEventListener('bento-bus-down', (event) => {
        const detail = (event as CustomEvent).detail;
        if (typeof detail !== 'string') return;
        try {
          listener(JSON.parse(detail) as BusDown);
        } catch {
          // Not ours; ignore.
        }
      }),
  };
}

const HELLO_RETRY_MIN_MS = 250;
const HELLO_RETRY_MAX_MS = 2000;

/**
 * Sends `hello` until `isAcknowledged()` is true. The relay can be unavailable
 * for a while (the actor not attached yet, the background still starting, a dev
 * reload), and a lost hello leaves the document without state for good. The
 * background answers a repeated hello idempotently.
 */
export function sendHelloUntilAcknowledged(send: () => void, isAcknowledged: () => boolean): void {
  let delay = HELLO_RETRY_MIN_MS;
  const attempt = () => {
    if (isAcknowledged()) return;
    send();
    // The relay answers synchronously when it is up; nothing to retry then.
    if (isAcknowledged()) return;
    setTimeout(attempt, delay);
    delay = Math.min(delay * 2, HELLO_RETRY_MAX_MS);
  };
  attempt();
}
