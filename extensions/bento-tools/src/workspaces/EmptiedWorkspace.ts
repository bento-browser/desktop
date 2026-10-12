// What a window does when a tab closes and its workspace has no sidebar tab left.
// Kept apart from background.ts so the decision can be tested with real stores.

import type { TabSnapshot } from '@shared/protocol';
import { livePanelIds } from '../panels/PanelPromotion';

/**
 * Windows whose workspace is being replaced (a workspace delete moved the window
 * to another workspace, which has no tab yet). While a window is handing off,
 * its workspace is not "emptied" by the tabs closing around the handoff.
 */
export interface WindowHandoffGuard {
  /** Mark the window; call the returned function when the handoff is done. */
  begin(windowId: number): () => void;
  isActive(windowId: number): boolean;
}

export function createWindowHandoffGuard(): WindowHandoffGuard {
  const depth = new Map<number, number>();
  return {
    begin(windowId) {
      depth.set(windowId, (depth.get(windowId) ?? 0) + 1);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        const left = (depth.get(windowId) ?? 1) - 1;
        if (left > 0) depth.set(windowId, left);
        else depth.delete(windowId);
      };
    },
    isActive: (windowId) => depth.has(windowId),
  };
}

export type EmptiedWorkspaceAction =
  | { kind: 'none' }
  | { kind: 'promote-panel'; workspaceId: string; panelTabId: number }
  | { kind: 'switch-window'; deleteWorkspaceId: string; candidateId: string }
  | { kind: 'close-window' };

export interface EmptiedWorkspaceDeps {
  tabs: { snapshot(): TabSnapshot[]; isClosing(tabId: number): boolean };
  panels: { getPanels(workspaceId: string): number[] };
  workspaces: {
    getActiveId(windowId: number): string | null;
    getActiveIdByWindow(): Record<number, string>;
    snapshot(): { workspaces: Array<{ id: string }> };
  };
  handoff: Pick<WindowHandoffGuard, 'isActive'>;
  /** True once if the removed tab was a panel whose own removal is already handled. */
  takeRecentlyRemovedPanel(tabId: number): boolean;
}

/**
 * Decide what closing `tabId` in `windowId` means for the window's active
 * workspace. When its last sidebar tab is gone: promote a panel into the main
 * slot, else move the window to a free workspace and delete the empty one, else
 * close the window (match "Cmd+W until done" instead of letting Firefox select a
 * tab of a workspace the window left earlier).
 */
export function afterTabRemoved(
  deps: EmptiedWorkspaceDeps,
  tabId: number,
  windowId: number,
): EmptiedWorkspaceAction {
  if (deps.handoff.isActive(windowId)) return { kind: 'none' };
  const activeWsId = deps.workspaces.getActiveId(windowId);
  if (!activeWsId) return { kind: 'none' };

  // The removed tab is filtered out explicitly because the tabs.onRemoved
  // propagation into the registry is not guaranteed to have run yet.
  const panelTabIds = deps.panels.getPanels(activeWsId);
  const others = deps.tabs.snapshot().filter((t) => t.id !== tabId);
  if (
    others.some(
      (t) => t.windowId === windowId && t.workspaceId === activeWsId && !panelTabIds.includes(t.id),
    )
  ) {
    return { kind: 'none' };
  }

  // A panel that is itself closing (or already gone) cannot become the main tab; counting
  // it would leave the window on a foreign tab with this workspace still active.
  const promotablePanelIds = livePanelIds(panelTabIds, others, (id) => deps.tabs.isClosing(id));
  if (deps.takeRecentlyRemovedPanel(tabId) && promotablePanelIds.length > 0) {
    return { kind: 'none' };
  }
  if (promotablePanelIds.length > 0) {
    return { kind: 'promote-panel', workspaceId: activeWsId, panelTabId: promotablePanelIds[0]! };
  }

  // "Available" = exists, is not shown by another window, and is not the one being
  // deleted. With none, keep the empty workspace and close the window: a future window
  // can pick it up and the orchestrator will spawn a fresh tab on activation.
  const ownedByOthers = new Set(
    Object.entries(deps.workspaces.getActiveIdByWindow())
      .filter(([k]) => Number(k) !== windowId)
      .map(([, v]) => v),
  );
  const candidate = deps.workspaces
    .snapshot()
    .workspaces.find((w) => w.id !== activeWsId && !ownedByOthers.has(w.id));
  return candidate
    ? { kind: 'switch-window', deleteWorkspaceId: activeWsId, candidateId: candidate.id }
    : { kind: 'close-window' };
}
