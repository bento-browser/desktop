/**
 * Where a sidebar footer button sits, as chrome needs it to anchor a native panel
 * that Firefox opens on its own (the downloads panel after a download starts).
 *
 * Distances from the shell viewport's right and bottom edges, not a position: the
 * footer is pinned to the bottom of the shell and its buttons keep their distance
 * from the right edge as the sidebar or window resizes, so those distances change
 * only when the footer layout does (the rail restacking it). A position would change
 * on every frame of a sidebar drag. Chrome adds the shell frame's rect when it opens
 * the panel.
 */
export interface FooterButtonEdges {
  right: number;
  bottom: number;
  width: number;
  height: number;
}

// Half a pixel: layout noise below it is not a change worth a message to chrome.
const round = (value: number) => Math.round(value * 2) / 2;

/** The button's edges in the viewport, or null while it has no box (shell hidden). */
export function measureFooterButtonEdges(
  button: Element,
  viewportWidth: number = window.innerWidth,
  viewportHeight: number = window.innerHeight,
): FooterButtonEdges | null {
  const rect = button.getBoundingClientRect();
  if (viewportWidth <= 0 || viewportHeight <= 0 || rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    right: round(viewportWidth - rect.right),
    bottom: round(viewportHeight - rect.bottom),
    width: round(rect.width),
    height: round(rect.height),
  };
}

function sameEdges(a: FooterButtonEdges, b: FooterButtonEdges): boolean {
  return (
    a.right === b.right && a.bottom === b.bottom && a.width === b.width && a.height === b.height
  );
}

/**
 * Calls `onChange(edges)` once when first measured and again each time the button's
 * edges change. `footer` is the element whose size follows the layout changes that
 * move the button: the rail restacks it. The callback runs in the resize-observer
 * step, so a sidebar drag (which resizes the footer every frame but leaves the edges
 * alone) sends nothing.
 *
 * `getButton` is read on each observation, not once: switching the rail swaps the
 * tooltip wrapper, so React mounts a new button element and a held one goes stale.
 */
export function observeFooterButtonEdges(
  footer: Element,
  getButton: () => Element | null,
  onChange: (edges: FooterButtonEdges) => void,
): () => void {
  let last: FooterButtonEdges | null = null;
  const observer = new ResizeObserver(() => {
    const button = getButton();
    const edges = button && measureFooterButtonEdges(button);
    if (!edges || (last && sameEdges(last, edges))) return;
    last = edges;
    onChange(edges);
  });
  observer.observe(footer);
  return () => observer.disconnect();
}
