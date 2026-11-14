// Bookmarks toolbar entry. A transparent frame hosted by a XUL box in Firefox's bookmarks toolbar
// row (like the panel trailer): chrome sizes the row and shows the box only while the Bento
// bookmark manager is on; this document paints the buttons.
//
// State flow:
//   - initToolsPort opens the shell bus; the `bookmarks/snapshot` mirror feeds the buttons, and the
//     document asks for one when tools is reachable.
//   - A button sends BENTO_BOOKMARK_POPUP_OPEN with its own rect and chrome draws the menu in the
//     popup overlay (bookmarks-popup). The overlay tells this document which popup is up, so the
//     button shows its pressed state (bridge/bookmarkPopup.ts).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import { BookmarksToolbar } from '../components/BookmarksToolbar/BookmarksToolbar';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';
import { sendBookmarkPopupOpen, useOpenBookmarkPopupKey } from '../bridge/bookmarkPopup';
import { useBookmarksSnapshot } from '../bookmarks/useBookmarkManager';

initToolsPort({ families: ['workspaces', 'settings', 'bookmarks'] });

function BookmarksToolbarApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const snapshot = useBookmarksSnapshot();
  const openKey = useOpenBookmarkPopupKey();
  return (
    <BookmarksToolbar snapshot={snapshot} openKey={openKey} onOpenPopup={sendBookmarkPopupOpen} />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell bookmarks-toolbar: #root not found');

createRoot(container).render(
  <StrictMode>
    <BookmarksToolbarApp />
  </StrictMode>,
);
