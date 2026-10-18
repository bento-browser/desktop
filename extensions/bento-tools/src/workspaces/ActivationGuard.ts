// Decisions a workspace activation makes before it moves, creates or selects tabs. Kept apart from
// background.ts so they can be tested with a real WorkspaceStore.

import type { TabSnapshot } from '@shared/protocol';

/**
 * Whether `workspaceId` is still the workspace its window shows (`windowId` null: the global
 * fallback). An activation can wait before it acts (boot holds them until the restore is done)
 * and it awaits tab moves and reads on the way; if the window switched workspaces meanwhile, a
 * later activation owns the window and this one must stop, or it would select a tab of the
 * workspace the window no longer shows.
 */
export function isActivationCurrent(
  workspaceId: string,
  windowId: number | null,
  getActiveId: (windowId: number | null) => string | null,
): boolean {
  return getActiveId(windowId) === workspaceId;
}

/**
 * Whether a tab of the workspace is already the selected tab of the window (`windowId` null: of
 * any window). A selected panel counts as much as a selected sidebar tab: the panel is the page
 * the user was on, and selecting the workspace's first sidebar tab would take the selection away.
 */
export function hasSelectedWorkspaceTab(
  tabs: ReadonlyArray<Pick<TabSnapshot, 'workspaceId' | 'windowId' | 'active'>>,
  workspaceId: string,
  windowId: number | null,
): boolean {
  return tabs.some(
    (tab) =>
      tab.active &&
      tab.workspaceId === workspaceId &&
      (windowId === null || tab.windowId === windowId),
  );
}
