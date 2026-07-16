// Edit-workspace overlay entry. Mirrors src/confirm/main.tsx — its own
// Vite chunk + chrome <browser> frame so the form modal covers the entire
// browser window rather than being clipped to the sidebar.
//
// Lifecycle:
//   - Sidebar calls requestEditWorkspace({...}) when user clicks Edit.
//   - That helper (a) broadcasts the workspace snapshot on the
//     'bento-edit-workspace-bus' BroadcastChannel and (b) sets
//     document.title = BENTO_OPEN_EDIT_WORKSPACE_<ts>, which chrome's
//     bento-shell-mount.js poll picks up and reveals this overlay.
//   - This page's BroadcastChannel listener stores the payload in state;
//     the form re-renders with the live values.
//   - Cancel: set document.title = BENTO_CLOSE_EDIT_WORKSPACE_<ts>.
//   - Save: dispatch workspace/update through the existing tools port,
//     then close.
// Dialog stays mounted with isOpen=true permanently — visibility is
// purely a chrome concern via the host overlay (same pattern as palette
// and confirm).

import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '@tale-ui/react/dialog';
import { Button } from '@tale-ui/react/button';
import { TextField } from '@tale-ui/react/text-field';
import { Text } from '@tale-ui/react/text';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/card';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/dialog';
import '@tale-ui/react-styles/text-field';
import '@tale-ui/react-styles/color-swatch';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/list-box';
import '@tale-ui/react-styles/popover';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/search-field';
import '@tale-ui/react-styles/tooltip';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import {
  EDIT_WORKSPACE_CLOSE_PREFIX,
  subscribeToEditWorkspaceRequests,
  type EditWorkspacePayload,
} from '../bridge/useEditWorkspace';
import { DEFAULT_THEME_ID } from '../theme/presets';
import { WorkspaceIconField } from '../components/WorkspaceIconPicker/WorkspaceIconPicker';
import { WorkspaceThemePicker } from '../components/WorkspaceThemePicker/WorkspaceThemePicker';
import './edit-workspace.css';

initToolsPort();

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
}

function EditWorkspaceApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const [payload, setPayload] = useState<EditWorkspacePayload | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftThemeId, setDraftThemeId] = useState<string>(DEFAULT_THEME_ID);
  const [draftIcon, setDraftIcon] = useState('');

  useEffect(() => {
    return subscribeToEditWorkspaceRequests((next) => {
      // Reset form to the snapshot every time a new request arrives so
      // reopening the dialog after a cancel shows the live workspace
      // values, not the abandoned draft.
      setPayload(next);
      setDraftName(next.name);
      setDraftThemeId(next.themeId ?? DEFAULT_THEME_ID);
      setDraftIcon(next.icon ?? '');
    });
  }, []);

  function close() {
    document.title = `${EDIT_WORKSPACE_CLOSE_PREFIX}_${Date.now()}`;
  }

  function onSave() {
    if (!payload) {
      close();
      return;
    }
    const trimmedName = draftName.trim();
    const trimmedIcon = draftIcon.trim();
    dispatch({
      type: 'workspace/update',
      id: payload.workspaceId,
      changes: {
        // Empty name falls back to the snapshot — workspaces with empty
        // names render as "?" and become hard to identify.
        name: trimmedName || payload.name,
        themeId: draftThemeId,
        icon: trimmedIcon || undefined,
      },
    });
    close();
  }

  const workspaceName = draftName.trim() || payload?.name || 'workspace';

  return (
    <Dialog.Root
      isOpen={true}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Backdrop isDismissable>
        <Dialog.Popup>
          <Dialog.Title>Edit workspace</Dialog.Title>
          <Dialog.Description>
            Rename, pick a theme, or set an emoji for this workspace.
          </Dialog.Description>
          <Column gap="m" className="bento-edit-workspace__form">
            <Row gap="m" align="end" className="bento-edit-workspace__name-row">
              <Column gap="2xs" className="bento-edit-workspace__icon-field">
                <Text variant="label" size="s" as="span">
                  Icon
                </Text>
                <WorkspaceIconField
                  workspaceName={workspaceName}
                  value={draftIcon || undefined}
                  fallback={workspaceInitial(workspaceName)}
                  onIconChange={(icon) => setDraftIcon(icon ?? '')}
                />
              </Column>
              <TextField.Root
                value={draftName}
                onChange={setDraftName}
                className="bento-edit-workspace__name-field"
              >
                <TextField.Label>Workspace name</TextField.Label>
                <TextField.Input autoFocus />
              </TextField.Root>
            </Row>
            <Column gap="2xs">
              <Text variant="label" size="s">
                Theme
              </Text>
              <WorkspaceThemePicker
                workspaceName={workspaceName}
                selectedThemeId={draftThemeId}
                onThemeChange={setDraftThemeId}
              />
            </Column>
          </Column>
          <Dialog.Actions>
            <Button variant="neutral" onPress={close}>
              Cancel
            </Button>
            <Button variant="primary" onPress={onSave}>
              Save
            </Button>
          </Dialog.Actions>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell edit-workspace: #root not found');

createRoot(container).render(
  <StrictMode>
    <EditWorkspaceApp />
  </StrictMode>,
);
