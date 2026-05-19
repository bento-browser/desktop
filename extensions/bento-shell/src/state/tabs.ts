// Downstream mirror of bento-tools' TabRegistry (§4.2 mirror pattern).
// UI never mutates this directly — it dispatches Actions through useToolsPort,
// tools applies them and broadcasts deltas back, the listener applies the
// deltas to this store.

import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import type { TabDelta, TabSnapshot } from '@shared/protocol';
import { getPanelIdsForWorkspace, usePanelsStore } from './panels';

interface TabsState {
  /** Tab map keyed by id for O(1) selector subscriptions per tab row (§6.4). */
  byId: Record<number, TabSnapshot>;
  /** Insertion-order list, sorted by tab.index. Recomputed on snapshot/delta. */
  orderedIds: number[];
  /** Currently focused tab id (or null on cold boot). */
  activeId: number | null;
  /** True after the first tabs/snapshot from bento-tools has been applied.
   * Sidebar uses this (alongside panels readiness) to defer rendering its
   * tab list until both snapshots have arrived — without it the sidebar
   * flashes the unfiltered tab list for one frame at boot before
   * panels/sync arrives and the filter kicks in. */
  hydrated: boolean;

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
  hydrated: false,

  applySnapshot: (tabs) => {
    const byId: Record<number, TabSnapshot> = {};
    let activeId: number | null = null;
    for (const t of tabs) {
      byId[t.id] = t;
      if (t.active) activeId = t.id;
    }
    set({ byId, orderedIds: recomputeOrder(byId), activeId, hydrated: true });
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

/** Returns ordered tab ids belonging to the given workspace, with panel
 * tabs subtracted. Panels and tabs are disjoint in Bento's model: a tab
 * promoted to a side panel disappears from the sidebar list (the panel is
 * its new home). Tabs without a workspaceId are NOT surfaced anywhere —
 * bento-tools backfills boot-time orphans on init and auto-assigns
 * runtime-created tabs immediately, so the only window where a tab is
 * orphaned is the few ms between onCreated and assignWorkspace's
 * session.set resolving. Hiding orphans here keeps stray tabs from
 * bleeding across workspaces if a future bug ever leaves one unassigned.
 * useShallow keeps the array reference stable between renders so TabList
 * only re-renders when the filtered set actually changes. */
export function useWorkspaceTabIds(workspaceId: string | null, windowId?: number | null): number[] {
  const tabIds = useTabsStore(
    useShallow((s) => {
      if (!workspaceId && typeof windowId !== 'number') return s.orderedIds;
      const out: number[] = [];
      for (const id of s.orderedIds) {
        const tab = s.byId[id];
        if (!tab) continue;
        if (workspaceId && tab.workspaceId !== workspaceId) continue;
        // Filter by windowId so each window's sidebar only shows tabs
        // that physically live in its OWN gBrowser. With the "one
        // workspace per window" enforcement, the sidebar in window B
        // would otherwise also list tabs from window A's gBrowser that
        // happen to share the same workspaceId (orphans from a prior
        // workspace switch, or tabs created when another window owned
        // the workspace). Clicking those cross-window tabs dispatches
        // tab/activate → browser.tabs.update activates the tab in its
        // own window (and focuses it) — symptom: clicking in window B
        // marks the tab active in B's sidebar but the main slot stays
        // on the previous tab. Hiding cross-window tabs avoids the
        // confusion. Phase C twin-tabs will fix this properly by
        // mirroring tabs across windows. Caller passing `undefined`
        // gets the legacy workspace-only filter (overlays, Ladle).
        if (typeof windowId === 'number' && tab.windowId !== windowId) continue;
        out.push(id);
      }
      return out;
    }),
  );
  // Per-workspace panel filter. The store keeps the Set reference
  // stable for a given workspace until panels/sync replaces it, so
  // useMemo below returns the same array unless the inputs actually
  // change.
  const panelIds = usePanelsStore((s) => getPanelIdsForWorkspace(s, workspaceId));
  return useMemo(() => {
    if (panelIds.size === 0) return tabIds;
    return tabIds.filter((id) => !panelIds.has(id));
  }, [tabIds, panelIds]);
}
