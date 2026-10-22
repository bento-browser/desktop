// The temporary "Private" workspace of a private window.
//
// It lives in memory only (WorkspaceStore keeps it apart from the persisted
// workspaces) and its data must never reach storage. Every persistence boundary
// (panels, tab folders, pinned panels, parked workspaces, session markers) asks
// this one predicate instead of knowing how the id is shaped.

const PRIVATE_WORKSPACE_ID_PREFIX = 'private:';

export const PRIVATE_WORKSPACE_NAME = 'Private';

export function makePrivateWorkspaceId(): string {
  return `${PRIVATE_WORKSPACE_ID_PREFIX}${crypto.randomUUID()}`;
}

/** Whether `workspaceId` names a private window's temporary workspace. */
export function isEphemeralWorkspaceId(workspaceId: string | null | undefined): boolean {
  return typeof workspaceId === 'string' && workspaceId.startsWith(PRIVATE_WORKSPACE_ID_PREFIX);
}
