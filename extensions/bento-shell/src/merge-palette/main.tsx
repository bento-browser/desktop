// Merge palette page entry. Chrome owns visibility for this persistent
// overlay frame and sends open/close nonces through a frame-script
// BroadcastChannel so source discovery refreshes on every open.

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/spinner';
import '@tale-ui/react-styles/command-palette';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { dispatch, initToolsPort } from '../bridge/useToolsPort';
import { MergePalette } from '../components/MergePalette/MergePalette';
import { useExternalMergeStore } from '../state/externalMerge';

initToolsPort();

const CLOSE_TITLE_PREFIX = 'BENTO_CLOSE_MERGE_PALETTE';
const BUS_NAME = 'bento-merge-palette';

function close() {
  document.title = `${CLOSE_TITLE_PREFIX}_${Date.now()}`;
}

function MergePaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(BUS_NAME);
    const onMessage = (message: MessageEvent) => {
      const data = message.data as { type?: unknown; nonce?: unknown } | null;
      if (!data || typeof data.type !== 'string') return;
      const nonce = typeof data.nonce === 'string' ? data.nonce : String(Date.now());
      if (data.type === 'open') {
        useExternalMergeStore.getState().requestSourcesForOpen(nonce, dispatch);
      } else if (data.type === 'close') {
        useExternalMergeStore.getState().handleClose();
      }
    };
    channel.addEventListener('message', onMessage);
    return () => {
      channel.removeEventListener('message', onMessage);
      channel.close();
    };
  }, []);

  return <MergePalette onClose={close} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell merge palette: #root not found');

createRoot(container).render(
  <StrictMode>
    <MergePaletteApp />
  </StrictMode>,
);
