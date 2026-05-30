// Downstream mirror of bento-tools' PanelStore. Panels and tabs are disjoint
// in Bento's model: a tab promoted to a side panel disappears from the
// sidebar list. The sidebar filter (useWorkspaceTabIds) consults this store
// to subtract panel ids from the rendered tab list.
//
// Keyed by workspaceId. bento-tools emits panels/sync for EVERY workspace
// (at boot + on every change), so the slide animation between workspaces
// can render each pane with the correct panel filter from frame 1 — without
// a per-workspace store, the previous-active workspace's panel set briefly
// filtered the new-active tab list during the slide and panel tabs leaked
// into the sidebar until the next panels/sync arrived.

import { create } from 'zustand';

interface PanelsState {
  /** workspaceId → set of tabIds currently rendered as side panels. */
  byWorkspace: Map<string, Set<number>>;
  /** Workspaces that have received their first panels/sync this session. */
  hydratedWorkspaces: Set<string>;
  apply: (workspaceId: string, tabIds: number[]) => void;
}

const EMPTY: Set<number> = new Set();

export const usePanelsStore = create<PanelsState>((set) => ({
  byWorkspace: new Map(),
  hydratedWorkspaces: new Set(),
  apply: (workspaceId, tabIds) =>
    set((state) => {
      const nextByWorkspace = new Map(state.byWorkspace);
      nextByWorkspace.set(workspaceId, new Set(tabIds));
      let nextHydrated = state.hydratedWorkspaces;
      if (!nextHydrated.has(workspaceId)) {
        nextHydrated = new Set(nextHydrated);
        nextHydrated.add(workspaceId);
      }
      return {
        byWorkspace: nextByWorkspace,
        hydratedWorkspaces: nextHydrated,
      };
    }),
}));

/** Read the panel ids for a workspace. Returns a stable empty Set when the
 *  workspace has no panels yet (haven't received its panels/sync). */
export function getPanelIdsForWorkspace(
  state: PanelsState,
  workspaceId: string | null,
): Set<number> {
  if (!workspaceId) return EMPTY;
  return state.byWorkspace.get(workspaceId) ?? EMPTY;
}
