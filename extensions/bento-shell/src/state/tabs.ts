// Downstream mirror of bento-tools' TabRegistry (§4.2 mirror pattern).
// UI never mutates this directly — it dispatches Actions through useToolsPort,
// tools applies them and broadcasts deltas back, the listener applies the
// deltas to this store.

import { create } from 'zustand';
import type { TabDelta, TabSnapshot } from '@shared/protocol';

interface TabsState {
  /** Tab map keyed by id for O(1) selector subscriptions per tab row (§6.4). */
  byId: Record<number, TabSnapshot>;
  /** Insertion-order list, sorted by tab.index. Recomputed on snapshot/delta. */
  orderedIds: number[];
  /** Currently focused tab id (or null on cold boot). */
  activeId: number | null;

  applySnapshot: (tabs: TabSnapshot[]) => void;
  applyDeltas: (deltas: TabDelta[]) => void;
}

function recomputeOrder(byId: Record<number, TabSnapshot>): number[] {
  return Object.values(byId)
    .sort((a, b) => a.index - b.index)
    .map((t) => t.id);
}

export const useTabsStore = create<TabsState>((set) => ({
  byId: {},
  orderedIds: [],
  activeId: null,

  applySnapshot: (tabs) => {
    const byId: Record<number, TabSnapshot> = {};
    let activeId: number | null = null;
    for (const t of tabs) {
      byId[t.id] = t;
      if (t.active) activeId = t.id;
    }
    set({ byId, orderedIds: recomputeOrder(byId), activeId });
  },

  applyDeltas: (deltas) => {
    set((state) => {
      // Shallow copy maps so selector subscriptions tied to specific ids
      // re-render only when their tab changed (§6.4).
      const byId = { ...state.byId };
      let activeId = state.activeId;
      let needsReorder = false;

      for (const d of deltas) {
        switch (d.kind) {
          case 'created':
            byId[d.tab.id] = d.tab;
            if (d.tab.active) activeId = d.tab.id;
            needsReorder = true;
            break;
          case 'updated': {
            const existing = byId[d.id];
            if (!existing) break;
            const merged = { ...existing, ...d.changes };
            byId[d.id] = merged;
            if ('index' in d.changes) needsReorder = true;
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

/** Selector hook: subscribes only to the tab with this id, not the whole map. */
export function useTab(id: number): TabSnapshot | undefined {
  return useTabsStore((s) => s.byId[id]);
}
