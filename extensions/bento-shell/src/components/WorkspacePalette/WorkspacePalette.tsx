import { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/shallow';
import { Button, Dialog, IconButton, Text, TextField } from '@muxui/react';
import Check from 'lucide-react/dist/esm/icons/check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import type { Workspace } from '@shared/protocol';

import { requestConfirm } from '../../bridge/useConfirm';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { BENTO_THEMES, DEFAULT_THEME_ID } from '../../theme/presets';
import { WorkspaceIconField } from '../WorkspaceIconPicker/WorkspaceIconPicker';
import { WorkspaceThemePicker } from '../WorkspaceThemePicker/WorkspaceThemePicker';
import { BentoIcon, Column, Row } from '../primitives';
import './WorkspacePalette.css';

export interface WorkspacePaletteProps {
  onClose: () => void;
}

interface WorkspaceDraft {
  name: string;
}

const THEME_ROTATION = BENTO_THEMES.map((theme) => theme.id).filter(
  (id) => id !== DEFAULT_THEME_ID,
);

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
}

function resultLabel(count: number): string {
  return `${count} ${count === 1 ? 'workspace' : 'workspaces'}`;
}

function pickRotatedTheme(used: ReadonlySet<string | undefined>, total: number): string {
  if (THEME_ROTATION.length === 0) return DEFAULT_THEME_ID;
  const unused = THEME_ROTATION.find((id) => !used.has(id));
  if (unused) return unused;
  return THEME_ROTATION[total % THEME_ROTATION.length]!;
}

function isEnterKey(key: string): boolean {
  return key === 'Enter';
}

interface WorkspaceEditorRowProps {
  workspace: Workspace;
  draft: WorkspaceDraft;
  active: boolean;
  canDelete: boolean;
  tabCount: number;
  onDraftChange: (id: string, changes: Partial<WorkspaceDraft>) => void;
  onCommitName: (workspace: Workspace) => void;
  onIconChange: (workspace: Workspace, icon: string | undefined) => void;
  onThemeChange: (workspace: Workspace, themeId: string) => void;
  onActivate: (id: string) => void;
  onDelete: (workspace: Workspace) => void;
}

function WorkspaceEditorRow({
  workspace,
  draft,
  active,
  canDelete,
  tabCount,
  onDraftChange,
  onCommitName,
  onIconChange,
  onThemeChange,
  onActivate,
  onDelete,
}: WorkspaceEditorRowProps) {
  const displayName = draft.name.trim() || workspace.name;

  return (
    <Row gap="s" align="center" className="bento-workspace-palette__row">
      <WorkspaceIconField
        workspaceName={workspace.name}
        value={workspace.icon}
        fallback={workspaceInitial(displayName)}
        onIconChange={(icon) => onIconChange(workspace, icon)}
      />
      <Row gap="s" align="center" className="bento-workspace-palette__name-cell">
        <TextField
          aria-label="Workspace name"
          value={draft.name}
          onChange={(name) => onDraftChange(workspace.id, { name })}
          className="bento-workspace-palette__name-field"
          inputProps={{
            className: 'bento-workspace-palette__field-input',
            onBlur: () => onCommitName(workspace),
            onKeyDown: (event) => {
              if (!isEnterKey(event.key)) return;
              event.preventDefault();
              event.currentTarget.blur();
            },
          }}
        />
      </Row>
      <WorkspaceThemePicker
        workspaceName={workspace.name}
        selectedThemeId={workspace.themeId}
        onThemeChange={(themeId) => onThemeChange(workspace, themeId)}
      />
      <Button
        variant={active ? 'ghost' : 'neutral'}
        size="sm"
        className="bento-workspace-palette__status-button"
        onActivate={() => onActivate(workspace.id)}
        disabled={active}
      >
        {active ? (
          <>
            <BentoIcon icon={Check} size="sm" />
            Active
          </>
        ) : (
          'Switch'
        )}
      </Button>
      <IconButton
        variant="danger"
        size="sm"
        aria-label={`Delete ${workspace.name}`}
        className="bento-workspace-palette__delete-button"
        disabled={!canDelete}
        onActivate={() => onDelete(workspace)}
      >
        <BentoIcon icon={Trash2} size="sm" />
      </IconButton>
      <Text variant="body" size="s" color="muted" className="bento-workspace-palette__sr-only">
        {tabCount} tabs
      </Text>
    </Row>
  );
}

export function WorkspacePalette({ onClose }: WorkspacePaletteProps) {
  const workspaces = useWorkspacesStore(useShallow((s) => s.orderedIds.map((id) => s.byId[id]!)));
  const tabs = useTabsStore(
    useShallow((s) => s.orderedIds.map((id) => s.byId[id]).filter((tab) => !!tab)),
  );
  const windowId = useCurrentWindowId();
  const activeId = useActiveWorkspaceIdForWindow(windowId);
  const [drafts, setDrafts] = useState<Record<string, WorkspaceDraft>>({});

  useEffect(() => {
    setDrafts((current) => {
      const next: Record<string, WorkspaceDraft> = {};
      for (const workspace of workspaces) {
        next[workspace.id] = current[workspace.id] ?? {
          name: workspace.name,
        };
      }
      return next;
    });
  }, [workspaces]);

  const tabCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tab of tabs) {
      if (!tab.workspaceId) continue;
      out[tab.workspaceId] = (out[tab.workspaceId] ?? 0) + 1;
    }
    return out;
  }, [tabs]);

  function setDraft(id: string, changes: Partial<WorkspaceDraft>) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        name: current[id]?.name ?? '',
        ...changes,
      },
    }));
  }

  function commitName(workspace: Workspace) {
    const draft = drafts[workspace.id]?.name ?? workspace.name;
    const name = draft.trim();
    if (!name) {
      setDraft(workspace.id, { name: workspace.name });
      return;
    }
    if (name !== workspace.name) {
      dispatch({ type: 'workspace/update', id: workspace.id, changes: { name } });
    }
    setDraft(workspace.id, { name });
  }

  function updateTheme(workspace: Workspace, themeId: string) {
    if (themeId !== (workspace.themeId ?? DEFAULT_THEME_ID)) {
      dispatch({ type: 'workspace/update', id: workspace.id, changes: { themeId } });
    }
  }

  function updateIcon(workspace: Workspace, icon: string | undefined) {
    if (icon !== workspace.icon) {
      dispatch({ type: 'workspace/update', id: workspace.id, changes: { icon } });
    }
  }

  function activateWorkspace(id: string) {
    dispatch({ type: 'workspace/activate', id });
  }

  function createWorkspace() {
    const nextIndex = workspaces.length;
    const usedThemes = new Set(workspaces.map((workspace) => workspace.themeId));
    dispatch({
      type: 'workspace/create',
      name: `Workspace ${nextIndex + 1}`,
      themeId: pickRotatedTheme(usedThemes, nextIndex),
    });
  }

  function deleteWorkspace(workspace: Workspace) {
    if (workspaces.length <= 1) return;
    const tabCount = tabCounts[workspace.id] ?? 0;
    if (tabCount === 0) {
      dispatch({ type: 'workspace/delete', id: workspace.id, closeTabs: false });
      return;
    }
    requestConfirm({
      title: `Delete "${workspace.name}"?`,
      description: `This will close ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'} in this workspace. This action cannot be undone.`,
      confirmLabel: 'Delete workspace',
      variant: 'danger',
      action: { type: 'workspace/delete', id: workspace.id, closeTabs: true },
    });
  }

  return (
    <Dialog
      open={true}
      title="Edit workspaces"
      dismissable
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      panelClassName="bento-workspace-palette__dialog"
      titleClassName="bento-workspace-palette__title"
      actionsClassName="bento-workspace-palette__footer"
      actions={
        <Row align="center" className="bento-workspace-palette__footer-content">
          <Text
            variant="body"
            size="s"
            color="muted"
            className="bento-workspace-palette__footer-text"
          >
            {resultLabel(workspaces.length)}
          </Text>
          <Button
            variant="ghost"
            size="sm"
            className="bento-workspace-palette__close-button"
            onActivate={onClose}
          >
            Close
          </Button>
        </Row>
      }
      contentClassName="bento-workspace-palette__dialog-content"
    >
      <Column gap="xs" className="bento-workspace-palette__content">
        <Column gap="xs" className="bento-workspace-palette__list">
          <Row gap="s" align="center" className="bento-workspace-palette__heading-row">
            <Text variant="label" size="s" color="muted">
              Icon
            </Text>
            <Text variant="label" size="s" color="muted">
              Workspace
            </Text>
            <Text variant="label" size="s" color="muted">
              Theme
            </Text>
            <Text variant="label" size="s" color="muted">
              Status
            </Text>
            <Text variant="label" size="s" color="muted">
              Delete
            </Text>
          </Row>
          {workspaces.map((workspace) => (
            <WorkspaceEditorRow
              key={workspace.id}
              workspace={workspace}
              draft={drafts[workspace.id] ?? { name: workspace.name }}
              active={workspace.id === activeId}
              canDelete={workspaces.length > 1}
              tabCount={tabCounts[workspace.id] ?? 0}
              onDraftChange={setDraft}
              onCommitName={commitName}
              onIconChange={updateIcon}
              onThemeChange={updateTheme}
              onActivate={activateWorkspace}
              onDelete={deleteWorkspace}
            />
          ))}
          <Row align="center" className="bento-workspace-palette__list-actions">
            <Button
              variant="neutral"
              size="sm"
              className="bento-workspace-palette__new-button"
              onActivate={createWorkspace}
            >
              <BentoIcon icon={Plus} size="sm" />
              Add workspace
            </Button>
          </Row>
        </Column>
      </Column>
    </Dialog>
  );
}
