import { moveWorkspaceTabsToWindow } from '../tabs/AdoptedTab';
import type { TabRegistry } from '../tabs/TabRegistry';
import { planParkedRestore, type ParkedWorkspaceTab } from './ParkedWorkspace';

export interface ParkedRestoreDeps {
  workspaceId: string;
  /** The window the tabs open in (null: wherever Firefox opens them). */
  targetWindowId: number | null;
  /** The workspace's parked entries in index order, already taken from the parked list. */
  parked: readonly ParkedWorkspaceTab[];
  tabs: Pick<TabRegistry, 'snapshot' | 'rename' | 'assignWorkspaceEagerly'>;
  /** False once a later activation owns the window this restore was started for. */
  stillCurrent: () => boolean;
  /** The window that shows the workspace now, or null when none does. */
  findOwningWindow: (workspaceId: string) => number | null;
}

export interface ParkedRestoreResult {
  /** Whether any entry now has a tab, matched or opened. */
  restored: boolean;
  /**
   * The entries a superseded restore never started. They belong back in the parked list, for the
   * next activation to restore in the window that owns the workspace by then.
   */
  unrestored: ParkedWorkspaceTab[];
}

/**
 * Moves a tab a restore opened in a window that no longer shows the workspace to the window that
 * does. Nothing moves when no window shows it.
 */
async function handOverTab(
  workspaceId: string,
  tab: { id: number; windowId: number | undefined; pinned: boolean },
  findOwningWindow: (workspaceId: string) => number | null,
): Promise<void> {
  const owner = findOwningWindow(workspaceId);
  if (owner === null || owner === tab.windowId) return;
  try {
    await moveWorkspaceTabsToWindow([tab], owner, workspaceId);
  } catch (err) {
    console.warn('[bento-tools] parked tab hand-over failed:', tab.id, err);
  }
}

/**
 * Opens a workspace's parked tabs, or pins and renames the live tab that already shows an entry.
 * It awaits tab reads and creates, and the window may move to another workspace meanwhile. From
 * then on it neither selects nor opens anything: the entries it has not started go back to the
 * caller, so a window that no longer shows the workspace does not collect the rest of its tabs.
 * The tab whose create was already in flight when that happened is handed to the window that
 * owns the workspace now. With no owner it stays, like the tabs of any workspace the window
 * switched away from, and the next activation of the workspace moves it.
 */
export async function restoreParkedEntries(deps: ParkedRestoreDeps): Promise<ParkedRestoreResult> {
  const { workspaceId, targetWindowId, parked, tabs, stillCurrent, findOwningWindow } = deps;
  const existingUrlByTabId = new Map<number, string>();
  const existingTabs = tabs
    .snapshot()
    .filter(
      (tab) =>
        tab.workspaceId === workspaceId &&
        (targetWindowId === null || tab.windowId === targetWindowId),
    )
    .sort((a, b) => a.index - b.index);

  for (const tab of existingTabs) {
    try {
      const live = await browser.tabs.get(tab.id);
      const pendingUrl =
        typeof (live as browser.tabs.Tab & { pendingUrl?: unknown }).pendingUrl === 'string'
          ? (live as browser.tabs.Tab & { pendingUrl?: string }).pendingUrl
          : undefined;
      const url = live.url && live.url !== 'about:blank' ? live.url : pendingUrl;
      if (url && url !== 'about:blank') existingUrlByTabId.set(tab.id, url);
    } catch {
      // Stale registry entries are expected during startup/session restore.
    }
  }

  let restored = false;
  const steps = planParkedRestore(parked, existingUrlByTabId, existingTabs.length);
  for (const [index, step] of steps.entries()) {
    if (!stillCurrent()) {
      return { restored, unrestored: steps.slice(index).map((rest) => rest.entry) };
    }
    const { entry, existingTabId, active } = step;
    if (existingTabId !== null) {
      try {
        if (active || entry.pinned) {
          await browser.tabs.update(existingTabId, {
            ...(active ? { active: true } : {}),
            ...(entry.pinned ? { pinned: true } : {}),
          });
        }
      } catch (err) {
        console.warn('[bento-tools] parked tab session-restore match failed:', existingTabId, err);
      }
      if (entry.customTitle) {
        void tabs.rename(existingTabId, entry.customTitle);
      }
      restored = true;
      continue;
    }

    try {
      const created = await browser.tabs.create({
        url: entry.url,
        active,
        ...(targetWindowId !== null ? { windowId: targetWindowId } : {}),
      });
      if (typeof created.id !== 'number') continue;
      tabs.assignWorkspaceEagerly(created.id, workspaceId);
      if (entry.pinned) {
        void browser.tabs.update(created.id, { pinned: true }).catch((err) => {
          console.warn('[bento-tools] parked tab pin restore failed:', created.id, err);
        });
      }
      if (entry.customTitle) {
        void tabs.rename(created.id, entry.customTitle);
      }
      restored = true;
      if (!stillCurrent()) {
        await handOverTab(
          workspaceId,
          { id: created.id, windowId: created.windowId, pinned: entry.pinned },
          findOwningWindow,
        );
      }
    } catch (err) {
      console.warn('[bento-tools] parked tab restore failed:', entry.url, err);
    }
  }
  return { restored, unrestored: [] };
}
