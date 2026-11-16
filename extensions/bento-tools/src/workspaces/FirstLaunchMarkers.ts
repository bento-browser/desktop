// Persists the boot backfill's workspace on the launch that created a never-stored profile's
// default workspace. Kept apart from background.ts so its conditions can be tested.

import type { TabRegistry } from '../tabs/TabRegistry';

export interface FirstLaunchMarkerDeps {
  /** `WorkspaceStore.bootstrappedDefaultId`: the default workspace init created for a profile
   * that never stored workspaces, else null. */
  bootstrappedDefaultId: string | null;
  /** The ids of the regular workspaces the store holds now. */
  workspaceIds: () => readonly string[];
  /** Whether a regular tab came back from the session with a workspace marker (read after
   * `hydrateWorkspaceIds`, before any backfill): then the session is an earlier one's. */
  sessionHadMarkers: boolean;
  tabs: Pick<
    TabRegistry,
    'snapshot' | 'isPrivate' | 'isClosing' | 'confirmUnassigned' | 'assignWorkspaceEagerly'
  >;
}

/**
 * The boot backfill gives an unmarked tab the active workspace in memory only, because on any
 * later launch that is a guess (a legacy tab's real workspace is unknown). On the launch where
 * init created the default workspace because Bento never stored workspaces (both storage keys
 * absent) it is not: that default is the only workspace, so the tabs open then belong to it.
 * Their marker is written here, so chrome arms the switch curtain when a later switch selects
 * them.
 *
 * All or nothing: nothing is written when a regular tab came back from the session with a
 * marker, when the store no longer holds just that default (an imported set can replace it),
 * or when reading the candidates' session values again (`confirmUnassigned`) finds any value or
 * fails for any of them. `confirmUnassigned` applies a found value without waiting for it, so
 * the snapshot cannot be trusted to show a sibling's restored marker yet; any shortfall in the
 * confirmed ids stops the whole write, as does any regular tab the registry now places in another
 * workspace. Private and closing tabs are never written.
 */
export async function persistFirstLaunchWorkspace(
  deps: FirstLaunchMarkerDeps,
  workspaceId: string,
  tabIds: readonly number[],
): Promise<void> {
  const { bootstrappedDefaultId, workspaceIds, sessionHadMarkers, tabs } = deps;
  const onlyDefault = () => {
    const ids = workspaceIds();
    return ids.length === 1 && ids[0] === workspaceId;
  };
  if (sessionHadMarkers || bootstrappedDefaultId !== workspaceId || !onlyDefault()) return;
  const candidates = tabIds.filter((id) => !tabs.isPrivate(id) && !tabs.isClosing(id));
  const unmarked = await tabs.confirmUnassigned(candidates);
  if (unmarked.length !== candidates.length || !onlyDefault()) return;
  const snapshot = tabs.snapshot();
  // A regular tab in another workspace by now was restored with that marker.
  const restored = snapshot.some(
    (tab) =>
      !tabs.isPrivate(tab.id) && tab.workspaceId !== undefined && tab.workspaceId !== workspaceId,
  );
  if (restored) return;
  const inWorkspace = new Set(
    snapshot
      .filter((tab) => tab.workspaceId === workspaceId && !tabs.isClosing(tab.id))
      .map((tab) => tab.id),
  );
  await Promise.all(
    unmarked
      .filter((id) => inWorkspace.has(id) && !tabs.isPrivate(id))
      .map((id) => tabs.assignWorkspaceEagerly(id, workspaceId)),
  );
}
