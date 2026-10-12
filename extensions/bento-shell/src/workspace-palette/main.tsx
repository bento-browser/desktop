// Workspace-palette overlay entry. Lives in its own Vite chunk + chrome
// <browser> frame so the workspace management palette covers the full
// browser window instead of being clipped by the sidebar iframe.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import '../components/WorkspaceSwitcher/WorkspaceSwitcher.css';
import { WorkspacePalette } from '../components/WorkspacePalette/WorkspacePalette';
import { WORKSPACE_PALETTE_CLOSE_PREFIX } from '../bridge/useWorkspacePalette';
import { initToolsPort } from '../bridge/useToolsPort';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { sendChromeTitle } from '../bridge/chromeTitle';
import { useOverlayReadySignal } from '../bridge/overlayReady';

initToolsPort();

function WorkspacePaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  useOverlayReadySignal('workspace-palette');
  const handleClose = () => {
    sendChromeTitle(`${WORKSPACE_PALETTE_CLOSE_PREFIX}_${Date.now()}`);
  };
  return <WorkspacePalette onClose={handleClose} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell workspace palette: #root not found');

createRoot(container).render(
  <StrictMode>
    <WorkspacePaletteApp />
  </StrictMode>,
);
