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

interface StoredBackups {
  version: number;
  entries: Array<{ id: string; createdAt: number; data: BentoExportSchema }>;
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

  constructor(ctx: BackupContext) {
    this.#ctx = ctx;
  }

  startAutoBackup(settings: BentoSettings): void {
    this.#stopTimer();
    if (!settings.autoBackupEnabled) return;
    const ms = settings.autoBackupIntervalMinutes * 60 * 1000;
    this.#timerId = setInterval(() => {
      void this.#createAutoBackup(settings.autoBackupMaxCount);
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

    for (const ws of targetWorkspaces) {
      const wsTabs = allTabs.filter((t) => t.workspaceId === ws.id);
      const panelTabIds = new Set(this.#ctx.panels.getPanels(ws.id));
      const pinnedEntries = this.#ctx.pinnedPanels.entriesForWorkspace(ws.id);
      const pinnedTabIdSet = new Set(pinnedEntries);

      const tabs: BentoExportSchema['workspaces'][0]['tabs'] = [];
      const tabIdToUrl = new Map<number, string>();

      for (const t of wsTabs) {
        if (panelTabIds.has(t.id)) continue;
        try {
          const live = await browser.tabs.get(t.id);
          if (!live.url) continue;
          tabIdToUrl.set(t.id, live.url);
          tabs.push({
            url: live.url,
            title: t.customTitle || t.title,
            customTitle: t.customTitle,
            pinned: t.pinned,
          });
        } catch {
          // tab gone
        }
      }

      const panels: BentoExportSchema['workspaces'][0]['panels'] = [];
      for (const tabId of panelTabIds) {
        try {
          const live = await browser.tabs.get(tabId);
          if (!live.url) continue;
          tabIdToUrl.set(tabId, live.url);
          const widthPx = this.#ctx.panels.getWidth(tabId);
          const entry: { url: string; widthPx?: number } = { url: live.url };
          if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
          panels.push(entry);
        } catch {
          // tab gone
        }
      }

      const pinnedPanels: BentoExportSchema['workspaces'][0]['pinnedPanels'] = [];
      let order = 0;
      for (const tabId of pinnedTabIdSet) {
        const url = tabIdToUrl.get(tabId);
        if (url) {
          pinnedPanels.push({ url, order: order++ });
        }
      }

      workspaces.push({
        id: ws.id,
        name: ws.name,
        themeId: ws.themeId,
        icon: ws.icon,
        createdAt: ws.createdAt,
        tabs,
        panels,
        pinnedPanels,
      });
    }

    const savedPanelItems = this.#ctx.savedPanels.list();
    const savedPanels = savedPanelItems.map((sp) => ({
      title: sp.title,
      url: sp.url,
    }));

    return {
      schemaVersion: 1,
      bentoVersion: '0.0.0',
      exportedAt: Date.now(),
      workspaces,
      settings: Object.keys(overrides).length > 0 ? overrides : undefined,
      savedPanels,
    };
  }

  async listBackups(): Promise<BackupListEntry[]> {
    const stored = await this.#loadStored();
    return stored.entries.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      workspaceCount: e.data.workspaces.length,
      tabCount: e.data.workspaces.reduce((sum, ws) => sum + ws.tabs.length, 0),
    }));
  }

  async getBackupData(id: string): Promise<BentoExportSchema | null> {
    const stored = await this.#loadStored();
    const entry = stored.entries.find((e) => e.id === id);
    return entry?.data ?? null;
  }

  async deleteBackup(id: string): Promise<void> {
    const stored = await this.#loadStored();
    stored.entries = stored.entries.filter((e) => e.id !== id);
    await this.#saveStored(stored);
  }

  async #createAutoBackup(maxCount: number): Promise<void> {
    try {
      const data = await this.collectSnapshot();
      const stored = await this.#loadStored();
      stored.entries.push({
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        data,
      });
      while (stored.entries.length > maxCount) {
        stored.entries.shift();
      }
      await this.#saveStored(stored);
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

  #stopTimer(): void {
    if (this.#timerId !== null) {
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
  }
}
