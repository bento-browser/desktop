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

/**
 * The parked lists a browser start drops. Firefox restores the windows of the last session with
 * their tabs itself, so replaying a list parked at quit would open each of those tabs a second
 * time and could move the selection. No address comparison can tell the two apart: a restored tab
 * that is still loading, such as the selected one or a pinned one, reports no address. The decision
 * looks at membership only: a workspace with a tab in a window that came back from the session had
 * its tabs restored. A tab in any other window (the one a fresh start opens) does not count. Lists
 * of other workspaces, whose window was closed and not restored, stay for their next activation.
 *
 * Only a real browser start (`browserStarted`, the `runtime.onStartup` signal) may drop a list.
 * When bento-tools reloads under a running browser, a workspace can have a tab in a window that
 * survived because a closing window handed it over, and its list still holds the tab that window
 * could not move: dropping it would lose that tab. So with `browserStarted` false nothing is dropped.
 */
export function parkedWorkspacesToDiscard(
  parkedWorkspaceIds: Iterable<string>,
  liveTabs: ReadonlyArray<Pick<TabSnapshot, 'windowId' | 'workspaceId'>>,
  restoredWindowIds: ReadonlySet<number>,
  browserStarted: boolean,
): string[] {
  if (!browserStarted) return [];
  const restored = new Set<string>();
  for (const tab of liveTabs) {
    if (tab.workspaceId && restoredWindowIds.has(tab.windowId)) restored.add(tab.workspaceId);
  }
  return [...parkedWorkspaceIds].filter((workspaceId) => restored.has(workspaceId));
}

export interface ParkedRestoreStep {
  entry: ParkedWorkspaceTab;
  /** The live tab that already shows the entry's address, consumed once. */
  existingTabId: number | null;
  /** Whether restoring this entry selects it. */
  active: boolean;
}

/**
 * Pairs each parked entry (in index order) with a live tab that already shows its URL, and says
 * whether restoring it takes the selection: only the first does, and not when it opens a new tab
 * while the workspace already has live tabs. Those include pages a closing window handed over,
 * and a parked empty New Tab must not win over the page the user was on; the workspace
 * activation picks the remembered tab when nothing is selected.
 */
export function planParkedRestore(
  parked: readonly ParkedWorkspaceTab[],
  liveUrlByTabId: ReadonlyMap<number, string>,
  liveTabCount: number,
): ParkedRestoreStep[] {
  const consumed = new Set<number>();
  return parked.map((entry, index) => {
    let existingTabId: number | null = null;
    for (const [tabId, url] of liveUrlByTabId) {
      if (consumed.has(tabId) || url !== entry.url) continue;
      existingTabId = tabId;
      consumed.add(tabId);
      break;
    }
    const active = index === 0 && (existingTabId !== null || liveTabCount === 0);
    return { entry, existingTabId, active };
  });
}
