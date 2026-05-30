// Singleton bus to bento-tools, via bento-shell's background. We use a
// BroadcastChannel (same-origin, cross-process) instead of runtime.connect
// because chrome-mounted extension pages can't reliably runtime.connect.
//
// background.ts holds the actual port to bento-tools and relays events
// both ways through 'bento-shell-bus'.
//
// Per-window awareness: each shell document lives in a <browser> hosted
// by a specific chrome window. The chrome script (bento-shell-mount.js)
// resolves THAT window's WebExtension windowId via the authoritative
// `Management.global.windowTracker.getId(window)` API and stamps it onto
// the shell URL as a HASH fragment `#bentoWindowId=<N>` before
// navigating the frame. The shell document reads it from
// `location.hash`. Hash-fragments are chosen over query strings because
// query strings cause Firefox to re-partition the BrowsingContextGroup
// for the shell document, which silently breaks the cross-process
// BroadcastChannel('bento-shell-bus') the shell uses to talk to the
// singleton bento-shell background. Hashes are purely client-side and
// don't affect process placement or the resource path. Symptom of the
// query-string variant: shell renders skeleton but `tools/booted` never
// arrives.
//
// This is more reliable than `browser.windows.getCurrent()` from the
// shell context: chrome-mounted <browser> frames are NOT regular tabs
// (they live in browser.xhtml, not tabbrowser-tabpanels), so the
// windows API can misreport the hosting window — typically returning
// the most-recently-focused window when the shell wasn't focused at
// the moment of the call. That misreport produces the "switching
// workspace in window A also switches window B" bug. Chrome-side
// windowTracker is authoritative because it reads the chrome window's
// stable BrowserWindowTracker id directly.
//
// Every dispatch stamps `__windowId` on the wire envelope so bento-
// tools scopes per-window state correctly. The bento-shell background
// extension is a singleton across all chrome windows so it can't carry
// the windowId itself — actions from window A and window B both flow
// through it on the same port.

import type { Action, Event, WireAction } from '@shared/protocol';
import { useSyncExternalStore } from 'react';
import { useTabsStore } from '../state/tabs';
import { selectActiveIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useSettingsStore } from '../state/settings';
import { usePanelsStore } from '../state/panels';
import { usePinnedPanelsStore } from '../state/pinnedPanels';
import { useSavedPanelsStore } from '../state/savedPanels';
import { usePrivacyStore } from '../state/privacy';
import { useBackupStore } from '../state/backup';

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
  /** WebExtension windowId of the chrome window hosting this shell
   * document. Read SYNCHRONOUSLY at module load from the
   * `#bentoWindowId=<N>` URL hash the chrome script stamps onto the
   * shell URL via `setFrameSrc` in bento-shell-mount.js. The chrome
   * script gets the authoritative value from
   * `Management.global.windowTracker.getId(window)`. Hash (not query
   * string) because query strings change the BrowsingContextGroup and
   * break the cross-process BroadcastChannel the shell uses to receive
   * tools events. Null only when:
   *   - this shell is loaded outside Bento's chrome (Ladle, standalone
   *     vite preview) — neither stamps the hash.
   *   - the chrome-side windowTracker import failed (rare; bento-shell-
   *     mount.js logs a warning in that case).
   * In both cases bento-tools falls back to legacy global behaviour
   * (single-window semantics). */
  windowId: number | null;
}

function readWindowIdFromHash(): number | null {
  try {
    // location.hash includes the leading "#" — strip it before parsing.
    // The hash is shaped like "#bentoWindowId=42" (single key); URLSearchParams
    // is overkill but tolerant of extra params, so we use it for forward-
    // compatibility if more flags get added later.
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const params = new URLSearchParams(hash);
    const raw = params.get('bentoWindowId');
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

const state: BusState = {
  channel: null,
  ready: false,
  sidePanelTitleBridge: false,
  windowId: readWindowIdFromHash(),
};
const subscribers = new Set<() => void>();

function notify() {
  for (const fn of subscribers) fn();
}

function markToolsReady() {
  if (typeof performance === 'undefined') return;

  performance.mark('bento.toolsReady');
  if (performance.getEntriesByName('bento.boot', 'mark').length === 0) {
    return;
  }

  performance.measure('bento.bootToToolsReady', 'bento.boot', 'bento.toolsReady');
}

function ensureConnection(): void {
  if (state.channel) return;
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('[bento-shell document] no BroadcastChannel — skipping');
    return;
  }

  const channel = new BroadcastChannel(CHANNEL_NAME);
  state.channel = channel;

  channel.addEventListener('message', (msg) => {
    const { data } = msg;
    if (!data || data.kind !== 'event') return;
    const event = data.event as Event;
    switch (event.type) {
      case 'tools/booted':
        state.ready = true;
        // The sidebar has bento.boot from main.tsx; secondary entries also
        // connect to this bus, but do not own that startup mark.
        markToolsReady();
        notify();
        // The cached snapshot relayed by bento-shell background may be from
        // a moment when tools' TabRegistry hadn't yet captured all startup
        // tabs. Ask for a fresh one — applySnapshot replaces, not merges,
        // so this can only fix things, never lose tabs.
        dispatch({ type: 'tabs/requestSnapshot' });
        dispatch({ type: 'workspaces/requestSnapshot' });
        dispatch({ type: 'settings/requestSnapshot' });
        dispatch({ type: 'pinnedPanels/requestSnapshot' });
        dispatch({ type: 'savedPanels/requestSnapshot' });
        return;
      case 'tabs/snapshot':
        useTabsStore.getState().applySnapshot(event.tabs);
        return;
      case 'tabs/changed':
        useTabsStore.getState().applyDeltas(event.deltas);
        return;
      case 'workspaces/snapshot':
        useWorkspacesStore
          .getState()
          .applySnapshot(event.workspaces, event.activeId, event.activeIdByWindow);
        return;
      case 'workspaces/changed':
        useWorkspacesStore.getState().applyDeltas(event.deltas);
        return;
      case 'settings/snapshot':
      case 'settings/changed':
        useSettingsStore.getState().apply(event.settings);
        // uiColorMode is delivered to chrome via the BENTO_PANELS title-
        // IPC payload (the panels/sync handler below includes it). We
        // intentionally do NOT write a dedicated BENTO_COLOR_MODE title
        // here: at boot the BENTO_COLOR_MODE write would race
        // BENTO_PANELS via document.title (last-write-wins), and an
        // addon-restart-mid-init can land COLOR_MODE last — chrome then
        // never sees the panels payload and renders main-only until the
        // user manually triggers a fresh panels/sync (workspace switch).
        // Instead bento-tools' settings.onChange fires emitPanelsSync,
        // which produces a fresh BENTO_PANELS title carrying the new
        // uiColorMode — single channel, no race.
        return;
      case 'panels/sync': {
        usePanelsStore.getState().apply(
          event.workspaceId,
          event.panels.map((p) => p.tabId),
        );
        // Forward to chrome via title-IPC, BUT only for THIS WINDOW'S
        // active workspace — the chrome reconciler renders the
        // currently-visible panel strip and would corrupt the layout
        // if we sent panels for inactive workspaces. With per-window
        // active workspace (phase A.2), window A and window B can be
        // on different workspaces; each shell document writes its own
        // BENTO_PANELS title only when the panels/sync workspaceId
        // matches the workspace its window is currently showing.
        // bento-tools broadcasts panels/sync for every workspace (the
        // local store needs them for the workspace-switch slide
        // animation's pre-populated panel filter); this gate scopes
        // chrome's reconciler input to the per-window active set.
        //
        // Format expected by bento-shell-mount.js:
        //   BENTO_PANELS:<ts>:<base64-of-json>. Payload shape:
        //   { windowId?, workspaceId, panels: Array<{tabId, url, ...}> }
        // workspaceId carries this window's active workspace so
        // chrome's Cmd+1..9 handler can scope tab activation to the
        // current workspace without needing a separate IPC channel.
        // windowId is informational — document.title is intrinsically
        // per-window so chrome doesn't strictly need it to route, but
        // including it lets handlePanelsTitle log and validate the
        // payload's window-of-origin against its own gBrowser window.
        if (state.sidePanelTitleBridge) {
          const wsState = useWorkspacesStore.getState();
          const activeId = selectActiveIdForWindow(wsState, state.windowId);
          if (event.workspaceId === activeId) {
            const payload: {
              workspaceId: string;
              panels: typeof event.panels;
              windowId?: number;
              themeId?: string;
              mainWidthPx?: number;
              uiColorMode?: string;
              sidebarCollapsed?: boolean;
              customPanelSizes?: number[];
              panelCycleWraparound?: boolean;
              panelShadowsEnabled?: boolean;
              stripScrollLeft?: number;
              pinnedTabIdsInWorkspace?: number[];
              savedPanelCount?: number;
              scrollToPanelTabId?: number;
              layout: typeof event.layout;
              panelStatusByTabId: typeof event.panelStatusByTabId;
            } = {
              workspaceId: activeId,
              panels: event.panels,
              layout: event.layout,
              panelStatusByTabId: event.panelStatusByTabId,
            };
            if (state.windowId !== null) {
              payload.windowId = state.windowId;
            }
            const activeWorkspace = wsState.byId[activeId];
            if (activeWorkspace?.themeId) {
              payload.themeId = activeWorkspace.themeId;
            } else {
              payload.themeId = 'default';
            }
            if (typeof event.mainWidthPx === 'number') {
              payload.mainWidthPx = event.mainWidthPx;
            }
            if (typeof event.stripScrollLeft === 'number' && event.stripScrollLeft >= 0) {
              payload.stripScrollLeft = event.stripScrollLeft;
            }
            // Bundle chrome-bound settings into the panels payload so
            // they reach chrome via the single BENTO_PANELS title-IPC
            // channel. uiColorMode flips Tale UI tokens on the chrome
            // window root; sidebarCollapsed toggles the narrow-rail
            // class on #bento-shell-host; customPanelSizes populates
            // each side panel header's kebab "more" menu. Single
            // channel = no race with separate title writes (the
            // COLOR_MODE channel was dropped earlier for this reason).
            const cur = useSettingsStore.getState().current;
            if (cur?.uiColorMode) payload.uiColorMode = cur.uiColorMode;
            if (typeof cur?.sidebarCollapsed === 'boolean') {
              payload.sidebarCollapsed = cur.sidebarCollapsed;
            }
            if (Array.isArray(cur?.customPanelSizes)) {
              payload.customPanelSizes = cur.customPanelSizes;
            }
            if (typeof cur?.panelCycleWraparound === 'boolean') {
              payload.panelCycleWraparound = cur.panelCycleWraparound;
            }
            if (typeof cur?.panelShadowsEnabled === 'boolean') {
              payload.panelShadowsEnabled = cur.panelShadowsEnabled;
            }
            // Pinned-panel set for THIS workspace (Set.has(tabId) drives
            // the kebab menu's Pin/Unpin label) and the global count of
            // bookmarks in the "Saved panels" folder (chrome reads this
            // to size the Add-panel trailer's inline favicon row). Both
            // ride on this single chrome-bound channel — tools is the
            // source of truth and populates them directly on the event.
            if (Array.isArray(event.pinnedTabIdsInWorkspace)) {
              payload.pinnedTabIdsInWorkspace = event.pinnedTabIdsInWorkspace;
            }
            if (typeof event.savedPanelCount === 'number') {
              payload.savedPanelCount = event.savedPanelCount;
            }
            if (typeof event.scrollToPanelTabId === 'number') {
              payload.scrollToPanelTabId = event.scrollToPanelTabId;
            }
            const json = JSON.stringify(payload);
            // btoa needs latin1; encodeURIComponent first to handle multibyte.
            const b64 = btoa(unescape(encodeURIComponent(json)));
            document.title = `BENTO_PANELS:${Date.now()}:${b64}`;
          }
        }
        return;
      }
      case 'privacy/snapshot':
        usePrivacyStore.getState().apply(event.privacy);
        return;
      case 'pinnedPanels/snapshot':
        usePinnedPanelsStore.getState().applySnapshot(event.entries);
        return;
      case 'pinnedPanels/changed':
        usePinnedPanelsStore.getState().applyDeltas(event.deltas);
        return;
      case 'savedPanels/snapshot':
        useSavedPanelsStore.getState().apply(event.items);
        return;
      case 'backup/exportReady':
        window.dispatchEvent(
          new CustomEvent('bento-export-ready', {
            detail: { json: event.json, filename: event.filename },
          }),
        );
        return;
      case 'backup/importComplete':
        window.dispatchEvent(new CustomEvent('bento-import-complete', { detail: event.summary }));
        return;
      case 'backup/importError':
        window.dispatchEvent(new CustomEvent('bento-import-error', { detail: event.message }));
        return;
      case 'backup/list':
        useBackupStore.getState().apply(event.backups);
        return;
      case 'pong':
        return;
      default:
        return;
    }
  });

  // Tell the background we're alive so it replays last booted + snapshot.
  channel.postMessage({ kind: 'hello' });

  // windowId was already captured synchronously from `?bentoWindowId=` at
  // module load. Send shell/hello so bento-tools logs the windowId for
  // this shell instance — useful as a startup log line for debugging.
  // The same windowId rides every subsequent dispatch via the
  // __windowId envelope.
  if (state.windowId !== null) {
    dispatch({ type: 'shell/hello', windowId: state.windowId });
  }
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function getReady(): boolean {
  return state.ready;
}

function getWindowId(): number | null {
  return state.windowId;
}

/** Initialize the bus (call once at shell mount). Safe to call multiple times. */
export function initToolsPort(): void {
  ensureConnection();
}

/** React hook returning this shell document's chrome window's WebExtension
 * windowId, or null if it hasn't yet resolved (the brief gap between
 * mount and `browser.windows.getCurrent()` returning) or if the API isn't
 * available (Ladle / standalone preview). Subscribers re-render once the
 * windowId is captured so per-window selectors like
 * `useActiveWorkspaceForCurrentWindow()` flip from global fallback to
 * per-window state without a reload. */
export function useCurrentWindowId(): number | null {
  return useSyncExternalStore(subscribe, getWindowId, getWindowId);
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

/** Dispatch an Action to bento-tools (via background). Automatically
 * stamps `__windowId` on the wire envelope so bento-tools can route
 * per-window. Documents that haven't yet resolved their windowId (the
 * brief async gap between mount and getCurrent) dispatch without the
 * stamp and bento-tools treats them as window-unknown. */
export function dispatch(action: Action): void {
  ensureConnection();
  const wireAction: WireAction =
    state.windowId !== null ? { ...action, __windowId: state.windowId } : action;
  state.channel?.postMessage({ kind: 'action', action: wireAction });
}
