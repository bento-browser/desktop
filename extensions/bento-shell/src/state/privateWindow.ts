// Whether this shell document belongs to a private window.
//
// The mount stamps `#bentoPrivate=1` on every frame of a private window (sidebar and
// overlays alike), so the hash answers before any snapshot arrives. A private document
// is only ever sent its own temporary Private workspace (`private: true`), so that flag
// answers too; it also lets Ladle show the private window from a seeded workspace.

import { selectActiveIdForWindow, useWorkspacesStore } from './workspaces';
import { useCurrentWindowId } from '../bridge/useToolsPort';
import { readPrivateFromHash } from '../bridge/windowId';

const hostedByPrivateWindow = readPrivateFromHash();

type WorkspacesSnapshot = ReturnType<typeof useWorkspacesStore.getState>;

/** Whether the window's active workspace is a private window's temporary one. */
export function activeWorkspaceIsPrivate(
  state: WorkspacesSnapshot,
  windowId: number | null,
): boolean {
  const activeId = selectActiveIdForWindow(state, windowId);
  return activeId !== null && state.byId[activeId]?.private === true;
}

export function usePrivateWindow(): boolean {
  const windowId = useCurrentWindowId();
  const activeIsPrivate = useWorkspacesStore((s) => activeWorkspaceIsPrivate(s, windowId));
  return hostedByPrivateWindow || activeIsPrivate;
}
