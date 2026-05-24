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
//   - "+" / favicon clicks dispatch `panel/openAt` with position: 'end'.
//     Tools creates the tab and appends it as a panel; the existing
//     panels/sync round-trip puts the new panel in chrome's strip.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core';
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
  // Append a blank panel. position 'end' bypasses the sourceTabId
  // computation so the new panel lands rightmost regardless of the
  // current main / panel selection.
  dispatch({
    type: 'panel/openAt',
    url: 'about:newtab',
    sourceTabId: null,
    position: 'end',
  });
}

function onOpenSaved(url: string) {
  dispatch({ type: 'panel/openAt', url, sourceTabId: null, position: 'end' });
}

function PanelTrailerApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  const items = useSavedPanelsStore((s) => s.items);
  return <PanelTrailer items={items} onAddBlank={onAddBlank} onOpenSaved={onOpenSaved} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell panel-trailer: #root not found');

createRoot(container).render(
  <StrictMode>
    <PanelTrailerApp />
  </StrictMode>,
);
