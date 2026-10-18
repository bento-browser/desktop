// Fake panels-store seeding for Ladle stories. The TabList readiness gate
// waits for usePanelsStore.hydratedWorkspaces to contain the active
// workspace id before rendering — without this the App-level demo stories
// would sit forever on the skeleton loader. Seeding an empty panel list
// per workspace marks it as hydrated and unblocks the gate.
//
// Both helpers replace the whole store. The store's own apply() merges per
// workspace, so panel ids a previous story left for another workspace would
// otherwise stay in the same Ladle session and hide tabs from a story that
// does not have that workspace.

import { usePanelsStore } from '../panels';

function replacePanels(panelsByWorkspace: Record<string, number[]>): void {
  usePanelsStore.setState({
    byWorkspace: new Map(
      Object.entries(panelsByWorkspace).map(([workspaceId, tabIds]) => [
        workspaceId,
        new Set(tabIds),
      ]),
    ),
    hydratedWorkspaces: new Set(Object.keys(panelsByWorkspace)),
  });
}

export function seedPanelsHydrated(workspaceIds: string[]): void {
  replacePanels(Object.fromEntries(workspaceIds.map((id) => [id, []])));
}

export function seedPanelsByWorkspace(panelsByWorkspace: Record<string, number[]>): void {
  replacePanels(panelsByWorkspace);
}
