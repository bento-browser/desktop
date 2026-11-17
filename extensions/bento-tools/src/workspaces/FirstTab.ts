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

/**
 * How a first tab ended up. Only `selected` leaves a tab of the workspace selected in the window.
 * - `selected`: selected in the window it opened in (the new tab, or the fallback opened selected)
 *   when that call resolved. It can move, close or lose the window to another workspace after
 *   that, so a caller that acts on it later (a workspace delete) reads the window again.
 * - `superseded`: the window moved on; kept, unselected, as the workspace's tab.
 * - `displaced`: moved to another window, out of the workspace, closing or gone before it could
 *   be selected; left unselected.
 * - `unselected`: selecting it and opening a selected fallback both failed, or it has no id.
 */
export interface FirstTabOutcome {
  status: 'selected' | 'superseded' | 'displaced' | 'unselected';
  tab: browser.tabs.Tab;
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
 *   in the workspace (per the registry) and not closing. Otherwise it is left unselected
 *   (`displaced`) and no other tab is opened here, so a tab dragged to another window is not
 *   selected there. `openWorkspaceFirstTabOnce` opens the one replacement.
 * - Superseded once the tab exists: it is kept, unselected, as the workspace's tab (assigned in
 *   memory, and marked unless that write failed), like the tabs of any workspace the window
 *   left; the next activation selects it instead of opening another. It is not closed: the
 *   window's new workspace may have no tab yet, and the removal would read as it emptying.
 * - Selection failed: a selected tab is opened the old way, so the window does not stay on a
 *   tab of the workspace it left.
 *
 * A failed first create rejects.
 */
export async function openWorkspaceFirstTab(deps: FirstTabDeps): Promise<FirstTabOutcome> {
  const { workspaceId, tabs, stillCurrent } = deps;
  const where = {
    ...(deps.url !== undefined ? { url: deps.url } : {}),
    ...(deps.windowId !== null ? { windowId: deps.windowId } : {}),
  };
  const created = await browser.tabs.create({ ...where, active: false });
  if (typeof created.id !== 'number') return { status: 'unselected', tab: created };
  await tabs.assignWorkspaceEagerly(created.id, workspaceId);
  if (!stillCurrent()) return { status: 'superseded', tab: created };
  if (!(await stillInPlace(tabs, created.id, created.windowId, workspaceId))) {
    return { status: stillCurrent() ? 'displaced' : 'superseded', tab: created };
  }
  // The re-read is another await: a later activation may own the window by now.
  if (!stillCurrent()) return { status: 'superseded', tab: created };
  try {
    await browser.tabs.update(created.id, { active: true });
    return { status: 'selected', tab: created };
  } catch (err) {
    console.warn('[bento-tools] selecting the new workspace tab failed:', created.id, err);
  }
  if (!stillCurrent()) return { status: 'superseded', tab: created };
  try {
    const fallback = await browser.tabs.create({ ...where, active: true });
    if (typeof fallback.id !== 'number') return { status: 'unselected', tab: created };
    void tabs.assignWorkspaceEagerly(fallback.id, workspaceId);
    return { status: 'selected', tab: fallback };
  } catch (err) {
    console.warn('[bento-tools] opening a selected workspace tab failed:', err);
    return { status: 'unselected', tab: created };
  }
}

/**
 * `openWorkspaceFirstTab`, opened once more when the first tab was displaced (dragged away,
 * reassigned or closed during its marker write) while the window still shows the workspace, so
 * the window does not stay on the tab of the workspace it left. One retry only: a second
 * displaced tab is reported as is.
 */
export async function openWorkspaceFirstTabOnce(deps: FirstTabDeps): Promise<FirstTabOutcome> {
  const first = await openWorkspaceFirstTab(deps);
  if (first.status !== 'displaced' || !deps.stillCurrent()) return first;
  return openWorkspaceFirstTab(deps);
}
