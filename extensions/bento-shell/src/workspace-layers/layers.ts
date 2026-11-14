// The layers of the workspace layers document: the workspace switcher menu, the edit-workspace
// dialog and the confirmation dialog share one chrome host and one document
// (docs/technical/overlay-documents.md, "Workspace layers document").
//
// One layer is mounted at a time: the newest request replaces the current one. A request comes
// from another document over that layer's bus (the sidebar, the workspace palette) or from the
// switcher in this document through showWorkspaceLayer: a BroadcastChannel does not deliver a
// message to the object that posted it, and each bridge module keeps one channel, so a request
// from inside this document never reaches its own subscription.
//
// A layer renders only while chrome presents the host for that layer: the BentoShellBus actor
// writes `data-bento-host-presented` and `data-bento-host-layer` on the root (the host
// presentation query names the layer). Chrome shows the host at once, so the layer's Mux
// component plays its own entrance on screen. Closing keeps the layer mounted while chrome fades
// the host out; the hide (presented false) then drops it. A request whose layer chrome has not
// presented (yet) waits, so neither order of payload and reveal shows the wrong layer.

import { create } from 'zustand';
import { sendChromeTitle } from '../bridge/chromeTitle';
import type { ConfirmPayload } from '../bridge/useConfirm';
import type { EditWorkspacePayload } from '../bridge/useEditWorkspace';
import type { WorkspaceSwitcherOpenPayload } from '../bridge/useWorkspaceSwitcher';

export type WorkspaceLayerRequest =
  | { layer: 'workspace-switcher'; payload: WorkspaceSwitcherOpenPayload }
  | { layer: 'edit-workspace'; payload: EditWorkspacePayload }
  | { layer: 'confirm'; payload: ConfirmPayload };

export type WorkspaceLayer = WorkspaceLayerRequest['layer'];

const LAYERS: readonly WorkspaceLayer[] = ['workspace-switcher', 'edit-workspace', 'confirm'];
const isWorkspaceLayer = (value: string): value is WorkspaceLayer =>
  (LAYERS as readonly string[]).includes(value);

/** Every title of this document names the layer that wrote it: `BENTO_LAYER:<layer>:<title>`.
 * Chrome routes by layer as it routes other documents by frame, so an open from the switcher
 * keeps its meaning (it replaces the switcher) apart from the same open from elsewhere. */
export const WORKSPACE_LAYER_TITLE_PREFIX = 'BENTO_LAYER:';

export function sendWorkspaceLayerTitle(layer: WorkspaceLayer, title: string): void {
  sendChromeTitle(`${WORKSPACE_LAYER_TITLE_PREFIX}${layer}:${title}`);
}

type CurrentRequest = WorkspaceLayerRequest & {
  /** Increases with every request, so a repeated open remounts its layer. */
  id: number;
};

interface WorkspaceLayersState {
  request: CurrentRequest | null;
  /** The layer chrome presents the host for, or null while the host is hidden. Outside a hosted
   * overlay (Ladle, the standalone preview) every layer counts as presented. */
  presented: WorkspaceLayer | 'any' | null;
}

const HOST_PRESENTED_ATTRIBUTE = 'data-bento-host-presented';
const HOST_LAYER_ATTRIBUTE = 'data-bento-host-layer';
const hosted =
  new URLSearchParams(globalThis.location?.hash.slice(1) ?? '').get('bentoHostedOverlay') === '1';

export const useWorkspaceLayers = create<WorkspaceLayersState>(() => ({
  request: null,
  presented: hosted ? null : 'any',
}));

let nextRequestId = 0;

/** Mounts `request`'s layer in place of the current one once chrome presents it. */
export function showWorkspaceLayer(request: WorkspaceLayerRequest): void {
  useWorkspaceLayers.setState({ request: { ...request, id: ++nextRequestId } });
}

/** Unmounts `layer` if it is the current one; a newer layer that replaced it stays. */
export function clearWorkspaceLayer(layer: WorkspaceLayer): void {
  useWorkspaceLayers.setState((state) =>
    state.request?.layer === layer ? { request: null } : state,
  );
}

/** The request to render: the current one, while chrome presents its layer. */
export function useVisibleWorkspaceLayer(): CurrentRequest | null {
  return useWorkspaceLayers(({ request, presented }) =>
    request && (presented === 'any' || presented === request.layer) ? request : null,
  );
}

function readPresentedLayer(): WorkspaceLayer | null | undefined {
  const root = document.documentElement;
  const presented = root.getAttribute(HOST_PRESENTED_ATTRIBUTE);
  if (presented === 'false') return null;
  if (presented !== 'true') return undefined;
  const layer = root.getAttribute(HOST_LAYER_ATTRIBUTE);
  return layer !== null && isWorkspaceLayer(layer) ? layer : null;
}

/** Follows chrome's presentation of the host for the life of the document. A hide drops the
 * request of the layer that was presented and reports it to `onDropped`; a request for another
 * layer (a sidebar click during the fade-out) waits for its own show. */
export function observeWorkspaceLayersPresentation(
  onDropped: (layer: WorkspaceLayer) => void,
): () => void {
  const apply = () => {
    const next = readPresentedLayer();
    if (next === undefined) return;
    const { request, presented } = useWorkspaceLayers.getState();
    const dropped = next === null && request?.layer === presented ? request : null;
    useWorkspaceLayers.setState({ presented: next, request: dropped ? null : request });
    if (dropped) onDropped(dropped.layer);
  };
  document.addEventListener('bento-host-presentation', apply);
  return () => document.removeEventListener('bento-host-presentation', apply);
}
