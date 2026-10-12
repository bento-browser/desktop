// A tab can arrive in a window by itself: torn out of another window, dragged
// into one, or adopted as the first tab of a new window. Firefox keeps the tab
// id, and its SessionStore values come along, so the tab still names the
// workspace (and panel slot) of the window it left. Without releasing that, the
// tab is hidden from the destination sidebar and the new window opens an extra
// blank tab for its own, apparently empty, workspace.

import type { TabSnapshot } from '@shared/protocol';

export interface AdoptedTabDeps {
  tabs: {
    snapshot(): TabSnapshot[];
    clearWorkspace(id: number): Promise<void>;
    assignWorkspaceEagerly(id: number, workspaceId: string): Promise<boolean>;
  };
  workspaces: {
    findOwningWindow(workspaceId: string): number | null;
    getActiveId(windowId: number): string | null;
  };
  panels: {
    findWorkspacesContainingTab(tabId: number): string[];
    remove(workspaceId: string, tabId: number): boolean;
  };
  clearPanelMarker(tabId: number): Promise<void>;
  syncPanelMarkers(workspaceId: string): void;
  emitPanelsSync(workspaceId: string): void;
}

/**
 * Detach a tab that arrived in `newWindowId` from the workspace it carried.
 * A tab whose workspace the destination window shows keeps it (Bento's own
 * cross-window move on workspace activation). Otherwise the tab leaves its
 * panel layouts, loses the stale workspace, and joins the destination's
 * workspace now when it has one; a window that has not claimed a workspace yet
 * assigns it on its first activation (`adoptableTabs`).
 */
export async function releaseAdoptedTab(
  deps: AdoptedTabDeps,
  tabId: number,
  newWindowId: number,
): Promise<void> {
  const tab = deps.tabs.snapshot().find((candidate) => candidate.id === tabId);
  if (!tab?.workspaceId) return;
  if (deps.workspaces.findOwningWindow(tab.workspaceId) === newWindowId) return;

  const panelWorkspaceIds = deps.panels
    .findWorkspacesContainingTab(tabId)
    .filter((workspaceId) => deps.panels.remove(workspaceId, tabId));
  if (panelWorkspaceIds.length > 0) await deps.clearPanelMarker(tabId);
  for (const workspaceId of panelWorkspaceIds) {
    deps.syncPanelMarkers(workspaceId);
    deps.emitPanelsSync(workspaceId);
  }

  await deps.tabs.clearWorkspace(tabId);
  const destinationId = deps.workspaces.getActiveId(newWindowId);
  if (destinationId) await deps.tabs.assignWorkspaceEagerly(tabId, destinationId);
}

/**
 * The tabs a freshly opened window should treat as its own when its workspace
 * has no tab yet, instead of opening a blank one: tabs without a workspace (the
 * window's initial tab, or tabs `releaseAdoptedTab` detached when several were
 * moved in together). Only a window where no tab has a workspace qualifies, so
 * switching to an empty workspace in a working window still opens its own tab.
 */
export function adoptableTabs(
  windowTabs: readonly TabSnapshot[],
  isClosing: (tabId: number) => boolean,
  isPrivate: (tabId: number) => boolean,
): TabSnapshot[] {
  if (windowTabs.some((tab) => tab.workspaceId)) return [];
  return windowTabs.filter((tab) => !isClosing(tab.id) && !isPrivate(tab.id));
}

/**
 * Which windows may adopt unassigned tabs. SessionStore restores tabs (and their
 * `bento.workspaceId` values) after the registry's first read, so before startup
 * has settled and hydrated an unassigned tab may only be an unread one, and writing
 * the window's workspace onto it would overwrite the real assignment. Only windows
 * created after that point qualify.
 */
export interface AdoptionGate {
  /** Remember a window that exists before the gate settles. */
  noteWindow(windowId: number): void;
  settle(): void;
  isSettled(): boolean;
  allows(windowId: number): boolean;
}

export function createAdoptionGate(): AdoptionGate {
  const startupWindows = new Set<number>();
  let settled = false;
  return {
    noteWindow(windowId) {
      if (!settled) startupWindows.add(windowId);
    },
    settle() {
      settled = true;
    },
    isSettled: () => settled,
    allows: (windowId) => settled && !startupWindows.has(windowId),
  };
}

/**
 * The tabs a window may adopt when its workspace has none: `adoptableTabs`, for a
 * window the gate allows, once their session metadata has been read and found
 * empty. One tab with a value (a restored window, an undone window close) means
 * the window is not fresh and nothing is adopted.
 */
export async function tabsToAdopt(args: {
  gate: Pick<AdoptionGate, 'allows'>;
  windowId: number;
  snapshot: () => TabSnapshot[];
  isClosing: (tabId: number) => boolean;
  isPrivate: (tabId: number) => boolean;
  confirmUnassigned: (tabIds: number[]) => Promise<number[]>;
}): Promise<TabSnapshot[]> {
  if (!args.gate.allows(args.windowId)) return [];
  const inWindow = () => args.snapshot().filter((tab) => tab.windowId === args.windowId);
  const first = adoptableTabs(inWindow(), args.isClosing, args.isPrivate);
  if (first.length === 0) return [];
  const confirmed = new Set(await args.confirmUnassigned(first.map((tab) => tab.id)));
  // Tabs can change while the metadata is read; judge the window as it is now.
  const current = adoptableTabs(inWindow(), args.isClosing, args.isPrivate);
  return current.every((tab) => confirmed.has(tab.id)) ? current : [];
}
