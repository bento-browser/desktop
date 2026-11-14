// The edit-workspace layer: rename the workspace, set its icon and pick its theme. Requested by
// the sidebar (over bento-edit-workspace-bus) and by the switcher layer (in this document). Save
// dispatches workspace/update through the tools port; Cancel, Save, Esc and a click outside the
// dialog write the close title, and chrome fades the host out with the dialog still mounted.

import { useState } from 'react';
import { Button, Dialog, Text, TextField } from '@muxui/react';
import { Column, Row } from '../components/primitives';
import { dispatch } from '../bridge/useToolsPort';
import { EDIT_WORKSPACE_CLOSE_PREFIX, type EditWorkspacePayload } from '../bridge/useEditWorkspace';
import { DEFAULT_THEME_ID } from '../theme/presets';
import { WorkspaceIconField } from '../components/WorkspaceIconPicker/WorkspaceIconPicker';
import { WorkspaceThemePicker } from '../components/WorkspaceThemePicker/WorkspaceThemePicker';
import './edit-workspace.css';
import { sendWorkspaceLayerTitle } from './layers';

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
}

export function EditWorkspaceLayer({ payload }: { payload: EditWorkspacePayload }) {
  // The layer mounts for each request (main.tsx keys it by request), so the drafts start from
  // the live workspace values and never from an abandoned draft.
  const [draftName, setDraftName] = useState(payload.name);
  const [draftThemeId, setDraftThemeId] = useState<string>(payload.themeId ?? DEFAULT_THEME_ID);
  const [draftIcon, setDraftIcon] = useState(payload.icon ?? '');

  function close() {
    sendWorkspaceLayerTitle('edit-workspace', `${EDIT_WORKSPACE_CLOSE_PREFIX}_${Date.now()}`);
  }

  function onSave() {
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

  const workspaceName = draftName.trim() || payload.name || 'workspace';

  return (
    <Dialog
      open={true}
      title="Edit workspace"
      description="Rename, pick a theme, or set an emoji for this workspace."
      dismissable
      onOpenChange={(open) => {
        if (!open) close();
      }}
      actionsClassName="bento-edit-workspace__actions"
      actions={
        <>
          <Button variant="neutral" onActivate={close}>
            Cancel
          </Button>
          <Button variant="primary" onActivate={onSave}>
            Save
          </Button>
        </>
      }
    >
      <Column gap="m" className="bento-edit-workspace__form">
        <Row gap="m" align="end" className="bento-edit-workspace__name-row">
          <Column gap="2xs" className="bento-edit-workspace__icon-field">
            <Text variant="label" size="sm" as="span">
              Icon
            </Text>
            <WorkspaceIconField
              workspaceName={workspaceName}
              value={draftIcon || undefined}
              fallback={workspaceInitial(workspaceName)}
              onIconChange={(icon) => setDraftIcon(icon ?? '')}
            />
          </Column>
          <TextField
            label="Workspace name"
            value={draftName}
            onChange={setDraftName}
            className="bento-edit-workspace__name-field"
            autoFocus
          />
        </Row>
        <Column gap="2xs">
          <Text variant="label" size="sm">
            Theme
          </Text>
          <WorkspaceThemePicker
            workspaceName={workspaceName}
            selectedThemeId={draftThemeId}
            onThemeChange={setDraftThemeId}
          />
        </Column>
      </Column>
    </Dialog>
  );
}
