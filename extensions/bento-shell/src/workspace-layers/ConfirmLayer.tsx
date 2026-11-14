// The confirmation layer: an AlertDialog for a destructive action (deleting a workspace with
// tabs). Requested by the sidebar and the workspace palette (over bento-confirm-bus) and by the
// switcher layer (in this document). Confirm dispatches the payload's action through the tools
// port, then closes; Cancel and Esc close. A click on the backdrop does not dismiss it.

import { AlertDialog, Button } from '@muxui/react';
import { dispatch } from '../bridge/useToolsPort';
import { CONFIRM_CLOSE_PREFIX, type ConfirmPayload } from '../bridge/useConfirm';
import { sendWorkspaceLayerTitle } from './layers';

export function ConfirmLayer({ payload }: { payload: ConfirmPayload }) {
  function close() {
    sendWorkspaceLayerTitle('confirm', `${CONFIRM_CLOSE_PREFIX}_${Date.now()}`);
  }

  function onConfirm() {
    dispatch(payload.action);
    close();
  }

  return (
    <AlertDialog.Root
      open={true}
      onOpenChange={(open) => {
        // The AlertDialog asks to close on Esc (a click on its backdrop does not dismiss an
        // AlertDialog). Forward that to chrome, which hides the host; without it the dialog would
        // go and the host would stay over the window, taking the pointer.
        if (!open) close();
      }}
    >
      <AlertDialog.Trigger
        aria-hidden="true"
        tabIndex={-1}
        style={{
          position: 'fixed',
          inset: 0,
          width: 0,
          height: 0,
          opacity: 0,
          pointerEvents: 'none',
          border: 0,
          padding: 0,
        }}
      >
        Open confirmation
      </AlertDialog.Trigger>
      <AlertDialog.Backdrop>
        <AlertDialog.Popup>
          <AlertDialog.Content>
            <AlertDialog.Title>{payload.title}</AlertDialog.Title>
            <AlertDialog.Description>{payload.description}</AlertDialog.Description>
            <AlertDialog.Actions>
              <Button variant="neutral" onActivate={close}>
                Cancel
              </Button>
              <Button variant={payload.variant} onActivate={onConfirm}>
                {payload.confirmLabel}
              </Button>
            </AlertDialog.Actions>
          </AlertDialog.Content>
        </AlertDialog.Popup>
      </AlertDialog.Backdrop>
    </AlertDialog.Root>
  );
}
