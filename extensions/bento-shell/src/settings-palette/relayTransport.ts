// Settings transport over the BentoShellBus relay.
//
// The relay (BentoShellBus actor and parent hub, bridge/shellBus.ts) moves JSON between a shell
// document and the shell background in every window, so the Settings overlay works in private
// windows too. The hub, not this document, supplies the window id and privacy; the background
// (bridge/settingsRelay.ts) forwards each request to tools with that identity and sends the
// answer back to this document only.
//
//   up    {kind:'settings-hello', helloId}        registers this document
//   up    {kind:'settings-request', request}      one SettingsRequestBody
//   down  {kind:'ack', helloId}                   the relay is ready for us
//   down  {kind:'settings-result', result}        the answer to one request
//   down  {kind:'event', event}                   a profile-wide change notice
//
// `connect()` must be called once; until the relay acknowledges, requests wait (at most
// `queueMs`, the client's own deadline, so a stale request is never sent late).

import {
  createRelayTransport as createBusRelay,
  sendHelloUntilAcknowledged,
} from '../bridge/shellBus';
import type { SettingsRequestBody, SettingsTransport } from './settingsClient';

const DEFAULT_QUEUE_MS = 15_000;

export interface RelayTransportOptions {
  /** Where the relay's events are dispatched; the document's window. */
  target?: EventTarget;
  queueMs?: number;
  newId?: () => string;
}

export interface RelayTransport extends SettingsTransport {
  /** Starts the handshake and the listener. Returns a function that undoes both. */
  connect(): () => void;
  readonly isReady: boolean;
}

export function createRelayTransport(options: RelayTransportOptions = {}): RelayTransport {
  const bus = createBusRelay(options.target ?? window);
  const queueMs = options.queueMs ?? DEFAULT_QUEUE_MS;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const handlers = new Set<(message: unknown) => void>();
  const queue: Array<{ request: SettingsRequestBody; expiresAt: number }> = [];
  let helloId: string | undefined;
  let connected = false;
  let ready = false;

  const post = (request: SettingsRequestBody) => bus.post({ kind: 'settings-request', request });
  const deliver = (message: unknown) => {
    for (const handler of handlers) handler(message);
  };

  bus.subscribe((message) => {
    // The listener cannot be removed, and the page may send anything down this event.
    if (!connected || typeof message !== 'object' || message === null) return;
    if (message.kind === 'ack') {
      if (message.helloId !== helloId || ready) return;
      ready = true;
      const now = Date.now();
      for (const entry of queue.splice(0)) if (entry.expiresAt > now) post(entry.request);
    } else if (message.kind === 'settings-result') {
      deliver(message.result);
    } else if (message.kind === 'event') {
      deliver(message.event);
    }
  });

  return {
    get isReady() {
      return ready;
    },

    connect() {
      helloId = newId();
      connected = true;
      sendHelloUntilAcknowledged(
        () => bus.post({ kind: 'settings-hello', helloId: helloId! }),
        () => ready || !connected,
      );
      return () => {
        connected = false;
        ready = false;
        queue.length = 0;
      };
    },

    send(request) {
      if (ready) post(request);
      else queue.push({ request, expiresAt: Date.now() + queueMs });
    },

    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
