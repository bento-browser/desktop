// Generic chrome-menu overlay entry. Sibling to confirm/palette/edit-
// workspace/workspace-switcher — its own chrome-mounted <browser> that
// covers the full window so a Mux Menu can render at arbitrary
// chrome-window coordinates without being clipped to the sidebar.
//
// Unlike the other overlays, this one is GENERIC: chrome decides which
// trigger to anchor to and what items to render. A `contextId` echoes
// back on selection so chrome's per-call onSelect handler runs.
//
// Lifecycle:
//   - Chrome's showChromeMenu({anchor, items, onSelect}) registers the
//     onSelect handler under a fresh contextId, then shows this
//     overlay and dispatches a 'menu/open' action via the existing
//     shell-bus (the SHELL_ACTION_FRAME_SCRIPT path that already
//     plumbs chrome → bento-shell-bus).
//   - This page's BroadcastChannel listener stores {anchor, items,
//     contextId} and ChromeMenu renders Mux's Menu anchored to
//     an invisible Menu.Trigger positioned at the anchor rect.
//   - Item selection: document.title = BENTO_MENU_SELECT:<ctx>:<id>.
//     Chrome's poll parses that, looks up the handler by contextId,
//     calls it, and hides the overlay.
//   - Dismiss (Esc, outside click, item-click after selection): set
//     document.title = BENTO_MENU_CLOSE:<ctx>. Chrome hides the
//     overlay and drops the handler from the contextId map.

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';
import { ChromeMenu, type ChromeMenuOpenPayload } from './ChromeMenu';
import { sendChromeTitle } from '../bridge/chromeTitle';
import { useOverlayReadySignal } from '../bridge/overlayReady';
import { subscribeToMenuOpen } from '../bridge/useMenuOpen';

initToolsPort();

function MenuApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const [payload, setPayload] = useState<ChromeMenuOpenPayload | null>(null);
  // Mux Menu fires onAction (our onSelect) FIRST, then closes the
  // menu in the same synchronous frame which fires onOpenChange(false)
  // (our onClose). Both handlers send a title and chrome receives both, in
  // order. SELECT already hides the overlay and drops the handler, so this
  // ref lets onClose skip the redundant CLOSE after a select. Reset when the
  // next open allocates a new contextId.
  const justSelectedRef = useRef(false);

  useEffect(
    () =>
      // Chrome's dispatchShellAction posts 'menu/open' onto bento-shell-bus for this
      // window only (bridge/useMenuOpen.ts).
      subscribeToMenuOpen((next) => {
        justSelectedRef.current = false;
        setPayload(next);
      }),
    [],
  );

  // After the bus subscription above: chrome sends menu/open once this is announced.
  useOverlayReadySignal('menu');

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('contextmenu', preventNativeContextMenu, true);
    return () => {
      document.removeEventListener('contextmenu', preventNativeContextMenu, true);
    };
  }, []);

  if (!payload) return null;

  return (
    <ChromeMenu
      payload={payload}
      onClose={() => {
        if (justSelectedRef.current) {
          justSelectedRef.current = false;
          setPayload(null);
          return;
        }
        sendChromeTitle(`BENTO_MENU_CLOSE:${payload.contextId}`);
        setPayload(null);
      }}
      onSelect={(itemId) => {
        justSelectedRef.current = true;
        sendChromeTitle(`BENTO_MENU_SELECT:${payload.contextId}:${itemId}`);
        setPayload(null);
      }}
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell menu: #root not found');

createRoot(container).render(
  <StrictMode>
    <MenuApp />
  </StrictMode>,
);
