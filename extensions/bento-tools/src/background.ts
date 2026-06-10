// Bento Tools — background entry point.
//
// Owns the persistent state: tab registry, future workspace store, future
// keyboard registry. Accepts long-lived ports from bento-shell, sends an
// initial snapshot + tools/booted Event, then streams batched deltas.

import { handle } from './messaging/protocol-handler';
import { TabRegistry } from './tabs/TabRegistry';
import type { WindowClosingTabSnapshot } from './tabs/TabRegistry';
import { SleepPolicy } from './tabs/SleepPolicy';
import { WorkspaceStore } from './workspaces/WorkspaceStore';
import { SettingsStore } from './settings/SettingsStore';
import { PanelStore } from './panels/PanelStore';
import { PinnedPanelsStore } from './pinnedPanels/PinnedPanelsStore';
import { TabFolderStore } from './tabFolders/TabFolderStore';
import { SavedPanelsStore } from './saved-panels/SavedPanelsStore';
import { BackupStore } from './backup/BackupStore';
import {
  clearPanelMarker,
  readPanelMarker,
  readPanelMarkerWithRetries,
  setPanelMarker,
} from './panels/SessionMarker';
import { KeyRegistry } from './keyboard/KeyRegistry';
import { applyPrivacyLevel, setDefaultSearchEngine } from './privacy/ProtectionLevels';
import type { BentoSettings, Event, WireAction } from '@shared/protocol';
import { SHELL_TOOLS_PORT } from '@shared/protocol';

const tabs = new TabRegistry();
const workspaces = new WorkspaceStore();
const settings = new SettingsStore();
const panels = new PanelStore();
const pinnedPanels = new PinnedPanelsStore({
  getPanelKey: (workspaceId, tabId) => panels.getPanelKey(workspaceId, tabId),
});
const tabFolders = new TabFolderStore();
const savedPanels = new SavedPanelsStore();
const backup = new BackupStore({ workspaces, tabs, panels, pinnedPanels, settings, savedPanels });

async function sweepStaleFolderIds(): Promise<void> {
  const snapshot = tabs.snapshot();
  for (const tab of snapshot) {
    if (!tab.folderId) continue;
    if (tabFolders.has(tab.folderId)) continue;
    await tabs.setFolder(tab.id, null);
  }
}

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

const PARKED_WORKSPACE_TABS_STORAGE_KEY = 'bento.parkedWorkspaceTabs';
const IMPORT_PINNED_PANEL_SESSION_KEY = 'bento.importPinnedPanel';
const SESSION_READ_RETRY_DELAY_MS = 50;

interface ParkedWorkspaceTab {
  url: string;
  title: string;
  customTitle?: string;
  pinned: boolean;
  index: number;
}

let parkedWorkspaceTabs = new Map<string, ParkedWorkspaceTab[]>();

async function readTabSessionValueWithRetries(
  tabId: number,
  key: string,
  attempts = 8,
): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    const value = await browser.sessions.getTabValue(tabId, key).catch(() => undefined);
    if (value !== undefined) return value;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_READ_RETRY_DELAY_MS));
    }
  }
  return undefined;
}

async function loadParkedWorkspaceTabs(): Promise<void> {
  try {
    const raw = (await browser.storage.local.get(PARKED_WORKSPACE_TABS_STORAGE_KEY)) as Record<
      string,
      unknown
    >;
    const stored = raw[PARKED_WORKSPACE_TABS_STORAGE_KEY];
    if (!stored || typeof stored !== 'object') return;
    const next = new Map<string, ParkedWorkspaceTab[]>();
    for (const [workspaceId, value] of Object.entries(stored as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const entries: ParkedWorkspaceTab[] = [];
      for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const tab = item as Partial<ParkedWorkspaceTab>;
        if (typeof tab.url !== 'string' || tab.url.length === 0) continue;
        entries.push({
          url: tab.url,
          title: typeof tab.title === 'string' ? tab.title : '',
          customTitle: typeof tab.customTitle === 'string' ? tab.customTitle : undefined,
          pinned: tab.pinned === true,
          index:
            typeof tab.index === 'number' && Number.isFinite(tab.index)
              ? tab.index
              : entries.length,
        });
      }
      if (entries.length > 0) next.set(workspaceId, entries);
    }
    parkedWorkspaceTabs = next;
  } catch (err) {
    console.warn('[bento-tools] parked workspace tabs load failed:', err);
  }
}

function persistParkedWorkspaceTabs(): void {
  const payload: Record<string, ParkedWorkspaceTab[]> = {};
  for (const [workspaceId, entries] of parkedWorkspaceTabs) {
    if (entries.length > 0) payload[workspaceId] = entries;
  }
  const op =
    Object.keys(payload).length > 0
      ? browser.storage.local.set({ [PARKED_WORKSPACE_TABS_STORAGE_KEY]: payload })
      : browser.storage.local.remove(PARKED_WORKSPACE_TABS_STORAGE_KEY);
  void op.catch((err) => console.warn('[bento-tools] parked workspace tabs save failed:', err));
}

function takeParkedWorkspaceTabs(workspaceId: string): ParkedWorkspaceTab[] {
  const entries = parkedWorkspaceTabs.get(workspaceId) ?? [];
  if (entries.length > 0) {
    parkedWorkspaceTabs.delete(workspaceId);
    persistParkedWorkspaceTabs();
  }
  return entries;
}

function parkTabsForClosingWindow(windowId: number, closingTabs: WindowClosingTabSnapshot[]): void {
  const byWorkspace = new Map<string, WindowClosingTabSnapshot[]>();
  for (const tab of closingTabs) {
    if (!tab.workspaceId) continue;
    const existing = byWorkspace.get(tab.workspaceId) ?? [];
    existing.push(tab);
    byWorkspace.set(tab.workspaceId, existing);
  }

  for (const [workspaceId, workspaceTabs] of byWorkspace) {
    const urlByTabId = new Map<number, string>();
    for (const tab of workspaceTabs) {
      if (tab.url) urlByTabId.set(tab.id, tab.url);
    }

    const panelTabIds = new Set(panels.getPanels(workspaceId));
    const parkedPanels = panels.parkWorkspaceWithResolvedUrls(workspaceId, (tabId) =>
      urlByTabId.get(tabId),
    );
    const sidebarTabs = workspaceTabs
      .filter((tab) => !panelTabIds.has(tab.id) && tab.url && tab.url !== 'about:blank')
      .sort((a, b) => a.index - b.index)
      .map((tab) => ({
        url: tab.url!,
        title: tab.title,
        customTitle: tab.customTitle,
        pinned: tab.pinned,
        index: tab.index,
      }));

    const hadParkedSidebarTabs = parkedWorkspaceTabs.has(workspaceId);
    if (sidebarTabs.length > 0) {
      parkedWorkspaceTabs.set(workspaceId, sidebarTabs);
    } else {
      parkedWorkspaceTabs.delete(workspaceId);
    }
    if (sidebarTabs.length > 0 || parkedPanels || hadParkedSidebarTabs)
      persistParkedWorkspaceTabs();
  }

  workspaces.forgetWindow(windowId);
}

async function restoreParkedTabsForWorkspace(
  workspaceId: string,
  targetWindowId: number | null,
): Promise<boolean> {
  const parked = takeParkedWorkspaceTabs(workspaceId).sort((a, b) => a.index - b.index);
  if (parked.length === 0) return false;

  const existingUrlByTabId = new Map<number, string>();
  const existingTabs = tabs
    .snapshot()
    .filter(
      (tab) =>
        tab.workspaceId === workspaceId &&
        (targetWindowId === null || tab.windowId === targetWindowId),
    )
    .sort((a, b) => a.index - b.index);

  for (const tab of existingTabs) {
    try {
      const live = await browser.tabs.get(tab.id);
      const pendingUrl =
        typeof (live as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
          ? (live as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl
          : undefined;
      const url = live.url && live.url !== 'about:blank' ? live.url : pendingUrl;
      if (url && url !== 'about:blank') existingUrlByTabId.set(tab.id, url);
    } catch {
      // Stale registry entries are expected during startup/session restore.
    }
  }

  const consumedExistingTabIds = new Set<number>();
  let restored = false;
  for (let index = 0; index < parked.length; index++) {
    const entry = parked[index]!;
    let existingTabId: number | null = null;
    for (const [tabId, url] of existingUrlByTabId) {
      if (consumedExistingTabIds.has(tabId)) continue;
      if (url !== entry.url) continue;
      existingTabId = tabId;
      consumedExistingTabIds.add(tabId);
      break;
    }
    if (existingTabId !== null) {
      try {
        if (index === 0 || entry.pinned) {
          await browser.tabs.update(existingTabId, {
            ...(index === 0 ? { active: true } : {}),
            ...(entry.pinned ? { pinned: true } : {}),
          });
        }
      } catch (err) {
        console.warn('[bento-tools] parked tab session-restore match failed:', existingTabId, err);
      }
      if (entry.customTitle) {
        void tabs.rename(existingTabId, entry.customTitle);
      }
      restored = true;
      continue;
    }

    try {
      const created = await browser.tabs.create({
        url: entry.url,
        active: index === 0,
        ...(targetWindowId !== null ? { windowId: targetWindowId } : {}),
      });
      if (typeof created.id !== 'number') continue;
      tabs.assignWorkspaceEagerly(created.id, workspaceId);
      if (entry.pinned) {
        void browser.tabs.update(created.id, { pinned: true }).catch((err) => {
          console.warn('[bento-tools] parked tab pin restore failed:', created.id, err);
        });
      }
      if (entry.customTitle) {
        void tabs.rename(created.id, entry.customTitle);
      }
      restored = true;
    } catch (err) {
      console.warn('[bento-tools] parked tab restore failed:', entry.url, err);
    }
  }
  return restored;
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
async function restorePanelsForWorkspace(
  workspaceId: string,
  targetWindowId: number | null = null,
): Promise<void> {
  const persisted = panels.takePersistedWorkspace(workspaceId);
  const entries = persisted?.entries;
  if (!persisted || !entries || entries.length === 0) {
    // No panels to restore, but the workspace might still have pending
    // pinned-panel entries waiting. Drop those — the panels they
    // depended on are gone (no persistence), so the pins can't bind.
    pinnedPanels.recoverTabIdsAfterPanelRestore(workspaceId, new Map());
    return;
  }
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
  // URL → tabId map for the pinned-panel restorer below. Built up as
  // each persisted panel entry is reconciled, so a pin whose URL
  // matches a panel created mid-restore (no existing tab — see
  // tabs.create branch) also rebinds correctly.
  const urlToTabId = new Map<string, number>();
  const panelKeyToTabId = new Map<string, number>();
  const consumed = new Set<number>();

  const restoreTabForUrl = async (url: string): Promise<number | null> => {
    for (const t of wsTabs) {
      if (consumed.has(t.id)) continue;
      if (tabUrls.get(t.id) === url) {
        consumed.add(t.id);
        return t.id;
      }
    }

    // No existing tab — open one. active:false so panel restoration
    // doesn't yank focus from the user's current tab.
    try {
      const created = await browser.tabs.create({
        url,
        active: false,
        ...(targetWindowId !== null ? { windowId: targetWindowId } : {}),
      });
      if (typeof created.id === 'number') {
        await tabs.assignWorkspace(created.id, workspaceId);
        return created.id;
      }
    } catch (err) {
      console.warn('[bento-tools] panel restore: tabs.create failed for', url, err);
    }
    return null;
  };

  for (const entry of entries) {
    const url = entry.url;
    const matchedId = await restoreTabForUrl(url);
    if (matchedId !== null) {
      panelKeyToTabId.set(entry.panelKey, matchedId);
      urlToTabId.set(url, matchedId);
      // Re-apply the persisted width so chrome's reconcile sees a width
      // in the panels/sync payload and applies it to the panel element.
      if (typeof entry.widthPx === 'number' && entry.widthPx > 0) {
        panels.setWidth(matchedId, entry.widthPx);
      }
      if (entry.headerHidden === true) {
        panels.setHeaderHidden(matchedId, true);
      }
    }
  }
  panels.restorePersistedLayout(workspaceId, persisted.layout, panelKeyToTabId);
  // Restore pinned-panel bindings for this workspace now that we know
  // which URLs map to which live tabIds. Pins whose URL doesn't match
  // any restored panel are dropped — the panel they referred to is
  // gone, so there's nothing to pin.
  pinnedPanels.recoverTabIdsAfterPanelRestore(workspaceId, { panelKeyToTabId, urlToTabId });
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

async function restorePanelsFromSessionMarkersAtBoot(): Promise<Set<string>> {
  const restoredWorkspaceIds = new Set<string>();
  const candidateTabs = tabs
    .snapshot()
    .filter(
      (tab) => !tabs.isClosing(tab.id) && panels.findWorkspacesContainingTab(tab.id).length === 0,
    );
  const markedTabs = await readPanelMarkersForTabsWithRetries(candidateTabs);

  markedTabs.sort((a, b) => {
    const byWorkspace = a.marker.workspaceId.localeCompare(b.marker.workspaceId);
    if (byWorkspace) return byWorkspace;
    const byRootIndex = a.marker.rootIndex - b.marker.rootIndex;
    if (byRootIndex) return byRootIndex;
    return a.tab.index - b.tab.index;
  });

  for (const { tab, marker } of markedTabs) {
    const restoredTab = await browser.tabs.get(tab.id).catch(() => null);
    const restoredWindowId =
      typeof restoredTab?.windowId === 'number' && restoredTab.windowId >= 0
        ? restoredTab.windowId
        : null;
    if (!workspaces.has(marker.workspaceId)) {
      await workspaces
        .adoptImportedWorkspacesFromSession(restoredWindowId)
        .catch((err) => console.warn('[bento-tools] imported workspace adoption failed:', err));
    }
    const workspace = workspaces.snapshot().workspaces.find((w) => w.id === marker.workspaceId);
    if (!workspace) {
      void clearPanelMarker(tab.id);
      continue;
    }

    tabs.assignWorkspaceEagerly(tab.id, marker.workspaceId);
    const alreadyPanel = panels.findWorkspacesContainingTab(tab.id).includes(marker.workspaceId);
    const inserted =
      alreadyPanel || panels.insertAtRestoreLocation(marker.workspaceId, tab.id, marker);
    if (!inserted) continue;

    const defaultWidth = settings.snapshot().defaultPanelWidthPx;
    if (!alreadyPanel && defaultWidth > 0) {
      panels.setWidth(tab.id, defaultWidth);
    }

    const importedPinMarker = await readTabSessionValueWithRetries(
      tab.id,
      IMPORT_PINNED_PANEL_SESSION_KEY,
    );
    if (marker.pinnedPanel === true || importedPinMarker === true) {
      pinnedPanels.add(marker.workspaceId, tab.id);
    }
    if (importedPinMarker !== undefined) {
      void browser.sessions
        .removeTabValue(tab.id, IMPORT_PINNED_PANEL_SESSION_KEY)
        .catch((err) =>
          console.warn('[bento-tools] imported pinned-panel marker cleanup failed:', err),
        );
    }
    restoredWorkspaceIds.add(marker.workspaceId);
  }

  for (const workspaceId of restoredWorkspaceIds) {
    syncPanelMarkersForWorkspace(workspaceId);
    await emitPanelsSync(workspaceId);
  }

  return restoredWorkspaceIds;
}

async function readPanelMarkersForTabsWithRetries(
  candidateTabs: Array<ReturnType<TabRegistry['snapshot']>[number]>,
  attempts = 8,
): Promise<
  Array<{
    tab: ReturnType<TabRegistry['snapshot']>[number];
    marker: NonNullable<Awaited<ReturnType<typeof readPanelMarker>>>;
  }>
> {
  const remaining = new Map(candidateTabs.map((tab) => [tab.id, tab]));
  const markedTabs: Array<{
    tab: ReturnType<TabRegistry['snapshot']>[number];
    marker: NonNullable<Awaited<ReturnType<typeof readPanelMarker>>>;
  }> = [];

  for (let i = 0; i < attempts && remaining.size > 0; i++) {
    const reads = await Promise.all(
      Array.from(remaining.values()).map(async (tab) => ({
        tab,
        marker: await readPanelMarker(tab.id),
      })),
    );
    for (const { tab, marker } of reads) {
      if (!marker) continue;
      remaining.delete(tab.id);
      markedTabs.push({ tab, marker });
    }
    if (remaining.size > 0 && i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_READ_RETRY_DELAY_MS));
    }
  }

  return markedTabs;
}

// Resolve a workspace's panel tabIds to {tabId, url} entries and broadcast
// to all connected shells. Each shell forwards the snapshot to chrome via
// title-IPC; chrome reconciles its panel strip. Only the ACTIVE workspace's
// panels render — emitting for an inactive workspace is wasted work.
async function emitPanelsSync(
  workspaceId: string,
  options: { scrollToPanelTabId?: number; windowId?: number } = {},
): Promise<void> {
  // No active-workspace gate. Sidebar's tab-list filter
  // (useWorkspaceTabIds) needs panel ids for EVERY workspace so the
  // workspace-switch slide animation can render the new pane with
  // the correct panel filter from frame 1, not after panels/sync
  // arrives a frame later. Chrome's title-IPC forward in
  // useToolsPort gates on activeId so only the active workspace's
  // panels reach the chrome reconciler.
  const tabIds = panels.getVisiblePanelIds(workspaceId);
  const resolved = await Promise.all(
    tabIds.map((id) =>
      browser.tabs
        .get(id)
        .then((tab) => {
          const widthPx = panels.getWidth(id);
          const entry: {
            tabId: number;
            url: string;
            title: string;
            favIconUrl: string;
            audible: boolean;
            muted: boolean;
            widthPx?: number;
            headerHidden?: boolean;
          } = {
            tabId: id,
            url: tab.url ?? '',
            title: tab.title ?? '',
            favIconUrl: tab.favIconUrl ?? '',
            audible: tab.audible ?? false,
            muted: tab.mutedInfo?.muted ?? false,
          };
          if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
          if (panels.getHeaderHidden(id)) entry.headerHidden = true;
          return entry;
        })
        .catch(() => null),
    ),
  );
  const valid = resolved.filter(
    (
      p,
    ): p is {
      tabId: number;
      url: string;
      title: string;
      favIconUrl: string;
      audible: boolean;
      muted: boolean;
      widthPx?: number;
      headerHidden?: boolean;
    } => p !== null,
  );
  const validPanelIds = new Set(valid.map((panel) => panel.tabId));
  const missingPanelIds = tabIds.filter((id) => !validPanelIds.has(id));
  if (missingPanelIds.length > 0) {
    for (const id of missingPanelIds) {
      panels.remove(workspaceId, id);
    }
    await emitPanelsSync(workspaceId, options);
    return;
  }
  const mainWidthPx = panels.getMainWidth(workspaceId);
  const defaultPanelWidthPx = settings.snapshot().defaultPanelWidthPx;
  const stripScrollLeft = panels.getStripScroll(workspaceId);
  const themeId = workspaces.snapshot().workspaces.find((w) => w.id === workspaceId)?.themeId;
  const pinnedTabIdsInWorkspace = pinnedPanels.entriesForWorkspace(workspaceId);
  // Saved-panel count is GLOBAL (not workspace-scoped) but rides on this
  // event because chrome already polls BENTO_PANELS and needs the count
  // to size the Add-panel trailer's inline favicon row. Always include
  // when the store has initialized (zero counts matter — chrome shrinks
  // the trailer back to its base width when the user empties the folder).
  const savedPanelItems = savedPanels.list();
  const savedPanelCount = savedPanelItems.length;

  const event: {
    type: 'panels/sync';
    workspaceId: string;
    windowId?: number;
    themeId?: string;
    panels: typeof valid;
    mainWidthPx?: number;
    defaultPanelWidthPx?: number;
    stripScrollLeft?: number;
    pinnedTabIdsInWorkspace?: number[];
    savedPanelCount?: number;
    savedPanelItems?: typeof savedPanelItems;
    scrollToPanelTabId?: number;
    layout: ReturnType<typeof panels.getPanelLayoutSync>;
    panelStatusByTabId: ReturnType<typeof panels.getPanelStatusMap>;
  } = {
    type: 'panels/sync',
    workspaceId,
    themeId: themeId || 'default',
    panels: valid,
    savedPanelCount,
    savedPanelItems,
    layout: panels.getPanelLayoutSync(workspaceId),
    panelStatusByTabId: panels.getPanelStatusMap(workspaceId),
  };
  if (typeof mainWidthPx === 'number' && mainWidthPx > 0) event.mainWidthPx = mainWidthPx;
  if (typeof defaultPanelWidthPx === 'number' && defaultPanelWidthPx > 0) {
    event.defaultPanelWidthPx = Math.round(defaultPanelWidthPx);
  }
  if (typeof options.windowId === 'number' && options.windowId >= 0) {
    event.windowId = options.windowId;
  }
  if (typeof stripScrollLeft === 'number' && stripScrollLeft >= 0) {
    event.stripScrollLeft = stripScrollLeft;
  }
  if (pinnedTabIdsInWorkspace.length > 0) {
    event.pinnedTabIdsInWorkspace = pinnedTabIdsInWorkspace;
  }
  if (
    typeof options.scrollToPanelTabId === 'number' &&
    valid.some((panel) => panel.tabId === options.scrollToPanelTabId)
  ) {
    event.scrollToPanelTabId = options.scrollToPanelTabId;
  }
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
  pinnedPanels
    .init()
    .catch((err) => console.error('[bento-tools] PinnedPanelsStore init failed:', err)),
  tabFolders.init().catch((err) => console.error('[bento-tools] TabFolderStore init failed:', err)),
  savedPanels
    .init()
    .catch((err) => console.error('[bento-tools] SavedPanelsStore init failed:', err)),
  loadParkedWorkspaceTabs(),
]).then(async () => {
  sleep.init();
  // Push the persisted contentColorMode to Firefox's content
  // prefers-color-scheme override at boot. Subsequent changes flow
  // via settings.onChange below. Fire-and-forget: if the API errors
  // (rare), the user can re-toggle to retry.
  void applyContentColorMode(settings.snapshot().contentColorMode);
  if (settings.hasOverride('privacyProtectionLevel')) {
    void applyPrivacyLevel(settings.snapshot().privacyProtectionLevel).catch((err) =>
      console.warn('[bento-tools] boot privacy level apply failed:', err),
    );
  }
  if (settings.hasOverride('defaultSearchEngine')) {
    void setDefaultSearchEngine(settings.snapshot().defaultSearchEngine).catch((err) =>
      console.warn('[bento-tools] boot default search apply failed:', err),
    );
  }
  await sweepStaleFolderIds();
  let lastUiColorMode: BentoSettings['uiColorMode'] = settings.snapshot().uiColorMode;
  let lastSidebarCollapsed: BentoSettings['sidebarCollapsed'] =
    settings.snapshot().sidebarCollapsed;
  let lastCustomPanelSizesKey: string = JSON.stringify(settings.snapshot().customPanelSizes ?? []);
  let lastDefaultPanelWidthPx: BentoSettings['defaultPanelWidthPx'] =
    settings.snapshot().defaultPanelWidthPx;
  let lastPanelCycleWraparound: BentoSettings['panelCycleWraparound'] =
    settings.snapshot().panelCycleWraparound;
  let lastPanelShadowsEnabled: BentoSettings['panelShadowsEnabled'] =
    settings.snapshot().panelShadowsEnabled;
  settings.onChange((next) => {
    void applyContentColorMode(next.contentColorMode);
    // Re-fire panels/sync for every active workspace whenever a
    // chrome-bound setting changes (uiColorMode, sidebarCollapsed,
    // customPanelSizes, defaultPanelWidthPx, panelCycleWraparound,
    // panelShadowsEnabled) so chrome picks up the new value via the
    // BENTO_PANELS title (which carries those
    // fields in its payload). The shell no longer writes dedicated
    // title channels for these — they raced BENTO_PANELS via
    // document.title and the shell would lose the panels message at
    // boot. Single channel = no race.
    //
    // CRITICAL: broadcast for every workspace currently active in any
    // window, not just `getActiveId()` (which returns the GLOBAL
    // fallback). Each window's chrome only honors panels/sync whose
    // workspaceId matches THAT window's active workspace
    // (useToolsPort.ts:218). If we broadcast only the global fallback
    // (e.g. "Personal") while the user is on "Support" in their
    // current window, the chrome filter rejects the message, the
    // BENTO_PANELS title never updates, and only the sidebar (which
    // caches uiColorMode in React state) reflects the change.
    const colorChanged = next.uiColorMode !== lastUiColorMode;
    const collapsedChanged = next.sidebarCollapsed !== lastSidebarCollapsed;
    // Array compare via JSON — customPanelSizes is small (typically <8
    // numbers) so the stringify cost is negligible, and it correctly
    // detects content changes that the SettingsStore's referential
    // dirty check would also have to handle (every settings/update
    // dispatch creates a new array reference).
    const sizesKey = JSON.stringify(next.customPanelSizes ?? []);
    const sizesChanged = sizesKey !== lastCustomPanelSizesKey;
    const defaultPanelWidthChanged = next.defaultPanelWidthPx !== lastDefaultPanelWidthPx;
    const wraparoundChanged = next.panelCycleWraparound !== lastPanelCycleWraparound;
    const shadowsChanged = next.panelShadowsEnabled !== lastPanelShadowsEnabled;
    if (colorChanged) lastUiColorMode = next.uiColorMode;
    if (collapsedChanged) lastSidebarCollapsed = next.sidebarCollapsed;
    if (sizesChanged) lastCustomPanelSizesKey = sizesKey;
    if (defaultPanelWidthChanged) lastDefaultPanelWidthPx = next.defaultPanelWidthPx;
    if (wraparoundChanged) lastPanelCycleWraparound = next.panelCycleWraparound;
    if (shadowsChanged) lastPanelShadowsEnabled = next.panelShadowsEnabled;
    if (
      colorChanged ||
      collapsedChanged ||
      sizesChanged ||
      defaultPanelWidthChanged ||
      wraparoundChanged ||
      shadowsChanged
    ) {
      const targets = new Set<string>();
      const globalActive = workspaces.getActiveId();
      if (globalActive) targets.add(globalActive);
      for (const wsId of Object.values(workspaces.getActiveIdByWindow())) {
        if (wsId) targets.add(wsId);
      }
      for (const wsId of targets) void emitPanelsSync(wsId);
    }
    backup.onSettingsChanged(next);
  });
  backup.startAutoBackup(settings.snapshot());
  // Phase G.1 — restore per-window active workspace from SessionStore
  // before any backfill runs. Each window's `bento.activeWorkspaceId`
  // session value was written by WorkspaceStore.activate / assignAvailable
  // across the previous session; rehydrating it now means the downstream
  // backfill (`getActiveId(windowId)`) sees the correct per-window
  // workspace rather than the global fallback. Windows with no saved
  // value (first launch, brand-new windows mid-session) fall through
  // unchanged and pick up assignAvailable when their shell connects.
  try {
    const allWindows = await browser.windows.getAll();
    for (const win of allWindows) {
      if (typeof win.id !== 'number') continue;
      await workspaces.restoreFromSession(win.id);
    }
  } catch (err) {
    console.warn('[bento-tools] per-window workspace restore failed:', err);
  }

  // Boot-time global active workspace, used by the orchestration steps
  // below (selected-tab activation, second backfill, panel restore).
  // Pass null to getActiveId so it returns `#lastGlobalActiveId` — the
  // persisted fallback that every window falls back to before activating
  // its own per-window workspace.
  const wsId = workspaces.getActiveId(null);

  // Backfill: any tab that hydrated WITHOUT a workspaceId (fresh profile,
  // tabs from a pre-workspaces session, or tabs Firefox restored before
  // bento-tools attached its session listener) gets assigned to the active
  // workspace for ITS WINDOW. At cold boot, per-window state is empty so
  // every getActiveId(windowId) falls back to #lastGlobalActiveId — same
  // result as the pre-A.2 single-active behaviour. The per-window read
  // matters after a session has been running (windows have activated
  // their own workspaces) and the user opens an additional tab via a
  // path that bypasses the runtime onCreated listener (rare; defensive).
  for (const tab of tabs.snapshot()) {
    if (tabs.isClosing(tab.id)) continue;
    if (tab.workspaceId) continue;
    const tabWindowId = typeof tab.windowId === 'number' && tab.windowId >= 0 ? tab.windowId : null;
    const wsForTab = workspaces.getActiveId(tabWindowId);
    if (wsForTab) void tabs.assignWorkspace(tab.id, wsForTab);
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
  await tabs.closeMarkedTabs();

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
      if (tabs.isClosing(t.id)) continue;
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
      if (tabs.isClosing(tab.id)) continue;
      if (tab.workspaceId) continue;
      tabs.setWorkspaceInMemory(tab.id, wsId);
    }
  }
  // Zen import can live-restore tabs with bento.isPanel markers before
  // bento-tools has registered its tabs.onCreated listener. Promote
  // those already-present tabs into PanelStore here; otherwise the stale
  // marker sweep below would clear the markers and essentials would stay
  // as ordinary workspace tabs instead of pinned panels.
  await restorePanelsFromSessionMarkersAtBoot();
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
      await activateNonPanelTab(target.id, 'activate workspace tab at boot', target.windowId);
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
//   2. When a panel tab's title/favicon/audio state changes, re-emit
//      panels/sync for the owning workspace so chrome receives the current
//      metadata even when the layout did not change.
//   3. When a tab is closed, remove it from any workspace's panels list
//      so closing a tab from the sidebar doesn't leave a stale panel
//      pinned to a tab that no longer exists. Re-emit panels/sync if
//      the affected workspace is active.
tabs.onDeltas((deltas) => {
  const panelMetadataRefreshWorkspaces = new Set<string>();
  for (const d of deltas) {
    if (d.kind === 'created') {
      if (d.tab.folderId && !tabFolders.has(d.tab.folderId)) {
        void tabs.setFolder(d.tab.id, null);
      }
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
        //
        // Per-window assignment (phase A): the tab's `windowId` is the
        // chrome window it was created in. Use that window's per-
        // window active workspace so a Cmd+T in window A (showing
        // Personal) creates a Personal tab even when window B is on a
        // different workspace. Without this, the assignment falls back
        // to `#lastGlobalActiveId`, which is whatever the last GLOBAL
        // activation set it to — typically wrong in multi-window use.
        const sourceWindowId =
          typeof d.tab.windowId === 'number' && d.tab.windowId >= 0 ? d.tab.windowId : null;
        void (async () => {
          const panelMarker = await readPanelMarker(d.tab.id);
          if (panelMarker) {
            const markerWorkspaceExists = workspaces
              .snapshot()
              .workspaces.some((w) => w.id === panelMarker.workspaceId);
            await tabs.unmarkClosing(d.tab.id);
            if (markerWorkspaceExists) {
              return;
            }
            void clearPanelMarker(d.tab.id);
          }
          if (await tabs.isClosingOrMarked(d.tab.id)) {
            // Firefox preserves WebExtension session values through the
            // close -> Cmd+Shift+T undo-close path. Bento's close path marks
            // tabs as closing so stale live tabs can be swept at boot, but a
            // newly-created tab with that marker is the user's explicit
            // restore request. Consume the marker and let the normal
            // workspace assignment below run.
            await tabs.unmarkClosing(d.tab.id);
          }
          const sessionWs = await readTabSessionValueWithRetries(d.tab.id, 'bento.workspaceId');
          if (sessionWs && typeof sessionWs === 'string') {
            if (!workspaces.has(sessionWs)) {
              await workspaces
                .adoptImportedWorkspacesFromSession(sourceWindowId)
                .catch((err) =>
                  console.warn('[bento-tools] imported workspace adoption failed:', err),
                );
            }
            tabs.setWorkspaceInMemory(d.tab.id, sessionWs);
            return;
          }
          const wsId = workspaces.getActiveId(sourceWindowId);
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
    if (d.kind === 'updated') {
      if ('folderId' in d.changes && d.changes.folderId && !tabFolders.has(d.changes.folderId)) {
        void tabs.setFolder(d.id, null);
        continue;
      }
      if (
        'favIconUrl' in d.changes ||
        'title' in d.changes ||
        'audible' in d.changes ||
        'muted' in d.changes
      ) {
        for (const wsId of panels.findWorkspacesContainingPanelOrSubPanel(d.id)) {
          panelMetadataRefreshWorkspaces.add(wsId);
        }
      }
      continue;
    }
    if (d.kind === 'removed') {
      const affected = panels.findWorkspacesContainingTab(d.id);
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
  for (const wsId of panelMetadataRefreshWorkspaces) {
    void emitPanelsSync(wsId);
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
    if (d.kind === 'updated') {
      if (
        !('favIconUrl' in d.changes) &&
        !('title' in d.changes) &&
        !('customTitle' in d.changes)
      ) {
        continue;
      }
      const tab = tabs.snapshot().find((t) => t.id === d.id);
      if (!tab) continue;
      pinnedPanels.updateMetadataForTab(d.id, {
        title: tab.customTitle || tab.title,
        favIconUrl: tab.favIconUrl,
      });
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

// Track recently removed panel tab ids for restore/reconcile guards. Pins
// intentionally survive panel and tab closure; users remove pinned rail
// entries explicitly from the rail context menu.
const recentlyRemovedPanelTabIds = new Set<number>();
panels.onPanelRemoved((workspaceId, tabId) => {
  recentlyRemovedPanelTabIds.add(tabId);
  setTimeout(() => recentlyRemovedPanelTabIds.delete(tabId), 5000);
});

// Drop pins for a deleted workspace. A pin is workspace-scoped, so deleting
// the workspace removes the only context in which the pin can be restored.
workspaces.onDeltas((deltas) => {
  for (const d of deltas) {
    if (d.kind === 'removed') {
      pinnedPanels.removeForWorkspace(d.id);
      const removed = tabFolders.removeForWorkspace(d.id);
      if (removed.length > 0) {
        const removedIds = new Set(removed.map((folder) => folder.id));
        for (const tab of tabs.snapshot()) {
          if (tab.folderId && removedIds.has(tab.folderId)) void tabs.setFolder(tab.id, null);
        }
      }
    }
  }
});

// "Saved panels" folder list changes propagate two places:
//   1. Direct savedPanels/snapshot broadcast — the panel-trailer iframe
//      (and any other shell entry that mirrors the list) updates its
//      Zustand store and re-renders.
//   2. panels/sync re-emit for every active workspace — chrome's
//      BENTO_PANELS title carries the new savedPanelCount, which
//      drives the trailer's outer-vbox width. Without this, the
//      trailer doesn't grow until an unrelated workspace switch /
//      panel mutation re-fires panels/sync.
//
// Mirrors the settings.onChange wiring above: collect the set of every
// per-window active workspace plus the global fallback, then sync each.
savedPanels.onChange((items) => {
  broadcastEvent({ type: 'savedPanels/snapshot', items });
  const targets = new Set<string>();
  const globalActive = workspaces.getActiveId();
  if (globalActive) targets.add(globalActive);
  for (const wsId of Object.values(workspaces.getActiveIdByWindow())) {
    if (wsId) targets.add(wsId);
  }
  for (const wsId of targets) void emitPanelsSync(wsId);
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

function maybeHandleAddPanelMarker(
  tabId: number,
  url: string,
  source: string,
  windowId: number | null,
): void {
  if (handledAddPanelMarker.has(tabId)) return;
  if (!url.includes('bento_add_as_panel=1')) return;
  handledAddPanelMarker.add(tabId);
  void source;
  // Chrome (bento-shell-mount.js) owns the redirect of the underlying
  // tab away from the marker URL — its loadURI bypasses any
  // WebExtension API restrictions on about:newtab. The panel <browser>
  // substitutes about:newtab in createPanelElement when it sees the
  // marker URL, so the panel renders the new-tab page regardless of
  // chrome's redirect timing. Our only job here is to add the tab to
  // THAT WINDOW's active workspace's panel list and broadcast — the
  // "+" button lives in a per-window chrome strip so the panel belongs
  // to the window's own active workspace, not the global fallback.
  const wsId = workspaces.getActiveId(windowId);
  if (!wsId) {
    console.warn('[bento-tools] add-as-panel: no active workspace, dropping');
    return;
  }
  const sourceTabIdMatch = /[?&]bento_source_tab_id=([^&#]+)/.exec(url);
  const sourceTabIdRaw = sourceTabIdMatch ? decodeURIComponent(sourceTabIdMatch[1] ?? '') : '';
  let inserted = false;
  if (sourceTabIdRaw === 'main') {
    inserted = panels.insertAt(wsId, tabId, 0);
  } else if (sourceTabIdRaw) {
    const sourceTabId = Number(sourceTabIdRaw);
    inserted = insertPanelAfterSource(wsId, tabId, sourceTabId);
  } else {
    inserted = insertPanelAtEnd(wsId, tabId);
  }
  if (inserted) {
    tabs.assignWorkspaceEagerly(tabId, wsId);
    // Stamp the configured default width so the new panel renders at
    // the user's preferred size on first paint instead of Firefox's
    // flex default (--bento-panel-min-width = 380px). The setting is
    // mirrored in PanelStore via setWidth so it persists alongside
    // any later drag-resize.
    const defaultWidth = settings.snapshot().defaultPanelWidthPx;
    if (defaultWidth > 0) panels.setWidth(tabId, defaultWidth);
    syncPanelMarkersForWorkspace(wsId);
    void emitPanelsSync(wsId, { scrollToPanelTabId: tabId });
  } else {
    console.warn('[bento-tools] add-as-panel: panel insert returned false');
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

function isPanelOrSubPanelTabId(tabId: number): boolean {
  return panels.findWorkspacesContainingPanelOrSubPanel(tabId).length > 0;
}

async function activateNonPanelTab(
  tabId: number,
  label: string,
  windowId?: number,
): Promise<boolean> {
  if (!Number.isFinite(tabId)) return false;
  if (tabs.isClosing(tabId)) return false;
  if (isPanelOrSubPanelTabId(tabId)) return false;
  const snap = tabs.snapshot().find((candidate) => candidate.id === tabId);
  if (!snap) return false;
  if (typeof windowId === 'number' && snap.windowId !== windowId) return false;
  try {
    await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    return true;
  } catch (err) {
    console.warn(`[bento-tools] ${label} failed:`, err);
    return false;
  }
}

function rememberLastActiveNonPanelTab(tabId: number): void {
  if (!Number.isFinite(tabId)) return;
  if (tabs.isClosing(tabId)) return;
  if (isPanelOrSubPanelTabId(tabId)) return;
  lastActiveNonPanelTabId = tabId;
}

void (async () => {
  try {
    const [active] = await browser.tabs.query({ active: true, currentWindow: true });
    if (typeof active?.id !== 'number') return;
    const marker = await readPanelMarker(active.id);
    if (!marker) {
      rememberLastActiveNonPanelTab(active.id);
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
  const list = panels.getVisiblePanelIds(workspaceId);
  for (const tabId of list) {
    const location = panels.getPanelRestoreLocation(workspaceId, tabId);
    void setPanelMarker(tabId, workspaceId, location);
  }
}

function panelInsertLocationAfterSource(workspaceId: string, sourceTabId: number | null) {
  if (sourceTabId === null) return { rootIndex: 0 };
  if (!Number.isFinite(sourceTabId)) {
    return { rootIndex: panels.getRootNodeIds(workspaceId).length };
  }
  return panels.getPanelRestoreLocation(workspaceId, sourceTabId);
}

function insertPanelAfterSource(workspaceId: string, tabId: number, sourceTabId: number | null) {
  const location = panelInsertLocationAfterSource(workspaceId, sourceTabId);
  if (sourceTabId === null) return panels.insertAt(workspaceId, tabId, 0);
  return panels.insertAtRestoreLocation(workspaceId, tabId, location);
}

function insertPanelAtEnd(workspaceId: string, tabId: number) {
  return panels.insertAt(workspaceId, tabId, panels.getRootNodeIds(workspaceId).length);
}

function findNonPanelTabForWorkspace(
  workspaceId: string,
  excludeTabId: number,
  windowId?: number,
): number | null {
  const panelTabIds = new Set(panels.getPanels(workspaceId));
  const candidate = tabs.snapshot().find((tab) => {
    if (tab.id === excludeTabId) return false;
    if (tab.workspaceId !== workspaceId) return false;
    if (panelTabIds.has(tab.id)) return false;
    if (typeof windowId === 'number' && tab.windowId !== windowId) return false;
    return true;
  });
  return candidate?.id ?? null;
}

async function maybeRestorePanelFromMarker(
  tabId: number,
  previousNonPanelTabId: number | null,
): Promise<void> {
  const marker = await readPanelMarkerWithRetries(tabId);
  if (!marker) return;
  const restoredTab = await browser.tabs.get(tabId).catch(() => null);
  const restoredWindowId =
    typeof restoredTab?.windowId === 'number' && restoredTab.windowId >= 0
      ? restoredTab.windowId
      : null;
  if (!workspaces.has(marker.workspaceId)) {
    await workspaces
      .adoptImportedWorkspacesFromSession(restoredWindowId)
      .catch((err) => console.warn('[bento-tools] imported workspace adoption failed:', err));
  }
  const importedPinMarker = await readTabSessionValueWithRetries(
    tabId,
    IMPORT_PINNED_PANEL_SESSION_KEY,
  );
  const shouldPinImportedPanel = marker.pinnedPanel === true || importedPinMarker === true;
  await tabs.unmarkClosing(tabId);
  const workspace = workspaces.snapshot().workspaces.find((w) => w.id === marker.workspaceId);
  if (!workspace) {
    void clearPanelMarker(tabId);
    return;
  }
  tabs.assignWorkspaceEagerly(tabId, marker.workspaceId);
  const inserted = panels.insertAtRestoreLocation(marker.workspaceId, tabId, marker);
  const defaultWidth = settings.snapshot().defaultPanelWidthPx;
  if (inserted && defaultWidth > 0) {
    panels.setWidth(tabId, defaultWidth);
  }
  if (inserted) {
    if (shouldPinImportedPanel) {
      pinnedPanels.add(marker.workspaceId, tabId);
      void browser.sessions
        .removeTabValue(tabId, IMPORT_PINNED_PANEL_SESSION_KEY)
        .catch((err) =>
          console.warn('[bento-tools] imported pinned-panel marker cleanup failed:', err),
        );
    }
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
  try {
    const workspaceFallbackTabId = findNonPanelTabForWorkspace(
      marker.workspaceId,
      tabId,
      restoredWindowId ?? undefined,
    );
    const preferredFallbackTabId =
      previousNonPanelTabId !== null && previousNonPanelTabId !== tabId
        ? previousNonPanelTabId
        : workspaceFallbackTabId;
    if (preferredFallbackTabId === null || preferredFallbackTabId === tabId) return;
    const query =
      restoredWindowId !== null
        ? { active: true, windowId: restoredWindowId }
        : { active: true, currentWindow: true };
    const [active] = await browser.tabs.query(query);
    if (active?.id !== tabId) return;
    const reverted = await activateNonPanelTab(
      preferredFallbackTabId,
      'revert from panel restore',
      restoredWindowId ?? undefined,
    );
    if (
      !reverted &&
      workspaceFallbackTabId !== null &&
      workspaceFallbackTabId !== preferredFallbackTabId
    ) {
      await activateNonPanelTab(
        workspaceFallbackTabId,
        'fallback revert from panel restore',
        restoredWindowId ?? undefined,
      );
    }
  } catch (err) {
    console.warn('[bento-tools] revert from panel restore failed:', err);
  }
}

async function maybePromotePanelOpenerTab(
  tab: browser.tabs.Tab,
  previousNonPanelTabId: number | null,
): Promise<void> {
  if (typeof tab.id !== 'number') return;
  if (typeof tab.openerTabId !== 'number') return;

  const sourceWorkspaceIds = panels.findWorkspacesContainingTab(tab.openerTabId);
  if (sourceWorkspaceIds.length === 0) return;

  const windowId = typeof tab.windowId === 'number' && tab.windowId >= 0 ? tab.windowId : null;
  const activeWorkspaceId = workspaces.getActiveId(windowId);
  const workspaceId =
    activeWorkspaceId && sourceWorkspaceIds.includes(activeWorkspaceId)
      ? activeWorkspaceId
      : sourceWorkspaceIds[0];
  if (!workspaceId) return;

  if (!insertPanelAfterSource(workspaceId, tab.id, tab.openerTabId)) return;

  const defaultWidth = settings.snapshot().defaultPanelWidthPx;
  if (typeof defaultWidth === 'number' && defaultWidth > 0) {
    panels.setWidth(tab.id, defaultWidth);
  }
  syncPanelMarkersForWorkspace(workspaceId);
  void emitPanelsSync(workspaceId);

  if (previousNonPanelTabId === null || previousNonPanelTabId === tab.id) return;
  try {
    const query =
      typeof tab.windowId === 'number' && tab.windowId >= 0
        ? { active: true, windowId: tab.windowId }
        : { active: true, currentWindow: true };
    const [active] = await browser.tabs.query(query);
    if (active?.id !== tab.id) return;
    await activateNonPanelTab(
      previousNonPanelTabId,
      'revert from panel opener promotion',
      windowId ?? undefined,
    );
  } catch (err) {
    console.warn('[bento-tools] revert from panel opener promotion failed:', err);
  }
}

browser.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== 'number') return;
  // Capture synchronously, BEFORE any await — the concurrent
  // tabs.onActivated handler awaits readPanelMarker and, on a miss,
  // overwrites lastActiveNonPanelTabId with the new (panel) tab's id.
  const previousNonPanelTabId = lastActiveNonPanelTabId;
  const windowId = typeof tab.windowId === 'number' && tab.windowId >= 0 ? tab.windowId : null;
  maybeHandleAddPanelMarker(tab.id, tab.url ?? '', 'onCreated', windowId);
  void maybeRestorePanelFromMarker(tab.id, previousNonPanelTabId).then(() =>
    maybePromotePanelOpenerTab(tab, previousNonPanelTabId),
  );
});

browser.tabs.onActivated.addListener(async ({ tabId }) => {
  const marker = await readPanelMarker(tabId);
  if (!marker) {
    rememberLastActiveNonPanelTab(tabId);
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
    const reverted = await activateNonPanelTab(
      lastActiveNonPanelTabId,
      'revert panel-tab activation',
    );
    if (!reverted) lastActiveNonPanelTabId = null;
  } catch (err) {
    console.warn('[bento-tools] revert panel-tab activation failed (may have been closed):', err);
    // Stale lastActiveNonPanelTabId — clear so we don't keep trying.
    lastActiveNonPanelTabId = null;
  }
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    const windowId = typeof tab.windowId === 'number' && tab.windowId >= 0 ? tab.windowId : null;
    maybeHandleAddPanelMarker(tabId, changeInfo.url, 'onUpdated', windowId);
    if (
      changeInfo.url !== 'about:blank' &&
      panels.findWorkspacesContainingPanelOrSubPanel(tabId).length > 0
    ) {
      panels.persistCurrentState();
    }
  }
});

tabs.onWindowClosing(({ windowId, tabs: closingTabs }) => {
  parkTabsForClosingWindow(windowId, closingTabs);
});

// Release per-window workspace ownership when a chrome window closes so
// the workspace it was displaying becomes available to other windows
// (or to a future re-opened window). Without this, closing a window
// would leave its workspace permanently "taken" in
// WorkspaceStore.#activeIdByWindow — assignAvailable on the next new
// window would skip past it, and workspace/activate would forever
// route to a windowId that no longer exists (browser.windows.update
// would throw, but the activation would have been refused anyway).
browser.windows.onRemoved.addListener((windowId) => {
  workspaces.forgetWindow(windowId);
});

async function promoteLeftmostPanelToTab(workspaceId: string, tabId: number): Promise<void> {
  const originalPosition = panels.getPanels(workspaceId).indexOf(tabId);
  if (!panels.remove(workspaceId, tabId)) return;

  // Clear the panel session marker BEFORE activation. onActivated treats
  // a marked tab as a restored panel and bounces focus back to the last
  // non-panel tab; in the last-sidebar-tab-close path that fallback is
  // the tab being closed, so promotion can lose the race.
  await clearPanelMarker(tabId);
  tabs.assignWorkspaceEagerly(tabId, workspaceId);
  rememberLastActiveNonPanelTab(tabId);

  syncPanelMarkersForWorkspace(workspaceId);

  let promotedWindowId: number | undefined;
  try {
    const live = await browser.tabs.get(tabId);
    promotedWindowId =
      typeof live.windowId === 'number' && live.windowId >= 0 ? live.windowId : undefined;
    await browser.tabs.update(tabId, { active: true });
  } catch (err) {
    console.warn('[bento-tools] promote-panel activate failed:', err);
    panels.insertAt(workspaceId, tabId, originalPosition >= 0 ? originalPosition : 0);
    syncPanelMarkersForWorkspace(workspaceId);
    void emitPanelsSync(workspaceId);
    return;
  }

  void emitPanelsSync(
    workspaceId,
    promotedWindowId !== undefined ? { windowId: promotedWindowId } : undefined,
  );
}

// When the last tab in a window's ACTIVE workspace is closed, close the
// whole window — match the user's "Cmd+W until done" intent rather than
// letting Firefox's default tab-close logic auto-select an orphan tab
// from a workspace this window previously owned. Without this:
//   1. If the window has orphan tabs from a prior workspace (left
//      behind when the user switched workspace earlier), Firefox makes
//      one of them active — the user is suddenly viewing a tab whose
//      workspace isn't in the sidebar.
//   2. If gBrowser is truly empty (no orphans), Firefox closes the
//      window naturally and focus jumps to the next window — continued
//      Cmd+W eats the next window's tabs, which the user reads as
//      "Cmd+W is closing tabs in other workspaces".
// Closing the window explicitly resolves both: window goes away, focus
// jumps next time the user clicks (or via Cmd+`), and the next Cmd+W
// closes a tab in whichever window is now focused — predictable.
// An earlier iteration auto-spawned a fresh tab here; that produced an
// infinite Cmd+W spin (spawn → close → spawn) and was reverted.
//
// Use Cmd+Shift+W if you want to close the window with tabs still in
// the workspace; that path doesn't touch this handler.
browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
  // Firefox is already tearing the window down (last-tab close or
  // window-close API) — don't double-close.
  if (removeInfo.isWindowClosing) {
    return;
  }
  const windowId =
    typeof removeInfo.windowId === 'number' && removeInfo.windowId >= 0
      ? removeInfo.windowId
      : null;
  if (windowId === null) {
    return;
  }
  const activeWsId = workspaces.getActiveId(windowId);
  if (!activeWsId) {
    return;
  }
  // Filter the just-removed tab out explicitly because the
  // browser.tabs.onRemoved → TabRegistry-onRemoved propagation isn't
  // guaranteed to run before this handler.
  const panelTabIds = panels.getPanels(activeWsId);
  const panelTabIdsSet = new Set(panelTabIds);
  const remaining = tabs
    .snapshot()
    .filter(
      (t) =>
        t.id !== tabId &&
        t.windowId === windowId &&
        t.workspaceId === activeWsId &&
        !panelTabIdsSet.has(t.id),
    );
  if (remaining.length > 0) return;
  if (recentlyRemovedPanelTabIds.delete(tabId) && panelTabIds.length > 0) {
    return;
  }

  // No sidebar (non-panel) tabs left. If the workspace still has panels,
  // PROMOTE the leftmost panel into the main content slot rather than
  // closing the workspace. The promotion is a panel-store / panels/sync
  // mutation — the underlying Firefox tab keeps its docShell, so the
  // chrome reconciler relocates the existing <browser> from the
  // split-view slot to the main tabpanel without reloading the page
  // (DOM move, not a navigate). Repeated Cmd+W then chews through one
  // panel per press until the workspace is truly empty.
  if (panelTabIds.length > 0) {
    void promoteLeftmostPanelToTab(activeWsId, panelTabIds[0]!);
    return;
  }

  // Sidebar + panels both empty: delete the workspace and switch this
  // window to the next available one. "Available" = exists AND not
  // owned by another window AND not the one we're about to delete.
  // Compute the candidate FIRST so we can fall back gracefully when
  // there's nothing to switch to (no other workspace exists, or all
  // others are taken by other windows): keep the empty workspace
  // around and just close the window — a future window opening can
  // pick it up via assignAvailable and the orchestrator will spawn a
  // fresh tab on activation.
  const wsList = workspaces.snapshot().workspaces;
  const ownedByOthers = new Set(
    Object.entries(workspaces.getActiveIdByWindow())
      .filter(([k]) => Number(k) !== windowId)
      .map(([, v]) => v),
  );
  const candidate = wsList.find((w) => w.id !== activeWsId && !ownedByOthers.has(w.id));

  if (candidate) {
    // Release ownership BEFORE delete so the delete()'s own
    // "reassign every window that had this workspace" path is a no-op
    // for us. We're handling our own reassignment via the activate()
    // below to control which workspace we switch to (delete()'s
    // fallback picks first-in-insertion-order, which can collide with
    // another window's ownership).
    workspaces.forgetWindow(windowId);
    workspaces.delete(activeWsId);
    const result = workspaces.activate(candidate.id, windowId);
    if (result !== 'activated') {
      console.warn(
        '[bento-tools] post-delete activate returned',
        result,
        '— window may be left with no active workspace',
      );
    }
    return;
  }

  browser.windows
    .remove(windowId)
    .catch((err) => console.warn('[bento-tools] close-window-on-empty-workspace failed:', err));
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
async function handleWorkspaceActivation(
  wsId: string,
  targetWindowId: number | null,
): Promise<void> {
  // (0) Cross-window tab move: with the "one workspace per window"
  // invariant, a workspace's tabs (sidebar tabs AND panel tabs) follow
  // workspace ownership. When window B claims a workspace whose tabs
  // currently live in window A's gBrowser (orphans from a prior
  // workspace switch, or panels created when another window owned
  // this workspace), those tabs MUST relocate to B so the panel
  // reconciler in B can materialize <browser> elements and the user
  // can interact with them. Skipped for global activations (no
  // windowId) — those are legacy/internal and don't have a target
  // window. Filtered STRICTLY by workspaceId === wsId so other
  // workspaces' tabs that happen to share a window aren't touched.
  if (targetWindowId !== null) {
    const stray = tabs
      .snapshot()
      .filter((t) => t.workspaceId === wsId && t.windowId !== targetWindowId)
      .map((t) => t.id);
    if (stray.length > 0) {
      try {
        await browser.tabs.move(stray, { windowId: targetWindowId, index: -1 });
      } catch (err) {
        console.warn('[bento-tools] cross-window tab move failed:', err);
      }
    }
  }

  const restoredParkedTabs = await restoreParkedTabsForWorkspace(wsId, targetWindowId);

  // (1) Ensure the workspace has a tab and that tab is focused. Panel
  // tabs are excluded from candidates here — they live in their own
  // <browser> elements in the side strip, not the main panel, so
  // making one the active gBrowser tab would put its content in the
  // main panel area (where another panel browser is already showing
  // the same URL). The sidebar's tab list also excludes panels via
  // useWorkspaceTabIds, so this matches what the user sees.
  //
  // wsTabs is filtered globally (across all windows) for the legacy
  // global-activation path. For per-window activations we additionally
  // restrict to the target window — combined with the move step above,
  // every wsId tab now lives in targetWindowId, so this filter just
  // doubles as a safety check.
  const panelTabIds = new Set(panels.getPanels(wsId));
  const allWsTabs = tabs.snapshot().filter((t) => t.workspaceId === wsId && !panelTabIds.has(t.id));
  const wsTabs =
    targetWindowId !== null ? allWsTabs.filter((t) => t.windowId === targetWindowId) : allWsTabs;
  if (wsTabs.length === 0 && !restoredParkedTabs) {
    try {
      const created = await browser.tabs.create({
        active: true,
        ...(targetWindowId !== null ? { windowId: targetWindowId } : {}),
      });
      if (typeof created.id === 'number') {
        tabs.assignWorkspaceEagerly(created.id, wsId);
      }
    } catch (err) {
      console.warn('[bento-tools] newtab for empty workspace failed:', err);
    }
  } else if (wsTabs.length > 0 && !wsTabs.some((t) => t.active)) {
    // Restore the tab the user was last viewing in this workspace.
    // Falls back to the first tab when memory is empty (first
    // activation this session) or the remembered tab is gone /
    // moved / now a panel — wsTabs.find returns undefined in those
    // cases so the wsTabs[0] branch fires.
    const remembered = lastActiveTabByWorkspace.get(wsId);
    const target =
      (remembered !== undefined && wsTabs.find((t) => t.id === remembered)) || wsTabs[0]!;
    void activateNonPanelTab(target.id, 'activate workspace tab', target.windowId);
  }

  // (2) Lazy panel restore for inactive workspaces — runs once per
  // workspace per session. takePersistedUrls clears the entry so a
  // second activation is a no-op. restorePanelsForWorkspace also
  // emits panels/sync at the end, so we skip the explicit sync below
  // when restore actually had work to do.
  const hadPersisted = panels.workspacesWithPersistedUrls().includes(wsId);
  if (hadPersisted) {
    void restorePanelsForWorkspace(wsId, targetWindowId);
  } else {
    // (3) Sync panels for the now-active workspace.
    void emitPanelsSync(wsId, targetWindowId !== null ? { windowId: targetWindowId } : undefined);
  }
}

workspaces.onDeltas((deltas) => {
  for (const d of deltas) {
    if (d.kind === 'removed') {
      panels.removeWorkspace(d.id);
      lastActiveTabByWorkspace.delete(d.id);
      continue;
    }
    if (d.kind !== 'activated') continue;
    const targetWindowId = typeof d.windowId === 'number' ? d.windowId : null;
    void handleWorkspaceActivation(d.id, targetWindowId);
  }
});

browser.runtime.onConnectExternal.addListener((port) => {
  if (port.name !== SHELL_TOOLS_PORT) {
    console.warn('[bento-tools] rejecting unknown port name:', port.name);
    return;
  }
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
  const unsubPinnedPanels = pinnedPanels.onDeltas((deltas) => {
    send({ type: 'pinnedPanels/changed', deltas });
  });
  const unsubTabFolders = tabFolders.onDeltas((deltas) => {
    send({ type: 'tabFolders/changed', deltas });
  });

  port.onMessage.addListener((message: object) => {
    const wireAction = message as WireAction;
    // Extract the routing envelope's __windowId once and expose it on the
    // handler context. The shell document stamps every dispatch with the
    // WebExtension windowId of its chrome window; tools uses this to scope
    // per-window state (active workspace, panels/sync emission). Null on
    // older shell builds, on actions that fired before the document
    // resolved its windowId, or in dev-loop scenarios where the bus is
    // mocked. Handlers that need it should fall back to legacy global
    // semantics when null (no breaking change for single-window use).
    const sourceWindowId = typeof wireAction.__windowId === 'number' ? wireAction.__windowId : null;
    handle(wireAction, {
      tabs,
      workspaces,
      settings,
      panels,
      pinnedPanels,
      tabFolders,
      savedPanels,
      backup,
      send,
      emitPanelsSync,
      syncPanelMarkers: syncPanelMarkersForWorkspace,
      sourceWindowId,
    });
  });

  port.onDisconnect.addListener(() => {
    connectedPorts.delete(port);
    unsubTabs();
    unsubWorkspaces();
    unsubSettings();
    unsubPinnedPanels();
    unsubTabFolders();
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
    send({
      type: 'workspaces/snapshot',
      workspaces: wsSnap.workspaces,
      activeId: wsSnap.activeId,
      activeIdByWindow: wsSnap.activeIdByWindow,
    });
    send({ type: 'settings/snapshot', settings: settings.snapshot() });
    send({ type: 'pinnedPanels/snapshot', entries: pinnedPanels.entries() });
    send({ type: 'tabFolders/snapshot', folders: tabFolders.snapshot() });
    send({ type: 'savedPanels/snapshot', items: savedPanels.list() });
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
