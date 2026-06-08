// Generic chrome-menu overlay entry. Sibling to confirm/palette/edit-
// workspace/workspace-switcher — its own chrome-mounted <browser> that
// covers the full window so a Tale UI Menu can render at arbitrary
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
//     contextId} and ChromeMenu renders Tale UI's Menu anchored to
//     an invisible Menu.Trigger positioned at the anchor rect.
//   - Item selection: document.title = BENTO_MENU_SELECT:<ctx>:<id>.
//     Chrome's poll parses that, looks up the handler by contextId,
//     calls it, and hides the overlay.
//   - Dismiss (Esc, outside click, item-click after selection): set
//     document.title = BENTO_MENU_CLOSE:<ctx>. Chrome hides the
//     overlay and drops the handler from the contextId map.

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/menu';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { ChromeMenu, type ChromeMenuOpenPayload } from './ChromeMenu';

function MenuApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  const [payload, setPayload] = useState<ChromeMenuOpenPayload | null>(null);
  // react-aria's Menu fires onAction (our onSelect) FIRST, then closes the
  // menu in the same synchronous frame which fires onOpenChange(false)
  // (our onClose). Both handlers write document.title; chrome polls at
  // 60ms and only sees the LAST value, so a naive impl would always
  // observe CLOSE and never SELECT — the panel never resizes. This ref
  // lets onClose detect that a select just happened and skip its title
  // write, leaving SELECT as the observable signal. Cleared by the
  // poll's natural reset (next open allocates a new contextId).
  const justSelectedRef = useRef(false);

  useEffect(() => {
    // Listen on the existing bento-shell-bus. Chrome's dispatchShellAction
    // posts onto this channel via SHELL_ACTION_FRAME_SCRIPT; any
    // moz-extension page in the same origin (this one included) receives.
    const channel = new BroadcastChannel('bento-shell-bus');
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (data.kind !== 'action') return;
      const action = data.action;
      if (!action || action.type !== 'menu/open') return;
      // Validate enough of the payload to render. Bad payloads silently
      // drop — we'd rather render nothing than crash the overlay frame.
      if (!action.contextId || !action.anchor || !Array.isArray(action.items)) return;
      justSelectedRef.current = false;
      setPayload({
        contextId: action.contextId,
        anchor: action.anchor,
        items: action.items,
      });
    }
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, []);

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
        document.title = `BENTO_MENU_CLOSE:${payload.contextId}`;
        setPayload(null);
      }}
      onSelect={(itemId) => {
        justSelectedRef.current = true;
        document.title = `BENTO_MENU_SELECT:${payload.contextId}:${itemId}`;
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
