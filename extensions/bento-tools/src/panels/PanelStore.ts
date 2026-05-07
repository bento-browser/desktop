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

export class PanelStore {
  // workspaceId → ordered array of tab IDs that are panels for that workspace
  #byWorkspace = new Map<string, number[]>();
  #persistence = new Persistence();
  /** Persisted URLs from last shutdown, keyed by workspaceId. Consumed by
   * the boot restorer (background.ts) and then cleared. Surviving here
   * lets the restorer run after TabRegistry + WorkspaceStore are ready. */
  #persistedUrls = new Map<string, string[]>();

  async init(): Promise<void> {
    const persisted = await load();
    if (persisted) this.#persistedUrls = persisted.byWorkspace;
  }

  /** Pop the persisted URLs for a workspace, returning undefined after
   * the first call. Used by the boot restorer; after a workspace is
   * restored we don't want to re-run on subsequent activations. */
  takePersistedUrls(workspaceId: string): string[] | undefined {
    const urls = this.#persistedUrls.get(workspaceId);
    if (urls) this.#persistedUrls.delete(workspaceId);
    return urls;
  }

  /** All workspaceIds that still have unconsumed persisted URLs. */
  workspacesWithPersistedUrls(): string[] {
    return Array.from(this.#persistedUrls.keys());
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

  /** Remove a tab from a workspace's panels. Returns true if removed. */
  remove(workspaceId: string, tabId: number): boolean {
    const list = this.#byWorkspace.get(workspaceId);
    if (!list) return false;
    const next = list.filter((id) => id !== tabId);
    if (next.length === list.length) return false;
    if (next.length === 0) this.#byWorkspace.delete(workspaceId);
    else this.#byWorkspace.set(workspaceId, next);
    this.#schedulePersist();
    return true;
  }

  /** Drop all panels for a workspace (call when the workspace is deleted). */
  removeWorkspace(workspaceId: string): void {
    if (!this.#byWorkspace.delete(workspaceId)) return;
    this.#persistedUrls.delete(workspaceId);
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
    // Snapshot the map so the persistence layer's async flush sees the
    // state at schedule time, not whatever happens to be in #byWorkspace
    // when the debounce fires.
    this.#persistence.schedule(new Map(this.#byWorkspace));
  }
}
