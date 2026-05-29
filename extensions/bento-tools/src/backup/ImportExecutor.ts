import type { BentoExportSchema, ImportOptions, ImportSummary } from '@shared/protocol';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';

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

  if (options.replaceExisting) {
    const existing = ctx.workspaces.snapshot().workspaces;
    for (const ws of existing) {
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

  const existingNames = new Set(ctx.workspaces.snapshot().workspaces.map((w) => w.name));

  for (const wsData of data.workspaces) {
    const name = deduplicateName(wsData.name, existingNames);
    existingNames.add(name);

    const ws = ctx.workspaces.create({ name, themeId: wsData.themeId, icon: wsData.icon }, null);
    summary.workspacesCreated++;

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

    for (const panelData of wsData.panels) {
      let tabId = urlToTabId.get(panelData.url);
      if (tabId === undefined) {
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
      }
      if (ctx.panels.add(ws.id, tabId)) {
        if (typeof panelData.widthPx === 'number' && panelData.widthPx > 0) {
          ctx.panels.setWidth(tabId, panelData.widthPx);
        }
        if (panelData.subdivision && Array.isArray(panelData.subdivision.subPanelUrls)) {
          ctx.panels.subdivide(ws.id, tabId);
          const subTabIds: number[] = [];
          for (const spUrl of panelData.subdivision.subPanelUrls) {
            try {
              const spTab = await browser.tabs.create({ url: spUrl, active: false });
              if (typeof spTab.id === 'number') subTabIds.push(spTab.id);
            } catch {
              // skip sub-panel tabs that fail to restore
            }
          }
          if (subTabIds.length > 0) {
            const mode =
              panelData.subdivision.mode === 'dual' && subTabIds.length === 2
                ? ('dual' as const)
                : ('single' as const);
            ctx.panels.fillSubdivision(tabId, mode, mode === 'dual' ? subTabIds : [subTabIds[0]!]);
            if (typeof panelData.subdivision.topHeightFraction === 'number') {
              ctx.panels.setSubdivisionHeight(tabId, panelData.subdivision.topHeightFraction);
            }
            if (mode === 'dual' && typeof panelData.subdivision.splitRatio === 'number') {
              ctx.panels.setSubdivisionSplitRatio(tabId, panelData.subdivision.splitRatio);
            }
          }
        }
        summary.panelsRestored++;
      }
    }

    for (const ppData of wsData.pinnedPanels) {
      const tabId = urlToTabId.get(ppData.url);
      if (tabId !== undefined) {
        ctx.pinnedPanels.add(ws.id, tabId);
      }
    }
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
