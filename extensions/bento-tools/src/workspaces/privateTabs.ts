// Private tabs are skipped by ordinary workspace assignment and adoption, so this is
// the one place they join a workspace: their window's temporary Private workspace, in
// memory only (no session value is written for them).

import type { TabRegistry } from '../tabs/TabRegistry';
import type { WorkspaceStore } from './WorkspaceStore';

type Workspaces = Pick<WorkspaceStore, 'privateWorkspaceOf'>;
type Tabs = Pick<TabRegistry, 'snapshotPrivate' | 'setWorkspaceInMemory'>;

/** One private tab joins the Private workspace of the window it is in. A window with
 * no Private workspace yet leaves it alone: creating the workspace adopts it. */
export function joinPrivateWorkspace(
  workspaces: Workspaces,
  tabs: Pick<TabRegistry, 'setWorkspaceInMemory'>,
  tabId: number,
  windowId: number,
): void {
  const workspace = workspaces.privateWorkspaceOf(windowId);
  if (workspace) tabs.setWorkspaceInMemory(tabId, workspace.id);
}

/** Every private tab the window already has joins its Private workspace (the
 * workspace was just created, or tools restarted under a live window). */
export function adoptPrivateTabs(workspaces: Workspaces, tabs: Tabs, windowId: number): void {
  const workspace = workspaces.privateWorkspaceOf(windowId);
  if (!workspace) return;
  for (const tab of tabs.snapshotPrivate(windowId)) {
    if (tab.workspaceId !== workspace.id) tabs.setWorkspaceInMemory(tab.id, workspace.id);
  }
}
