// Cross-process bridge for the edit-workspace overlay.
//
// Same pattern as useConfirm: the form is hosted in its own chrome-mounted
// <browser> (edit-workspace.html) so the modal covers the whole window
// instead of being clipped to the sidebar's bounds. Modals belong on the
// browser, not the sidebar.
//
// Sidebar code calls requestEditWorkspace() to (a) broadcast the snapshot
// of the workspace being edited via BroadcastChannel and (b) signal chrome
// (via document.title sentinel) to reveal the overlay frame. The overlay
// content listens, renders the form, dispatches workspace/update on Save,
// and signals chrome to hide on dismiss.
//
// Separate channel name from useConfirm's bus so payloads don't collide;
// each overlay subscribes only to its own bus.

export const EDIT_WORKSPACE_BUS_NAME = 'bento-edit-workspace-bus';
export const EDIT_WORKSPACE_OPEN_PREFIX = 'BENTO_OPEN_EDIT_WORKSPACE';
export const EDIT_WORKSPACE_CLOSE_PREFIX = 'BENTO_CLOSE_EDIT_WORKSPACE';

export interface EditWorkspacePayload {
  /** Workspace id — passed back in workspace/update on Save. */
  workspaceId: string;
  /** Snapshot of the current workspace at the moment Edit was clicked.
   * Forms render against this so cancel-and-reopen always shows the live
   * values rather than abandoned drafts. */
  name: string;
  /** Current theme id; the picker selects this row on open. Undefined =
   * Default. */
  themeId?: string;
  icon?: string;
}

interface ShowMessage {
  kind: 'show';
  payload: EditWorkspacePayload;
}

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(EDIT_WORKSPACE_BUS_NAME);
  return channel;
}

/** Open the chrome edit-workspace overlay with a snapshot of the workspace
 * being edited. Safe to call before the overlay's content has booted —
 * the broadcast races the chrome reveal and the overlay's listener picks
 * up the payload as soon as its main.tsx runs. */
export function requestEditWorkspace(payload: EditWorkspacePayload): void {
  const ch = bus();
  if (!ch) {
    console.warn('[bento-shell] requestEditWorkspace: no BroadcastChannel — cannot open');
    return;
  }
  ch.postMessage({ kind: 'show', payload } satisfies ShowMessage);
  document.title = `${EDIT_WORKSPACE_OPEN_PREFIX}_${Date.now()}`;
}

/** Subscribe to edit-workspace requests. Called by the overlay content's
 * main.tsx; returns an unsubscribe. */
export function subscribeToEditWorkspaceRequests(
  handler: (payload: EditWorkspacePayload) => void,
): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as ShowMessage | undefined;
    if (data?.kind === 'show') handler(data.payload);
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
