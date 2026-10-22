// Settings transport over the private-window relay's document events.
//
// The relay (BentoShellBus actor + parent hub, plans/private-window-shell-bus.md) moves strings
// between a shell document and the shell background in every window: the document dispatches a
// 'bento-bus-up' CustomEvent whose detail is a JSON string, and receives 'bento-bus-down' the
// same way. The hub, not this document, supplies the window id and privacy.
//
// This file is the only place that knows how Settings traffic is shaped on that relay. The
// relay branch defines `hello`/`ack` and the `action`/`event` carriers; it defines no Settings
// kind yet, so the shapes below are an assumption to settle when the branches are joined:
//
//   up    {kind:'hello', helloId}                                   registers this document
//   up    {kind:'action', action:{type:'settings/request', ...body}} one SettingsRequestBody
//   down  {kind:'ack', helloId}                                     the relay is ready for us
//   down  {kind:'event', event}  event is a `settings/result` or a change notice
//
// `connect()` must be called once; until the relay acknowledges, requests wait (at most
// `queueMs`, the client's own deadline, so a stale request is never sent late).

import type { SettingsRequestBody, SettingsTransport } from './settingsClient';

export const RELAY_UP_EVENT = 'bento-bus-up';
export const RELAY_DOWN_EVENT = 'bento-bus-down';
export const SETTINGS_REQUEST_ACTION = 'settings/request';

const HELLO_RETRY_MIN_MS = 250;
const HELLO_RETRY_MAX_MS = 2000;
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
  const target = options.target ?? window;
  const queueMs = options.queueMs ?? DEFAULT_QUEUE_MS;
  const newId = options.newId ?? (() => crypto.randomUUID());
  const handlers = new Set<(message: unknown) => void>();
  const queue: Array<{ json: string; expiresAt: number }> = [];
  let helloId: string | undefined;
  let ready = false;
  let helloTimer: ReturnType<typeof setTimeout> | undefined;

  const post = (message: unknown) =>
    target.dispatchEvent(new CustomEvent(RELAY_UP_EVENT, { detail: JSON.stringify(message) }));

  const requestMessage = (request: SettingsRequestBody) =>
    JSON.stringify({ kind: 'action', action: { type: SETTINGS_REQUEST_ACTION, ...request } });

  function flush(): void {
    const now = Date.now();
    for (const entry of queue.splice(0)) {
      if (entry.expiresAt > now) {
        target.dispatchEvent(new CustomEvent(RELAY_UP_EVENT, { detail: entry.json }));
      }
    }
  }

  function onDown(event: Event): void {
    const detail = (event as CustomEvent).detail as unknown;
    if (typeof detail !== 'string') return;
    let message: unknown;
    try {
      message = JSON.parse(detail);
    } catch {
      return; // Not ours.
    }
    if (typeof message !== 'object' || message === null) return;
    const { kind } = message as { kind?: unknown };
    if (kind === 'ack') {
      if ((message as { helloId?: unknown }).helloId !== helloId || ready) return;
      ready = true;
      clearTimeout(helloTimer);
      flush();
    } else if (kind === 'event') {
      const inner = (message as { event?: unknown }).event;
      for (const handler of handlers) handler(inner);
    }
  }

  return {
    get isReady() {
      return ready;
    },

    connect() {
      helloId = newId();
      target.addEventListener(RELAY_DOWN_EVENT, onDown);
      let delay = HELLO_RETRY_MIN_MS;
      const attempt = () => {
        if (ready) return;
        post({ kind: 'hello', helloId });
        // The relay answers synchronously when it is up; nothing to retry then.
        if (ready) return;
        helloTimer = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, HELLO_RETRY_MAX_MS);
      };
      attempt();
      return () => {
        clearTimeout(helloTimer);
        target.removeEventListener(RELAY_DOWN_EVENT, onDown);
        ready = false;
        queue.length = 0;
      };
    },

    send(request) {
      const json = requestMessage(request);
      if (ready) {
        target.dispatchEvent(new CustomEvent(RELAY_UP_EVENT, { detail: json }));
      } else {
        queue.push({ json, expiresAt: Date.now() + queueMs });
      }
    },

    onMessage(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
