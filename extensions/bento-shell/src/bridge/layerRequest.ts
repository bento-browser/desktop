// The id of one request for a layer of the workspace layers document (the switcher menu, the
// edit-workspace dialog, the confirmation). Whoever opens a layer makes the id and puts it in the
// bus payload and in the open title; chrome keeps it with the open and names it in the host
// presentation, and the document shows only the payload whose id chrome presents
// (docs/technical/overlay-documents.md, "Workspace layers document").
//
// The ids are random UUIDs, so documents that open layers need no shared counter, and nothing
// orders requests by their ids.

declare const layerRequestIdBrand: unique symbol;
export type LayerRequestId = string & { readonly [layerRequestIdBrand]: true };

// Kept equal to WORKSPACE_LAYER_REQUEST_ID_PATTERN in bento-shell-mount.js and HOST_REQUEST_PATTERN
// in BentoShellBusChild.sys.mjs (scripts/overlay-surfaces.test.mjs checks the three).
export const LAYER_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isLayerRequestId(value: unknown): value is LayerRequestId {
  return typeof value === 'string' && LAYER_REQUEST_ID_PATTERN.test(value);
}

/** The one constructor of a request id. */
export function newLayerRequestId(): LayerRequestId {
  const id = crypto.randomUUID();
  if (!isLayerRequestId(id)) throw new Error(`unexpected UUID shape: ${id}`);
  return id;
}

/** The open title of a layer request: `<prefix>:<request id>:<timestamp>`. The timestamp keeps
 * successive titles distinct (chrome drops a repeated one); chrome rejects a title whose id is
 * missing or malformed. */
export function layerOpenTitle(prefix: string, requestId: LayerRequestId): string {
  return `${prefix}:${requestId}:${Date.now()}`;
}
