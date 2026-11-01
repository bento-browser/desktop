// Chrome hides an overlay's host without telling the document through the shell bus for several
// reasons of its own (a window resize, a tab change, another overlay opening, the Bookmarks view).
// What the document sees is the BentoShellBus actor: it writes `data-bento-host-presented` on the
// root and fires `bento-host-presentation` on the document, synchronously, when the host is shown
// or hidden. The attribute is absent until the first presentation.
//
// Chrome presents the host (and waits for the document's ack) before it sends the open message,
// but the message and a later hide are not ordered against the popup's own startup: a hide can
// land before the open is accepted or before React subscribes. `observeHostPresentation` therefore
// runs for the life of the document and `hostHiddenSinceOpen` answers for the latest open.

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

/**
 * Orders host presentations against accepted opens with one counter, so it needs no document.
 * The show that belongs to an open is the last one after the previous open was accepted: chrome
 * presents the host before it sends the open, so a hide that follows that show belongs to this
 * open, and a hide before it belongs to an earlier popup.
 */
export function createPresentationLog() {
  let sequence = 0;
  let lastShown = 0;
  let lastHidden = 0;
  // `sequence` when the previous open and the latest open were accepted.
  let previousAccepted = 0;
  let latestAccepted = 0;
  return {
    presented(presented: boolean): void {
      sequence += 1;
      if (presented) lastShown = sequence;
      else lastHidden = sequence;
    },
    openAccepted(): void {
      previousAccepted = latestAccepted;
      latestAccepted = sequence;
    },
    /** Whether the host was hidden after the latest open's show, with no show since. */
    hiddenSinceOpen(): boolean {
      return lastHidden > lastShown && lastShown > previousAccepted;
    },
  };
}

const log = createPresentationLog();

/** Starts following presentations for the life of the document. Call once at startup, before the
 * overlay announces it is ready, so no presentation is missed. */
export function observeHostPresentation(): void {
  document.addEventListener(HOST_PRESENTATION_EVENT, () => {
    const presented = document.documentElement.getAttribute(HOST_PRESENTED_ATTRIBUTE);
    if (presented === 'true') log.presented(true);
    else if (presented === 'false') log.presented(false);
  });
}

/** The document accepted an open from chrome: a hide counts for it only after its own show. */
export function markOpenAccepted(): void {
  log.openAccepted();
}

/** True when chrome hid the host after the latest accepted open was presented, and has not shown
 * it again. A popup that mounts then is already off screen and closes at once. */
export function hostHiddenSinceOpen(): boolean {
  return log.hiddenSinceOpen();
}
