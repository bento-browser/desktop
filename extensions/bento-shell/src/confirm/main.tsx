// Confirm overlay entry. Mirrors src/palette/main.tsx — its own Vite chunk
// + chrome <browser> frame so the AlertDialog covers the entire browser
// window rather than being clipped to the sidebar.
//
// Lifecycle:
//   - Sidebar calls requestConfirm({ title, description, action, ... })
//   - That helper (a) broadcasts the payload on 'bento-confirm-bus' and
//     (b) sets document.title = BENTO_OPEN_CONFIRM_<ts>, which chrome's
//     bento-shell-mount.js poll picks up and reveals this overlay.
//   - This page's BroadcastChannel listener stores the payload in state;
//     AlertDialog renders the prompt.
//   - Cancel: set document.title = BENTO_CLOSE_CONFIRM_<ts>; chrome hides.
//   - Confirm: dispatch payload.action through the existing tools port,
//     then close.
// AlertDialog stays mounted with isOpen=true permanently (same pattern as
// palette) — visibility is purely a chrome concern via the host overlay.

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AlertDialog } from '@tale-ui/react/alert-dialog';
import { Button } from '@tale-ui/react/button';

import '@tale-ui/core';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/dialog';
import '@tale-ui/react-styles/alert-dialog';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import {
  CONFIRM_CLOSE_PREFIX,
  subscribeToConfirmRequests,
  type ConfirmPayload,
} from '../bridge/useConfirm';

initToolsPort();

function ConfirmApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  // Last-received payload — chrome shows this overlay only after a payload
  // is broadcast, but we initialize null and treat absent payload as a
  // benign empty dialog (no buttons fire actions until a payload arrives).
  const [payload, setPayload] = useState<ConfirmPayload | null>(null);

  useEffect(() => {
    return subscribeToConfirmRequests(setPayload);
  }, []);

  function close() {
    // Sentinel title format mirrors the palette's. The chrome script polls
    // this frame's contentTitle and hides the overlay on this prefix.
    document.title = `${CONFIRM_CLOSE_PREFIX}_${Date.now()}`;
  }

  function onConfirm() {
    if (payload) dispatch(payload.action);
    close();
  }

  return (
    <AlertDialog.Root
      isOpen={true}
      onOpenChange={(open) => {
        // AlertDialog tries to close on Escape / backdrop click. Forward
        // that intent to chrome so the overlay frame hides too — without
        // this, the inner dialog disappears but the overlay frame stays
        // mounted and steals pointer events.
        if (!open) close();
      }}
    >
      <AlertDialog.Backdrop>
        <AlertDialog.Popup>
          <AlertDialog.Content>
            <AlertDialog.Title>{payload?.title ?? ''}</AlertDialog.Title>
            <AlertDialog.Description>{payload?.description ?? ''}</AlertDialog.Description>
            <AlertDialog.Actions>
              <Button variant="neutral" onPress={close}>
                Cancel
              </Button>
              <Button variant={payload?.variant ?? 'danger'} onPress={onConfirm}>
                {payload?.confirmLabel ?? 'Confirm'}
              </Button>
            </AlertDialog.Actions>
          </AlertDialog.Content>
        </AlertDialog.Popup>
      </AlertDialog.Backdrop>
    </AlertDialog.Root>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell confirm: #root not found');

createRoot(container).render(
  <StrictMode>
    <ConfirmApp />
  </StrictMode>,
);
