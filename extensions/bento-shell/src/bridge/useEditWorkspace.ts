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

import { sendChromeTitle } from './chromeTitle';
import { createShowBus, type OverlayRequest } from './overlayRequest';

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

const editBus = createShowBus<EditWorkspacePayload>(EDIT_WORKSPACE_BUS_NAME, 'edit-workspace');

/** Open the chrome edit-workspace overlay with a snapshot of the workspace
 * being edited. Safe to call before the overlay's document exists: chrome
 * creates it on the first open, and the request is posted again when the
 * document announces it is ready (overlayRequest.ts). The request is for this
 * document's window only, and a newer request for the same window replaces it. */
export function requestEditWorkspace(payload: EditWorkspacePayload): void {
  if (!editBus.request(payload)) {
    console.warn('[bento-shell] requestEditWorkspace: no BroadcastChannel — cannot open');
    return;
  }
  sendChromeTitle(`${EDIT_WORKSPACE_OPEN_PREFIX}_${Date.now()}`);
}

/** Subscribe to edit-workspace requests for this window. Called by the overlay
 * content's main.tsx; returns an unsubscribe. */
export function subscribeToEditWorkspaceRequests(
  handler: (payload: EditWorkspacePayload, request: OverlayRequest) => void,
): () => void {
  return editBus.subscribe(handler);
}
