// Floating address/search bar overlay entry. Lives in its own Vite chunk
// and chrome <browser> frame so it can cover the full browser window.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/command-palette';
import '@tale-ui/react-styles/select';
import '@tale-ui/react-styles/row';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import AddressBar from '../components/AddressBar/AddressBar';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { dispatch, initToolsPort } from '../bridge/useToolsPort';
import {
  signalAddrbarClose,
  subscribeToAddrbarOpenRequests,
  type AddrbarMode,
} from '../bridge/useAddrbar';

initToolsPort();

function AddressBarApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const [mode, setMode] = useState<AddrbarMode>('current');
  const [initialQuery, setInitialQuery] = useState('');
  const [openVersion, setOpenVersion] = useState(0);
  const [suppressFocus, setSuppressFocus] = useState(false);

  useEffect(() => {
    dispatch({ type: 'searchEngines/requestSnapshot' });
    return subscribeToAddrbarOpenRequests((nextMode, nextInitialQuery = '', options) => {
      dispatch({ type: 'searchEngines/requestSnapshot' });
      setMode(nextMode);
      setInitialQuery(nextInitialQuery);
      setSuppressFocus(options?.suppressFocus === true);
      setOpenVersion((version) => version + 1);
    });
  }, []);

  return (
    <AddressBar
      onClose={signalAddrbarClose}
      mode={mode}
      openVersion={openVersion}
      initialQuery={initialQuery}
      suppressFocus={suppressFocus}
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell address-bar: #root not found');

createRoot(container).render(
  <StrictMode>
    <AddressBarApp />
  </StrictMode>,
);
