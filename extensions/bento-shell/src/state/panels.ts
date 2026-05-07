// Downstream mirror of bento-tools' PanelStore for the active workspace.
// Panels and tabs are disjoint in Bento's model: a tab promoted to a side
// panel disappears from the sidebar list. The sidebar filter
// (useWorkspaceTabIds) consults this store to subtract panel ids from the
// rendered tab list.
//
// PanelStore in tools is keyed by workspace, but `panels/sync` only ever
// emits for the currently-active workspace (and re-emits on workspace
// activation). So this store always reflects the active workspace; we
// don't need a per-workspace mirror here.

import { create } from 'zustand';

interface PanelsState {
  /** Set of tabIds currently rendered as side panels in the active workspace. */
  ids: Set<number>;
  apply: (tabIds: number[]) => void;
}

export const usePanelsStore = create<PanelsState>((set) => ({
  ids: new Set(),
  apply: (tabIds) => set({ ids: new Set(tabIds) }),
}));
