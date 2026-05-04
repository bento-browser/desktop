// Singleton bus to bento-tools, via bento-shell's background. We use a
// BroadcastChannel (same-origin, cross-process) instead of runtime.connect
// because chrome-mounted extension pages can't reliably runtime.connect.
//
// background.ts holds the actual port to bento-tools and relays events
// both ways through 'bento-shell-bus'.

import type { Action, Event } from '@shared/protocol';
import { useSyncExternalStore } from 'react';
import { useTabsStore } from '../state/tabs';

const CHANNEL_NAME = 'bento-shell-bus';

interface BusState {
  channel: BroadcastChannel | null;
  ready: boolean;
}

const state: BusState = { channel: null, ready: false };
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

function ensureConnection(): void {
  if (state.channel) return;
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('[bento-shell document] no BroadcastChannel — skipping');
    return;
  }

  console.log('[bento-shell document] opening BroadcastChannel…');
  const channel = new BroadcastChannel(CHANNEL_NAME);
  state.channel = channel;

  channel.addEventListener('message', (msg) => {
    const { data } = msg;
    if (!data || data.kind !== 'event') return;
    const event = data.event as Event;
    console.log('[bento-shell document] event:', event.type);
    switch (event.type) {
      case 'tools/booted':
        state.ready = true;
        notify();
        // The cached snapshot relayed by bento-shell background may be from
        // a moment when tools' TabRegistry hadn't yet captured all startup
        // tabs. Ask for a fresh one — applySnapshot replaces, not merges,
        // so this can only fix things, never lose tabs.
        dispatch({ type: 'tabs/requestSnapshot' });
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

  // Tell the background we're alive so it replays last booted + snapshot.
  channel.postMessage({ kind: 'hello' });
  console.log('[bento-shell document] hello sent');
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function getReady(): boolean {
  return state.ready;
}

/** Initialize the bus (call once at shell mount). Safe to call multiple times. */
export function initToolsPort(): void {
  ensureConnection();
}

/** React hook returning the current ready flag; re-renders on connect. */
export function useToolsReady(): boolean {
  return useSyncExternalStore(subscribe, getReady, getReady);
}

/** Dispatch an Action to bento-tools (via background). */
export function dispatch(action: Action): void {
  ensureConnection();
  state.channel?.postMessage({ kind: 'action', action });
}
