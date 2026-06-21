// Palette page entry. Lives in its OWN Vite chunk + chrome <browser> frame
// so the modal can overlay the entire browser window rather than being
// clipped to the sidebar's bounds. The chrome process toggles the frame's
// visibility via a <key> binding (see src/browser/base/content/bento-shell-
// mount.js); this page is always "open" while it's mounted.
//
// On dismiss (Esc, backdrop click, command run) we postMessage the chrome
// parent so it can hide the frame again.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/command-palette';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import CommandPalette from '../components/CommandPalette/CommandPalette';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';

initToolsPort();

/** Sentinel document.title prefix that chrome's bento-shell-mount.js
 * listens for via DOMTitleChanged. window.parent.postMessage doesn't reach
 * the chrome process for remote=true browsers (different process boundary),
 * but DOMTitleChanged events DO bubble cross-process to the chrome
 * <browser> element. Timestamp suffix makes each close uniquely-titled so
 * successive close→open→close cycles always fire DOMTitleChanged (same
 * value twice in a row produces no event). */
const CLOSE_TITLE_PREFIX = 'BENTO_CLOSE_PALETTE';

function PaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  // Theme to the active workspace so the palette overlay renders with the
  // same brand/neutral palette as the sidebar. Chrome theme updates ride
  // through BENTO_PANELS; overlays must not write theme title sentinels
  // because they share document.title with their own close signals.
  useWorkspaceTheme();
  const handleClose = () => {
    const newTitle = `${CLOSE_TITLE_PREFIX}_${Date.now()}`;
    document.title = newTitle;
  };
  return <CommandPalette onClose={handleClose} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell palette: #root not found');

createRoot(container).render(
  <StrictMode>
    <PaletteApp />
  </StrictMode>,
);
