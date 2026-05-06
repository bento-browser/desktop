// Source-of-truth side panel tracker — multi-panel.
//
// Each workspace has an ordered array of tabIds that render as side
// panels (left-to-right). A tab can be a panel in at most one workspace
// at a time (single-binding). The panels render in chrome as N <browser>
// elements inside the existing #bento-side-panel-host strip; chrome
// reconciles based on the snapshot we broadcast (panels/sync event).
//
// Persistence is intentionally session-only — Firefox tab IDs aren't
// stable across browser restarts, so persisting them across restarts is
// a footgun. (Restoring panels by URL after session-restore is a
// separate future enhancement.)

export interface PanelEntry {
  tabId: number;
}

export class PanelStore {
  // workspaceId → ordered array of tab IDs that are panels for that workspace
  #byWorkspace = new Map<string, number[]>();

  /** No-op for parity with other stores (PanelStore is session-only). */
  async init(): Promise<void> {}

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
    return true;
  }

  /** Drop all panels for a workspace (call when the workspace is deleted). */
  removeWorkspace(workspaceId: string): void {
    this.#byWorkspace.delete(workspaceId);
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
}
