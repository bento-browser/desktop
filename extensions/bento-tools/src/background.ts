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
import { clearPanelMarker, readPanelMarker, setPanelMarker } from './panels/SessionMarker';
import { KeyRegistry } from './keyboard/KeyRegistry';
import type { Action, BentoSettings, Event } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

console.log('[bento-tools] boot', new Date().toISOString());

const tabs = new TabRegistry();
const workspaces = new WorkspaceStore();
const settings = new SettingsStore();
const panels = new PanelStore();

// Push contentColorMode to Firefox's prefers-color-scheme content
// override. Tracked separately from uiColorMode (which only affects
// Bento's chrome + shell) so users can keep e.g. light pages on a dark
// chrome. ColorModePref is now 'light' | 'dark' only — pass straight
// through to Firefox's overrideContentColorScheme API. Re-applied on
// every settings change so a fresh launch with persisted overrides
// reaches the right state without the user having to re-toggle.
let lastAppliedContentColorMode: BentoSettings['contentColorMode'] | null = null;
async function applyContentColorMode(mode: BentoSettings['contentColorMode']): Promise<void> {
  if (lastAppliedContentColorMode === mode) return;
  lastAppliedContentColorMode = mode;
  try {
    await browser.browserSettings.overrideContentColorScheme.set({ value: mode });
  } catch (err) {
    console.warn('[bento-tools] overrideContentColorScheme failed:', err);
  }
}

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
  const entries = panels.takePersistedEntries(workspaceId);
  if (!entries || entries.length === 0) return;
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
  for (const entry of entries) {
    const url = entry.url;
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
          await tabs.assignWorkspace(matchedId, workspaceId);
        }
      } catch (err) {
        console.warn('[bento-tools] panel restore: tabs.create failed for', url, err);
      }
    }
    if (matchedId !== null) {
      panels.add(workspaceId, matchedId);
      // Re-apply the persisted width so chrome's reconcile sees a width
      // in the panels/sync payload and applies it to the panel element.
      if (typeof entry.widthPx === 'number' && entry.widthPx > 0) {
        panels.setWidth(matchedId, entry.widthPx);
      }
    }
  }
  // Broadcast even when this workspace isn't currently active —
  // emitPanelsSync gates on activeId so the call is cheap. When the
  // workspace IS active (boot path or just-activated lazy path),
  // chrome reconciles the panel strip. Awaited so the boot path
  // doesn't return until the shell has had a chance to process the
  // broadcast — without this, downstream boot code (or onConnect's
  // bootReady await) can race ahead and the panels/sync gets dropped
  // when the addon-upgrade-mid-init kills the bg port.
  await emitPanelsSync(workspaceId);
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
        .then((tab) => {
          const widthPx = panels.getWidth(id);
          const entry: { tabId: number; url: string; favIconUrl: string; widthPx?: number } = {
            tabId: id,
            url: tab.url ?? '',
            favIconUrl: tab.favIconUrl ?? '',
          };
          if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
          return entry;
        })
        .catch(() => null),
    ),
  );
  const valid = resolved.filter(
    (p): p is { tabId: number; url: string; favIconUrl: string; widthPx?: number } => p !== null,
  );
  const mainWidthPx = panels.getMainWidth(workspaceId);
  const event: {
    type: 'panels/sync';
    workspaceId: string;
    panels: typeof valid;
    mainWidthPx?: number;
  } = {
    type: 'panels/sync',
    workspaceId,
    panels: valid,
  };
  if (typeof mainWidthPx === 'number' && mainWidthPx > 0) event.mainWidthPx = mainWidthPx;
  broadcastEvent(event);
}

const keys = new KeyRegistry({ workspaces, broadcastEvent });
const sleep = new SleepPolicy(tabs, settings);
// Sleep depends on TabRegistry + SettingsStore being populated for its first
// sweep (Workspaces only matter if a tab has a workspaceId). Defer init
// until they're ready.
//
// `bootReady` is awaited inside runtime.onConnectExternal so the initial
// snapshots sent to a freshly-connected shell reflect post-restore state
// (active workspace's panels populated, widths applied). Without this
// gate, onConnect runs immediately at module-eval time, sends an empty
// panels/sync (the in-memory store hasn't received restorePanelsForWorkspace's
// adds yet), and the shell renders the unfiltered tab list for the
// few hundred ms between that empty sync and the post-restore broadcast.
const bootReady = Promise.all([
  tabs.init().catch((err) => console.error('[bento-tools] TabRegistry init failed:', err)),
  workspaces.init().catch((err) => console.error('[bento-tools] WorkspaceStore init failed:', err)),
  settings.init().catch((err) => console.error('[bento-tools] SettingsStore init failed:', err)),
  panels.init().catch((err) => console.error('[bento-tools] PanelStore init failed:', err)),
]).then(async () => {
  sleep.init();
  // Push the persisted contentColorMode to Firefox's content
  // prefers-color-scheme override at boot. Subsequent changes flow
  // via settings.onChange below. Fire-and-forget: if the API errors
  // (rare), the user can re-toggle to retry.
  void applyContentColorMode(settings.snapshot().contentColorMode);
  let lastUiColorMode: BentoSettings['uiColorMode'] = settings.snapshot().uiColorMode;
  let lastSidebarCollapsed: BentoSettings['sidebarCollapsed'] =
    settings.snapshot().sidebarCollapsed;
  settings.onChange((next) => {
    void applyContentColorMode(next.contentColorMode);
    // Re-fire panels/sync for the active workspace whenever a
    // chrome-bound setting changes (uiColorMode, sidebarCollapsed) so
    // chrome picks up the new value via the BENTO_PANELS title (which
    // carries those fields in its payload). The shell no longer writes
    // dedicated title channels for these — they raced BENTO_PANELS via
    // document.title and the shell would lose the panels message at
    // boot. Single channel = no race.
    const colorChanged = next.uiColorMode !== lastUiColorMode;
    const collapsedChanged = next.sidebarCollapsed !== lastSidebarCollapsed;
    if (colorChanged) lastUiColorMode = next.uiColorMode;
    if (collapsedChanged) lastSidebarCollapsed = next.sidebarCollapsed;
    if (colorChanged || collapsedChanged) {
      const activeWs = workspaces.getActiveId();
      if (activeWs) void emitPanelsSync(activeWs);
    }
  });
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
  // Wait for SessionStore restoration to settle. Firefox's session
  // restore fires browser.tabs.onCreated for each restored tab AFTER
  // bento-tools' init promise resolves (browserStartupPromise resolves
  // on `sessionstore-windows-restored`, but the WINDOWS' tabs are
  // restored asynchronously after that). Without this wait, restore
  // sees an empty tabs.snapshot(), URL match fails for every persisted
  // URL, and tabs.create gets called for each — duplicating panels.
  // Settle-detect: wait for snapshot count to stop growing for ~300ms,
  // capped at 3s so a hung restore doesn't block boot indefinitely.
  await (async () => {
    let lastCount = tabs.snapshot().length;
    let stableTicks = 0;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const count = tabs.snapshot().length;
      if (count === lastCount) {
        stableTicks++;
        if (stableTicks >= 3) return;
      } else {
        stableTicks = 0;
      }
      lastCount = count;
    }
    console.warn(
      '[bento-tools] tab settlement timeout — proceeding with',
      tabs.snapshot().length,
      'tabs',
    );
  })();
  // Re-hydrate workspaceId session values for every tab. SessionStore
  // restores tabs via onCreated after our init() resolves, and the
  // WebExtension Tab object in onCreated doesn't include session
  // values — so without this, restored tabs sit in the registry with
  // workspaceId=undefined and the backfill below would clobber them
  // (assigning to active workspace, leaking Personal panel tabs into
  // a Workspace 2 boot, etc).
  await tabs.hydrateWorkspaceIds();

  // Pre-assign workspaceIds for sessionstore-restored tabs whose URL
  // matches a panel in bento.panels storage. The panel storage is a
  // second source of truth for workspace ownership: a URL stored under
  // workspace X's panel list means any live tab with that URL belongs
  // to workspace X. We do this BEFORE backfill because session values
  // can be unhydrated at boot (sessionstore's extData attaches lazily,
  // even after browserStartupPromise resolves), and a backfill that
  // ran with stale undefined workspaceIds would overwrite the real
  // session value with the active workspace — fixed before in
  // hydrateWorkspaceIds for tabs whose values had hydrated, but
  // unhydrated tabs still slip through. Walking panels storage closes
  // that gap for panel tabs (the user's primary workspace-binding
  // data); non-panel tabs still depend on session-value hydration +
  // backfill, but their cross-workspace-leak blast radius is much
  // smaller (they don't anchor a workspace's identity).
  {
    const allPanels = panels.peekAllPersistedEntries();
    const tabUrls = new Map<number, string>();
    for (const t of tabs.snapshot()) {
      if (t.workspaceId) continue; // already hydrated; respect it
      try {
        const live = await browser.tabs.get(t.id);
        if (live.url) tabUrls.set(t.id, live.url);
      } catch {
        /* tab gone */
      }
    }
    const consumed = new Set<number>();
    for (const [panelWsId, entries] of allPanels) {
      for (const entry of entries) {
        for (const [tabId, url] of tabUrls) {
          if (consumed.has(tabId)) continue;
          if (url !== entry.url) continue;
          consumed.add(tabId);
          // In-memory only — preserves any existing session value (or
          // absence). The user's explicit assignments remain canonical
          // across launches; this is just a boot-time best-guess
          // hint based on panel storage.
          tabs.setWorkspaceInMemory(tabId, panelWsId);
          break;
        }
      }
    }
  }

  // Backfill: any tab still without a workspaceId after hydration +
  // panel-URL pre-assignment gets assigned to the active workspace —
  // but ONLY in memory. Without the in-memory-only constraint, a
  // sessions API hiccup (extData not yet fully attached for a
  // session-restored tab) would have hydrate return undefined,
  // backfill would write the active workspace to sessions, and the
  // tab's original workspace assignment would be permanently
  // overwritten. With the in-memory variant, the original session
  // value is preserved across launches — the next launch's hydrate
  // gets another chance to pick it up correctly.
  if (wsId) {
    for (const tab of tabs.snapshot()) {
      if (tab.workspaceId) continue;
      tabs.setWorkspaceInMemory(tab.id, wsId);
    }
  }
  // Ensure Firefox's selectedTab belongs to the active workspace.
  // SessionStore restores whichever tab was last selected at shutdown,
  // which may be in a workspace OTHER than the one bento-tools considers
  // active. MUST happen BEFORE restorePanelsForWorkspace below: tabs.update
  // triggers TabSelect in chrome, which kicks chrome's reconciler with the
  // current __lastPanelsPayload (empty at boot, since no panels/sync has
  // arrived yet). If we did this AFTER restore, the TabSelect reconcile
  // would race against the in-flight panels/sync from restore's
  // emitPanelsSync — chrome's poll might miss the title or the addon
  // restart-mid-init (version bump) drops the broadcast, leaving chrome
  // showing main-only. Doing it FIRST guarantees the late panels/sync
  // overwrites the empty initial reconcile correctly.
  //
  // wsTabs filter excludes panel tabs (panels live in their own slots;
  // mainTab should be a sidebar tab). At this point in boot, panels.add
  // hasn't fired yet so getPanels returns []; the filter falls back to
  // any non-panel tab in the workspace.
  if (wsId) {
    const panelTabIds = new Set(panels.getPanels(wsId));
    const wsTabs = tabs.snapshot().filter((t) => t.workspaceId === wsId && !panelTabIds.has(t.id));
    if (wsTabs.length > 0 && !wsTabs.some((t) => t.active)) {
      const target = wsTabs[0]!;
      try {
        await browser.tabs.update(target.id, { active: true });
      } catch (err) {
        console.warn('[bento-tools] activate workspace tab at boot failed:', err);
      }
    }
  }

  // Restore persisted panels for the active workspace. Inactive
  // workspaces are restored lazily on first activation (see the
  // workspaces.onDeltas handler below) so a profile with many
  // workspaces doesn't pay the URL→tab matching cost up front.
  if (wsId) await restorePanelsForWorkspace(wsId);

  // Sweep stale `bento.isPanel` markers on session-restored tabs. The
  // marker is supposed to track tabs that ARE panels (so Cmd+Shift+T
  // restoration can put a closed panel back in its slot). When a tab
  // gets demoted from panel to sidebar via panel/remove the marker
  // gets cleared correctly, but session-restored tabs can end up with
  // markers that don't match the current panel list (e.g., the panel
  // URL got reassigned to a different tab on restore, or a duplicate
  // tab inherited the marker via session state). A stale marker
  // triggers the onActivated revert path below — symptom: clicking
  // a sidebar tab flickers content briefly, then snaps back. Clear
  // markers for any tab that's not in any workspace's panels list.
  try {
    const { workspaces: wss } = workspaces.snapshot();
    const allPanelTabIds = new Set<number>();
    for (const ws of wss) {
      for (const tabId of panels.getPanels(ws.id)) {
        allPanelTabIds.add(tabId);
      }
    }
    for (const tab of tabs.snapshot()) {
      if (allPanelTabIds.has(tab.id)) continue;
      const marker = await readPanelMarker(tab.id);
      if (marker) {
        console.log('[bento-tools] clearing stale panel marker on tab', tab.id);
        await clearPanelMarker(tab.id);
      }
    }
  } catch (err) {
    console.warn('[bento-tools] stale-marker sweep failed:', err);
  }
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
      // Read CURRENT in-memory state, not the delta's frozen snapshot.
      // Two paths can race:
      //   - SessionStore-restored tabs: TabRegistry.#hydrateOne is
      //     async; the workspaceId may have been set by the time this
      //     listener runs even though it wasn't in the delta.
      //   - restorePanelsForWorkspace: creates new tabs and immediately
      //     calls assignWorkspace; if its writes land before this
      //     listener, the live snapshot already has the right workspace.
      // Reading live state means we don't trample either of those.
      const live = tabs.snapshot().find((t) => t.id === d.tab.id);
      if (live && !live.workspaceId) {
        // No workspace yet. Try sessions one more time before falling
        // back to the active workspace — covers the "session value
        // hydrated mid-listener" race where the in-memory snapshot
        // hasn't been updated yet but the persistent value IS present.
        // Only writes to sessions if there's truly no value AND we
        // need to assign to active.
        void (async () => {
          const sessionWs = await browser.sessions
            .getTabValue(d.tab.id, 'bento.workspaceId')
            .catch(() => null);
          if (sessionWs && typeof sessionWs === 'string') {
            tabs.setWorkspaceInMemory(d.tab.id, sessionWs);
            return;
          }
          const wsId = workspaces.getActiveId();
          if (wsId) void tabs.assignWorkspace(d.tab.id, wsId);
        })();
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
      for (const wsId of affected) {
        panels.remove(wsId, d.id);
        // Remaining panels' indexes shifted — rewrite their markers
        // so a future Cmd+Shift+T lands at the correct slot.
        syncPanelMarkersForWorkspace(wsId);
      }
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
    syncPanelMarkersForWorkspace(wsId);
    void emitPanelsSync(wsId);
  } else {
    console.warn('[bento-tools] add-as-panel: panels.add returned false');
  }
}

// Restore a tab to its workspace's panel set after Cmd+Shift+T (Firefox
// SessionStore preserves the bento.isPanel session value across the
// close → restore round-trip; readPanelMarker pulls it back). Idempotent
// via panels.add returning false when the tabId is already present.
//
// Workspace-not-loaded edge case: if the marker references a workspace
// that no longer exists (deleted) or hasn't been loaded yet (boot path
// before WorkspaceStore.init resolves), clear the marker silently and
// skip — the user reopened the tab as a regular sidebar tab. The
// boot-path URL-based persistence in PanelStore handles cold-start
// restoration of all-workspace panel state.
// Track the last "real" (non-panel) active tab so panel tabs activated
// during Cmd+Shift+T restore can be reverted to that tab. Without this,
// SessionStore's undoCloseTab activates the restored panel tab, our
// reconciler treats it as the new mainTab, and the panel briefly
// covers the main slot until the user clicks back to a sidebar tab.
//
// Seeded at startup from browser.tabs.query because tabs.onActivated
// does NOT fire for the already-active tab at the moment our listener
// attaches — without seeding, lastActiveNonPanelTabId stays null until
// the user manually switches tabs, and Cmd+Shift+T on a fresh launch
// fails to revert.
let lastActiveNonPanelTabId: number | null = null;

void (async () => {
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof active?.id !== 'number') return;
    const marker = await readPanelMarker(active.id);
    if (!marker) {
      lastActiveNonPanelTabId = active.id;
    }
  } catch (err) {
    console.warn('[bento-tools] seed lastActiveNonPanelTabId failed:', err);
  }
})();

// Rewrite session markers for every panel in `workspaceId` with their
// current indexes. Call after any mutation that changes panel order
// (add, remove, reorder) so Cmd+Shift+T restores land in the same slot
// the panel was in WHEN IT WAS CLOSED, not the end of the list.
// Fire-and-forget per tab — the marker writes are independent and only
// matter at the next close→restore round-trip.
function syncPanelMarkersForWorkspace(workspaceId: string): void {
  const list = panels.getPanels(workspaceId);
  list.forEach((tabId, idx) => {
    void setPanelMarker(tabId, workspaceId, idx);
  });
}

async function maybeRestorePanelFromMarker(
  tabId: number,
  previousNonPanelTabId: number | null,
): Promise<void> {
  const marker = await readPanelMarker(tabId);
  if (!marker) return;
  const workspace = workspaces.snapshot().workspaces.find((w) => w.id === marker.workspaceId);
  if (!workspace) {
    void clearPanelMarker(tabId);
    return;
  }
  if (panels.insertAt(marker.workspaceId, tabId, marker.position)) {
    syncPanelMarkersForWorkspace(marker.workspaceId);
    void emitPanelsSync(marker.workspaceId);
  }
  // Cmd+Shift+T activates the restored tab. If it's a panel, revert
  // activation to the last non-panel tab so the panel lands in its side
  // slot instead of overlaying the main slot. Uses
  // `previousNonPanelTabId` captured synchronously in tabs.onCreated:
  // the concurrent tabs.onActivated handler often clobbers the
  // module-level lastActiveNonPanelTabId because SessionStore hasn't
  // restored the marker yet at activation time.
  if (previousNonPanelTabId === null || previousNonPanelTabId === tabId) {
    return;
  }
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (active?.id !== tabId) return;
    await browser.tabs.update(previousNonPanelTabId, { active: true });
  } catch (err) {
    console.warn('[bento-tools] revert from panel restore failed:', err);
  }
}

browser.tabs.onCreated.addListener((tab) => {
  console.log('[bento-tools] tabs.onCreated:', tab.id, 'url=', tab.url);
  if (typeof tab.id !== 'number') return;
  // Capture synchronously, BEFORE any await — the concurrent
  // tabs.onActivated handler awaits readPanelMarker and, on a miss,
  // overwrites lastActiveNonPanelTabId with the new (panel) tab's id.
  const previousNonPanelTabId = lastActiveNonPanelTabId;
  maybeHandleAddPanelMarker(tab.id, tab.url ?? '', 'onCreated');
  void maybeRestorePanelFromMarker(tab.id, previousNonPanelTabId);
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const marker = await readPanelMarker(tabId);
  if (!marker) {
    lastActiveNonPanelTabId = tabId;
    return;
  }
  // Backstop revert: if SessionStore restored the marker before
  // onActivated fires, this catches it. The primary revert lives in
  // maybeRestorePanelFromMarker because session values are usually
  // not yet readable here.
  if (lastActiveNonPanelTabId === null || lastActiveNonPanelTabId === tabId) {
    return;
  }
  try {
    await browser.tabs.update(lastActiveNonPanelTabId, { active: true });
  } catch (err) {
    console.warn('[bento-tools] revert panel-tab activation failed (may have been closed):', err);
    // Stale lastActiveNonPanelTabId — clear so we don't keep trying.
    lastActiveNonPanelTabId = null;
  }
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

  // Subscribe to deltas synchronously so any tab/workspace/settings
  // mutations that happen DURING the bootReady await still reach this
  // port. Delivery is buffered (each onDeltas listener is invoked in
  // emit order); without this synchronous subscribe, mutations that
  // fire between addListener and the awaited send-snapshot would race
  // and the shell would miss them.
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
    handle(message as Action, {
      tabs,
      workspaces,
      settings,
      panels,
      send,
      emitPanelsSync,
      syncPanelMarkers: syncPanelMarkersForWorkspace,
    });
  });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
    unsubTabs();
    unsubWorkspaces();
    unsubSettings();
  });

  // Wait for bento-tools' init + restore + sweep chain to complete
  // before sending the initial snapshots. Without this, on cold boot
  // the initial panels/sync reflects pre-restore state (empty for the
  // active workspace) and the shell's readiness gate flips with an
  // empty panel filter — symptom: sidebar shows the unfiltered tab
  // list for ~hundreds of ms before the post-restore panels/sync
  // arrives and the filter kicks in.
  void bootReady.then(() => {
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
    // the per-workspace panels/sync arrived. The active workspace has
    // had restorePanelsForWorkspace run by now (bootReady awaited it);
    // inactive workspaces stay lazy-restored on first activation, so
    // their sync here is the empty initial state until then.
    for (const ws of wsSnap.workspaces) {
      void emitPanelsSync(ws.id);
    }
  });
});
