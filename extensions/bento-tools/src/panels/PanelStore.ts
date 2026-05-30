// Source-of-truth side panel tracker — multi-panel.
//
// Each workspace has an ordered array of tabIds that render as side
// panels (left-to-right). A tab can be a panel in at most one workspace
// at a time (single-binding). The panels render in chrome as N <browser>
// elements inside the existing #bento-side-panel-host strip; chrome
// reconciles based on the snapshot we broadcast (panels/sync event).
//
// Persistence: tab IDs aren't stable across browser restarts, so the
// in-memory store keeps tabIds (efficient runtime) but the persistence
// layer stores URLs (stable across restarts). The boot-time restorer
// (background.ts) matches persisted URLs back to live tabIds and re-
// promotes them via `add`. See ./Persistence.ts.

import type { SubdivisionMode } from '@shared/protocol';
import { Persistence, load } from './Persistence';

export interface PanelEntry {
  tabId: number;
}

type PanelRemovedListener = (workspaceId: string, tabId: number) => void;

/** A persisted panel entry. width is in CSS pixels, optional (older
 * persisted shapes had only URLs). */
export interface PersistedPanelEntry {
  url: string;
  widthPx?: number;
  subdivision?: PersistedSubdivision;
}

export interface PersistedSubdivision {
  mode: SubdivisionMode;
  topHeightFraction: number;
  subPanelUrls: string[];
  splitRatio?: number;
}

export interface SubdivisionRuntime {
  mode: SubdivisionMode;
  topHeightFraction: number;
  subPanelTabIds: number[];
  splitRatio: number;
  topClosed?: boolean;
}

export interface BreakOutSubPanelResult {
  promotedTabId: number;
  parentTabId: number;
  removedParentTabIds: number[];
}

export class PanelStore {
  // workspaceId → ordered array of tab IDs that are panels for that workspace
  #byWorkspace = new Map<string, number[]>();
  // tabId → last-known panel width in CSS pixels. Set on panel/setWidth
  // (chrome dispatches this from endPanelDrag) and on boot restore (so a
  // restored panel renders at its previous width). Cleared on panel/remove
  // and tab close. Independent of #byWorkspace so a panel that's moved
  // between workspaces (future feature) keeps its width.
  #widthByTabId = new Map<number, number>();
  // Main-panel width in CSS pixels. Side panels are workspace-scoped,
  // but the main content slot is a single window/profile layout choice.
  #mainWidthPx: number | undefined;
  // workspaceId → horizontal scroll position of the chrome panel strip
  // at last update, in CSS pixels. Chrome captures scroll on the
  // tabpanels deck (debounced) and dispatches `panel/setStripScroll`;
  // tools writes here and includes the value in the next panels/sync
  // payload so chrome restores it after a workspace-switch reconcile.
  #stripScrollByWorkspace = new Map<string, number>();
  #subdivisions = new Map<number, SubdivisionRuntime>();
  #persistence = new Persistence();
  /** Persisted entries (URL + optional width) from last shutdown, keyed
   * by workspaceId. Consumed by the boot restorer (background.ts) and
   * then cleared. Surviving here lets the restorer run after TabRegistry
   * + WorkspaceStore are ready. */
  #persistedEntries = new Map<string, PersistedPanelEntry[]>();
  /** Fires whenever a panel binding `(workspaceId, tabId)` ceases to
   * exist — explicit `remove`, bulk `removeWorkspace`, or the leftmost-
   * promote path in `background.ts` (which calls `remove` itself).
   * Lets downstream stores (PinnedPanelsStore) drop dependent entries
   * without hand-cleaning at every call site. */
  #panelRemovedListeners = new Set<PanelRemovedListener>();

  async init(): Promise<void> {
    const persisted = await load();
    if (persisted) {
      this.#persistedEntries = persisted.byWorkspace;
      this.#mainWidthPx = persisted.mainWidthPx;
      this.#stripScrollByWorkspace = persisted.stripScrollByWorkspace;
    }
  }

  onPanelRemoved(listener: PanelRemovedListener): () => void {
    this.#panelRemovedListeners.add(listener);
    return () => this.#panelRemovedListeners.delete(listener);
  }

  #emitPanelRemoved(workspaceId: string, tabId: number): void {
    for (const l of this.#panelRemovedListeners) {
      try {
        l(workspaceId, tabId);
      } catch (err) {
        console.warn('[bento-tools] PanelStore onPanelRemoved listener threw:', err);
      }
    }
  }

  /** Pop the persisted entries for a workspace, returning undefined after
   * the first call. Used by the boot restorer; after a workspace is
   * restored we don't want to re-run on subsequent activations. */
  takePersistedEntries(workspaceId: string): PersistedPanelEntry[] | undefined {
    const entries = this.#persistedEntries.get(workspaceId);
    if (entries) this.#persistedEntries.delete(workspaceId);
    return entries;
  }

  /** All workspaceIds that still have unconsumed persisted entries. */
  workspacesWithPersistedUrls(): string[] {
    return Array.from(this.#persistedEntries.keys());
  }

  /** Non-consuming peek of all persisted entries grouped by workspace.
   * Used at boot to pre-assign workspaceIds on session-restored tabs by
   * URL — the panel storage is a second source of truth for which
   * workspace owns a tab, sidestepping the race where bento.workspaceId
   * session values aren't fully hydrated by the time backfill runs and
   * Wrong tabs get assigned to the active workspace. */
  peekAllPersistedEntries(): Map<string, PersistedPanelEntry[]> {
    return new Map(this.#persistedEntries);
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

  getMainWidth(): number | undefined {
    return this.#mainWidthPx;
  }

  /** Read the persisted strip-scroll position for a workspace, or
   * undefined if none has been recorded. Chrome consumes this via the
   * `stripScrollLeft` field on the panels/sync payload. */
  getStripScroll(workspaceId: string): number | undefined {
    return this.#stripScrollByWorkspace.get(workspaceId);
  }

  /** Write the chrome panel-strip scroll position for a workspace.
   * No-op on no-change so noisy chrome-side scroll events don't
   * re-trigger persistence on every pixel. Schedules a debounced
   * persistence write — same DEBOUNCE_MS as panel widths. */
  setStripScroll(workspaceId: string, scrollLeft: number): void {
    if (!Number.isFinite(scrollLeft) || scrollLeft < 0) return;
    const rounded = Math.round(scrollLeft);
    if (this.#stripScrollByWorkspace.get(workspaceId) === rounded) return;
    this.#stripScrollByWorkspace.set(workspaceId, rounded);
    this.#schedulePersist();
  }

  setMainWidth(widthPx: number): void {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const rounded = Math.max(320, Math.round(widthPx));
    if (this.#mainWidthPx === rounded) return;
    this.#mainWidthPx = rounded;
    this.#flushPersist();
  }

  /** Persist the current panel bindings without changing structure.
   * Used when a panel or sub-panel tab navigates: persistence stores URLs,
   * but URL changes do not otherwise mutate PanelStore state. */
  persistCurrentState(): void {
    this.#flushPersist();
  }

  /** Get the panel tab IDs for a workspace, in left-to-right order. */
  getPanels(workspaceId: string | null): number[] {
    if (!workspaceId) return [];
    const list = this.#byWorkspace.get(workspaceId) ?? [];
    const subPanelIds = this.allSubPanelTabIds();
    return list.filter((id) => !subPanelIds.has(id));
  }

  /** Append a tab to a workspace's panels. No-op if already present. */
  add(workspaceId: string, tabId: number): boolean {
    if (this.allSubPanelTabIds().has(tabId)) return false;
    const list = this.#byWorkspace.get(workspaceId) ?? [];
    if (list.includes(tabId)) return false;
    this.#byWorkspace.set(workspaceId, [...list, tabId]);
    this.#schedulePersist();
    return true;
  }

  /** Insert a tab at a specific slot. Position is clamped to
   * [0, list.length]; out-of-range values append. No-op if already
   * present. Used by the Cmd+Shift+T restore path so panels return to
   * their original slot rather than the end of the list. */
  insertAt(workspaceId: string, tabId: number, position: number): boolean {
    if (this.allSubPanelTabIds().has(tabId)) return false;
    const list = this.#byWorkspace.get(workspaceId) ?? [];
    if (list.includes(tabId)) return false;
    const idx = Math.max(0, Math.min(position, list.length));
    const next = [...list.slice(0, idx), tabId, ...list.slice(idx)];
    this.#byWorkspace.set(workspaceId, next);
    this.#schedulePersist();
    return true;
  }

  /** Remove a tab from a workspace's panels. Returns true if removed.
   * If the panel has a subdivision, the sub-panel tabIds are returned
   * in `removedSubPanelTabIds` so the caller can close them. */
  remove(workspaceId: string, tabId: number): boolean {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) return false;
    const next = list.filter((id) => id !== tabId);
    if (next.length === list.length) return false;
    if (next.length === 0) this.#byWorkspace.delete(workspaceId);
    else this.#byWorkspace.set(workspaceId, next);
    if (this.findWorkspacesContainingTab(tabId).length === 0) {
      this.#widthByTabId.delete(tabId);
    }
    this.#subdivisions.delete(tabId);
    this.#schedulePersist();
    this.#emitPanelRemoved(workspaceId, tabId);
    return true;
  }

  /** Like remove(), but also returns sub-panel tabIds that need closing. */
  removeWithSubPanels(workspaceId: string, tabId: number): number[] {
    const sub = this.#subdivisions.get(tabId);
    const victims = sub ? [...sub.subPanelTabIds] : [];
    this.remove(workspaceId, tabId);
    return victims;
  }

  /** Remove the subdivision parent but keep its sub-panels as normal panels.
   * Returns true when the parent was removed from the workspace. */
  promoteSubPanelsWhenRemovingParent(workspaceId: string, parentTabId: number): boolean {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) {
      return false;
    }
    const idx = list.indexOf(parentTabId);
    if (idx === -1) {
      return false;
    }
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub || sub.subPanelTabIds.length === 0) {
      return this.remove(workspaceId, parentTabId);
    }

    const promoted = sub.subPanelTabIds.filter((id) => Number.isFinite(id));
    const next = [...list.slice(0, idx), ...promoted, ...list.slice(idx + 1)];
    if (next.length === 0) this.#byWorkspace.delete(workspaceId);
    else this.#byWorkspace.set(workspaceId, next);

    const parentWidth = this.#widthByTabId.get(parentTabId);
    this.#widthByTabId.delete(parentTabId);
    if (
      typeof parentWidth === 'number' &&
      promoted.length > 0 &&
      !this.#widthByTabId.has(promoted[0]!)
    ) {
      this.#widthByTabId.set(promoted[0]!, parentWidth);
    }
    this.#subdivisions.delete(parentTabId);
    this.#schedulePersist();
    this.#emitPanelRemoved(workspaceId, parentTabId);
    return true;
  }

  /** Drop all panels for a workspace (call when the workspace is deleted).
   * Returns sub-panel tabIds that need closing. */
  removeWorkspace(workspaceId: string): number[] {
    const list = this.#byWorkspace.get(workspaceId);
    if (!this.#byWorkspace.delete(workspaceId)) return [];
    this.#persistedEntries.delete(workspaceId);
    this.#stripScrollByWorkspace.delete(workspaceId);
    const subVictims: number[] = [];
    if (list) {
      for (const tabId of list) {
        const sub = this.#subdivisions.get(tabId);
        if (sub) {
          subVictims.push(...sub.subPanelTabIds);
          this.#subdivisions.delete(tabId);
        }
        if (this.findWorkspacesContainingTab(tabId).length === 0) {
          this.#widthByTabId.delete(tabId);
        }
      }
    }
    this.#schedulePersist();
    if (list) {
      for (const tabId of list) this.#emitPanelRemoved(workspaceId, tabId);
    }
    return subVictims;
  }

  /** Replace the workspace's panel order. `tabIds` MUST be a permutation
   * of the current set — same length, same members. If it isn't (a panel
   * was added/removed in flight, or chrome sent stale ids), the reorder
   * is rejected so the wire can't accidentally smuggle add/remove
   * semantics through this channel. Returns true if the order actually
   * changed. */
  reorder(workspaceId: string, tabIds: number[]): boolean {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) return false;
    if (tabIds.length !== list.length) return false;
    const current = new Set(list);
    for (const id of tabIds) {
      if (!current.has(id)) return false;
    }
    if (tabIds.every((id, i) => list[i] === id)) return false;
    this.#byWorkspace.set(workspaceId, [...tabIds]);
    this.#schedulePersist();
    return true;
  }

  /** Find every workspace that holds this tab as a panel. Used by the
   * tab-removed handler to clean up panel state when its source tab
   * closes — a tab can be a panel in multiple workspaces in principle
   * (we don't enforce single-binding at write time). */
  findWorkspacesContainingTab(tabId: number): string[] {
    const out: string[] = [];
    for (const [wsId, list] of this.#byWorkspace) {
      if (list.includes(tabId)) out.push(wsId);
    }
    return out;
  }

  /** Find every workspace that owns this tab either as a top-level panel
   * or as a nested sub-panel under one. Nested subdivision close paths need
   * this because their immediate parent can itself be a sub-panel, so a
   * top-level-only lookup misses the workspace and chrome never receives the
   * state sync that clears stale child subdivisions. */
  findWorkspacesContainingPanelOrSubPanel(tabId: number): string[] {
    const direct = this.findWorkspacesContainingTab(tabId);
    if (direct.length > 0) return direct;

    const out: string[] = [];
    for (const wsId of this.#byWorkspace.keys()) {
      if (this.#topLevelAncestorFor(wsId, tabId) !== undefined) out.push(wsId);
    }
    return out;
  }

  // ── Subdivision API ──

  getSubdivision(parentTabId: number): SubdivisionRuntime | undefined {
    return this.#subdivisions.get(parentTabId);
  }

  /** All tab IDs that are sub-panels (across every subdivision). */
  allSubPanelTabIds(): Set<number> {
    const out = new Set<number>();
    for (const sub of this.#subdivisions.values()) {
      for (const id of sub.subPanelTabIds) out.add(id);
    }
    return out;
  }

  /** Reverse lookup: given a sub-panel tab ID, find its parent. */
  findParentOfSubPanel(subTabId: number): number | undefined {
    for (const [parentId, sub] of this.#subdivisions) {
      if (sub.subPanelTabIds.includes(subTabId)) return parentId;
    }
    return undefined;
  }

  #topLevelAncestorFor(workspaceId: string, tabId: number): number | undefined {
    const roots = this.#byWorkspace.get(workspaceId);
    if (!roots) return undefined;
    const seen = new Set<number>();
    let current = tabId;
    while (!seen.has(current)) {
      seen.add(current);
      if (roots.includes(current)) return current;
      const parent = this.findParentOfSubPanel(current);
      if (parent === undefined) return undefined;
      current = parent;
    }
    return undefined;
  }

  #subdivisionAncestorChainToRoot(workspaceId: string, tabId: number): number[] {
    const roots = this.#byWorkspace.get(workspaceId);
    if (!roots) return [];
    const chain: number[] = [];
    const seen = new Set<number>();
    let current = tabId;
    while (!seen.has(current)) {
      seen.add(current);
      chain.unshift(current);
      if (roots.includes(current)) return chain;
      const parent = this.findParentOfSubPanel(current);
      if (parent === undefined) return [];
      current = parent;
    }
    return [];
  }

  #fullSlotAncestorFor(workspaceId: string, subTabId: number): number | undefined {
    const roots = this.#byWorkspace.get(workspaceId);
    if (!roots || roots.length === 0 || roots.includes(subTabId)) return undefined;
    const seen = new Set<number>();
    let current = subTabId;
    while (!seen.has(current)) {
      seen.add(current);
      const parent = this.findParentOfSubPanel(current);
      if (parent === undefined) return undefined;
      const sub = this.#subdivisions.get(parent);
      // A top-closed subdivision exposes its children as the visible panel
      // surfaces. A dual split child is not full-width, but it is still a
      // user-addressable panel and may itself be subdivided.
      if (!sub?.topClosed || !sub.subPanelTabIds.includes(current)) {
        return undefined;
      }
      if (roots.includes(parent)) return parent;
      current = parent;
    }
    return undefined;
  }

  isFullSlotSubPanel(workspaceId: string, subTabId: number): boolean {
    return this.#fullSlotAncestorFor(workspaceId, subTabId) !== undefined;
  }

  /** Create a subdivision on a panel (enters chooser state). */
  subdivide(workspaceId: string, parentTabId: number): boolean {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) return false;
    const isTopLevelPanel = list.includes(parentTabId);
    const isFullSlotSubPanel = this.isFullSlotSubPanel(workspaceId, parentTabId);
    if (!isTopLevelPanel && !isFullSlotSubPanel) return false;
    if (this.#subdivisions.has(parentTabId)) return false;
    this.#subdivisions.set(parentTabId, {
      mode: 'single',
      topHeightFraction: 0.5,
      subPanelTabIds: [],
      splitRatio: 0.5,
    });
    this.#flushPersist();
    return true;
  }

  /** Fill a subdivision's bottom region with sub-panel tab(s). */
  fillSubdivision(parentTabId: number, mode: SubdivisionMode, subTabIds: number[]): boolean {
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub) return false;
    const expected = mode === 'single' ? 1 : 2;
    if (subTabIds.length !== expected) return false;
    sub.mode = mode;
    sub.subPanelTabIds = [...subTabIds];
    if (mode === 'single') sub.splitRatio = 0.5;
    this.#flushPersist();
    return true;
  }

  /** Remove a subdivision, returning sub-panel tabIds that should be closed. */
  removeSubdivision(_workspaceId: string, parentTabId: number): number[] {
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub) return [];
    const victims = [...sub.subPanelTabIds];
    this.#subdivisions.delete(parentTabId);
    this.#schedulePersist();
    return victims;
  }

  closeSubdivisionTop(_workspaceId: string, parentTabId: number): boolean {
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub || sub.subPanelTabIds.length === 0) return false;
    sub.topClosed = true;
    sub.topHeightFraction = 0;
    this.#schedulePersist();
    return true;
  }

  breakOutSubPanel(workspaceId: string, tabId: number): BreakOutSubPanelResult | undefined {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) return undefined;
    const parentTabId = this.findParentOfSubPanel(tabId);
    if (parentTabId === undefined) return undefined;
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub) return undefined;
    const idx = sub.subPanelTabIds.indexOf(tabId);
    if (idx === -1) return undefined;
    if (sub.topClosed && sub.subPanelTabIds.length === 1) return undefined;
    if (this.isFullSlotSubPanel(workspaceId, tabId)) return undefined;

    const topLevelAnchor = this.#topLevelAncestorFor(workspaceId, parentTabId);
    if (topLevelAnchor === undefined) return undefined;

    const remaining = sub.subPanelTabIds.filter((id) => id !== tabId);
    const removedParentTabIds: number[] = [];
    const anchorWidth =
      this.#widthByTabId.get(topLevelAnchor) ?? this.#widthByTabId.get(parentTabId);

    if (remaining.length === 0) {
      this.#subdivisions.delete(parentTabId);

      if (sub.topClosed) {
        const chain = this.#subdivisionAncestorChainToRoot(workspaceId, parentTabId);
        const chainSet = new Set(chain.length > 0 ? chain : [parentTabId]);
        const next: number[] = [];
        let inserted = false;
        for (const id of list) {
          if (id === tabId) continue;
          if (id === topLevelAnchor && !inserted) {
            next.push(tabId);
            inserted = true;
            continue;
          }
          if (chainSet.has(id)) continue;
          next.push(id);
        }
        if (!inserted) next.push(tabId);
        this.#byWorkspace.set(workspaceId, next);

        for (const id of chainSet) {
          this.#subdivisions.delete(id);
          this.#widthByTabId.delete(id);
          if (id !== tabId) removedParentTabIds.push(id);
        }
        if (typeof anchorWidth === 'number') this.#widthByTabId.set(tabId, anchorWidth);
        this.#schedulePersist();
        for (const id of chainSet) {
          if (id !== tabId) this.#emitPanelRemoved(workspaceId, id);
        }
        return { promotedTabId: tabId, parentTabId, removedParentTabIds };
      }

      const next = list.filter((id) => id !== tabId);
      const anchorIndex = next.indexOf(topLevelAnchor);
      if (anchorIndex === -1) next.push(tabId);
      else next.splice(anchorIndex + 1, 0, tabId);
      this.#byWorkspace.set(workspaceId, next);
      if (typeof anchorWidth === 'number' && !this.#widthByTabId.has(tabId)) {
        this.#widthByTabId.set(tabId, anchorWidth);
      }
      this.#schedulePersist();
      return { promotedTabId: tabId, parentTabId, removedParentTabIds };
    }

    sub.subPanelTabIds = remaining;
    if (remaining.length === 1) {
      sub.mode = 'single';
      sub.splitRatio = 0.5;
    }

    const next = list.filter((id) => id !== tabId);
    const anchorIndex = next.indexOf(topLevelAnchor);
    if (anchorIndex === -1) next.push(tabId);
    else next.splice(anchorIndex + 1, 0, tabId);
    this.#byWorkspace.set(workspaceId, next);
    if (typeof anchorWidth === 'number' && !this.#widthByTabId.has(tabId)) {
      this.#widthByTabId.set(tabId, anchorWidth);
    }
    this.#schedulePersist();
    return { promotedTabId: tabId, parentTabId, removedParentTabIds };
  }

  /** Remove a single sub-panel tab from its parent's subdivision.
   * Returns the parent tabId if the subdivision was modified, undefined otherwise. */
  removeSubPanelTab(subTabId: number): number | undefined {
    for (const [parentId, sub] of this.#subdivisions) {
      const idx = sub.subPanelTabIds.indexOf(subTabId);
      if (idx === -1) continue;
      const childSubdivision = this.#subdivisions.get(subTabId);
      const promotedChildren = childSubdivision
        ? childSubdivision.subPanelTabIds.filter((id) => Number.isFinite(id))
        : [];
      sub.subPanelTabIds.splice(idx, 1, ...promotedChildren);
      this.#subdivisions.delete(subTabId);
      this.#widthByTabId.delete(subTabId);
      if (sub.subPanelTabIds.length === 0) {
        this.#subdivisions.delete(parentId);
      } else if (sub.subPanelTabIds.length === 1) {
        sub.mode = 'single';
        sub.splitRatio = 0.5;
      } else if (sub.subPanelTabIds.length === 2) {
        sub.mode = 'dual';
      }
      this.#schedulePersist();
      return parentId;
    }
    return undefined;
  }

  setSubdivisionHeight(parentTabId: number, topHeightFraction: number): void {
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub) return;
    sub.topHeightFraction = Math.max(0.2, Math.min(0.8, topHeightFraction));
    this.#flushPersist();
  }

  setSubdivisionSplitRatio(parentTabId: number, splitRatio: number): void {
    const sub = this.#subdivisions.get(parentTabId);
    if (!sub || sub.mode !== 'dual') return;
    sub.splitRatio = Math.max(0.2, Math.min(0.8, splitRatio));
    this.#flushPersist();
  }

  /** Get all subdivisions (for sync emission). */
  getAllSubdivisions(): Map<number, SubdivisionRuntime> {
    return new Map(this.#subdivisions);
  }

  #schedulePersist(): void {
    this.#persistence.schedule(
      new Map(this.#byWorkspace),
      new Map(this.#widthByTabId),
      this.#mainWidthPx,
      new Map(this.#stripScrollByWorkspace),
      new Map(this.#subdivisions),
    );
  }

  #flushPersist(): void {
    this.#persistence.flushNow(
      new Map(this.#byWorkspace),
      new Map(this.#widthByTabId),
      this.#mainWidthPx,
      new Map(this.#stripScrollByWorkspace),
      new Map(this.#subdivisions),
    );
  }
}
