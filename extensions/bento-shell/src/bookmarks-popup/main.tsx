// Bookmark popup overlay entry. One chrome <browser> frame that covers the whole window and is
// transparent, so a click anywhere outside the popup lands in this document and dismisses it.
// It draws whatever chrome opened (components/BookmarkPopup): the save popover for the star and
// Cmd+D, or a toolbar menu (a group's links, the Spaces switcher, the overflow).
//
// Lifecycle:
//   - A shell document sends BENTO_BOOKMARK_POPUP_OPEN with a request anchored to its button.
//     Chrome translates the anchor to window coordinates, shows this overlay, and once this
//     document has announced it is ready sends `ui/bookmarkPopup/open` on the shell bus
//     (bridge/bookmarkPopup.ts).
//   - Every way out ends in `close`, which sends BENTO_BOOKMARK_POPUP_CLOSE with the popup id so
//     chrome hides the overlay and returns the focus. That includes chrome hiding the overlay
//     itself (a resize, a tab change): the popup hears it as `bento-host-presentation`
//     (bridge/hostPresentation.ts) and closes the same way, so the buttons lose their pressed
//     state. Chrome ignores the then stale close, which names a popup it no longer shows. A hide
//     can land before the open is accepted or before the popup mounts, so the document follows
//     presentations from startup and a popup that mounts into a host hidden after its show closes
//     at once.
//   - The popup also tells the other shell documents which popup is up (and when it is gone), so
//     the button that opened it shows its pressed state.
//   - Data comes over the shell bus like any other document: the `bookmarks/snapshot` mirror, and
//     every change a `bookmarks/*` action.

import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import { BookmarkPopup } from '../components/BookmarkPopup/BookmarkPopup';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import { markOpenAccepted, observeHostPresentation } from '../bridge/hostPresentation';
import { useOverlayReadySignal } from '../bridge/overlayReady';
import {
  notifyBookmarkPopupClosed,
  notifyBookmarkPopupOpened,
  popupKey,
  sendBookmarkPopupClose,
  subscribeToBookmarkPopupOpen,
  type OpenBookmarkPopup,
} from '../bridge/bookmarkPopup';
import { openBookmarksView } from '../bookmarks/titles';
import { useBookmarksSnapshot } from '../bookmarks/useBookmarkManager';

initToolsPort({ families: ['workspaces', 'settings', 'bookmarks'] });
// Before the ready announcement: chrome presents the host only after it.
observeHostPresentation();

function BookmarkPopupApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const snapshot = useBookmarksSnapshot();
  const [popup, setPopup] = useState<OpenBookmarkPopup | null>(null);
  // What chrome has shown and not yet been told is closed; state lags a synchronous close.
  const current = useRef<OpenBookmarkPopup | null>(null);

  useEffect(
    () =>
      subscribeToBookmarkPopupOpen((next) => {
        // A newer open replaces the popup in place, with no close from the old one's component.
        const previous = current.current;
        if (previous && previous.popupId !== next.popupId) {
          notifyBookmarkPopupClosed(popupKey(previous.request));
        }
        markOpenAccepted();
        current.current = next;
        setPopup(next);
        notifyBookmarkPopupOpened(popupKey(next.request));
      }),
    [],
  );

  // After the bus subscription above: chrome sends `ui/bookmarkPopup/open` once this is announced.
  useOverlayReadySignal('bookmarks-popup');

  const close = useCallback(() => {
    const shown = current.current;
    if (!shown) return;
    current.current = null;
    setPopup(null);
    notifyBookmarkPopupClosed(popupKey(shown.request));
    sendBookmarkPopupClose(shown.popupId);
  }, []);

  // Firefox's page menu ("Bookmark Page", "View Page Source") means nothing over a popup.
  useEffect(() => {
    const prevent = (event: MouseEvent) => event.preventDefault();
    document.addEventListener('contextmenu', prevent, true);
    return () => document.removeEventListener('contextmenu', prevent, true);
  }, []);

  if (!popup) return null;
  return (
    <BookmarkPopup
      key={popup.popupId}
      request={popup.request}
      snapshot={snapshot}
      send={dispatch}
      onClose={close}
      onOpenBookmarks={openBookmarksView}
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell bookmarks-popup: #root not found');

createRoot(container).render(
  <StrictMode>
    <BookmarkPopupApp />
  </StrictMode>,
);
