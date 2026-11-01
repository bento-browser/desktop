// Chrome hides an overlay's host without telling the document through the shell bus for several
// reasons of its own (a window resize, a tab change, another overlay opening, the Bookmarks view).
// What the document sees is the BentoShellBus actor: it writes `data-bento-host-presented` on the
// root and fires `bento-host-presentation` on the document, synchronously, when the host is shown
// or hidden. The attribute is absent until the first presentation.

const HOST_PRESENTATION_EVENT = 'bento-host-presentation';
const HOST_PRESENTED_ATTRIBUTE = 'data-bento-host-presented';

/** Calls `handler` each time chrome hides this document's host. Showing it does not. */
export function subscribeToHostHidden(handler: () => void): () => void {
  const listener = () => {
    if (document.documentElement.getAttribute(HOST_PRESENTED_ATTRIBUTE) === 'false') handler();
  };
  document.addEventListener(HOST_PRESENTATION_EVENT, listener);
  return () => document.removeEventListener(HOST_PRESENTATION_EVENT, listener);
}
