// Privacy dashboard entry. Separate Vite entry from the main shell so the
// shell's bundle doesn't pay for code that's only loaded when the user
// opens moz-extension://<uuid>/dist/privacy.html. Imports only the Tale UI
// components PrivacyDashboard actually uses (no Menu/Avatar/etc.).

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/switch';
import '@tale-ui/react-styles/toggle-button';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/banner';

import '../theme/bento-tokens.css';
import '../theme/bento-fonts.css';
import { PrivacyDashboard } from '../features/PrivacyDashboard/PrivacyDashboard';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';

function PrivacyApp() {
  useFirefoxTheme();
  return <PrivacyDashboard />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell privacy: #root not found');

createRoot(container).render(
  <StrictMode>
    <PrivacyApp />
  </StrictMode>,
);
