// Tells the view when chrome shows and hides it. The document stays loaded while chrome hides it,
// so every show starts fresh. Chrome sends the show once the document has announced itself, as a
// 'bento-bookmarks-show' event, and a 'bento-bookmarks-hide' when it hides the view however that
// happened (a frame script dispatches both, as it does for Settings).

import { useEffect, useState } from 'react';

export const BOOKMARKS_SHOW_EVENT = 'bento-bookmarks-show';
export const BOOKMARKS_HIDE_EVENT = 'bento-bookmarks-hide';

/** Calls `onShow` and `onHide` for chrome's events; returns the unsubscribe. */
export function listenForVisibility(
  source: EventTarget,
  handlers: { onShow(): void; onHide(): void },
): () => void {
  const show = () => handlers.onShow();
  const hide = () => handlers.onHide();
  source.addEventListener(BOOKMARKS_SHOW_EVENT, show);
  source.addEventListener(BOOKMARKS_HIDE_EVENT, hide);
  return () => {
    source.removeEventListener(BOOKMARKS_SHOW_EVENT, show);
    source.removeEventListener(BOOKMARKS_HIDE_EVENT, hide);
  };
}

/** Counters that change on every show and every hide. `onShow` runs on each show, before React
 * hears of it (the entry asks tools for a fresh snapshot there). */
export function useVisibilityTokens(onShow: () => void): { openToken: number; hideToken: number } {
  const [tokens, setTokens] = useState({ openToken: 0, hideToken: 0 });
  useEffect(
    () =>
      listenForVisibility(window, {
        onShow: () => {
          onShow();
          setTokens((current) => ({ ...current, openToken: current.openToken + 1 }));
        },
        onHide: () => setTokens((current) => ({ ...current, hideToken: current.hideToken + 1 })),
      }),
    [onShow],
  );
  return tokens;
}
