// Downstream mirror of bento-tools' WorkspaceStore (§4.2 mirror pattern).
// Same contract as state/tabs.ts: UI dispatches Actions through useToolsPort,
// tools mutates persistent state and broadcasts deltas, this listener applies
// them. UI never mutates the store directly.

import { create } from 'zustand';
import type { Workspace, WorkspaceDelta } from '@shared/protocol';

interface WorkspacesState {
  byId: Record<string, Workspace>;
  /** Insertion-order list, sorted by createdAt for stable rendering. */
  orderedIds: string[];
  activeId: string | null;

  applySnapshot: (workspaces: Workspace[], activeId: string | null) => void;
  applyDeltas: (deltas: WorkspaceDelta[]) => void;
}

function recomputeOrder(byId: Record<string, Workspace>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((w) => w.id);
}

export const useWorkspacesStore = create<WorkspacesState>((set) => ({
  byId: {},
  orderedIds: [],
  activeId: null,

  applySnapshot: (workspaces, activeId) => {
    const byId: Record<string, Workspace> = {};
    for (const w of workspaces) byId[w.id] = w;
    set({ byId, orderedIds: recomputeOrder(byId), activeId });
  },

  applyDeltas: (deltas) => {
    set((state) => {
      const byId = { ...state.byId };
      let activeId = state.activeId;
      let needsReorder = false;

      for (const d of deltas) {
        switch (d.kind) {
          case 'created':
            byId[d.workspace.id] = d.workspace;
            needsReorder = true;
            break;
          case 'updated': {
            const existing = byId[d.id];
            if (!existing) break;
            byId[d.id] = { ...existing, ...d.changes };
            break;
          }
          case 'removed':
            delete byId[d.id];
            if (activeId === d.id) activeId = null;
            needsReorder = true;
            break;
          case 'activated':
            activeId = d.id;
            break;
        }
      }

      return {
        byId,
        activeId,
        ...(needsReorder ? { orderedIds: recomputeOrder(byId) } : {}),
      };
    });
  },
}));

/** Selector hook: subscribes only to the workspace with this id. */
export function useWorkspace(id: string | null): Workspace | undefined {
  return useWorkspacesStore((s) => (id ? s.byId[id] : undefined));
}
