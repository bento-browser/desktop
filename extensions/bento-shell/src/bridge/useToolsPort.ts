// Singleton bus to bento-tools, via bento-shell's background. We use a
// BroadcastChannel (same-origin, cross-process) instead of runtime.connect
// because chrome-mounted extension pages can't reliably runtime.connect.
//
// background.ts holds the actual port to bento-tools and relays events
// both ways through 'bento-shell-bus'.

import type { Action, Event } from '@shared/protocol';
import { useSyncExternalStore } from 'react';
import { useTabsStore } from '../state/tabs';
import { useWorkspacesStore } from '../state/workspaces';
import { useSettingsStore } from '../state/settings';
import { usePanelsStore } from '../state/panels';
import { usePrivacyStore } from '../state/privacy';

const CHANNEL_NAME = 'bento-shell-bus';

interface BusState {
  channel: BroadcastChannel | null;
  ready: boolean;
  /** Whether this shell entry should translate panel/show + panel/hide
   * events into the chrome-script `BENTO_SIDE_PANEL:...` document.title
   * IPC. The sidebar opts in via enableSidePanelTitleBridge(); other
   * entries (confirm, palette, settings, privacy) MUST NOT — they share
   * this bus to receive store snapshots, but they don't own the chrome
   * side panel and writing the title would clobber their own title-IPC
   * close signals (e.g. the confirm overlay's BENTO_CLOSE_CONFIRM_<ts>). */
  sidePanelTitleBridge: boolean;
}

const state: BusState = { channel: null, ready: false, sidePanelTitleBridge: false };
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
        // Marks paired with bento.boot in main.tsx. Idempotent — performance
        // marks dedupe internally if the bus replays this event.
        performance.mark('bento.toolsReady');
        performance.measure('bento.bootToToolsReady', 'bento.boot', 'bento.toolsReady');
        notify();
        // The cached snapshot relayed by bento-shell background may be from
        // a moment when tools' TabRegistry hadn't yet captured all startup
        // tabs. Ask for a fresh one — applySnapshot replaces, not merges,
        // so this can only fix things, never lose tabs.
        dispatch({ type: 'tabs/requestSnapshot' });
        dispatch({ type: 'workspaces/requestSnapshot' });
        dispatch({ type: 'settings/requestSnapshot' });
        return;
      case 'tabs/snapshot':
        useTabsStore.getState().applySnapshot(event.tabs);
        return;
      case 'tabs/changed':
        useTabsStore.getState().applyDeltas(event.deltas);
        return;
      case 'workspaces/snapshot':
        useWorkspacesStore.getState().applySnapshot(event.workspaces, event.activeId);
        return;
      case 'workspaces/changed':
        useWorkspacesStore.getState().applyDeltas(event.deltas);
        return;
      case 'settings/snapshot':
      case 'settings/changed':
        useSettingsStore.getState().apply(event.settings);
        // Forward uiColorMode to chrome via title-IPC. The sidebar entry
        // owns this signal (sidePanelTitleBridge gate); secondary entries
        // share the bus to receive store snapshots but don't write
        // chrome-side titles. uiColorMode is also sent inside
        // BENTO_PANELS payloads (idempotent on chrome) — this dedicated
        // path covers settings changes that DON'T trigger a panels/sync.
        if (state.sidePanelTitleBridge) {
          document.title = `BENTO_COLOR_MODE:${Date.now()}:${event.settings.uiColorMode}`;
        }
        return;
      case 'panels/sync':
        // Mirror panel ids per workspace so the sidebar can subtract
        // them from the tab list (panels and tabs are disjoint sets in
        // Bento's model). Apply on every shell entry, not just the
        // sidebar — secondary entries like the command palette also
        // need to know which tabs are panels so their tab listings
        // stay consistent.
        usePanelsStore.getState().apply(
          event.workspaceId,
          event.panels.map((p) => p.tabId),
        );
        // Forward to chrome via title-IPC, BUT only for the active
        // workspace's panels — the chrome reconciler renders the
        // currently-visible panel strip and would corrupt the
        // layout if we sent panels for inactive workspaces. bento-
        // tools now broadcasts panels/sync for every workspace (so
        // the local store can pre-populate the per-workspace filter
        // for the slide animation); this gate keeps chrome's view
        // scoped to the active workspace as before.
        //
        // Format expected by bento-shell-mount.js:
        //   BENTO_PANELS:<ts>:<base64-of-json>. Payload shape:
        //   { workspaceId: string|null, panels: Array<{tabId, url, ...}> }
        // workspaceId carries the active workspace so chrome's
        // Cmd+1..9 handler can scope tab activation to the current
        // workspace without needing a separate IPC channel.
        if (state.sidePanelTitleBridge) {
          const activeId = useWorkspacesStore.getState().activeId;
          if (event.workspaceId === activeId) {
            const payload: {
              workspaceId: string;
              panels: typeof event.panels;
              mainWidthPx?: number;
              uiColorMode?: string;
            } = {
              workspaceId: activeId,
              panels: event.panels,
            };
            if (typeof event.mainWidthPx === 'number') {
              payload.mainWidthPx = event.mainWidthPx;
            }
            // Idempotent re-send of the user's uiColorMode preference.
            // BENTO_COLOR_MODE has its own title-IPC path for changes
            // that DON'T trigger reconcile, but bundling it here makes
            // every reconcile self-correcting against any race that
            // dropped the dedicated message.
            const ui = useSettingsStore.getState().current?.uiColorMode;
            if (ui) payload.uiColorMode = ui;
            const json = JSON.stringify(payload);
            // btoa needs latin1; encodeURIComponent first to handle multibyte.
            const b64 = btoa(unescape(encodeURIComponent(json)));
            document.title = `BENTO_PANELS:${Date.now()}:${b64}`;
          }
        }
        return;
      case 'privacy/snapshot':
        usePrivacyStore.getState().apply(event.privacy);
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

/** Opt this entry into translating panel/show + panel/hide events into
 * the chrome `BENTO_SIDE_PANEL:...` document.title IPC. Called only by
 * the sidebar (src/main.tsx) — the sidebar is the canonical owner of
 * the chrome side-panel reveal/hide signal. Other entries (confirm,
 * palette, settings, privacy) intentionally do NOT call this. */
export function enableSidePanelTitleBridge(): void {
  state.sidePanelTitleBridge = true;
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
