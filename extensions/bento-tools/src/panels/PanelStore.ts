import type { PanelLayoutMoveTarget, PanelLayoutStatus } from '@shared/protocol';
import {
  addPanel,
  breakOutPanel,
  canBreakOut,
  canSubdivide,
  canSplitBottomPanel,
  canSplitTopPanel,
  cloneLayout,
  containsPanel,
  emptyLayout,
  fillChooser,
  fromPersistenceLayout,
  getPanelLayoutStatus,
  getPanelRestoreLocation,
  getPanelStatusMap,
  getRootNodeIds,
  getVisiblePanelIds,
  insertPanelAt,
  insertPanelAtRestoreLocation,
  migrateLegacyEntriesToPersistence,
  movePanel,
  panelKeysForLayout,
  removePanel,
  removePanelWithDescendants,
  removeVerticalGroup,
  removeWorkspace,
  reorderRootNodes,
  setGroupRatio,
  splitBottomPanel,
  splitTopPanel,
  subdividePanel,
  toPersistenceLayout,
  toSyncLayout,
  type PanelPersistenceSnapshot,
  type PanelPersistenceWorkspaceLayout,
  type PanelRestoreLocation,
  type WorkspacePanelLayout,
} from './PanelLayout';
import { Persistence, load } from './Persistence';

type PanelRemovedListener = (workspaceId: string, tabId: number) => void;

export interface PersistedPanelEntry {
  panelKey: string;
  url: string;
  widthPx?: number;
}

export interface PersistedWorkspacePanels {
  entries: PersistedPanelEntry[];
  layout: PanelPersistenceWorkspaceLayout;
}

export interface BreakOutPanelResult {
  promotedTabId: number;
}

export class PanelStore {
  #layoutByWorkspace = new Map<string, WorkspacePanelLayout>();
  #widthByTabId = new Map<number, number>();
  #mainWidthByWorkspace = new Map<string, number>();
  #stripScrollByWorkspace = new Map<string, number>();
  #persistence = new Persistence();
  #persistedWorkspaces = new Map<string, PersistedWorkspacePanels>();
  #panelRemovedListeners = new Set<PanelRemovedListener>();

  async init(): Promise<void> {
    const persisted = await load();
    if (persisted) {
      this.#persistedWorkspaces = persisted.byWorkspace;
      this.#mainWidthByWorkspace = persisted.mainWidthByWorkspace;
      this.#stripScrollByWorkspace = persisted.stripScrollByWorkspace;
    }
  }

  onPanelRemoved(listener: PanelRemovedListener): () => void {
    this.#panelRemovedListeners.add(listener);
    return () => this.#panelRemovedListeners.delete(listener);
  }

  #emitPanelRemoved(workspaceId: string, tabId: number): void {
    for (const listener of this.#panelRemovedListeners) {
      try {
        listener(workspaceId, tabId);
      } catch (err) {
        console.warn('[bento-tools] PanelStore onPanelRemoved listener threw:', err);
      }
    }
  }

  takePersistedWorkspace(workspaceId: string): PersistedWorkspacePanels | undefined {
    const persisted = this.#persistedWorkspaces.get(workspaceId);
    if (persisted) this.#persistedWorkspaces.delete(workspaceId);
    return persisted;
  }

  takePersistedEntries(workspaceId: string): PersistedPanelEntry[] | undefined {
    return this.takePersistedWorkspace(workspaceId)?.entries;
  }

  workspacesWithPersistedUrls(): string[] {
    return Array.from(this.#persistedWorkspaces.keys());
  }

  peekAllPersistedEntries(): Map<string, PersistedPanelEntry[]> {
    const out = new Map<string, PersistedPanelEntry[]>();
    for (const [workspaceId, persisted] of this.#persistedWorkspaces) {
      out.set(workspaceId, persisted.entries);
    }
    return out;
  }

  getWidth(tabId: number): number | undefined {
    return this.#widthByTabId.get(tabId);
  }

  setWidth(tabId: number, widthPx: number): void {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const rounded = Math.round(widthPx);
    if (this.#widthByTabId.get(tabId) === rounded) return;
    this.#widthByTabId.set(tabId, rounded);
    this.#flushPersist();
  }

  getMainWidth(workspaceId: string | null): number | undefined {
    if (!workspaceId) return undefined;
    return this.#mainWidthByWorkspace.get(workspaceId);
  }

  setMainWidth(workspaceId: string, widthPx: number): void {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const rounded = Math.max(320, Math.round(widthPx));
    if (this.#mainWidthByWorkspace.get(workspaceId) === rounded) return;
    this.#mainWidthByWorkspace.set(workspaceId, rounded);
    this.#flushPersist();
  }

  getStripScroll(workspaceId: string): number | undefined {
    return this.#stripScrollByWorkspace.get(workspaceId);
  }

  setStripScroll(workspaceId: string, scrollLeft: number): void {
    if (!Number.isFinite(scrollLeft) || scrollLeft < 0) return;
    const rounded = Math.round(scrollLeft);
    if (this.#stripScrollByWorkspace.get(workspaceId) === rounded) return;
    this.#stripScrollByWorkspace.set(workspaceId, rounded);
    this.#schedulePersist();
  }

  persistCurrentState(): void {
    this.#flushPersist();
  }

  getPanelLayout(workspaceId: string | null): WorkspacePanelLayout {
    if (!workspaceId) return emptyLayout();
    return cloneLayout(this.#layoutByWorkspace.get(workspaceId));
  }

  getPanelLayoutSync(workspaceId: string | null) {
    return toSyncLayout(workspaceId ? this.#layoutByWorkspace.get(workspaceId) : undefined);
  }

  getVisiblePanelIds(workspaceId: string | null): number[] {
    if (!workspaceId) return [];
    return getVisiblePanelIds(this.#layoutByWorkspace.get(workspaceId));
  }

  getRootNodeIds(workspaceId: string | null): string[] {
    if (!workspaceId) return [];
    return getRootNodeIds(this.#layoutByWorkspace.get(workspaceId));
  }

  containsPanel(workspaceId: string | null, tabId: number): boolean {
    if (!workspaceId) return false;
    return containsPanel(this.#layoutByWorkspace.get(workspaceId), tabId);
  }

  getPanelLayoutStatus(workspaceId: string | null, tabId: number): PanelLayoutStatus {
    if (!workspaceId) return 'unknown';
    return getPanelLayoutStatus(this.#layoutByWorkspace.get(workspaceId), tabId);
  }

  getPanelStatusMap(workspaceId: string | null): Record<number, PanelLayoutStatus> {
    if (!workspaceId) return {};
    return getPanelStatusMap(this.#layoutByWorkspace.get(workspaceId));
  }

  canSubdivide(workspaceId: string | null, tabId: number): boolean {
    if (!workspaceId) return false;
    return canSubdivide(this.#layoutByWorkspace.get(workspaceId), tabId);
  }

  canSplitTopPanel(workspaceId: string | null, tabId: number): boolean {
    if (!workspaceId) return false;
    return canSplitTopPanel(this.#layoutByWorkspace.get(workspaceId), tabId);
  }

  canSplitBottomPanel(workspaceId: string | null, tabId: number): boolean {
    if (!workspaceId) return false;
    return canSplitBottomPanel(this.#layoutByWorkspace.get(workspaceId), tabId);
  }

  canBreakOut(workspaceId: string | null, tabId: number): boolean {
    if (!workspaceId) return false;
    return canBreakOut(this.#layoutByWorkspace.get(workspaceId), tabId);
  }

  getPanelRestoreLocation(workspaceId: string, tabId: number): PanelRestoreLocation {
    return getPanelRestoreLocation(this.#layoutByWorkspace.get(workspaceId), workspaceId, tabId);
  }

  getPanelKey(workspaceId: string, tabId: number): string | undefined {
    return panelKeysForLayout(this.#layoutByWorkspace.get(workspaceId)).get(tabId);
  }

  async buildPanelPersistenceSnapshot(
    workspaceId: string,
    resolveUrl: (tabId: number) => Promise<string | undefined>,
  ): Promise<PanelPersistenceSnapshot> {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    const keys = panelKeysForLayout(layout);
    const entries: PanelPersistenceSnapshot['entries'] = [];
    for (const [tabId, panelKey] of keys) {
      const url = await resolveUrl(tabId);
      if (!url || url === 'about:blank') continue;
      const widthPx = this.#widthByTabId.get(tabId);
      const entry: PanelPersistenceSnapshot['entries'][number] = { panelKey, tabId, url };
      if (typeof widthPx === 'number' && widthPx > 0) entry.widthPx = widthPx;
      entries.push(entry);
    }
    const keptKeys = new Map(entries.map((entry) => [entry.tabId, entry.panelKey]));
    return {
      entries,
      layout: toPersistenceLayout(layout, keptKeys),
    };
  }

  add(workspaceId: string, tabId: number): boolean {
    const layout = this.#layoutForMutation(workspaceId);
    const changed = addPanel(layout, tabId);
    if (changed) this.#schedulePersist();
    return changed;
  }

  insertAt(workspaceId: string, tabId: number, position: number): boolean {
    const layout = this.#layoutForMutation(workspaceId);
    const changed = insertPanelAt(layout, tabId, position);
    if (changed) this.#schedulePersist();
    return changed;
  }

  insertAtRestoreLocation(
    workspaceId: string,
    tabId: number,
    location: Pick<PanelRestoreLocation, 'rootIndex' | 'containingRootNodeId'>,
  ): boolean {
    const layout = this.#layoutForMutation(workspaceId);
    const changed = insertPanelAtRestoreLocation(layout, tabId, location);
    if (changed) this.#schedulePersist();
    return changed;
  }

  restorePersistedLayout(
    workspaceId: string,
    layout: PanelPersistenceWorkspaceLayout,
    tabIdByPanelKey: Map<string, number>,
  ): void {
    const runtime = fromPersistenceLayout(layout, tabIdByPanelKey);
    if (runtime.root.length === 0) {
      this.#layoutByWorkspace.delete(workspaceId);
    } else {
      this.#layoutByWorkspace.set(workspaceId, runtime);
    }
    this.#schedulePersist();
  }

  remove(workspaceId: string, tabId: number): boolean {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return false;
    const changed = removePanel(layout, tabId);
    if (!changed) return false;
    if (layout.root.length === 0) this.#layoutByWorkspace.delete(workspaceId);
    if (this.findWorkspacesContainingTab(tabId).length === 0) {
      this.#widthByTabId.delete(tabId);
    }
    this.#schedulePersist();
    this.#emitPanelRemoved(workspaceId, tabId);
    return true;
  }

  removeWithSubPanels(workspaceId: string, tabId: number): number[] {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return [];
    if (!containsPanel(layout, tabId)) return [];
    const victims = removePanelWithDescendants(layout, tabId);
    if (layout.root.length === 0) this.#layoutByWorkspace.delete(workspaceId);
    if (this.findWorkspacesContainingTab(tabId).length === 0) {
      this.#widthByTabId.delete(tabId);
    }
    for (const victim of victims) {
      if (this.findWorkspacesContainingTab(victim).length === 0) {
        this.#widthByTabId.delete(victim);
      }
      this.#emitPanelRemoved(workspaceId, victim);
    }
    this.#schedulePersist();
    this.#emitPanelRemoved(workspaceId, tabId);
    return victims;
  }

  removeWorkspace(workspaceId: string): number[] {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    const hadPersisted = this.#persistedWorkspaces.delete(workspaceId);
    const hadMainWidth = this.#mainWidthByWorkspace.delete(workspaceId);
    this.#stripScrollByWorkspace.delete(workspaceId);
    if (!layout && !hadPersisted) {
      if (hadMainWidth) this.#schedulePersist();
      return [];
    }
    const victims = layout ? removeWorkspace(layout) : [];
    this.#layoutByWorkspace.delete(workspaceId);
    for (const tabId of victims) {
      if (this.findWorkspacesContainingTab(tabId).length === 0) this.#widthByTabId.delete(tabId);
      this.#emitPanelRemoved(workspaceId, tabId);
    }
    this.#schedulePersist();
    return victims;
  }

  reorderRootNodes(workspaceId: string, rootNodeIds: string[]): boolean {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return false;
    const changed = reorderRootNodes(layout, rootNodeIds);
    if (changed) this.#schedulePersist();
    return changed;
  }

  movePanel(workspaceId: string, tabId: number, target: PanelLayoutMoveTarget): boolean {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return false;
    const changed = movePanel(layout, tabId, target, {
      horizontalGroupId: target.type === 'horizontal' ? this.#newLayoutId('horizontal') : undefined,
    });
    if (changed) this.#flushPersist();
    return changed;
  }

  subdivide(workspaceId: string, tabId: number): boolean {
    const layout = this.#layoutForMutation(workspaceId);
    const changed = subdividePanel(layout, tabId, {
      groupId: this.#newLayoutId('vertical'),
      chooserId: this.#newLayoutId('chooser'),
    });
    if (changed) this.#flushPersist();
    return changed;
  }

  splitTopPanel(workspaceId: string, tabId: number, newTabId: number): boolean {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return false;
    const changed = splitTopPanel(layout, tabId, newTabId, {
      horizontalGroupId: this.#newLayoutId('horizontal'),
    });
    if (changed) this.#flushPersist();
    return changed;
  }

  splitBottomPanel(workspaceId: string, tabId: number, newTabId: number): boolean {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return false;
    const changed = splitBottomPanel(layout, tabId, newTabId, {
      horizontalGroupId: this.#newLayoutId('horizontal'),
    });
    if (changed) this.#flushPersist();
    return changed;
  }

  fillChooser(
    workspaceId: string,
    chooserId: string,
    mode: 'single' | 'dual',
    tabIds: number[],
  ): boolean {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return false;
    const changed = fillChooser(layout, chooserId, mode, tabIds, {
      horizontalGroupId: mode === 'dual' ? this.#newLayoutId('horizontal') : undefined,
    });
    if (changed) this.#flushPersist();
    return changed;
  }

  removeVerticalGroup(workspaceId: string, groupId: string): number[] {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return [];
    const before = JSON.stringify(layout.root);
    const victims = removeVerticalGroup(layout, groupId);
    const changed = before !== JSON.stringify(layout.root);
    if (!changed) return [];
    for (const victim of victims) {
      if (this.findWorkspacesContainingTab(victim).length === 0) this.#widthByTabId.delete(victim);
      this.#emitPanelRemoved(workspaceId, victim);
    }
    this.#schedulePersist();
    return victims;
  }

  breakOut(workspaceId: string, tabId: number): BreakOutPanelResult | undefined {
    const layout = this.#layoutByWorkspace.get(workspaceId);
    if (!layout) return undefined;
    const result = breakOutPanel(layout, tabId);
    if (!result) return undefined;
    this.#schedulePersist();
    return { promotedTabId: result.promotedTabId };
  }

  setGroupRatio(groupId: string, ratio: number): void {
    let changed = false;
    for (const layout of this.#layoutByWorkspace.values()) {
      if (setGroupRatio(layout, groupId, ratio)) changed = true;
    }
    if (changed) this.#flushPersist();
  }

  findWorkspacesContainingTab(tabId: number): string[] {
    const out: string[] = [];
    for (const [workspaceId, layout] of this.#layoutByWorkspace) {
      if (containsPanel(layout, tabId)) out.push(workspaceId);
    }
    return out;
  }

  findWorkspacesContainingPanelOrSubPanel(tabId: number): string[] {
    return this.findWorkspacesContainingTab(tabId);
  }

  getPanels(workspaceId: string | null): number[] {
    return this.getVisiblePanelIds(workspaceId);
  }

  #layoutForMutation(workspaceId: string): WorkspacePanelLayout {
    const existing = this.#layoutByWorkspace.get(workspaceId);
    if (existing) return existing;
    const created = emptyLayout();
    this.#layoutByWorkspace.set(workspaceId, created);
    return created;
  }

  #newLayoutId(kind: string): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${kind}:${crypto.randomUUID()}`;
    }
    return `${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  #schedulePersist(): void {
    this.#persistence.schedule(
      new Map(this.#layoutByWorkspace),
      new Map(this.#widthByTabId),
      new Map(this.#mainWidthByWorkspace),
      new Map(this.#stripScrollByWorkspace),
    );
  }

  #flushPersist(): void {
    this.#persistence.flushNow(
      new Map(this.#layoutByWorkspace),
      new Map(this.#widthByTabId),
      new Map(this.#mainWidthByWorkspace),
      new Map(this.#stripScrollByWorkspace),
    );
  }
}

export { migrateLegacyEntriesToPersistence };
