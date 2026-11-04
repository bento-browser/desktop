import type { WorkspaceStore } from './WorkspaceStore';

/**
 * Activate workspace `id` for `windowId`, the way choosing it from the switcher does.
 *
 * Bento enforces "one workspace per window": two windows rendering the same workspace's
 * panels produce broken state, because the panel reconciler resolves panel tabs against
 * `gBrowser`, which is per-window. When another window already shows the workspace, the
 * store refuses (`'conflict'`) and this focuses that window instead; the requesting
 * window stays as it is, and its UI reconciles on the next workspaces delta because no
 * `activated` delta fired.
 *
 * A null `windowId` falls back to the store's legacy global activation, for a caller
 * whose window is unknown.
 */
export function activateWorkspaceInWindow(
  workspaces: Pick<WorkspaceStore, 'activate' | 'findOwningWindow'>,
  id: string,
  windowId: number | null,
): void {
  if (workspaces.activate(id, windowId) !== 'conflict') return;
  const owner = workspaces.findOwningWindow(id);
  if (owner === null) return;
  browser.windows
    .update(owner, { focused: true })
    .catch((err) => console.warn('[bento-tools] workspace activate: focus owner failed:', err));
}
