// What the panels do when a tab goes away: closed, or (for a private tab) moved to another
// private window, which the old window's documents see as a removal.

import type { PanelStore } from './PanelStore';
import type { PinnedPanelsStore } from '../pinnedPanels/PinnedPanelsStore';

export interface RemovedTabDeps {
  panels: Pick<
    PanelStore,
    | 'findLinksForInspectedTab'
    | 'findWorkspacesContainingTab'
    | 'isDevtoolsPanel'
    | 'remove'
    | 'takeOrphanedDevtoolsTabs'
  >;
  pinnedPanels: Pick<PinnedPanelsStore, 'removeForTab'>;
  closeDevtoolsPanelTabs(tabIds: Iterable<number>, label: string): void;
  /** Rewrites the panel markers of a workspace whose remaining panels shifted. */
  syncPanelMarkers(workspaceId: string): void;
  /** Publishes the workspace's panels to the audience that may see them. */
  emitPanelsSync(workspaceId: string): unknown;
}

/**
 * Removes a gone tab from every workspace's panels, closes the devtools panels tied to it,
 * and publishes each affected workspace's panels.
 *
 * Every affected workspace is published, not only the one the global active id names: that
 * id is a regular workspace, so a private window's panels (and a regular window showing
 * another workspace) would otherwise keep a panel whose tab is gone.
 */
export function dropRemovedTabFromPanels(deps: RemovedTabDeps, tabId: number): void {
  const { panels, pinnedPanels } = deps;
  deps.closeDevtoolsPanelTabs(
    panels.findLinksForInspectedTab(tabId).map((link) => link.devtoolsTabId),
    'inspected-tab devtools close',
  );
  for (const wsId of panels.findWorkspacesContainingTab(tabId)) {
    const wasDevtools = panels.isDevtoolsPanel(wsId, tabId);
    panels.remove(wsId, tabId);
    if (wasDevtools) pinnedPanels.removeForTab(tabId);
    if (!wasDevtools) {
      deps.closeDevtoolsPanelTabs(
        panels.takeOrphanedDevtoolsTabs(wsId),
        'panel-removed devtools close',
      );
    }
    // Remaining panels' indexes shifted — rewrite their markers so a future Cmd+Shift+T
    // lands at the correct slot.
    deps.syncPanelMarkers(wsId);
    deps.emitPanelsSync(wsId);
  }
}
