// Settings page entry. Separate Vite entry from the main shell + privacy
// page. Imports the shared Mux theme boundary once for this document.
//
// Connects to bento-tools via initToolsPort() so the SettingsStore mirror
// hydrates from the live tools-side store and write-backs work.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../theme/muxui.css';
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
