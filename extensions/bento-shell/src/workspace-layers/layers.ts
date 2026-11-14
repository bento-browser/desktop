// The layers of the workspace layers document: the workspace switcher menu, the edit-workspace
// dialog and the confirmation dialog share one chrome host and one document
// (docs/technical/overlay-documents.md, "Workspace layers document").
//
// One layer is mounted at a time: the one chrome presents. Each request carries an id
// (bridge/layerRequest.ts) made by whoever opens the layer: the sidebar and the workspace palette
// post it with the payload on the layer's bus and in the open title; the switcher in this
// document opens edit and confirm through showWorkspaceLayer, because a BroadcastChannel does not
// deliver a message to the object that posted it and each bridge module keeps one channel.
//
// Chrome keeps the id with its open and names the layer and the id in the host presentation: the
// BentoShellBus actor writes `data-bento-host-presented`, `data-bento-host-layer` and
// `data-bento-host-request` on the root. The document renders the payload whose id is presented
// and nothing else. A payload no presentation names yet is kept by id until its presentation
// arrives, or until chrome presents a newer request for its layer (chrome presents only its
// newest open, so an older one of that layer never shows); a presentation whose payload has not
// arrived shows nothing until that payload lands; a hide retires exactly the presented id.
// Nothing is matched by layer alone or by arrival order.
//
// Chrome shows the host at once, so the layer's Mux component plays its own entrance on screen.
// Closing keeps the layer mounted while chrome fades the host out; the hide then drops it.

import { create } from 'zustand';
import { sendChromeTitle } from '../bridge/chromeTitle';
import { isLayerRequestId, type LayerRequestId } from '../bridge/layerRequest';
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

export type LayerRequest = WorkspaceLayerRequest & { id: LayerRequestId };

/** A presentation of the host: the layer and the request chrome shows. */
type Target = { layer: WorkspaceLayer; id: LayerRequestId };

interface WorkspaceLayersState {
  /** Payloads by request id, in arrival order. */
  requests: ReadonlyMap<LayerRequestId, LayerRequest>;
  /** The layer and request chrome presents the host for, or null while the host is hidden.
   * Outside a hosted overlay (Ladle, the standalone preview) the newest request shows. */
  presented: Target | 'any' | null;
}

const HOST_PRESENTED_ATTRIBUTE = 'data-bento-host-presented';
const HOST_LAYER_ATTRIBUTE = 'data-bento-host-layer';
const HOST_REQUEST_ATTRIBUTE = 'data-bento-host-request';
// A payload whose open chrome cancelled, or that arrived after chrome presented a newer request
// for its layer, is never presented or superseded; the oldest goes once this many are kept, so
// the map stays small.
const KEPT_REQUESTS = 8;
const hosted =
  new URLSearchParams(globalThis.location?.hash.slice(1) ?? '').get('bentoHostedOverlay') === '1';

export const useWorkspaceLayers = create<WorkspaceLayersState>(() => ({
  requests: new Map(),
  presented: hosted ? null : 'any',
}));

/** Keeps `request`'s payload until chrome presents its id (or shows it at once outside chrome). */
export function showWorkspaceLayer(request: LayerRequest): void {
  useWorkspaceLayers.setState(({ requests, presented }) => {
    const next = new Map(requests);
    next.delete(request.id);
    next.set(request.id, request);
    for (const id of next.keys()) {
      if (next.size <= KEPT_REQUESTS) break;
      if (presented === 'any' || presented?.id !== id) next.delete(id);
    }
    return { requests: next };
  });
}

/** Unmounts the request `id` (the switcher closing itself); any other request stays. */
export function clearWorkspaceLayer(id: LayerRequestId): void {
  useWorkspaceLayers.setState(({ requests }) => {
    if (!requests.has(id)) return {};
    const next = new Map(requests);
    next.delete(id);
    return { requests: next };
  });
}

/** The request to render: the one whose id chrome presents, once its payload is here. */
export function visibleWorkspaceLayer({
  requests,
  presented,
}: WorkspaceLayersState): LayerRequest | null {
  if (presented === null) return null;
  if (presented === 'any') return [...requests.values()].at(-1) ?? null;
  const request = requests.get(presented.id);
  return request?.layer === presented.layer ? request : null;
}

export function useVisibleWorkspaceLayer(): LayerRequest | null {
  return useWorkspaceLayers(visibleWorkspaceLayer);
}

// undefined: no presentation yet. A shown host whose presentation names no valid layer and id
// shows nothing (`target` null) rather than guessing.
function readPresentation(): { shown: true; target: Target | null } | { shown: false } | undefined {
  const root = document.documentElement;
  const presented = root.getAttribute(HOST_PRESENTED_ATTRIBUTE);
  if (presented === 'false') return { shown: false };
  if (presented !== 'true') return undefined;
  const layer = root.getAttribute(HOST_LAYER_ATTRIBUTE);
  const id = root.getAttribute(HOST_REQUEST_ATTRIBUTE);
  const valid = layer !== null && isWorkspaceLayer(layer) && isLayerRequestId(id);
  return { shown: true, target: valid ? { layer, id } : null };
}

/** Follows chrome's presentation of the host for the life of the document. A hide retires the
 * presented request and reports its layer to `onDropped` (the sidebar trigger then drops its open
 * state for a switcher chrome hid); every other kept payload waits for its own presentation. */
export function observeWorkspaceLayersPresentation(
  onDropped: (layer: WorkspaceLayer) => void,
): () => void {
  const apply = () => {
    const next = readPresentation();
    if (next === undefined) return;
    if (next.shown) {
      const { target } = next;
      useWorkspaceLayers.setState(({ requests }) => {
        if (!target) return { presented: null };
        // The presented request supersedes every other kept one for its layer.
        const kept = new Map(requests);
        for (const [id, request] of requests) {
          if (request.layer === target.layer && id !== target.id) kept.delete(id);
        }
        return { presented: target, requests: kept };
      });
      return;
    }
    const { requests, presented } = useWorkspaceLayers.getState();
    const retired =
      presented !== null && presented !== 'any' ? requests.get(presented.id) : undefined;
    const kept = new Map(requests);
    if (retired) kept.delete(retired.id);
    useWorkspaceLayers.setState({ presented: null, requests: kept });
    if (retired) onDropped(retired.layer);
  };
  document.addEventListener('bento-host-presentation', apply);
  return () => document.removeEventListener('bento-host-presentation', apply);
}
