// Where a tab created mid-session goes: a restored panel slot, a panel next to the panel that
// opened it, the workspace its SessionStore value names, or the workspace its window showed
// when it opened.
//
// SessionStore can attach a restored tab's values after tabs.onCreated (duplicateTab attaches
// them after a flush round-trip), so a tab without values is read again for up to ~1 s before
// it counts as unassigned. The shell hides a tab without a workspace, so that wait used to
// delay every new tab's sidebar row. The bento-tab-state experiment tells the cases apart at
// TabOpen (getCreationKind): a tab it calls "new" that has no values on one immediate read is
// placed at once. "restoring" and "unknown" tabs keep the waits.

import type { TabRegistry } from './TabRegistry';
import { WORKSPACE_SESSION_KEY } from './TabRegistry';
import { readPanelMarker } from '../panels/SessionMarker';

export type CreationKind = 'new' | 'restoring' | 'unknown';

const SESSION_READ_RETRY_DELAY_MS = 50;

export async function readTabSessionValueWithRetries(
  tabId: number,
  key: string,
  attempts = 8,
): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    const value = await browser.sessions.getTabValue(tabId, key).catch(() => undefined);
    if (value !== undefined) return value;
    if (i < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_READ_RETRY_DELAY_MS));
    }
  }
  return undefined;
}

export interface CreatedTabDeps {
  adoptionSettled(): boolean;
  isPrivate(tabId: number): boolean;
  activeWorkspaceId(windowId: number | null): string | null;
  /** The native-restore classification: panel marker, closing mark, session metadata. Resolves
   * whether Bento itself closed the tab. */
  restorePanel(tabId: number, previousNonPanelTabId: number | null): Promise<boolean>;
  /** Makes a tab opened from a panel a panel beside it. Inserts synchronously. */
  promoteFromPanelOpener(tab: browser.tabs.Tab, previousNonPanelTabId: number | null): void;
  isPanel(tabId: number): boolean;
  /** The workspace the registry holds for the tab now. */
  workspaceOf(tabId: number): string | undefined;
  hasWorkspace(workspaceId: string): boolean;
  adoptImportedWorkspaces(windowId: number | null): Promise<unknown>;
  tabs: Pick<TabRegistry, 'assignWorkspace' | 'assignWorkspaceEagerly' | 'setWorkspaceInMemory'>;
}

interface Placement {
  /** A new tab with no session values: nothing will be restored into it. */
  fresh: boolean;
  bentoClosed: boolean;
}

const windowIdOf = (windowId: number | undefined) =>
  typeof windowId === 'number' && windowId >= 0 ? windowId : null;

export function createCreatedTabs(deps: CreatedTabDeps) {
  // Per tab seen by onCreated: the workspace its window showed then, and its placement, started
  // there unless startup was still adopting tabs.
  const records = new Map<number, { workspaceId: string | null; placed?: Promise<Placement> }>();

  async function isFresh(tabId: number): Promise<boolean> {
    if (deps.isPrivate(tabId)) return false;
    const kind = await browser.bentoTabState.getCreationKind(tabId).catch(() => 'unknown');
    if (kind !== 'new') return false;
    const [marker, workspaceId] = await Promise.all([
      readPanelMarker(tabId),
      readTabSessionValueWithRetries(tabId, WORKSPACE_SESSION_KEY, 1),
    ]);
    return !marker && workspaceId === undefined;
  }

  async function place(tab: browser.tabs.Tab, tabId: number, previous: number | null) {
    const fresh = await isFresh(tabId);
    const bentoClosed = fresh ? false : await deps.restorePanel(tabId, previous);
    // Before any workspace assignment, so a link opened from a panel never shows a sidebar row.
    deps.promoteFromPanelOpener(tab, previous);
    return { fresh, bentoClosed };
  }

  return {
    /** Call from TabRegistry.onTabCreated, before any await: a 'created' delta that arrives
     * first finds no record and takes the slow path. */
    onCreated(tab: browser.tabs.Tab, previousNonPanelTabId: number | null): void {
      const tabId = tab.id;
      if (typeof tabId !== 'number') return;
      // Captured now: a workspace switch while the tab is classified must not move it.
      const workspaceId = deps.activeWorkspaceId(windowIdOf(tab.windowId));
      if (!deps.adoptionSettled()) {
        // Startup owns this tab's restore; the 'created' delta restores it if startup is done.
        deps.promoteFromPanelOpener(tab, previousNonPanelTabId);
        records.set(tabId, { workspaceId });
        return;
      }
      const placed = place(tab, tabId, previousNonPanelTabId);
      placed.catch((err) =>
        console.warn('[bento-tools] created tab placement failed:', tabId, err),
      );
      records.set(tabId, { workspaceId, placed });
    },

    /** The 'created' delta of a regular tab that has no workspace yet. Call before any await.
     * `previousNonPanelTabId` is used only for a tab whose placement onCreated did not start. */
    async placeUnassigned(
      tabId: number,
      windowId: number | undefined,
      previousNonPanelTabId: number | null,
    ): Promise<void> {
      const record = records.get(tabId);
      const captured = record ? record.workspaceId : deps.activeWorkspaceId(windowIdOf(windowId));
      // A window that opened before shell/hello showed no workspace at creation, and a captured
      // workspace can be deleted while the tab is classified; read the window's again then.
      const workspaceId = () =>
        captured && deps.hasWorkspace(captured)
          ? captured
          : deps.activeWorkspaceId(windowIdOf(windowId));
      // Boot owns startup tabs, including sweeping retained closing marks.
      if (!deps.adoptionSettled()) return;
      const { fresh, bentoClosed } = await (record?.placed ??
        deps
          .restorePanel(tabId, previousNonPanelTabId)
          .then((closed) => ({ fresh: false, bentoClosed: closed })));
      if (deps.isPanel(tabId)) return;
      const freshWorkspaceId = fresh ? workspaceId() : null;
      if (freshWorkspaceId) {
        // A Bento handler that opened the tab may have assigned it while it was classified.
        if (!deps.workspaceOf(tabId))
          void deps.tabs.assignWorkspaceEagerly(tabId, freshWorkspaceId);
        return;
      }
      // Not fresh, or fresh in a window that still shows no workspace: the waits below also give
      // the window time to claim one.
      const sessionWs = await readTabSessionValueWithRetries(tabId, WORKSPACE_SESSION_KEY);
      if (sessionWs && typeof sessionWs === 'string') {
        if (!bentoClosed && !deps.hasWorkspace(sessionWs)) {
          await deps
            .adoptImportedWorkspaces(windowIdOf(windowId))
            .catch((err) => console.warn('[bento-tools] imported workspace adoption failed:', err));
        }
        deps.tabs.setWorkspaceInMemory(tabId, sessionWs);
        return;
      }
      const fallback = workspaceId();
      // As above, a fresh tab keeps an assignment its opener made during the waits.
      if (fallback && !(fresh && deps.workspaceOf(tabId))) {
        void deps.tabs.assignWorkspace(tabId, fallback);
      }
    },

    forget(tabId: number): void {
      records.delete(tabId);
    },
  };
}
