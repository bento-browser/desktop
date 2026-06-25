// Workspace-palette overlay entry. Lives in its own Vite chunk + chrome
// <browser> frame so the workspace management palette covers the full
// browser window instead of being clipped by the sidebar iframe.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/avatar';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/color-swatch';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/command-palette';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/popover';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/search-field';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/text-field';
import '@tale-ui/react-styles/toggle-button';
import '@tale-ui/react-styles/tooltip';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../components/WorkspaceSwitcher/WorkspaceSwitcher.css';
import { WorkspacePalette } from '../components/WorkspacePalette/WorkspacePalette';
import { WORKSPACE_PALETTE_CLOSE_PREFIX } from '../bridge/useWorkspacePalette';
import { initToolsPort } from '../bridge/useToolsPort';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';

initToolsPort();

function WorkspacePaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const handleClose = () => {
    document.title = `${WORKSPACE_PALETTE_CLOSE_PREFIX}_${Date.now()}`;
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
