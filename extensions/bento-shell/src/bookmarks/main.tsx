// Bookmarks view entry. The view lives in its own chrome overlay <browser> frame that fills the
// window under the toolbar strip (docs/technical/bookmarks.md); chrome owns its visibility and this
// document asks to be hidden with a BENTO_CLOSE_BOOKMARKS title.
//
// Data comes over the shell bus like any other document: tools sends the `bookmarks/snapshot` to
// regular windows only, this document asks for one when it connects and on every show, and every
// change is a `bookmarks/*` action. The open tabs of the drawer are the tabs mirror of the window's
// active workspace.

import { StrictMode, useCallback, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Text } from '@muxui/react';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import BookmarksView from '../components/BookmarksView/BookmarksView';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { dispatch, initToolsPort, useCurrentWindowId, useToolsReady } from '../bridge/useToolsPort';
import { useOverlayReadySignal } from '../bridge/overlayReady';
import { useBookmarksStore } from '../state/bookmarks';
import { usePrivateWindow } from '../state/privateWindow';
import { useActiveWorkspaceIdForWindow } from '../state/workspaces';
import { closeBookmarksView } from './titles';
import { useOpenTabs } from './useOpenTabs';
import { useVisibilityTokens } from './visibility';

initToolsPort({ families: ['tabs', 'workspaces', 'settings', 'panels', 'bookmarks'] });

function requestSnapshot() {
  dispatch({ type: 'bookmarks/requestSnapshot' });
}

function BookmarksApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const isPrivate = usePrivateWindow();
  const snapshot = useBookmarksStore((state) => state.snapshot);
  const ready = useToolsReady();
  const windowId = useCurrentWindowId();
  const workspaceId = useActiveWorkspaceIdForWindow(windowId);
  const openTabs = useOpenTabs(workspaceId, windowId);
  const { openToken, focusOnOpen, hideToken } = useVisibilityTokens(
    useCallback(() => {
      if (!isPrivate) requestSnapshot();
    }, [isPrivate]),
  );

  // Tools sends the snapshot to a document that connects while it is booting; one that joins a
  // running tools asks for it once the bus has answered.
  useEffect(() => {
    if (ready && !isPrivate) requestSnapshot();
  }, [ready, isPrivate]);

  // After the effects that subscribe: chrome reveals the view, and sends its show, on this.
  useOverlayReadySignal('bookmarks');

  // Chrome refuses to open the view in a private window; if one is ever shown there is nothing to act on.
  if (isPrivate) {
    return (
      <div className="bento-bookmarks bento-bookmarks--unavailable">
        <Text variant="body" size="md" color="muted">
          Bookmarks are not available in private windows.
        </Text>
      </div>
    );
  }
  return (
    <BookmarksView
      snapshot={snapshot}
      openTabs={openTabs}
      send={dispatch}
      onClose={closeBookmarksView}
      openToken={openToken}
      focusSearchOnOpen={focusOnOpen}
      hideToken={hideToken}
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell bookmarks: #root not found');

createRoot(container).render(
  <StrictMode>
    <BookmarksApp />
  </StrictMode>,
);
