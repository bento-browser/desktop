import type { BentoExportSchema, ImportOptions, ImportSummary } from '@shared/protocol';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import { migrateLegacyEntriesToPersistence } from '../panels/PanelStore';

export interface ImportContext {
  workspaces: WorkspaceStore;
  tabs: TabRegistry;
  panels: PanelStore;
  pinnedPanels: PinnedPanelsStore;
  settings: SettingsStore;
  savedPanels: SavedPanelsStore;
}

function deduplicateName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const suffixed = `${name} (imported)`;
  if (!existing.has(suffixed)) return suffixed;
  let i = 2;
  while (existing.has(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

async function removeWorkspacesAfterReplacement(
  workspaces: ReturnType<WorkspaceStore['snapshot']>['workspaces'],
  ctx: ImportContext,
): Promise<void> {
  for (const ws of workspaces) {
    const tabIds = ctx.tabs
      .snapshot()
      .filter((t) => t.workspaceId === ws.id)
      .map((t) => t.id);
    if (tabIds.length > 0) {
      try {
        await browser.tabs.remove(tabIds);
      } catch (err) {
        console.warn('[bento-tools] import: tabs.remove failed for workspace', ws.name, err);
      }
    }
    ctx.workspaces.delete(ws.id);
  }
}

export async function executeImport(
  data: BentoExportSchema,
  options: ImportOptions,
  ctx: ImportContext,
): Promise<ImportSummary> {
  const summary: ImportSummary = {
    workspacesCreated: 0,
    tabsOpened: 0,
    panelsRestored: 0,
    settingsApplied: false,
  };

  const workspacesToReplace = options.replaceExisting ? ctx.workspaces.snapshot().workspaces : [];

  const existingNames = options.replaceExisting
    ? new Set<string>()
    : new Set(ctx.workspaces.snapshot().workspaces.map((w) => w.name));
  const importedWorkspaceIds: string[] = [];

  for (const wsData of data.workspaces) {
    const name = deduplicateName(wsData.name, existingNames);
    existingNames.add(name);

    const ws = ctx.workspaces.create({ name, themeId: wsData.themeId, icon: wsData.icon }, null);
    importedWorkspaceIds.push(ws.id);
    summary.workspacesCreated++;
    if (
      typeof wsData.mainWidthPx === 'number' &&
      Number.isFinite(wsData.mainWidthPx) &&
      wsData.mainWidthPx > 0
    ) {
      ctx.panels.setMainWidth(ws.id, wsData.mainWidthPx);
    }
    if (
      typeof wsData.stripScrollLeft === 'number' &&
      Number.isFinite(wsData.stripScrollLeft) &&
      wsData.stripScrollLeft >= 0
    ) {
      ctx.panels.setStripScroll(ws.id, wsData.stripScrollLeft);
    }

    const urlToTabId = new Map<string, number>();

    for (const tabData of wsData.tabs) {
      try {
        const created = await browser.tabs.create({
          url: tabData.url,
          active: false,
          pinned: tabData.pinned,
        });
        if (typeof created.id !== 'number') continue;
        await ctx.tabs.assignWorkspace(created.id, ws.id);
        if (tabData.customTitle) {
          void ctx.tabs.rename(created.id, tabData.customTitle);
        }
        urlToTabId.set(tabData.url, created.id);
        summary.tabsOpened++;
      } catch (err) {
        console.warn('[bento-tools] import: tabs.create failed for', tabData.url, err);
      }
    }

    const importedPanelData =
      data.schemaVersion === 2 && wsData.panelLayout
        ? {
            entries: wsData.panels.map((panel, index) => ({
              panelKey: panel.panelKey || `import-panel-${index}`,
              url: panel.url,
              widthPx: panel.widthPx,
            })),
            layout: wsData.panelLayout,
          }
        : migrateLegacyEntriesToPersistence(
            wsData.panels.map((panel) => ({
              url: panel.url,
              widthPx: panel.widthPx,
              subdivision: panel.subdivision,
            })),
            ws.id,
          );

    const panelKeyToTabId = new Map<string, number>();
    const panelUrlToTabIds = new Map<string, number[]>();
    for (const panelData of importedPanelData.entries) {
      let tabId: number | undefined;
      try {
        const created = await browser.tabs.create({
          url: panelData.url,
          active: false,
        });
        if (typeof created.id !== 'number') continue;
        await ctx.tabs.assignWorkspace(created.id, ws.id);
        tabId = created.id;
        summary.tabsOpened++;
      } catch (err) {
        console.warn('[bento-tools] import: panel tabs.create failed for', panelData.url, err);
        continue;
      }
      panelKeyToTabId.set(panelData.panelKey, tabId);
      const list = panelUrlToTabIds.get(panelData.url) ?? [];
      list.push(tabId);
      panelUrlToTabIds.set(panelData.url, list);
      if (typeof panelData.widthPx === 'number' && panelData.widthPx > 0) {
        ctx.panels.setWidth(tabId, panelData.widthPx);
      }
    }
    ctx.panels.restorePersistedLayout(ws.id, importedPanelData.layout, panelKeyToTabId);
    summary.panelsRestored += panelKeyToTabId.size;

    for (const ppData of wsData.pinnedPanels) {
      let tabId =
        ppData.panelKey && panelKeyToTabId.has(ppData.panelKey)
          ? panelKeyToTabId.get(ppData.panelKey)
          : undefined;
      if (tabId === undefined && ppData.url) {
        tabId = panelUrlToTabIds.get(ppData.url)?.shift();
      }
      if (tabId !== undefined) {
        ctx.pinnedPanels.add(ws.id, tabId);
      }
    }
  }

  if (options.replaceExisting && summary.tabsOpened === 0 && importedWorkspaceIds.length > 0) {
    try {
      const created = await browser.tabs.create({ url: 'about:blank', active: false });
      if (typeof created.id === 'number') {
        await ctx.tabs.assignWorkspace(created.id, importedWorkspaceIds[0]!);
        summary.tabsOpened++;
      }
    } catch (err) {
      console.warn('[bento-tools] import: fallback tab create failed:', err);
    }
  }

  if (options.replaceExisting) {
    await removeWorkspacesAfterReplacement(workspacesToReplace, ctx);
  }

  if (options.importSettings && data.settings) {
    ctx.settings.update(data.settings);
    summary.settingsApplied = true;
  }

  if (options.importSavedPanels && data.savedPanels) {
    for (const sp of data.savedPanels) {
      void ctx.savedPanels.save(sp.url, sp.title);
    }
  }

  return summary;
}
