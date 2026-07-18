import type { BentoExportSchema, ImportOptions, ImportSummary } from '@shared/protocol';
import type { WorkspaceStore } from '../workspaces/WorkspaceStore';
import type { TabRegistry } from '../tabs/TabRegistry';
import type { PanelStore } from '../panels/PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';
import type { SettingsStore } from '../settings/SettingsStore';
import type { SavedPanelsStore } from '../saved-panels/SavedPanelsStore';
import { migrateLegacyEntriesToPersistence } from '../panels/PanelStore';
import { PrivacyMutationService } from '../privacy/PrivacyMutationService';

export interface ImportContext {
  workspaces: WorkspaceStore;
  tabs: TabRegistry;
  panels: PanelStore;
  pinnedPanels: PinnedPanelsStore;
  settings: SettingsStore;
  savedPanels: SavedPanelsStore;
  /** The authenticated window that originated this import/restore. */
  targetWindowId: number;
  operation?: {
    plannedWorkspaceIds: string[];
    onPhase(phase: string): Promise<void>;
    onWorkspaceCreated(workspaceId: string): Promise<void>;
    onTabCreated(tabId: number): Promise<void>;
    onOldTabRemoved?(tabId: number): Promise<void>;
    onWindowMap?(mapping: Record<number, string>): Promise<void>;
  };
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
    const candidateIds = ctx.tabs
      .snapshot()
      .filter((t) => t.workspaceId === ws.id)
      .map((t) => t.id);
    const tabIds: number[] = [];
    for (const tabId of candidateIds) {
      try {
        const live = await browser.tabs.get(tabId);
        if (live.incognito !== true) tabIds.push(tabId);
      } catch {
        // A missing tab is already absent and needs no cleanup.
      }
    }
    if (tabIds.length > 0) {
      try {
        await browser.tabs.remove(tabIds);
      } catch (err) {
        console.warn('[bento-tools] import: tabs.remove failed for workspace', ws.name, err);
      }
    }
    let removalComplete = true;
    for (const tabId of tabIds) {
      try {
        await browser.tabs.get(tabId);
        removalComplete = false;
      } catch {
        await ctx.operation?.onOldTabRemoved?.(tabId);
      }
    }
    if (!removalComplete) continue;
    const removedSet = new Set(tabIds);
    const stillReferenced = ctx.tabs
      .snapshot()
      .some((tab) => tab.workspaceId === ws.id && !removedSet.has(tab.id));
    if (stillReferenced) continue;
    ctx.workspaces.delete(ws.id);
  }
}

async function requireRegularTargetWindow(windowId: number): Promise<void> {
  const target = await browser.windows.get(windowId);
  if (target.incognito === true || target.type !== 'normal') {
    throw new Error('target_window_unavailable');
  }
}

export async function executeImport(
  data: BentoExportSchema,
  options: ImportOptions,
  ctx: ImportContext,
): Promise<ImportSummary> {
  await requireRegularTargetWindow(ctx.targetWindowId);
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
  const createdTabIdsByWorkspace = new Map<string, number[]>();
  const ordinaryTabIdsByWorkspace = new Map<string, number[]>();

  await ctx.operation?.onPhase('creating-workspaces');

  for (const [workspaceOrdinal, wsData] of data.workspaces.entries()) {
    const name = deduplicateName(wsData.name, existingNames);
    existingNames.add(name);

    const ws = ctx.workspaces.create({ name, themeId: wsData.themeId, icon: wsData.icon }, null, {
      activate: false,
      id: ctx.operation?.plannedWorkspaceIds[workspaceOrdinal],
    });
    importedWorkspaceIds.push(ws.id);
    createdTabIdsByWorkspace.set(ws.id, []);
    ordinaryTabIdsByWorkspace.set(ws.id, []);
    await ctx.operation?.onWorkspaceCreated(ws.id);
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

    await ctx.operation?.onPhase('creating-tabs');
    for (const tabData of wsData.tabs) {
      try {
        const created = await browser.tabs.create({
          url: tabData.url,
          active: false,
          pinned: tabData.pinned,
          windowId: ctx.targetWindowId,
        });
        if (typeof created.id !== 'number') continue;
        await ctx.operation?.onTabCreated(created.id);
        await ctx.tabs.assignWorkspace(created.id, ws.id);
        if (tabData.customTitle) {
          await ctx.tabs.rename(created.id, tabData.customTitle);
        }
        createdTabIdsByWorkspace.get(ws.id)!.push(created.id);
        ordinaryTabIdsByWorkspace.get(ws.id)!.push(created.id);
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
          windowId: ctx.targetWindowId,
        });
        if (typeof created.id !== 'number') continue;
        await ctx.operation?.onTabCreated(created.id);
        await ctx.tabs.assignWorkspace(created.id, ws.id);
        tabId = created.id;
        createdTabIdsByWorkspace.get(ws.id)!.push(created.id);
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
        if (typeof ppData.widthPx === 'number' && ppData.widthPx > 0) {
          ctx.pinnedPanels.add(ws.id, tabId, { widthPx: Math.round(ppData.widthPx) });
        } else {
          ctx.pinnedPanels.add(ws.id, tabId);
        }
      }
    }
  }

  await ctx.operation?.onPhase('staged');

  if (importedWorkspaceIds.length === 0) {
    const fallback = ctx.workspaces.create(
      { name: ctx.settings.snapshot().defaultWorkspaceName },
      null,
      { activate: false, id: ctx.operation?.plannedWorkspaceIds[0] },
    );
    importedWorkspaceIds.push(fallback.id);
    createdTabIdsByWorkspace.set(fallback.id, []);
    ordinaryTabIdsByWorkspace.set(fallback.id, []);
    await ctx.operation?.onWorkspaceCreated(fallback.id);
    summary.workspacesCreated++;
  }

  const windowMap = new Map<number, string>();
  if (options.replaceExisting) {
    const regularWindows = (await browser.windows.getAll())
      .filter((window) => window.type === 'normal' && window.incognito !== true)
      .flatMap((window) => (typeof window.id === 'number' ? [window.id] : []));
    if (!regularWindows.includes(ctx.targetWindowId)) throw new Error('target_window_unavailable');
    regularWindows.sort((left, right) =>
      left === ctx.targetWindowId ? -1 : right === ctx.targetWindowId ? 1 : left - right,
    );
    while (importedWorkspaceIds.length < regularWindows.length) {
      const ordinal = importedWorkspaceIds.length;
      const fallback = ctx.workspaces.create(
        { name: `${ctx.settings.snapshot().defaultWorkspaceName} (${ordinal + 1})` },
        null,
        { activate: false, id: ctx.operation?.plannedWorkspaceIds[ordinal] },
      );
      importedWorkspaceIds.push(fallback.id);
      createdTabIdsByWorkspace.set(fallback.id, []);
      ordinaryTabIdsByWorkspace.set(fallback.id, []);
      await ctx.operation?.onWorkspaceCreated(fallback.id);
      summary.workspacesCreated++;
    }
    for (const [ordinal, windowId] of regularWindows.entries()) {
      windowMap.set(windowId, importedWorkspaceIds[ordinal]!);
    }
  } else {
    windowMap.set(ctx.targetWindowId, importedWorkspaceIds[0]!);
  }

  await ctx.operation?.onPhase('relocating');
  for (const [windowId, workspaceId] of windowMap) {
    await requireRegularTargetWindow(windowId);
    const createdForWorkspace = createdTabIdsByWorkspace.get(workspaceId) ?? [];
    if (createdForWorkspace.length > 0 && windowId !== ctx.targetWindowId) {
      await browser.tabs.move(createdForWorkspace, { windowId, index: -1 });
    }
    let ordinary = ordinaryTabIdsByWorkspace.get(workspaceId) ?? [];
    if (ordinary.length === 0) {
      const guard = await browser.tabs.create({ url: 'about:blank', active: false, windowId });
      if (typeof guard.id !== 'number') throw new Error('target_window_unavailable');
      await ctx.operation?.onTabCreated(guard.id);
      await ctx.tabs.assignWorkspace(guard.id, workspaceId);
      createdTabIdsByWorkspace.get(workspaceId)!.push(guard.id);
      ordinary = [guard.id];
      ordinaryTabIdsByWorkspace.set(workspaceId, ordinary);
      summary.tabsOpened++;
    }
    const activation = ctx.workspaces.activate(workspaceId, windowId);
    if (activation !== 'activated' && activation !== 'noop') {
      throw new Error('target_window_unavailable');
    }
  }
  await ctx.operation?.onWindowMap?.(Object.fromEntries(windowMap));
  await ctx.operation?.onPhase('proving');
  await Promise.all([
    ctx.workspaces.persistCurrentState?.(),
    ctx.panels.persistCurrentState?.(),
    ctx.pinnedPanels.persistCurrentState?.(),
  ]);

  if (options.replaceExisting) {
    await ctx.operation?.onPhase('cleaning-old');
    await removeWorkspacesAfterReplacement(workspacesToReplace, ctx);
  }

  await ctx.operation?.onPhase('graph-published');

  if (options.importSettings && data.settings) {
    await ctx.operation?.onPhase('applying-settings');
    const { privacyProtectionLevel, defaultSearchEngine, ...ordinarySettings } = data.settings;
    if (Object.keys(ordinarySettings).length > 0) {
      await ctx.settings.update(ordinarySettings);
    }
    const live = new PrivacyMutationService(ctx.settings);
    const outcomes = await Promise.all([
      privacyProtectionLevel
        ? live.setProtectionLevel(privacyProtectionLevel)
        : Promise.resolve(null),
      defaultSearchEngine ? live.setSearchEngine(defaultSearchEngine) : Promise.resolve(null),
    ]);
    summary.settingsApplied = outcomes.every(
      (outcome) => outcome === null || outcome.state === 'succeeded',
    );
  }

  if (options.importSavedPanels && data.savedPanels) {
    await ctx.operation?.onPhase('applying-saved-panels');
    for (const sp of data.savedPanels) {
      await ctx.savedPanels.save(sp.url, sp.title);
    }
  }

  await ctx.operation?.onPhase('terminal');

  return summary;
}
