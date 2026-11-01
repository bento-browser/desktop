// Tells the view when chrome shows and hides it. The document stays loaded while chrome hides it,
// so every show starts fresh. Chrome sends the show once the document has announced itself, as a
// 'bento-bookmarks-show' event, and a 'bento-bookmarks-hide' when it hides the view however that
// happened (a frame script dispatches both, as it does for Settings). The show carries
// `detail: { focus: boolean }`: chrome says `focus: false` when something above the view (a prompt,
// another overlay) has the focus, and the view must not take it for its search field.

import { useEffect, useState } from 'react';

export const BOOKMARKS_SHOW_EVENT = 'bento-bookmarks-show';
export const BOOKMARKS_HIDE_EVENT = 'bento-bookmarks-hide';

/** Whether a show may take the focus. Only an explicit `focus: false` in the detail says no, so
 * an event without a detail (a story, a test) behaves as before. */
export function showMayFocus(event: Event): boolean {
  const detail: unknown = (event as CustomEvent<unknown>).detail;
  return !(
    typeof detail === 'object' &&
    detail !== null &&
    'focus' in detail &&
    detail.focus === false
  );
}

/** Calls `onShow` and `onHide` for chrome's events; returns the unsubscribe. */
export function listenForVisibility(
  source: EventTarget,
  handlers: { onShow(show: { focus: boolean }): void; onHide(): void },
): () => void {
  const show = (event: Event) => handlers.onShow({ focus: showMayFocus(event) });
  const hide = () => handlers.onHide();
  source.addEventListener(BOOKMARKS_SHOW_EVENT, show);
  source.addEventListener(BOOKMARKS_HIDE_EVENT, hide);
  return () => {
    source.removeEventListener(BOOKMARKS_SHOW_EVENT, show);
    source.removeEventListener(BOOKMARKS_HIDE_EVENT, hide);
  };
}

export interface VisibilityTokens {
  /** Changes on every show. */
  openToken: number;
  /** Whether the latest show may take the focus. */
  focusOnOpen: boolean;
  /** Changes on every hide. */
  hideToken: number;
}

/** Counters that change on every show and every hide. `onShow` runs on each show, before React
 * hears of it (the entry asks tools for a fresh snapshot there). */
export function useVisibilityTokens(onShow: () => void): VisibilityTokens {
  const [tokens, setTokens] = useState<VisibilityTokens>({
    openToken: 0,
    focusOnOpen: true,
    hideToken: 0,
  });
  useEffect(
    () =>
      listenForVisibility(window, {
        onShow: ({ focus }) => {
          onShow();
          setTokens((current) => ({
            ...current,
            openToken: current.openToken + 1,
            focusOnOpen: focus,
          }));
        },
        onHide: () => setTokens((current) => ({ ...current, hideToken: current.hideToken + 1 })),
      }),
    [onShow],
  );
  return tokens;
}
