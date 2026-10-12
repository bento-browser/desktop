// Merge palette page entry. Chrome owns visibility for this persistent
// overlay frame and sends open/close nonces through a frame-script
// BroadcastChannel so source discovery refreshes on every open.

import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { dispatch, initToolsPort } from '../bridge/useToolsPort';
import { MergePalette } from '../components/MergePalette/MergePalette';
import { useExternalMergeStore } from '../state/externalMerge';
import { sendChromeTitle } from '../bridge/chromeTitle';
import { useOverlayReadySignal } from '../bridge/overlayReady';
import { subscribeToMergePaletteLifecycle } from '../bridge/useMergePaletteBus';

initToolsPort();

const CLOSE_TITLE_PREFIX = 'BENTO_CLOSE_MERGE_PALETTE';

function close() {
  sendChromeTitle(`${CLOSE_TITLE_PREFIX}_${Date.now()}`);
}

function MergePaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();

  useEffect(
    () =>
      subscribeToMergePaletteLifecycle(({ type, nonce }) => {
        if (type === 'open') {
          useExternalMergeStore.getState().requestSourcesForOpen(nonce, dispatch);
        } else {
          useExternalMergeStore.getState().handleClose();
        }
      }),
    [],
  );

  // After the effect above: chrome sends its open nonce once this is announced.
  useOverlayReadySignal('merge-palette');

  return <MergePalette onClose={close} />;
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell merge palette: #root not found');

createRoot(container).render(
  <StrictMode>
    <MergePaletteApp />
  </StrictMode>,
);
