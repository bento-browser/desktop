// Floating address/search bar overlay entry. Lives in its own Vite chunk
// and chrome <browser> frame sized around the palette popup.

import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/css/src';
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
  signalAddrbarReady,
  subscribeToAddrbarOpenRequests,
  type AddrbarMode,
  type AddrbarPlacement,
} from '../bridge/useAddrbar';

initToolsPort();
document.documentElement.dataset.bentoAddressBar = 'true';

interface AddressBarOpenState {
  openId: string;
  mode: AddrbarMode;
  initialQuery: string;
  openVersion: number;
  suppressFocus: boolean;
  clipboardUrl: string;
  placement: AddrbarPlacement | null;
}

function AddressBarApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const [openState, setOpenState] = useState<AddressBarOpenState | null>(null);

  useEffect(() => {
    dispatch({ type: 'searchEngines/requestSnapshot' });
    dispatch({ type: 'savedPanels/requestSnapshot' });
    return subscribeToAddrbarOpenRequests((nextMode, nextInitialQuery = '', options) => {
      dispatch({ type: 'searchEngines/requestSnapshot' });
      dispatch({ type: 'savedPanels/requestSnapshot' });
      setOpenState((state) => ({
        openId: options?.openId || '',
        mode: nextMode,
        initialQuery: nextInitialQuery,
        suppressFocus: options?.suppressFocus === true,
        clipboardUrl: options?.clipboardUrl || '',
        placement: options?.placement || null,
        openVersion: (state?.openVersion || 0) + 1,
      }));
    });
  }, []);

  useLayoutEffect(() => {
    if (openState?.openId) signalAddrbarReady(openState.openId);
  }, [openState?.openId]);

  if (!openState) return null;

  return (
    <AddressBar
      onClose={signalAddrbarClose}
      mode={openState.mode}
      openVersion={openState.openVersion}
      initialQuery={openState.initialQuery}
      suppressFocus={openState.suppressFocus}
      clipboardUrl={openState.clipboardUrl}
      placement={openState.placement}
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
