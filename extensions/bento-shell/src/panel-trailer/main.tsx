// Panel-trailer chrome-overlay entry. Lives in its OWN Vite chunk + chrome
// <browser> frame so the "+ saved-panel-favicons" row can use Tale UI
// tooltips without being clipped to the sidebar iframe.
//
// Unlike the other overlays (welcome / confirm / palette / etc.) this one
// is NOT a full-window modal — it's hosted by a XUL <vbox> at the end of
// #tabbrowser-tabpanels.bento-split-active. Chrome controls the outer
// vbox's flex-basis based on the savedPanelCount carried on BENTO_PANELS;
// this React app only owns the inside of the iframe.
//
// State flow:
//   - initToolsPort opens the BroadcastChannel('bento-shell-bus') and
//     auto-dispatches `savedPanels/requestSnapshot` on `tools/booted`.
//   - useSavedPanelsStore mirrors the snapshot.
//   - "+" sets a title-IPC sentinel so chrome creates the blank panel
//     through its native addNewPanel path.
//   - Favicon clicks dispatch `panel/openAt` with position: 'end'.
//     Tools creates the tab and appends it as a panel; the existing
//     panels/sync round-trip puts the new panel in chrome's strip.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/tooltip';
import '@tale-ui/react-styles/select-native';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import { useSavedPanelsStore } from '../state/savedPanels';
import { PanelTrailer } from '../components/PanelTrailer/PanelTrailer';

initToolsPort();

function onAddBlank() {
  // Append a blank panel via chrome's addNewPanel marker path. This keeps
  // the native tab and its notificationbox in the same chrome window as
  // the visible panel strip.
  document.title = `BENTO_PANEL_TRAILER_ADD_BLANK:${Date.now()}`;
}

function onOpenSaved(url: string) {
  dispatch({ type: 'panel/openAt', url, sourceTabId: null, position: 'end' });
}

function encodePanelTrailerMenuPayload(payload: object): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

function openPanelTrailerContextMenu(event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  document.title = `BENTO_PANEL_TRAILER_CONTEXT_MENU:${Date.now()}:${encodePanelTrailerMenuPayload({
    anchor: { left: event.clientX, top: event.clientY, width: 1, height: 1 },
  })}`;
}

function PanelTrailerApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  const items = useSavedPanelsStore((s) => s.items);
  return <PanelTrailer items={items} onAddBlank={onAddBlank} onOpenSaved={onOpenSaved} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell panel-trailer: #root not found');

document.addEventListener('contextmenu', openPanelTrailerContextMenu, true);

createRoot(container).render(
  <StrictMode>
    <PanelTrailerApp />
  </StrictMode>,
);
