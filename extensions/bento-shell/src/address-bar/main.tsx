// Floating address/search bar overlay entry. Lives in its own Vite chunk
// and chrome <browser> frame so it can cover the full browser window.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/image';
import '@tale-ui/react-styles/dialog';
import '@tale-ui/react-styles/autocomplete';
import '@tale-ui/react-styles/search-field';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import AddressBar from '../components/AddressBar/AddressBar';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';
import {
  signalAddrbarClose,
  subscribeToAddrbarOpenRequests,
  type AddrbarMode,
} from '../bridge/useAddrbar';

initToolsPort();

function AddressBarApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  const [mode, setMode] = useState<AddrbarMode>('current');
  const [openVersion, setOpenVersion] = useState(0);

  useEffect(() => {
    return subscribeToAddrbarOpenRequests((nextMode) => {
      setMode(nextMode);
      setOpenVersion((version) => version + 1);
    });
  }, []);

  return <AddressBar onClose={signalAddrbarClose} mode={mode} openVersion={openVersion} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell address-bar: #root not found');

createRoot(container).render(
  <StrictMode>
    <AddressBarApp />
  </StrictMode>,
);
