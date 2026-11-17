// Opening the tab a window shows when it switches to a workspace that has none. Kept apart from
// background.ts so the order of its steps can be tested.

import type { TabRegistry } from '../tabs/TabRegistry';

export interface FirstTabDeps {
  workspaceId: string;
  /** The window the tab opens in (null: wherever Firefox opens it). */
  windowId: number | null;
  /** Omitted: the New Tab page. */
  url?: string;
  tabs: Pick<TabRegistry, 'assignWorkspaceEagerly' | 'isClosing' | 'snapshot'>;
  /** False once the window no longer shows the workspace (a later activation owns it). */
  stillCurrent: () => boolean;
}

/**
 * Opens a tab for the workspace and selects it once its workspace marker is written. Chrome
 * reads the selected tab's marker at TabSelect to tell a workspace switch apart
 * (`shouldDeferReconcileForWorkspaceSwitch` in the mount script). A tab selected before its
 * marker exists is drawn at once beside the old workspace's panels, and the switch fade then
 * runs over content that has already changed, so the tab opens unselected first.
 *
 * - Marker write failed: the tab is still selected, without the fade (the old behaviour).
 * - Moved during the write: selected only while it is still in the window it opened in, still
 *   in the workspace (per the registry) and not closing. Otherwise it is left unselected and no
 *   other tab is opened, so a tab dragged to another window is not selected there.
 * - Superseded once the tab exists: it is kept, unselected, as the workspace's tab (assigned in
 *   memory, and marked unless that write failed), like the tabs of any workspace the window
 *   left; the next activation selects it instead of opening another. It is not closed: the
 *   window's new workspace may have no tab yet, and the removal would read as it emptying.
 * - Selection failed: a selected tab is opened the old way, so the window does not stay on a
 *   tab of the workspace it left.
 *
 * Returns the tab that was opened (selected or kept), or null when none could be opened. A
 * failed first create rejects.
 */
/** Whether the new tab is still where it opened: the same window (read from Firefox, since the
 * registry learns of a move only from events), the workspace in the registry, and not closing. A
 * tab the registry does not hold yet keeps the eager assignment it was created with. */
async function stillInPlace(
  tabs: FirstTabDeps['tabs'],
  id: number,
  windowId: number | undefined,
  workspaceId: string,
): Promise<boolean> {
  const now = await browser.tabs.get(id).catch(() => null);
  if (!now || now.windowId !== windowId || tabs.isClosing(id)) return false;
  const tracked = tabs.snapshot().find((tab) => tab.id === id);
  return tracked === undefined || tracked.workspaceId === workspaceId;
}

export async function openWorkspaceFirstTab(deps: FirstTabDeps): Promise<browser.tabs.Tab | null> {
  const { workspaceId, tabs, stillCurrent } = deps;
  const where = {
    ...(deps.url !== undefined ? { url: deps.url } : {}),
    ...(deps.windowId !== null ? { windowId: deps.windowId } : {}),
  };
  const created = await browser.tabs.create({ ...where, active: false });
  if (typeof created.id !== 'number') return null;
  await tabs.assignWorkspaceEagerly(created.id, workspaceId);
  if (!stillCurrent()) return created;
  if (!(await stillInPlace(tabs, created.id, created.windowId, workspaceId))) return created;
  // The re-read is another await: a later activation may own the window by now.
  if (!stillCurrent()) return created;
  try {
    await browser.tabs.update(created.id, { active: true });
    return created;
  } catch (err) {
    console.warn('[bento-tools] selecting the new workspace tab failed:', created.id, err);
  }
  if (!stillCurrent()) return created;
  try {
    const fallback = await browser.tabs.create({ ...where, active: true });
    if (typeof fallback.id !== 'number') return created;
    void tabs.assignWorkspaceEagerly(fallback.id, workspaceId);
    return fallback;
  } catch (err) {
    console.warn('[bento-tools] opening a selected workspace tab failed:', err);
    return created;
  }
}
