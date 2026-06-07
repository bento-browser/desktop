// Settings page entry. Separate Vite entry from the main shell + privacy
// page. Imports only the Tale UI components Settings actually uses.
//
// Connects to bento-tools via initToolsPort() so the SettingsStore mirror
// hydrates from the live tools-side store and write-backs work.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/card';
import '@tale-ui/react-styles/switch';
import '@tale-ui/react-styles/select';
import '@tale-ui/react-styles/disclosure';
import '@tale-ui/react-styles/toggle-button';
import '@tale-ui/react-styles/number-field';
import '@tale-ui/react-styles/text-field';
import '@tale-ui/react-styles/dialog';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { Settings } from '../features/Settings/Settings';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';

initToolsPort();

function SettingsApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  return <Settings />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell settings: #root not found');

createRoot(container).render(
  <StrictMode>
    <SettingsApp />
  </StrictMode>,
);
