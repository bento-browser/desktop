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
 * private window is parked.
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
