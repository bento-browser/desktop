// Downstream mirror of bento-tools' PinnedPanelsStore (§4.2 mirror pattern).
// Pinned panels are GLOBAL across workspaces — every workspace's sidebar
// shows the same entries — so the store keeps a single ordered list rather
// than the per-workspace map used by `state/panels.ts`.
//
// Entries arrive sorted by `order` from tools (PinnedPanelsStore.entries())
// and are kept sorted on each delta apply, so the component can render in
// list order without per-render sorting.

import { create } from 'zustand';
import type { PinnedPanelDelta, PinnedPanelEntry } from '@shared/protocol';

interface PinnedPanelsState {
  /** Ordered ascending by entry.order. */
  entries: PinnedPanelEntry[];
  applySnapshot: (entries: PinnedPanelEntry[]) => void;
  applyDeltas: (deltas: PinnedPanelDelta[]) => void;
}

function sortByOrder(list: PinnedPanelEntry[]): PinnedPanelEntry[] {
  return [...list].sort((a, b) => a.order - b.order);
}

export const usePinnedPanelsStore = create<PinnedPanelsState>((set) => ({
  entries: [],
  applySnapshot: (entries) => set({ entries: sortByOrder(entries) }),
  applyDeltas: (deltas) =>
    set((state) => {
      let next = state.entries;
      let changed = false;
      for (const d of deltas) {
        switch (d.kind) {
          case 'added': {
            // Defensive — tools doesn't double-emit but in-flight
            // reconciliation could see a duplicate after a snapshot
            // re-request. Replace by key just in case.
            const without = next.filter(
              (e) => !(e.workspaceId === d.entry.workspaceId && e.tabId === d.entry.tabId),
            );
            next = [...without, d.entry];
            changed = true;
            break;
          }
          case 'removed': {
            const filtered = next.filter(
              (e) => !(e.workspaceId === d.workspaceId && e.tabId === d.tabId),
            );
            if (filtered.length !== next.length) {
              next = filtered;
              changed = true;
            }
            break;
          }
          case 'updated': {
            next = next.map((e) =>
              e.workspaceId === d.workspaceId && e.tabId === d.tabId ? { ...e, ...d.changes } : e,
            );
            changed = true;
            break;
          }
          case 'reordered':
            next = d.entries;
            changed = true;
            break;
        }
      }
      if (!changed) return {};
      return { entries: sortByOrder(next) };
    }),
}));
