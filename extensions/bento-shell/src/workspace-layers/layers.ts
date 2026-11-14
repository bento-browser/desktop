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
// Chrome keeps the id with its open and names the layer, the id and the presentation generation
// in the host presentation: the BentoShellBus actor writes `data-bento-host-presented`,
// `data-bento-host-layer`, `data-bento-host-request` and `data-bento-host-generation` on the
// root. The document renders the payload whose id is presented and nothing else, then reports
// `BENTO_LAYER_RENDERED:<id>:<generation>` under the layer's tag; chrome lets the host take
// pointer input only after that report matches its current presentation.
//
// Retention. A payload is kept by id until it is obsolete: its id was presented and that
// presentation ended (a hide, or chrome presenting another id). A presentation whose payload has
// not arrived shows nothing until that payload lands, and a payload that arrives before its
// presentation waits for it in any order. The only other way out is the cap below.
//
// Chrome shows the host at once, so the layer's Mux component plays its own entrance on screen.
// Closing keeps the layer mounted while chrome fades the host out; the hide then drops it.

import { useEffect } from 'react';
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

/** A presentation of the host: the layer, the request and the presentation generation. */
type Target = { layer: WorkspaceLayer; id: LayerRequestId; generation: number };

interface KeptRequest {
  request: LayerRequest;
  /** Arrival order in this document. */
  seq: number;
  /** The layer closed itself (the switcher after an item action or an outside click): it is
   * unmounted, and the hide that ends its presentation is not news to the sidebar. */
  closed: boolean;
}

interface WorkspaceLayersState {
  /** Payloads by request id, in arrival order. */
  requests: ReadonlyMap<LayerRequestId, KeptRequest>;
  /** The presentation chrome shows the host for, or null while the host is hidden.
   * Outside a hosted overlay (Ladle, the standalone preview) the newest request shows. */
  presented: Target | 'any' | null;
  /** The arrival order of the newest presented payload (-1 before any). */
  presentedSeq: number;
}

const HOST_PRESENTED_ATTRIBUTE = 'data-bento-host-presented';
const HOST_LAYER_ATTRIBUTE = 'data-bento-host-layer';
const HOST_REQUEST_ATTRIBUTE = 'data-bento-host-request';
const HOST_GENERATION_ATTRIBUTE = 'data-bento-host-generation';
/** The document's report that it rendered the presented request (bento-shell-mount.js
 * handleWorkspaceLayerRendered). */
export const WORKSPACE_LAYER_RENDERED_PREFIX = 'BENTO_LAYER_RENDERED';
// Payloads that are never presented (an open chrome cancelled or replaced before presenting it,
// or one whose title never reached chrome) are not retired by a hide. Past this many kept
// payloads, the oldest that arrived before the newest presented payload go: chrome handles an
// open title within a task of its payload, so such a payload has been superseded. A payload that
// arrived after the newest presented one is never evicted.
const KEPT_REQUESTS = 32;
const hosted =
  new URLSearchParams(globalThis.location?.hash.slice(1) ?? '').get('bentoHostedOverlay') === '1';
let nextSeq = 0;

export const useWorkspaceLayers = create<WorkspaceLayersState>(() => ({
  requests: new Map(),
  presented: hosted ? null : 'any',
  presentedSeq: -1,
}));

const presentedId = (presented: WorkspaceLayersState['presented']) =>
  presented !== null && presented !== 'any' ? presented.id : null;

/** Keeps `request`'s payload until chrome presents its id (or shows it at once outside chrome). */
export function showWorkspaceLayer(request: LayerRequest): void {
  useWorkspaceLayers.setState(({ requests, presented, presentedSeq }) => {
    const seq = nextSeq++;
    const next = new Map(requests);
    next.set(request.id, { request, seq, closed: false });
    // Outside chrome the newest request shows, so it counts as presented.
    const shownSeq =
      presented === 'any' || presentedId(presented) === request.id ? seq : presentedSeq;
    for (const [id, kept] of requests) {
      if (next.size <= KEPT_REQUESTS) break;
      if (kept.seq < shownSeq && id !== presentedId(presented)) next.delete(id);
    }
    return { requests: next, presentedSeq: shownSeq };
  });
}

/** Unmounts the request `id` (the switcher closing itself); any other request stays. */
export function clearWorkspaceLayer(id: LayerRequestId): void {
  useWorkspaceLayers.setState(({ requests }) => {
    const kept = requests.get(id);
    if (!kept || kept.closed) return {};
    const next = new Map(requests);
    next.set(id, { ...kept, closed: true });
    return { requests: next };
  });
}

/** The request to render: the one whose id chrome presents, once its payload is here. */
export function visibleWorkspaceLayer({
  requests,
  presented,
}: WorkspaceLayersState): LayerRequest | null {
  if (presented === null) return null;
  if (presented === 'any') {
    const open = [...requests.values()].filter((kept) => !kept.closed);
    return open.at(-1)?.request ?? null;
  }
  const kept = requests.get(presented.id);
  return kept && !kept.closed && kept.request.layer === presented.layer ? kept.request : null;
}

export function useVisibleWorkspaceLayer(): LayerRequest | null {
  return useWorkspaceLayers(visibleWorkspaceLayer);
}

/** The rendered report for the current presentation, once its request renders. */
export function renderedReportTitle(state: WorkspaceLayersState): string | null {
  const { presented } = state;
  if (presented === null || presented === 'any' || !visibleWorkspaceLayer(state)) return null;
  return `${WORKSPACE_LAYER_RENDERED_PREFIX}:${presented.id}:${presented.generation}`;
}

/** Tells chrome, after the commit, that the presented request rendered (one report per
 * presentation: the title names the id and the generation). */
export function useReportRenderedWorkspaceLayer(): void {
  const layer = useWorkspaceLayers((state) => visibleWorkspaceLayer(state)?.layer ?? null);
  const title = useWorkspaceLayers(renderedReportTitle);
  useEffect(() => {
    if (layer && title) sendWorkspaceLayerTitle(layer, title);
  }, [layer, title]);
}

// undefined: no presentation yet. A shown host whose presentation names no valid layer, id and
// generation shows nothing (`target` null) rather than guessing.
function readPresentation(): { shown: true; target: Target | null } | { shown: false } | undefined {
  const root = document.documentElement;
  const presented = root.getAttribute(HOST_PRESENTED_ATTRIBUTE);
  if (presented === 'false') return { shown: false };
  if (presented !== 'true') return undefined;
  const layer = root.getAttribute(HOST_LAYER_ATTRIBUTE);
  const id = root.getAttribute(HOST_REQUEST_ATTRIBUTE);
  const generation = root.getAttribute(HOST_GENERATION_ATTRIBUTE);
  const valid =
    layer !== null &&
    isWorkspaceLayer(layer) &&
    isLayerRequestId(id) &&
    generation !== null &&
    /^\d{1,15}$/.test(generation);
  return { shown: true, target: valid ? { layer, id, generation: Number(generation) } : null };
}

/** Follows chrome's presentation of the host for the life of the document. The end of a
 * presentation (a hide, or another id presented) retires its request. A hide reports the
 * presented layer to `onDropped` unless that layer had closed itself (the sidebar trigger then
 * drops its open state for a switcher chrome hid, also one whose payload never came). */
export function observeWorkspaceLayersPresentation(
  onDropped: (layer: WorkspaceLayer) => void,
): () => void {
  const apply = () => {
    const next = readPresentation();
    if (next === undefined) return;
    const { requests, presented, presentedSeq } = useWorkspaceLayers.getState();
    const ended = presentedId(presented);
    const kept = new Map(requests);
    if (next.shown) {
      const target = next.target;
      if (ended !== null && ended !== target?.id) kept.delete(ended);
      const shown = target ? kept.get(target.id) : undefined;
      useWorkspaceLayers.setState({
        presented: target,
        requests: kept,
        presentedSeq: shown ? Math.max(presentedSeq, shown.seq) : presentedSeq,
      });
      return;
    }
    const retired = ended !== null ? kept.get(ended) : undefined;
    if (ended !== null) kept.delete(ended);
    useWorkspaceLayers.setState({ presented: null, requests: kept });
    if (presented !== null && presented !== 'any' && !retired?.closed) onDropped(presented.layer);
  };
  document.addEventListener('bento-host-presentation', apply);
  return () => document.removeEventListener('bento-host-presentation', apply);
}
