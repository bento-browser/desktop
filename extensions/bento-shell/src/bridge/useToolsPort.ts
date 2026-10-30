// Singleton bus to bento-tools, via bento-shell's background. We use a
// BroadcastChannel (same-origin, cross-process) instead of runtime.connect
// because chrome-mounted extension pages can't reliably runtime.connect.
//
// background.ts holds the actual port to bento-tools and relays events
// both ways through 'bento-shell-bus'.
//
// Documents in a private window cannot use that channel (Firefox partitions
// BroadcastChannel by privateBrowsingId), so the transport is chosen from the
// `#bentoPrivate=1` hash flag: the BentoShellBus relay there, the channel here.
// See bridge/shellBus.ts and docs/technical/shell-chrome-bridge.md.
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

import type {
  Action,
  ColorStamp,
  Event,
  SidebarShortcutBehavior,
  WireAction,
} from '@shared/protocol';
import { useSyncExternalStore } from 'react';
import { useTabsStore } from '../state/tabs';
import { selectActiveIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useSettingsStore } from '../state/settings';
import { usePanelsStore } from '../state/panels';
import { usePinnedPanelsStore } from '../state/pinnedPanels';
import { useTabFoldersStore } from '../state/tabFolders';
import { useSavedPanelsStore } from '../state/savedPanels';
import { usePrivacyStore } from '../state/privacy';
import { useAddressBarStore } from '../state/addressBar';
import { useSearchEnginesStore } from '../state/searchEngines';
import { usePanelFocusStore } from '../state/panelFocus';
import { useExternalMergeStore } from '../state/externalMerge';
import { WINDOW_LOCAL_SETTING_KEYS } from '@shared/windowLocalSettings';
import { resolveThemeId } from '../theme/presets';
import { sendChromeTitle } from './chromeTitle';
import { followColorStamp } from './colorStamp';
import {
  BUS_CHANNEL_NAME,
  createChannelTransport,
  createRelayTransport,
  isDocumentLocalAction,
  sendHelloUntilAcknowledged,
  type BusDown,
  type ShellBusTransport,
} from './shellBus';
import { readPrivateFromHash, readWindowIdFromHash } from './windowId';

type PanelsSyncEvent = Extract<Event, { type: 'panels/sync' }>;

interface BusState {
  /** Link to the shell background: BroadcastChannel in a regular window, the
   * BentoShellBus relay in a private one (see shellBus.ts). */
  bus: ShellBusTransport | null;
  /** Private window only: plain BroadcastChannel for document-local actions
   * ('menu/open', 'ui/*'), which work inside the private partition. */
  localChannel: BroadcastChannel | null;
  /** Whether the hosting window is private (`#bentoPrivate=1`). */
  isPrivate: boolean;
  /** Private window only: the relay answered this document's hello. */
  acknowledged: boolean;
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
  /** Identifies this document's `hello`. The background tags its bootstrap
   * replay with it so only the joining document applies the replay. */
  helloId: string;
  /** Sidebar only: latest panels/sync per workspace that chrome has not
   * received in full yet: held while this window's active workspace is
   * unknown, or forwarded before the settings (or workspace theme) it embeds
   * had hydrated. Re-forwarded by forwardPendingPanelsToChrome once the
   * missing input arrives, whichever order the events come in. */
  pendingPanelsSync: Map<string, PanelsSyncEvent>;
  /** Sidebar of a private window only: the panels/sync last written to chrome,
   * without its scroll hint. A private window's own sidebar or colour change never
   * reaches tools, so tools does not re-fire panels/sync for it; this is sent again
   * with the new values instead. */
  lastPanelsForChrome: PanelsSyncEvent | null;
  /** The order stamp of the saved colour mode (settings events' `colorStamp`), null until a
   * current tools build has sent one. Every panels payload carries it, so chrome can drop one
   * that was built before a newer mode reached it by the direct route. */
  colorStamp: ColorStamp | null;
}

const state: BusState = {
  bus: null,
  localChannel: null,
  isPrivate: readPrivateFromHash(),
  acknowledged: false,
  ready: false,
  sidePanelTitleBridge: false,
  windowId: readWindowIdFromHash(),
  helloId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  pendingPanelsSync: new Map(),
  lastPanelsForChrome: null,
  colorStamp: null,
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

/** Writes one workspace's panels/sync to chrome as a BENTO_PANELS title.
 * Callers have already decided the event belongs to this window's active
 * workspace. The payload embeds settings and the workspace theme, so an event
 * written before they hydrated stays pending for one re-forward. */
function forwardPanelsToChrome(event: PanelsSyncEvent): void {
  const wsState = useWorkspacesStore.getState();
  const payload: {
    workspaceId: string;
    panels: typeof event.panels;
    windowId?: number;
    themeId?: string;
    mainWidthPx?: number;
    defaultPanelWidthPx?: number;
    uiColorMode?: string;
    uiColorModeStamp?: ColorStamp;
    sidebarCollapsed?: boolean;
    sidebarHidden?: boolean;
    sidebarShortcutBehavior?: SidebarShortcutBehavior;
    customPanelSizes?: number[];
    panelCycleWraparound?: boolean;
    panelShadowsEnabled?: boolean;
    panelCornerRadiusPx?: number;
    panelSplitterSizePx?: number;
    stripScrollLeft?: number;
    pinnedTabIdsInWorkspace?: number[];
    savedPanelCount?: number;
    savedPanelItems?: typeof event.savedPanelItems;
    devtoolsPairs?: typeof event.devtoolsPairs;
    scrollToPanelTabId?: number;
    scrollToPanelReveal?: 'full' | 'right-edge';
    layout: typeof event.layout;
    panelStatusByTabId: typeof event.panelStatusByTabId;
  } = {
    workspaceId: event.workspaceId,
    panels: event.panels,
    layout: event.layout,
    panelStatusByTabId: event.panelStatusByTabId,
  };
  if (state.windowId !== null) {
    payload.windowId = state.windowId;
  }
  const activeWorkspace = wsState.byId[event.workspaceId];
  // This payload is the extension-to-chrome presentation hint. Keep
  // the tools event and persisted workspace id raw, but resolve
  // unknown/legacy ids before chrome applies its scoped stylesheet.
  payload.themeId = resolveThemeId(event.themeId ?? activeWorkspace?.themeId);
  if (typeof event.mainWidthPx === 'number') {
    payload.mainWidthPx = event.mainWidthPx;
  }
  if (typeof event.stripScrollLeft === 'number' && event.stripScrollLeft >= 0) {
    payload.stripScrollLeft = event.stripScrollLeft;
  }
  // Bundle chrome-bound settings into the panels payload so
  // they reach chrome via the single BENTO_PANELS title-IPC
  // channel. uiColorMode flips Mux/Bento tokens on the chrome
  // window root; sidebarCollapsed toggles the narrow-rail
  // class on #bento-shell-host; sidebarHidden and
  // sidebarShortcutBehavior drive Cmd/Ctrl+S hide/restore;
  // customPanelSizes populates
  // each side panel header's kebab "more" menu;
  // panelCornerRadiusPx sets split-view panel frame radius;
  // panelSplitterSizePx sets split-view splitter/gap size; and
  // defaultPanelWidthPx sets the main slot's default minimum
  // width. Single channel = no race with separate title
  // writes (the COLOR_MODE channel was dropped earlier for
  // this reason).
  const cur = useSettingsStore.getState().current;
  if (cur !== null && (event.themeId !== undefined || activeWorkspace !== undefined)) {
    state.pendingPanelsSync.delete(event.workspaceId);
  } else {
    state.pendingPanelsSync.set(event.workspaceId, event);
  }
  const bootUiColorMode =
    document.documentElement.getAttribute('data-bento-color-mode-pref') ??
    document.documentElement.getAttribute('data-color-mode');
  if (cur?.uiColorMode) payload.uiColorMode = cur.uiColorMode;
  else if (bootUiColorMode) payload.uiColorMode = bootUiColorMode;
  // A private window shows its own mode, never tools' saved one, so it has no scheduled flip.
  if (state.colorStamp) {
    const { run, seq } = state.colorStamp;
    payload.uiColorModeStamp = state.isPrivate ? { run, seq } : state.colorStamp;
  }
  if (typeof cur?.sidebarCollapsed === 'boolean') {
    payload.sidebarCollapsed = cur.sidebarCollapsed;
  }
  if (typeof cur?.sidebarHidden === 'boolean') {
    payload.sidebarHidden = cur.sidebarHidden;
  }
  if (cur?.sidebarShortcutBehavior === 'collapse' || cur?.sidebarShortcutBehavior === 'hide') {
    payload.sidebarShortcutBehavior = cur.sidebarShortcutBehavior;
  }
  if (Array.isArray(cur?.customPanelSizes)) {
    payload.customPanelSizes = cur.customPanelSizes;
  }
  if (typeof event.defaultPanelWidthPx === 'number') {
    payload.defaultPanelWidthPx = event.defaultPanelWidthPx;
  } else if (typeof cur?.defaultPanelWidthPx === 'number') {
    payload.defaultPanelWidthPx = cur.defaultPanelWidthPx;
  }
  if (typeof cur?.panelCycleWraparound === 'boolean') {
    payload.panelCycleWraparound = cur.panelCycleWraparound;
  }
  if (typeof cur?.panelShadowsEnabled === 'boolean') {
    payload.panelShadowsEnabled = cur.panelShadowsEnabled;
  }
  if (typeof cur?.panelCornerRadiusPx === 'number') {
    payload.panelCornerRadiusPx = cur.panelCornerRadiusPx;
  }
  if (typeof cur?.panelSplitterSizePx === 'number') {
    payload.panelSplitterSizePx = cur.panelSplitterSizePx;
  }
  // Pinned-panel set for THIS workspace (Set.has(tabId) drives
  // the chrome panel-header pin button state), per-panel audio
  // state, and the global count of bookmarks in the "Saved panels"
  // folder (chrome reads this to size the Add-panel trailer's inline
  // favicon row). These ride on this single chrome-bound channel —
  // tools is the source of truth and populates them directly on the
  // event.
  if (Array.isArray(event.pinnedTabIdsInWorkspace)) {
    payload.pinnedTabIdsInWorkspace = event.pinnedTabIdsInWorkspace;
  }
  if (typeof event.savedPanelCount === 'number') {
    payload.savedPanelCount = event.savedPanelCount;
  }
  if (Array.isArray(event.savedPanelItems)) {
    payload.savedPanelItems = event.savedPanelItems;
  }
  if (Array.isArray(event.devtoolsPairs)) {
    payload.devtoolsPairs = event.devtoolsPairs;
  }
  if (typeof event.scrollToPanelTabId === 'number') {
    payload.scrollToPanelTabId = event.scrollToPanelTabId;
    if (event.scrollToPanelReveal === 'right-edge') {
      payload.scrollToPanelReveal = 'right-edge';
    }
  }
  if (state.isPrivate) {
    const resendable = { ...event };
    delete resendable.scrollToPanelTabId;
    delete resendable.scrollToPanelReveal;
    state.lastPanelsForChrome = resendable;
  }
  const json = JSON.stringify(payload);
  // btoa needs latin1; encodeURIComponent first to handle multibyte.
  const b64 = btoa(unescape(encodeURIComponent(json)));
  sendChromeTitle(`BENTO_PANELS:${Date.now()}:${b64}`);
}

/** Forwards the pending panels/sync for this window's workspace once the
 * workspace is known, and drops the rest (other workspaces never reach
 * chrome). forwardPanelsToChrome keeps the event pending while an input is
 * still missing, so call this after every workspaces and settings update. */
function forwardPendingPanelsToChrome(): void {
  if (state.pendingPanelsSync.size === 0) return;
  const activeId = selectActiveIdForWindow(useWorkspacesStore.getState(), state.windowId);
  if (activeId === null) return;
  const pending = state.pendingPanelsSync.get(activeId);
  state.pendingPanelsSync.clear();
  if (pending) forwardPanelsToChrome(pending);
}

function ensureConnection(): void {
  if (state.bus) return;
  if (typeof BroadcastChannel === 'undefined') {
    console.warn('[bento-shell document] no BroadcastChannel — skipping');
    return;
  }

  const bus = state.isPrivate ? createRelayTransport() : createChannelTransport();
  state.bus = bus;
  if (state.isPrivate) state.localChannel = new BroadcastChannel(BUS_CHANNEL_NAME);

  bus.subscribe((data: BusDown) => {
    if (!data) return;
    if (data.kind === 'ack') {
      if (data.helloId === state.helloId) state.acknowledged = true;
      return;
    }
    if (data.kind !== 'event') return;
    // The background replays cached state per `hello`. Documents that did
    // not say hello already hold it, so only the joiner applies the replay.
    const isReplay = typeof data.replayFor === 'string';
    if (isReplay && data.replayFor !== state.helloId) return;
    const event = data.event as Event;
    switch (event.type) {
      case 'tools/booted': {
        const wasReady = state.ready;
        state.ready = true;
        // The sidebar has bento.boot from main.tsx; secondary entries also
        // connect to this bus, but do not own that startup mark.
        markToolsReady();
        notify();
        // Only a replayed boot means this document may have missed the
        // snapshots tools sends right after a live `tools/booted`, so only
        // that case asks for them. A document that already saw the live boot
        // is complete, and requests would make tools broadcast every
        // snapshot to every document again.
        if (!isReplay || wasReady) return;
        dispatch({ type: 'tabs/requestSnapshot' });
        dispatch({ type: 'workspaces/requestSnapshot' });
        dispatch({ type: 'settings/requestSnapshot' });
        dispatch({ type: 'pinnedPanels/requestSnapshot' });
        dispatch({ type: 'tabFolders/requestSnapshot' });
        dispatch({ type: 'savedPanels/requestSnapshot' });
        return;
      }
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
        forwardPendingPanelsToChrome();
        return;
      case 'workspaces/changed':
        useWorkspacesStore.getState().applyDeltas(event.deltas);
        forwardPendingPanelsToChrome();
        return;
      case 'settings/snapshot':
      case 'settings/changed': {
        const before = useSettingsStore.getState().current;
        // Before the store applies: its subscribers may build a payload.
        if (event.colorStamp)
          state.colorStamp = followColorStamp(state.colorStamp, event.colorStamp);
        useSettingsStore.getState().apply(event.settings, event.colorStamp?.flipAt);
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
        // uiColorMode — single channel, no race. The one case tools'
        // emit cannot cover is a late sidebar whose panels were forwarded
        // before its first settings snapshot; that payload is pending and
        // goes out again now.
        forwardPendingPanelsToChrome();
        // A private window's own change is the other case: it stays in the shell
        // background, so there is no tools emit to carry it to chrome.
        if (
          state.isPrivate &&
          state.lastPanelsForChrome &&
          before &&
          WINDOW_LOCAL_SETTING_KEYS.some((key) => before[key] !== event.settings[key])
        ) {
          forwardPanelsToChrome(state.lastPanelsForChrome);
        }
        return;
      }
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
          const isTargetedAtThisWindow =
            typeof event.windowId === 'number' &&
            state.windowId !== null &&
            event.windowId === state.windowId;
          if (event.workspaceId === activeId || (isTargetedAtThisWindow && activeId === null)) {
            forwardPanelsToChrome(event);
          } else if (activeId === null) {
            // This window's workspace isn't known yet (late bootstrap: the
            // cached replay beats the workspace snapshot). Hold the latest
            // sync per workspace; workspace hydration forwards the one that
            // matches. Without this the replay is dropped for good.
            state.pendingPanelsSync.set(event.workspaceId, event);
          }
        }
        return;
      }
      case 'privacy/snapshot':
        usePrivacyStore.getState().apply(event.privacy);
        return;
      case 'searchEngines/snapshot':
        useSearchEnginesStore.getState().apply(event.snapshot);
        return;
      case 'addrbar/results':
        useAddressBarStore.getState().applyResults(event.requestId, event.query, event.results);
        return;
      case 'addrbar/restoreClosedResult':
        useAddressBarStore
          .getState()
          .applyRestoreResult(event.requestId, event.sessionId, event.outcome);
        return;
      case 'panel/focusedChanged':
        if (
          typeof event.windowId === 'number' &&
          state.windowId !== null &&
          event.windowId !== state.windowId
        ) {
          return;
        }
        usePanelFocusStore.getState().apply(event.tabId);
        return;
      case 'pinnedPanels/snapshot':
        usePinnedPanelsStore.getState().applySnapshot(event.entries);
        return;
      case 'pinnedPanels/changed':
        usePinnedPanelsStore.getState().applyDeltas(event.deltas);
        return;
      case 'tabFolders/snapshot':
        useTabFoldersStore.getState().applySnapshot(event.folders);
        return;
      case 'tabFolders/changed':
        useTabFoldersStore.getState().applyDeltas(event.deltas);
        return;
      case 'savedPanels/snapshot':
        useSavedPanelsStore.getState().apply(event.items);
        return;
      case 'externalMerge/sources':
        useExternalMergeStore.getState().applySources(event, state.windowId);
        return;
      case 'externalMerge/started':
        useExternalMergeStore.getState().applyStarted(event, state.windowId);
        return;
      case 'externalMerge/progress':
        useExternalMergeStore.getState().applyProgress(event, state.windowId);
        return;
      case 'externalMerge/complete':
        useExternalMergeStore.getState().applyComplete(event, state.windowId);
        return;
      case 'externalMerge/error':
        useExternalMergeStore.getState().applyError(event, state.windowId);
        return;
      case 'pong':
        return;
      default:
        return;
    }
  });

  // Tell the background we're alive so it replays last booted + panels/sync
  // to this document only (tagged with helloId).
  if (state.isPrivate) {
    // The relay may not be up yet, so repeat the hello until it answers. The
    // background owns the private window's shell/hello (it knows the window from
    // chrome, and repeats it when tools reconnects), so none is sent from here.
    sendHelloUntilAcknowledged(
      () => bus.post({ kind: 'hello', helloId: state.helloId }),
      () => state.acknowledged,
    );
    return;
  }
  bus.post({ kind: 'hello', helloId: state.helloId });

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
  const message = { kind: 'action', action: wireAction } as const;
  if (state.localChannel && isDocumentLocalAction(action)) state.localChannel.postMessage(message);
  else state.bus?.post(message);
}
