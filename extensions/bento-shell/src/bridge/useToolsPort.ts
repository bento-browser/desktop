// Singleton long-lived port to bento-tools. Connection happens lazily on
// first access and lives for the whole shell document. Inbound Events are
// dispatched to the relevant Zustand stores; outbound Actions go through
// the exported `dispatch` function (§4.2 mirror pattern).

import type { Action, Event } from '@shared/protocol';
import { useSyncExternalStore } from 'react';
import { useTabsStore } from '../state/tabs';

// Document context can't reliably runtime.connect to bento-tools when loaded
// inside a chrome <browser> mount (cross-process extension restrictions).
// Instead we connect to bento-shell's own background page which has the
// reliable cross-extension port and relays events both ways.
const DOCUMENT_PORT_NAME = 'shell-document';

interface PortState {
  port: browser.runtime.Port | null;
  ready: boolean;
}

const state: PortState = { port: null, ready: false };
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

function ensureConnection(): void {
  if (state.port) return;
  console.log('[bento-shell document] ensureConnection — browser:', typeof browser);
  if (typeof browser === 'undefined' || !browser.runtime?.connect) {
    console.warn('[bento-shell document] no browser.runtime.connect — skipping');
    return;
  }

  console.log('[bento-shell document] connecting to own background…');
  const port = browser.runtime.connect({ name: DOCUMENT_PORT_NAME });
  state.port = port;
  console.log('[bento-shell document] port created');

  port.onMessage.addListener((message: object) => {
    const event = message as Event;
    console.log('[bento-shell document] event:', event.type, event);
    switch (event.type) {
      case 'tools/booted':
        state.ready = true;
        notify();
        return;
      case 'tabs/snapshot':
        useTabsStore.getState().applySnapshot(event.tabs);
        return;
      case 'tabs/changed':
        useTabsStore.getState().applyDeltas(event.deltas);
        return;
      case 'pong':
        return;
      default:
        return;
    }
  });

  port.onDisconnect.addListener(() => {
    state.port = null;
    state.ready = false;
    notify();
  });
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function getReady(): boolean {
  return state.ready;
}

/** Initialize the port (call once at shell mount). Safe to call multiple times. */
export function initToolsPort(): void {
  ensureConnection();
}

/** React hook returning the current ready flag; re-renders on connect/disconnect. */
export function useToolsReady(): boolean {
  return useSyncExternalStore(subscribe, getReady, getReady);
}

/** Dispatch an Action to bento-tools. No-op when the port isn't connected. */
export function dispatch(action: Action): void {
  ensureConnection();
  state.port?.postMessage(action);
}
