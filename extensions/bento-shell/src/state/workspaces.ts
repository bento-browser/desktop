// Downstream mirror of bento-tools' WorkspaceStore (§4.2 mirror pattern).
// Same contract as state/tabs.ts: UI dispatches Actions through useToolsPort,
// tools mutates persistent state and broadcasts deltas, this listener applies
// them. UI never mutates the store directly.
//
// Per-window active workspace (phase A.2): tracks both a global fallback
// `activeId` (legacy single-window state, persisted by tools) and a
// `activeIdByWindow` map populated by per-window activations.
// Selectors like `useActiveWorkspaceForCurrentWindow()` read the per-
// window value when this shell document knows its windowId (resolved by
// useToolsPort on mount), falling back to the global value otherwise.

import { create } from 'zustand';
import type { Workspace, WorkspaceDelta } from '@shared/protocol';

interface WorkspacesState {
  byId: Record<string, Workspace>;
  /** Insertion-order list, sorted by createdAt for stable rendering. */
  orderedIds: string[];
  /** Global fallback active workspace. Persisted across sessions. Used
   * when the shell document hasn't yet captured its windowId, when the
   * window hasn't activated a workspace per-window yet, or by legacy
   * single-window code paths. */
  activeId: string | null;
  /** Per-window active workspace map. Mirrors `WorkspaceStore.#activeIdByWindow`
   * in tools. Updated by `activated` deltas carrying a `windowId`. */
  activeIdByWindow: Record<number, string>;

  applySnapshot: (
    workspaces: Workspace[],
    activeId: string | null,
    activeIdByWindow: Record<number, string>,
  ) => void;
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
  activeIdByWindow: {},

  applySnapshot: (workspaces, activeId, activeIdByWindow) => {
    const byId: Record<string, Workspace> = {};
    for (const w of workspaces) byId[w.id] = w;
    set({ byId, orderedIds: recomputeOrder(byId), activeId, activeIdByWindow });
  },

  applyDeltas: (deltas) => {
    set((state) => {
      const byId = { ...state.byId };
      let activeId = state.activeId;
      const activeIdByWindow = { ...state.activeIdByWindow };
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
            // Strip any per-window entries pointing at the removed
            // workspace. Tools will follow up with `activated` deltas for
            // a replacement; we just clear the stale entry here.
            for (const [winId, wsId] of Object.entries(activeIdByWindow)) {
              if (wsId === d.id) delete activeIdByWindow[Number(winId)];
            }
            needsReorder = true;
            break;
          case 'activated':
            if (typeof d.windowId === 'number') {
              activeIdByWindow[d.windowId] = d.id;
            } else {
              activeId = d.id;
            }
            break;
        }
      }

      return {
        byId,
        activeId,
        activeIdByWindow,
        ...(needsReorder ? { orderedIds: recomputeOrder(byId) } : {}),
      };
    });
  },
}));

/** Selector hook: subscribes only to the workspace with this id. */
export function useWorkspace(id: string | null): Workspace | undefined {
  return useWorkspacesStore((s) => (id ? s.byId[id] : undefined));
}

/** Resolve the active workspace id for a specific window. Returns:
 *   - The window's own per-window active workspace when set.
 *   - The global fallback `activeId` only if no OTHER window has it
 *     active (Bento enforces "one workspace per window" — silently
 *     showing the same workspace in two windows produces broken panel
 *     state pending Phase C).
 *   - null when the window has no assignment AND the fallback would
 *     conflict with another window. The shell renders an empty / picker
 *     state in that case.
 * Pass null/undefined for the legacy "I don't know my windowId" path
 * (Ladle previews, standalone vite). Same fallback as before applies
 * since there's no specific window to enforce isolation for. */
export function selectActiveIdForWindow(
  state: WorkspacesState,
  windowId: number | null,
): string | null {
  if (typeof windowId === 'number') {
    const perWindow = state.activeIdByWindow[windowId];
    if (perWindow) return perWindow;
    // Try the global fallback, but only if no OTHER window owns it.
    const fallback = state.activeId;
    if (!fallback) return null;
    for (const otherWinIdStr of Object.keys(state.activeIdByWindow)) {
      const otherWinId = Number(otherWinIdStr);
      if (otherWinId === windowId) continue;
      if (state.activeIdByWindow[otherWinId] === fallback) return null;
    }
    return fallback;
  }
  return state.activeId;
}

/** Zustand-selector variant of `selectActiveIdForWindow`. Subscribes only
 * to the relevant state slices — re-renders when this window's active
 * workspace changes OR (during the pre-windowId gap) when the global
 * fallback changes. Mirror equivalent of bento-tools'
 * `WorkspaceStore.getActiveId(windowId)`. */
export function useActiveWorkspaceIdForWindow(windowId: number | null): string | null {
  return useWorkspacesStore((s) => selectActiveIdForWindow(s, windowId));
}
