import type { TabSnapshot } from '@shared/protocol';
import type { WindowClosingTabSnapshot } from '../tabs/TabRegistry';

export interface ParkedWorkspaceTab {
  url: string;
  title: string;
  customTitle?: string;
  pinned: boolean;
  index: number;
}

/**
 * What a closing window may leave in storage for one workspace: a URL per panel
 * tab (for `PanelStore.parkWorkspaceWithResolvedUrls`) and the sidebar tabs to
 * restore later. Private tabs contribute nothing, so no URL or title from a
 * private window is parked. A blank page is not restored: the blank tab a window
 * hands its other tabs over from stays behind to be closed with it.
 */
export function parkableWorkspaceTabs(
  workspaceTabs: readonly WindowClosingTabSnapshot[],
  panelTabIds: ReadonlySet<number>,
  isPrivate: (tabId: number) => boolean,
): { urlByTabId: Map<number, string>; sidebarTabs: ParkedWorkspaceTab[] } {
  const persistable = workspaceTabs.filter((tab) => !isPrivate(tab.id));
  const urlByTabId = new Map<number, string>();
  for (const tab of persistable) {
    if (tab.url) urlByTabId.set(tab.id, tab.url);
  }
  const sidebarTabs = persistable
    .filter((tab) => !panelTabIds.has(tab.id) && tab.url && tab.url !== 'about:blank')
    .sort((a, b) => a.index - b.index)
    .map((tab) => ({
      url: tab.url!,
      title: tab.title,
      customTitle: tab.customTitle,
      pinned: tab.pinned,
      index: tab.index,
    }));
  return { urlByTabId, sidebarTabs };
}

/**
 * True when a panel tab of the workspace is open in a window other than `windowId`. Such a
 * workspace keeps its panel layout when `windowId` closes: parking it would rebuild the
 * layout from the URLs of the tabs still in the closing window and drop the live panels.
 */
export function hasPanelsInOtherWindow(
  panelTabIds: ReadonlySet<number>,
  tabs: readonly TabSnapshot[],
  windowId: number,
): boolean {
  return tabs.some((tab) => panelTabIds.has(tab.id) && tab.windowId !== windowId);
}

/**
 * What a closing window parks for one workspace. A window that handed its tabs over leaves
 * only what could not or need not move; when other panels of the workspace live in another
 * window, the layout stays with them (`keepPanelLayout`) and a panel stranded here is parked
 * as a sidebar tab, so its page is not lost with a layout slot that no longer exists.
 */
export function planWorkspaceParking(args: {
  workspaceTabs: readonly WindowClosingTabSnapshot[];
  panelTabIds: ReadonlySet<number>;
  tabsNow: readonly TabSnapshot[];
  windowId: number;
  isPrivate: (tabId: number) => boolean;
}): ReturnType<typeof parkableWorkspaceTabs> & { keepPanelLayout: boolean } {
  const keepPanelLayout = hasPanelsInOtherWindow(args.panelTabIds, args.tabsNow, args.windowId);
  const parked = parkableWorkspaceTabs(
    args.workspaceTabs,
    keepPanelLayout ? new Set<number>() : args.panelTabIds,
    args.isPrivate,
  );
  return { ...parked, keepPanelLayout };
}
