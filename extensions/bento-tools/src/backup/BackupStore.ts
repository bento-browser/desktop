import type { BentoExportSchema, BackupListEntry, BentoSettings } from '@shared/protocol';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import { DEFAULT_SETTINGS } from '../settings/SettingsStore';

const STORAGE_KEY = 'bento.backups';
const STORAGE_VERSION = 1;

interface StoredBackupEntry {
  id: string;
  createdAt: number;
  data: BentoExportSchema;
  privacySafety?: 'private-filtered-v1' | string;
}

interface StoredBackups {
  version: number;
  entries: StoredBackupEntry[];
}

export interface BackupContext {
  workspaces: WorkspaceStore;
  tabs: TabRegistry;
  panels: PanelStore;
  pinnedPanels: PinnedPanelsStore;
  settings: SettingsStore;
  savedPanels: SavedPanelsStore;
}

export class BackupStore {
  #ctx: BackupContext;
  #timerId: ReturnType<typeof setTimeout> | null = null;
  #storageQueue: Promise<void> = Promise.resolve();

  constructor(ctx: BackupContext) {
    this.#ctx = ctx;
  }

  startAutoBackup(settings: BentoSettings): void {
    this.#stopTimer();
    if (!settings.autoBackupEnabled) return;
    const ms = settings.autoBackupIntervalMinutes * 60 * 1000;
    this.#timerId = setInterval(() => {
      void this.#createAutoBackup(this.#ctx.settings.snapshot().autoBackupMaxCount);
    }, ms);
  }

  onSettingsChanged(settings: BentoSettings): void {
    this.startAutoBackup(settings);
  }

  async collectSnapshot(workspaceIds?: string[]): Promise<BentoExportSchema> {
    const wsSnap = this.#ctx.workspaces.snapshot();
    const allTabs = this.#ctx.tabs.snapshot();
    const targetWorkspaces = workspaceIds
      ? wsSnap.workspaces.filter((w) => workspaceIds.includes(w.id))
      : wsSnap.workspaces;

    const settingsSnap = this.#ctx.settings.snapshot();
    const overrides: Partial<BentoSettings> = {};
    for (const key of Object.keys(settingsSnap) as Array<keyof BentoSettings>) {
      if (settingsSnap[key] !== DEFAULT_SETTINGS[key]) {
        (overrides as Record<string, unknown>)[key] = settingsSnap[key];
      }
    }

    const workspaces: BentoExportSchema['workspaces'] = [];
    const liveTabCache = new Map<number, browser.tabs.Tab | null>();
    const getEligibleLiveTab = async (tabId: number): Promise<browser.tabs.Tab | null> => {
      if (liveTabCache.has(tabId)) return liveTabCache.get(tabId) ?? null;
      try {
        const live = await browser.tabs.get(tabId);
        const eligible = live.incognito === true ? null : live;
        liveTabCache.set(tabId, eligible);
        return eligible;
      } catch {
        liveTabCache.set(tabId, null);
        return null;
      }
    };

    for (const ws of targetWorkspaces) {
      const wsTabs = allTabs.filter((t) => t.workspaceId === ws.id);
      const panelTabIds = new Set(this.#ctx.panels.getVisiblePanelIds(ws.id));
      const pinnedEntries = this.#ctx.pinnedPanels.entriesForWorkspaceDetailed(ws.id);

      const tabs: BentoExportSchema['workspaces'][0]['tabs'] = [];
      const tabIdToUrl = new Map<number, string>();

      for (const t of wsTabs) {
        if (panelTabIds.has(t.id)) continue;
        const live = await getEligibleLiveTab(t.id);
        if (!live?.url) continue;
        tabIdToUrl.set(t.id, live.url);
        tabs.push({
          url: live.url,
          title: t.customTitle || t.title,
          customTitle: t.customTitle,
          pinned: t.pinned,
        });
      }

      const panelSnapshot = await this.#ctx.panels.buildPanelPersistenceSnapshot(
        ws.id,
        async (tabId) => {
          const live = await getEligibleLiveTab(tabId);
          return live?.url || undefined;
        },
      );
      for (const entry of panelSnapshot.entries) {
        tabIdToUrl.set(entry.tabId, entry.url);
      }
      const panels: BentoExportSchema['workspaces'][0]['panels'] = panelSnapshot.entries.map(
        (entry) => {
          const panel: BentoExportSchema['workspaces'][0]['panels'][number] = {
            panelKey: entry.panelKey,
            url: entry.url,
          };
          if (typeof entry.widthPx === 'number' && entry.widthPx > 0) {
            panel.widthPx = entry.widthPx;
          }
          return panel;
        },
      );
      const panelKeyByTabId = new Map(
        panelSnapshot.entries.map((entry) => [entry.tabId, entry.panelKey]),
      );

      const pinnedPanels: BentoExportSchema['workspaces'][0]['pinnedPanels'] = [];
      for (const entry of pinnedEntries) {
        const panelKey = panelKeyByTabId.get(entry.tabId);
        const url = tabIdToUrl.get(entry.tabId);
        if (panelKey || url) {
          const pin: BentoExportSchema['workspaces'][0]['pinnedPanels'][number] = {
            panelKey,
            url,
            order: entry.order,
          };
          if (typeof entry.widthPx === 'number' && entry.widthPx > 0) {
            pin.widthPx = entry.widthPx;
          }
          pinnedPanels.push(pin);
        }
      }

      const exportedWorkspace: BentoExportSchema['workspaces'][number] = {
        id: ws.id,
        name: ws.name,
        themeId: ws.themeId,
        icon: ws.icon,
        createdAt: ws.createdAt,
        tabs,
        panels,
        panelLayout: panelSnapshot.layout,
        pinnedPanels,
      };
      const mainWidthPx = this.#ctx.panels.getMainWidth(ws.id);
      if (typeof mainWidthPx === 'number' && Number.isFinite(mainWidthPx) && mainWidthPx > 0) {
        exportedWorkspace.mainWidthPx = mainWidthPx;
      }
      const stripScrollLeft = this.#ctx.panels.getStripScroll(ws.id);
      if (
        typeof stripScrollLeft === 'number' &&
        Number.isFinite(stripScrollLeft) &&
        stripScrollLeft >= 0
      ) {
        exportedWorkspace.stripScrollLeft = stripScrollLeft;
      }
      workspaces.push(exportedWorkspace);
    }

    const savedPanelItems = this.#ctx.savedPanels.list();
    const savedPanels = savedPanelItems.map((sp) => ({
      title: sp.title,
      url: sp.url,
    }));

    return {
      schemaVersion: 2,
      bentoVersion: '0.0.0',
      exportedAt: Date.now(),
      workspaces,
      settings: Object.keys(overrides).length > 0 ? overrides : undefined,
      savedPanels,
    };
  }

  async listBackups(): Promise<BackupListEntry[]> {
    return this.#withStorageLock(async () => {
      const stored = await this.#loadStored();
      return stored.entries.map((e) => ({
        id: e.id,
        createdAt: e.createdAt,
        workspaceCount: e.data.workspaces.length,
        tabCount: e.data.workspaces.reduce((sum, ws) => sum + ws.tabs.length, 0),
        privacySafety:
          e.privacySafety === 'private-filtered-v1' ? 'private-filtered-v1' : 'legacy-unknown',
      }));
    });
  }

  async getBackupData(id: string): Promise<BentoExportSchema | null> {
    return this.#withStorageLock(async () => {
      const stored = await this.#loadStored();
      const entry = stored.entries.find((e) => e.id === id);
      return entry?.data ?? null;
    });
  }

  async deleteBackup(id: string): Promise<void> {
    await this.#withStorageLock(async () => {
      const stored = await this.#loadStored();
      stored.entries = stored.entries.filter((e) => e.id !== id);
      await this.#saveStored(stored);
    });
  }

  async #createAutoBackup(maxCount: number): Promise<void> {
    try {
      const data = await this.collectSnapshot();
      await this.#withStorageLock(async () => {
        const stored = await this.#loadStored();
        stored.entries.push({
          id: crypto.randomUUID(),
          createdAt: Date.now(),
          data,
          privacySafety: 'private-filtered-v1',
        });
        while (stored.entries.length > maxCount) {
          stored.entries.shift();
        }
        await this.#saveStored(stored);
      });
    } catch (err) {
      console.warn('[bento-tools] auto-backup failed:', err);
    }
  }

  async #loadStored(): Promise<StoredBackups> {
    try {
      const raw = (await browser.storage.local.get(STORAGE_KEY)) as Record<string, unknown>;
      const stored = raw[STORAGE_KEY] as StoredBackups | undefined;
      if (stored && typeof stored === 'object' && stored.version === STORAGE_VERSION) {
        return stored;
      }
    } catch (err) {
      console.warn('[bento-tools] backup load failed:', err);
    }
    return { version: STORAGE_VERSION, entries: [] };
  }

  async #saveStored(data: StoredBackups): Promise<void> {
    await browser.storage.local.set({ [STORAGE_KEY]: data });
  }

  #withStorageLock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#storageQueue.then(operation, operation);
    this.#storageQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #stopTimer(): void {
    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
  }
}
