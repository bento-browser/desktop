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

import { Persistence, load } from './Persistence';

export interface PanelEntry {
  tabId: number;
}

/** A persisted panel entry. width is in CSS pixels, optional (older
 * persisted shapes had only URLs). */
export interface PersistedPanelEntry {
  url: string;
  widthPx?: number;
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
  // workspaceId → main-panel width in CSS pixels. Set on panel/setMainWidth
  // (chrome dispatches this when the user drags the main splitter). Lives
  // alongside #byWorkspace because each workspace has its own main-slot
  // sizing — wide for reading-focused workspaces, narrow for tool-strip
  // workspaces, etc.
  #mainWidthByWorkspace = new Map<string, number>();
  #persistence = new Persistence();
  /** Persisted entries (URL + optional width) from last shutdown, keyed
   * by workspaceId. Consumed by the boot restorer (background.ts) and
   * then cleared. Surviving here lets the restorer run after TabRegistry
   * + WorkspaceStore are ready. */
  #persistedEntries = new Map<string, PersistedPanelEntry[]>();

  async init(): Promise<void> {
    const persisted = await load();
    if (persisted) {
      this.#persistedEntries = persisted.byWorkspace;
      // Main widths apply per-workspace and are workspace-scoped (not
      // per-tab), so they go straight into the live map at init time —
      // unlike #widthByTabId which has to wait for tabIds to materialize
      // via restorePanelsForWorkspace.
      for (const [wsId, w] of persisted.mainWidthByWorkspace) {
        this.#mainWidthByWorkspace.set(wsId, w);
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
    this.#schedulePersist();
  }

  getMainWidth(workspaceId: string): number | undefined {
    return this.#mainWidthByWorkspace.get(workspaceId);
  }

  setMainWidth(workspaceId: string, widthPx: number): void {
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const rounded = Math.round(widthPx);
    if (this.#mainWidthByWorkspace.get(workspaceId) === rounded) return;
    this.#mainWidthByWorkspace.set(workspaceId, rounded);
    this.#schedulePersist();
  }

  /** Get the panel tab IDs for a workspace, in left-to-right order. */
  getPanels(workspaceId: string | null): number[] {
    if (!workspaceId) return [];
    return this.#byWorkspace.get(workspaceId) ?? [];
  }

  /** Append a tab to a workspace's panels. No-op if already present. */
  add(workspaceId: string, tabId: number): boolean {
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
    const list = this.#byWorkspace.get(workspaceId) ?? [];
    if (list.includes(tabId)) return false;
    const idx = Math.max(0, Math.min(position, list.length));
    const next = [...list.slice(0, idx), tabId, ...list.slice(idx)];
    this.#byWorkspace.set(workspaceId, next);
    this.#schedulePersist();
    return true;
  }

  /** Remove a tab from a workspace's panels. Returns true if removed. */
  remove(workspaceId: string, tabId: number): boolean {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) return false;
    const next = list.filter((id) => id !== tabId);
    if (next.length === list.length) return false;
    if (next.length === 0) this.#byWorkspace.delete(workspaceId);
    else this.#byWorkspace.set(workspaceId, next);
    // Width is per-tabId; drop it if no remaining workspace holds this
    // tab as a panel. (findWorkspacesContainingTab is run AFTER the
    // remove above, so a tab pinned in multiple workspaces keeps its
    // width until the last one drops it.)
    if (this.findWorkspacesContainingTab(tabId).length === 0) {
      this.#widthByTabId.delete(tabId);
    }
    this.#schedulePersist();
    return true;
  }

  /** Drop all panels for a workspace (call when the workspace is deleted). */
  removeWorkspace(workspaceId: string): void {
    const list = this.#byWorkspace.get(workspaceId);
    if (!this.#byWorkspace.delete(workspaceId)) return;
    this.#persistedEntries.delete(workspaceId);
    this.#mainWidthByWorkspace.delete(workspaceId);
    if (list) {
      for (const tabId of list) {
        if (this.findWorkspacesContainingTab(tabId).length === 0) {
          this.#widthByTabId.delete(tabId);
        }
      }
    }
    this.#schedulePersist();
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

  #schedulePersist(): void {
    // Snapshot the maps so the persistence layer's async flush sees the
    // state at schedule time, not whatever happens to be in #byWorkspace
    // when the debounce fires.
    this.#persistence.schedule(
      new Map(this.#byWorkspace),
      new Map(this.#widthByTabId),
      new Map(this.#mainWidthByWorkspace),
    );
  }
}
