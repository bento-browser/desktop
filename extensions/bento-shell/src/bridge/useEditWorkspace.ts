// Cross-process bridge for the edit-workspace overlay.
//
// Same pattern as useConfirm: the form is the edit-workspace layer of the
// chrome-mounted workspace layers document (workspace-layers.html), so the
// modal covers the whole window instead of being clipped to the sidebar's
// bounds. Modals belong on the browser, not the sidebar.
//
// Sidebar code calls requestEditWorkspace() to (a) broadcast the snapshot
// of the workspace being edited via BroadcastChannel and (b) signal chrome
// (via document.title sentinel) to show the layer. The layers document
// listens, renders the form, dispatches workspace/update on Save, and
// signals chrome to hide on dismiss. The switcher layer opens it directly.
//
// Separate channel name from useConfirm's bus so payloads don't collide;
// each overlay subscribes only to its own bus. Every payload also names its
// window (windowId.ts) and a receiver ignores other windows': the channel
// reaches the edit-workspace document of every Bento window.

import { sendChromeTitle } from './chromeTitle';
import {
  isLayerRequestId,
  layerOpenTitle,
  newLayerRequestId,
  type LayerRequestId,
} from './layerRequest';
import { isForThisWindow, thisWindowId } from './windowId';

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
  windowId: number | null;
  /** Names this request end to end: chrome's open and presentation carry it too. */
  requestId: LayerRequestId;
  payload: EditWorkspacePayload;
}

let channel: BroadcastChannel | null = null;
function bus(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(EDIT_WORKSPACE_BUS_NAME);
  return channel;
}

/** Open the edit-workspace layer with a snapshot of the workspace being
 * edited. The layers document is created at window startup. */
export function requestEditWorkspace(payload: EditWorkspacePayload): LayerRequestId | null {
  const ch = bus();
  if (!ch) {
    console.warn('[bento-shell] requestEditWorkspace: no BroadcastChannel — cannot open');
    return null;
  }
  const requestId = newLayerRequestId();
  ch.postMessage({
    kind: 'show',
    windowId: thisWindowId,
    requestId,
    payload,
  } satisfies ShowMessage);
  sendChromeTitle(layerOpenTitle(EDIT_WORKSPACE_OPEN_PREFIX, requestId));
  return requestId;
}

/** Subscribe to edit-workspace requests. Called by the workspace layers
 * document; returns an unsubscribe. */
export function subscribeToEditWorkspaceRequests(
  handler: (payload: EditWorkspacePayload, requestId: LayerRequestId) => void,
): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as ShowMessage | undefined;
    if (
      data?.kind === 'show' &&
      isForThisWindow(data.windowId) &&
      isLayerRequestId(data.requestId)
    ) {
      handler(data.payload, data.requestId);
    }
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
