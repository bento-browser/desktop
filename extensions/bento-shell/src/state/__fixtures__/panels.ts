// Fake panels-store seeding for Ladle stories. The TabList readiness gate
// waits for usePanelsStore.hydratedWorkspaces to contain the active
// workspace id before rendering — without this the App-level demo stories
// would sit forever on the skeleton loader. Seeding an empty panel list
// per workspace marks it as hydrated and unblocks the gate.

import { usePanelsStore } from '../panels';

export function seedPanelsHydrated(workspaceIds: string[]): void {
  for (const id of workspaceIds) {
    usePanelsStore.getState().apply(id, []);
  }
}

export function seedPanelsByWorkspace(panelsByWorkspace: Record<string, number[]>): void {
  for (const [workspaceId, tabIds] of Object.entries(panelsByWorkspace)) {
    usePanelsStore.getState().apply(workspaceId, tabIds);
  }
}
