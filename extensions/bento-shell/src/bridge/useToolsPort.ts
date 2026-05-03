// Singleton long-lived port to bento-tools. Connection happens lazily on
// first access and lives for the whole shell document. Inbound Events are
// dispatched to the relevant Zustand stores; outbound Actions go through
// the exported `dispatch` function (§4.2 mirror pattern).

import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';
import { useSyncExternalStore } from 'react';
import { useTabsStore } from '../state/tabs';

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
  if (typeof browser === 'undefined' || !browser.runtime?.connect) {
    // Standalone Vite dev server: leave port null. M1+ bridge/ mock layer
    // can swap a fake port in here for local UI iteration.
    return;
  }

  const port = browser.runtime.connect('bento-tools@bento.app', {
    name: SHELL_TOOLS_PORT,
  });
  state.port = port;

  port.onMessage.addListener((message: object) => {
    const event = message as Event;
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
