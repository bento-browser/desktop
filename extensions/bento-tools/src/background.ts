// Bento Tools — background entry point.
//
// Owns the persistent state: tab registry, future workspace store, future
// keyboard registry. Accepts long-lived ports from bento-shell, sends an
// initial snapshot + tools/booted Event, then streams batched deltas.

import { handle } from './messaging/protocol-handler';
import { TabRegistry } from './tabs/TabRegistry';
import { SleepPolicy } from './tabs/SleepPolicy';
import { WorkspaceStore } from './workspaces/WorkspaceStore';
import { SettingsStore } from './settings/SettingsStore';
import { PanelStore } from './panels/PanelStore';
import { KeyRegistry } from './keyboard/KeyRegistry';
import type { Action, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

console.log('[bento-tools] boot', new Date().toISOString());

const tabs = new TabRegistry();
const workspaces = new WorkspaceStore();
const settings = new SettingsStore();
const panels = new PanelStore();

// Set of currently-connected shell document ports. Tools can broadcast
// events to all of them — needed for tools-initiated UI events like
// ui/openCommandPalette (fired by the global Cmd+K shortcut). Per-port
// state-delta sends still happen inside the onConnect handler closure.
const connectedPorts = new Set<browser.runtime.Port>();
function broadcastEvent(event: Event): void {
  for (const port of connectedPorts) {
    try {
      port.postMessage(event);
    } catch (err) {
      console.warn('[bento-tools] broadcast failed:', err);
    }
  }
}

// Restore a workspace's panels from URLs persisted across the last
// shutdown. Idempotent: takePersistedUrls clears the entry on first call,
// so subsequent activations of the same workspace are no-ops.
//
// URL → tabId matching: walk the workspace's existing tabs and consume
// the first unmatched tab whose URL matches each persisted URL. For URLs
// without a matching tab (Firefox sessionstore lost it, or the URL was
// pinned only as a panel and the tab was closed at shutdown), open a new
// tab with the URL and assign it to the workspace. Either way, each URL
// becomes a tabId in the panels list.
//
// Multi-workspace restore is lazy: only the active workspace restores at
// boot. Inactive workspaces restore on first activation (see
// workspaces.onDeltas handler). A profile with 20 workspaces × 5 panels
// each shouldn't pay the URL→tab matching cost up front.
async function restorePanelsForWorkspace(workspaceId: string): Promise<void> {
  const urls = panels.takePersistedUrls(workspaceId);
  if (!urls || urls.length === 0) return;
  // Tabs eligible for matching: this workspace's existing tabs.
  const wsTabs = tabs.snapshot().filter((t) => t.workspaceId === workspaceId);
  // Need the URL too. TabSnapshot omits it (perf §6.5) so re-fetch via
  // browser.tabs.get for the candidates only.
  const tabUrls = new Map<number, string>();
  for (const t of wsTabs) {
    try {
      const live = await browser.tabs.get(t.id);
      if (live.url) tabUrls.set(t.id, live.url);
    } catch {
      /* tab gone */
    }
  }
  const consumed = new Set<number>();
  for (const url of urls) {
    let matchedId: number | null = null;
    for (const t of wsTabs) {
      if (consumed.has(t.id)) continue;
      if (tabUrls.get(t.id) === url) {
        matchedId = t.id;
        consumed.add(t.id);
        break;
      }
    }
    if (matchedId === null) {
      // No existing tab — open one. active:false so panel restoration
      // doesn't yank focus from the user's current tab.
      try {
        const created = await browser.tabs.create({ url, active: false });
        if (typeof created.id === 'number') {
          matchedId = created.id;
          // The onCreated handler in this file auto-assigns to the
          // CURRENT active workspace. If we're restoring a non-active
          // workspace (lazy path), that's wrong — assign explicitly.
          await tabs.assignWorkspace(matchedId, workspaceId);
        }
      } catch (err) {
        console.warn('[bento-tools] panel restore: tabs.create failed for', url, err);
      }
    }
    if (matchedId !== null) panels.add(workspaceId, matchedId);
  }
  // Broadcast even when this workspace isn't currently active —
  // emitPanelsSync gates on activeId so the call is cheap. When the
  // workspace IS active (boot path or just-activated lazy path),
  // chrome reconciles the panel strip.
  void emitPanelsSync(workspaceId);
}

// Resolve a workspace's panel tabIds to {tabId, url} entries and broadcast
// to all connected shells. Each shell forwards the snapshot to chrome via
// title-IPC; chrome reconciles its panel strip. Only the ACTIVE workspace's
// panels render — emitting for an inactive workspace is wasted work.
async function emitPanelsSync(workspaceId: string): Promise<void> {
  // No active-workspace gate. Sidebar's tab-list filter
  // (useWorkspaceTabIds) needs panel ids for EVERY workspace so the
  // workspace-switch slide animation can render the new pane with
  // the correct panel filter from frame 1, not after panels/sync
  // arrives a frame later. Chrome's title-IPC forward in
  // useToolsPort gates on activeId so only the active workspace's
  // panels reach the chrome reconciler.
  const tabIds = panels.getPanels(workspaceId);
  const resolved = await Promise.all(
    tabIds.map((id) =>
      browser.tabs
        .get(id)
        .then((tab) => ({
          tabId: id,
          url: tab.url ?? '',
          favIconUrl: tab.favIconUrl ?? '',
        }))
        .catch(() => null),
    ),
  );
  const valid = resolved.filter(
    (p): p is { tabId: number; url: string; favIconUrl: string } => p !== null,
  );
  broadcastEvent({ type: 'panels/sync', workspaceId, panels: valid });
}

const keys = new KeyRegistry({ workspaces, broadcastEvent });
const sleep = new SleepPolicy(tabs, settings);
// Sleep depends on TabRegistry + SettingsStore being populated for its first
// sweep (Workspaces only matter if a tab has a workspaceId). Defer init
// until they're ready.
Promise.all([
  tabs.init().catch((err) => console.error('[bento-tools] TabRegistry init failed:', err)),
  workspaces.init().catch((err) => console.error('[bento-tools] WorkspaceStore init failed:', err)),
  settings.init().catch((err) => console.error('[bento-tools] SettingsStore init failed:', err)),
  panels.init().catch((err) => console.error('[bento-tools] PanelStore init failed:', err)),
]).then(async () => {
  sleep.init();
  // Backfill: any tab that hydrated WITHOUT a workspaceId (fresh profile,
  // tabs from a pre-workspaces session, or tabs Firefox restored before
  // bento-tools attached its session listener) gets assigned to the active
  // workspace. The runtime onCreated path handles future tabs via the
  // tabs.onDeltas listener below; this catches the boot-time gap that
  // listener can't see (hydrated tabs are inserted directly into the map,
  // they never emit a `created` delta).
  const wsId = workspaces.getActiveId();
  if (wsId) {
    for (const tab of tabs.snapshot()) {
      if (tab.workspaceId) continue;
      void tabs.assignWorkspace(tab.id, wsId);
    }
  }
  // Restore persisted panels for the active workspace. Inactive
  // workspaces are restored lazily on first activation (see the
  // workspaces.onDeltas handler below) so a profile with many
  // workspaces doesn't pay the URL→tab matching cost up front.
  if (wsId) await restorePanelsForWorkspace(wsId);
});
keys.init();

// Per-workspace memory of the last-focused tab. When the user switches
// away from a workspace and returns, we restore them to the tab they
// were viewing rather than always landing on wsTabs[0]. In-memory only
// — session-scoped; on browser restart the memory resets and the
// activate handler falls back to the first workspace tab.
//
// Updated on every tabs/activated delta (see the second tabs.onDeltas
// listener below). Cleared on tabs/removed for the matching id and on
// workspaces/removed for the matching workspace.
const lastActiveTabByWorkspace = new Map<string, number>();

// Tab delta orchestrator. Two responsibilities:
//   1. Auto-assign newly created tabs to the currently active workspace.
//      Existing tabs without an assignment (first-boot upgrade from a pre-
//      workspaces session) are NOT retroactively assigned here — that
//      would clobber a future "leave unassigned" semantic if we ever
//      add it. The shell can backfill on demand via tab/assignWorkspace.
//   2. When a tab is closed, remove it from any workspace's panels list
//      so closing a tab from the sidebar doesn't leave a stale panel
//      pinned to a tab that no longer exists. Re-emit panels/sync if
//      the affected workspace is active.
tabs.onDeltas((deltas) => {
  for (const d of deltas) {
    if (d.kind === 'created') {
      if (!d.tab.workspaceId) {
        const wsId = workspaces.getActiveId();
        if (wsId) void tabs.assignWorkspace(d.tab.id, wsId);
      }
      // URL-marker check moved to a dedicated browser.tabs.onCreated
      // listener (below). TabRegistry's TabSnapshot intentionally
      // omits `url` per §6.5 of the perf budget ("no url until
      // tooltip-needed"), so we can't see the marker URL from this
      // delta. The native WebExtension Tab object includes url, so
      // the separate listener has direct access.
      continue;
    }
    if (d.kind === 'removed') {
      const affected = panels.findWorkspacesContainingTab(d.id);
      if (affected.length === 0) continue;
      for (const wsId of affected) panels.remove(wsId, d.id);
      const activeId = workspaces.getActiveId();
      if (activeId && affected.includes(activeId)) {
        void emitPanelsSync(activeId);
      }
      continue;
    }
  }
});

// Per-workspace last-active tab tracker. Separate listener so the panels
// orchestrator above stays focused on its own concern. Watches activated
// + removed deltas to keep lastActiveTabByWorkspace in sync with reality:
//   - activated: record (tab.workspaceId → tab.id) for non-panel tabs.
//     Panel tabs are excluded — they're not in the sidebar tab list, so
//     the user wouldn't expect to "land back" on a panel after a
//     workspace round-trip.
//   - removed: drop any entry that pointed at the gone tab so the next
//     workspace activation falls back to wsTabs[0] instead of trying to
//     restore a tab that no longer exists.
tabs.onDeltas((deltas) => {
  for (const d of deltas) {
    if (d.kind === 'activated') {
      const tab = tabs.snapshot().find((t) => t.id === d.id);
      if (!tab || !tab.workspaceId) continue;
      if (panels.findWorkspacesContainingTab(d.id).length > 0) continue;
      lastActiveTabByWorkspace.set(tab.workspaceId, d.id);
      continue;
    }
    if (d.kind === 'removed') {
      for (const [wsId, tabId] of lastActiveTabByWorkspace) {
        if (tabId === d.id) lastActiveTabByWorkspace.delete(wsId);
      }
      continue;
    }
  }
});

// "Add panel" trailer button (bento-shell-mount.js) creates the tab at
//   about:blank?bento_add_as_panel=1&ts=<ms>
// — the URL is the marker. Chrome → bento-tools IPC has no direct
// channel, so the URL doubles as the signal. We see the marker here,
// redirect the panel browser to about:newtab, and add the tab to the
// active workspace's panel list. The active flag pulls Firefox focus
// into the new tab — chrome's reconciler then scrolls + focuses the
// matching panel browser.
//
// Listen on BOTH onCreated and onUpdated: the WebExtension API can fire
// onCreated before the URL is committed (the tab object's url is empty
// or about:blank initially), then onUpdated when the URL lands. We'd
// miss the marker if we only watched onCreated. handledTabs dedupes so
// we don't run the redirect twice if the URL is already there at
// onCreated time.
const handledAddPanelMarker = new Set<number>();

function maybeHandleAddPanelMarker(tabId: number, url: string, source: string): void {
  if (handledAddPanelMarker.has(tabId)) return;
  if (!url.includes('bento_add_as_panel=1')) return;
  handledAddPanelMarker.add(tabId);
  console.log('[bento-tools] add-as-panel marker hit via', source, '— tabId:', tabId);
  // Chrome (bento-shell-mount.js) owns the redirect of the underlying
  // tab away from the marker URL — its loadURI bypasses any
  // WebExtension API restrictions on about:newtab. The panel <browser>
  // substitutes about:newtab in createPanelElement when it sees the
  // marker URL, so the panel renders the new-tab page regardless of
  // chrome's redirect timing. Our only job here is to add the tab to
  // the active workspace's panel list and broadcast.
  const wsId = workspaces.getActiveId();
  if (!wsId) {
    console.warn('[bento-tools] add-as-panel: no active workspace, dropping');
    return;
  }
  if (panels.add(wsId, tabId)) {
    console.log('[bento-tools] add-as-panel: panels.add OK, emitting sync');
    void emitPanelsSync(wsId);
  } else {
    console.warn('[bento-tools] add-as-panel: panels.add returned false');
  }
}

browser.tabs.onCreated.addListener((tab) => {
  console.log('[bento-tools] tabs.onCreated:', tab.id, 'url=', tab.url);
  if (typeof tab.id !== 'number') return;
  maybeHandleAddPanelMarker(tab.id, tab.url ?? '', 'onCreated');
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url) {
    console.log('[bento-tools] tabs.onUpdated url change:', tabId, '→', changeInfo.url);
    maybeHandleAddPanelMarker(tabId, changeInfo.url, 'onUpdated');
  }
});

browser.tabs.onRemoved.addListener((tabId) => {
  handledAddPanelMarker.delete(tabId);
});

// Workspace activation orchestrator. Two responsibilities the WorkspaceStore
// can't shoulder alone (it has no access to TabRegistry or browser.tabs):
//   1. Tabs always belong to a workspace, and the active workspace must
//      always have a focused tab. If the activated workspace has no tabs,
//      open a fresh newtab (which the tabs.onDeltas listener above will
//      auto-assign to the now-active workspace). If it has tabs, move the
//      Firefox tab focus into one of them so the content area matches what
//      the sidebar shows.
//   2. Side panels are per-workspace. Re-broadcast panels/sync on every
//      activation so chrome reconciles its panel strip to the new active
//      workspace's panels (could be empty, could be many — chrome handles
//      both via the same reconciler).
// Removed-workspace cleanup keeps the panel store from leaking entries.
workspaces.onDeltas((deltas) => {
  for (const d of deltas) {
    if (d.kind === 'removed') {
      panels.removeWorkspace(d.id);
      lastActiveTabByWorkspace.delete(d.id);
      continue;
    }
    if (d.kind !== 'activated') continue;
    const wsId = d.id;

    // (1) Ensure the workspace has a tab and that tab is focused. Panel
    // tabs are excluded from candidates here — they live in their own
    // <browser> elements in the side strip, not the main panel, so
    // making one the active gBrowser tab would put its content in the
    // main panel area (where another panel browser is already showing
    // the same URL). The sidebar's tab list also excludes panels via
    // useWorkspaceTabIds, so this matches what the user sees.
    const panelTabIds = new Set(panels.getPanels(wsId));
    const wsTabs = tabs.snapshot().filter((t) => t.workspaceId === wsId && !panelTabIds.has(t.id));
    if (wsTabs.length === 0) {
      browser.tabs
        .create({ active: true })
        .catch((err) => console.warn('[bento-tools] newtab for empty workspace failed:', err));
    } else if (!wsTabs.some((t) => t.active)) {
      // Restore the tab the user was last viewing in this workspace.
      // Falls back to the first tab when memory is empty (first
      // activation this session) or the remembered tab is gone /
      // moved / now a panel — wsTabs.find returns undefined in those
      // cases so the wsTabs[0] branch fires.
      const remembered = lastActiveTabByWorkspace.get(wsId);
      const target =
        (remembered !== undefined && wsTabs.find((t) => t.id === remembered)) || wsTabs[0]!;
      browser.tabs
        .update(target.id, { active: true })
        .catch((err) => console.warn('[bento-tools] activate workspace tab failed:', err));
    }

    // (2) Lazy panel restore for inactive workspaces — runs once per
    // workspace per session. takePersistedUrls clears the entry so a
    // second activation is a no-op. restorePanelsForWorkspace also
    // emits panels/sync at the end, so we skip the explicit sync below
    // when restore actually had work to do.
    const hadPersisted = panels.workspacesWithPersistedUrls().includes(wsId);
    if (hadPersisted) {
      void restorePanelsForWorkspace(wsId);
    } else {
      // (3) Sync panels for the now-active workspace.
      void emitPanelsSync(wsId);
    }
  }
});

browser.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== SHELL_TOOLS_PORT) {
    console.warn('[bento-tools] rejecting unknown port name:', port.name);
    return;
  }
  console.log('[bento-tools] shell connected:', port.sender?.id);
  connectedPorts.add(port);

  const send = (event: Event) => {
    try {
      port.postMessage(event);
    } catch (err) {
      console.warn('[bento-tools] postMessage failed (port may be disconnected):', err);
    }
  };

  send({ type: 'tools/booted', version: '0.0.0' });
  send({ type: 'tabs/snapshot', tabs: tabs.snapshot() });
  const wsSnap = workspaces.snapshot();
  send({ type: 'workspaces/snapshot', workspaces: wsSnap.workspaces, activeId: wsSnap.activeId });
  send({ type: 'settings/snapshot', settings: settings.snapshot() });
  // Replay panels for EVERY workspace so a freshly mounted shell can
  // pre-populate its per-workspace panelsStore. Without this, the
  // sidebar tab-list filter (useWorkspaceTabIds) for non-active
  // workspaces would see an empty panel set, leaking panel tabs into
  // the sidebar during the workspace-switch slide animation until
  // the per-workspace panels/sync arrived (which only happened on
  // workspace activation). With the pre-populated store, every
  // workspace's slide pane renders with the correct filter from
  // frame 1.
  for (const ws of wsSnap.workspaces) {
    void emitPanelsSync(ws.id);
  }

  const unsubTabs = tabs.onDeltas((deltas) => {
    send({ type: 'tabs/changed', deltas });
  });
  const unsubWorkspaces = workspaces.onDeltas((deltas) => {
    send({ type: 'workspaces/changed', deltas });
  });
  const unsubSettings = settings.onChange((next) => {
    send({ type: 'settings/changed', settings: next });
  });

  port.onMessage.addListener((message: object) => {
    handle(message as Action, { tabs, workspaces, settings, panels, send, emitPanelsSync });
  });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
    unsubTabs();
    unsubWorkspaces();
    unsubSettings();
  });
});
