// Which panel can take over as a workspace's main tab when its last sidebar tab
// goes away. Promotion activates the panel's tab, so a panel whose tab is
// closing (or already gone) cannot be promoted: it fails to activate and the
// workspace is left on a tab Firefox is about to drop.

import type { TabSnapshot } from '@shared/protocol';

/** Panels whose tab is still open and not on its way out, in panel order. */
export function livePanelIds(
  panelTabIds: readonly number[],
  tabs: readonly TabSnapshot[],
  isClosing: (tabId: number) => boolean,
): number[] {
  const openIds = new Set(tabs.map((tab) => tab.id));
  return panelTabIds.filter((tabId) => openIds.has(tabId) && !isClosing(tabId));
}

/**
 * The panel to promote after `leavingTabId` left `windowId` without closing
 * (torn out or dragged to another window, so no tab-removed event follows): the
 * leftmost live panel, when the tab was the workspace's last sidebar tab in
 * that window. Null when another sidebar tab stays or no panel can take over.
 */
export function panelToPromoteAfterDetach(args: {
  workspaceId: string;
  leavingTabId: number;
  windowId: number;
  tabs: readonly TabSnapshot[];
  panelTabIds: readonly number[];
  isClosing: (tabId: number) => boolean;
}): number | null {
  const panelIds = new Set(args.panelTabIds);
  const staysBehind = args.tabs.some(
    (tab) =>
      tab.id !== args.leavingTabId &&
      tab.windowId === args.windowId &&
      tab.workspaceId === args.workspaceId &&
      !panelIds.has(tab.id) &&
      !args.isClosing(tab.id),
  );
  if (staysBehind) return null;
  const candidates = livePanelIds(
    args.panelTabIds,
    args.tabs.filter((tab) => tab.windowId === args.windowId),
    args.isClosing,
  );
  return candidates[0] ?? null;
}
