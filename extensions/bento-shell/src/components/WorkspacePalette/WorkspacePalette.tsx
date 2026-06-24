import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { useShallow } from 'zustand/shallow';
import { CommandPalette as TaleCommandPalette } from '@tale-ui/react/command-palette';
import { Avatar } from '@tale-ui/react/avatar';
import { Button } from '@tale-ui/react/button';
import { ColorSwatch } from '@tale-ui/react/color-swatch';
import { ColorSwatchPicker } from '@tale-ui/react/color-swatch-picker';
import { Column } from '@tale-ui/react/column';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { TextField } from '@tale-ui/react/text-field';
import Check from 'lucide-react/dist/esm/icons/check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import type { Workspace } from '@shared/protocol';

import { requestConfirm } from '../../bridge/useConfirm';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { BENTO_THEMES, DEFAULT_THEME_ID, getThemeMeta } from '../../theme/presets';
import './WorkspacePalette.css';

export interface WorkspacePaletteProps {
  onClose: () => void;
}

interface WorkspaceDraft {
  name: string;
  icon: string;
}

type ColorSwatchPickerColor = Parameters<
  NonNullable<ComponentProps<typeof ColorSwatchPicker.Root>['onChange']>
>[0];

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

function commandText(workspace: Workspace): string {
  return [workspace.name, workspace.icon ?? '', getThemeMeta(workspace.themeId).name]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
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
  pickerValue: string;
  onDraftChange: (id: string, changes: Partial<WorkspaceDraft>) => void;
  onCommitName: (workspace: Workspace) => void;
  onCommitIcon: (workspace: Workspace) => void;
  onThemeChange: (workspace: Workspace, color: ColorSwatchPickerColor) => void;
  onActivate: (id: string) => void;
  onDelete: (workspace: Workspace) => void;
}

function WorkspaceEditorRow({
  workspace,
  draft,
  active,
  canDelete,
  tabCount,
  pickerValue,
  onDraftChange,
  onCommitName,
  onCommitIcon,
  onThemeChange,
  onActivate,
  onDelete,
}: WorkspaceEditorRowProps) {
  const displayName = draft.name.trim() || workspace.name;
  const avatarText = draft.icon.trim() || workspaceInitial(displayName);

  return (
    <Row gap="s" align="center" className="bento-workspace-palette__row">
      <Row gap="s" align="center" className="bento-workspace-palette__name-cell">
        <Avatar.Root
          size="sm"
          className="bento-workspace-switcher__avatar"
          data-bento-theme={workspace.themeId ?? DEFAULT_THEME_ID}
        >
          <Avatar.Fallback>{avatarText}</Avatar.Fallback>
        </Avatar.Root>
        <TextField.Root
          value={draft.name}
          onChange={(name) => onDraftChange(workspace.id, { name })}
          className="bento-workspace-palette__name-field"
        >
          <TextField.Label className="bento-workspace-palette__sr-only">
            Workspace name
          </TextField.Label>
          <TextField.Input
            className="bento-workspace-palette__field-input"
            onBlur={() => onCommitName(workspace)}
            onKeyDown={(event) => {
              if (!isEnterKey(event.key)) return;
              event.currentTarget.blur();
            }}
          />
        </TextField.Root>
      </Row>
      <TextField.Root
        value={draft.icon}
        onChange={(icon) => onDraftChange(workspace.id, { icon })}
        className="bento-workspace-palette__icon-field"
      >
        <TextField.Label className="bento-workspace-palette__sr-only">
          Workspace icon
        </TextField.Label>
        <TextField.Input
          className="bento-workspace-palette__field-input bento-workspace-palette__icon-input"
          placeholder="Icon"
          maxLength={2}
          onBlur={() => onCommitIcon(workspace)}
          onKeyDown={(event) => {
            if (!isEnterKey(event.key)) return;
            event.currentTarget.blur();
          }}
        />
      </TextField.Root>
      <ColorSwatchPicker.Root
        value={pickerValue}
        onChange={(color) => onThemeChange(workspace, color)}
        aria-label={`Theme for ${workspace.name}`}
        className="bento-workspace-palette__theme-picker"
        shape="circle"
      >
        {BENTO_THEMES.map((theme) => (
          <ColorSwatchPicker.Item key={theme.id} color={theme.brand60} aria-label={theme.name}>
            <ColorSwatch secondaryColor={theme.neutral20} />
          </ColorSwatchPicker.Item>
        ))}
      </ColorSwatchPicker.Root>
      <Button
        variant={active ? 'ghost' : 'neutral'}
        size="sm"
        onPress={() => onActivate(workspace.id)}
        isDisabled={active}
      >
        {active ? (
          <>
            <Icon icon={Check} size="sm" />
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
        isDisabled={!canDelete}
        onPress={() => onDelete(workspace)}
      >
        <Icon icon={Trash2} size="sm" />
      </IconButton>
      <Text variant="text" size="s" color="muted" className="bento-workspace-palette__sr-only">
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
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, WorkspaceDraft>>({});

  useEffect(() => {
    setDrafts((current) => {
      const next: Record<string, WorkspaceDraft> = {};
      for (const workspace of workspaces) {
        next[workspace.id] = current[workspace.id] ?? {
          name: workspace.name,
          icon: workspace.icon ?? '',
        };
      }
      return next;
    });
  }, [workspaces]);

  useEffect(() => {
    const focusSearch = () => {
      const input = document.querySelector(
        '.bento-workspace-palette__input',
      ) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    window.addEventListener('focus', focusSearch);
    return () => window.removeEventListener('focus', focusSearch);
  }, []);

  const themeIdByBrandHex = useMemo(() => {
    const out: Record<string, string> = {};
    for (const theme of BENTO_THEMES) out[theme.brand60.toLowerCase()] = theme.id;
    return out;
  }, []);

  const tabCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tab of tabs) {
      if (!tab.workspaceId) continue;
      out[tab.workspaceId] = (out[tab.workspaceId] ?? 0) + 1;
    }
    return out;
  }, [tabs]);

  const filteredWorkspaces = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return workspaces;
    return workspaces.filter((workspace) => commandText(workspace).includes(needle));
  }, [query, workspaces]);

  function setDraft(id: string, changes: Partial<WorkspaceDraft>) {
    setDrafts((current) => ({
      ...current,
      [id]: {
        name: current[id]?.name ?? '',
        icon: current[id]?.icon ?? '',
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

  function commitIcon(workspace: Workspace) {
    const draft = drafts[workspace.id]?.icon ?? '';
    const icon = draft.trim();
    const nextIcon = icon || undefined;
    if (nextIcon !== workspace.icon) {
      dispatch({ type: 'workspace/update', id: workspace.id, changes: { icon: nextIcon } });
    }
    setDraft(workspace.id, { icon });
  }

  function updateTheme(workspace: Workspace, color: ColorSwatchPickerColor) {
    const matchedId = themeIdByBrandHex[color.toString('hex').toLowerCase()];
    if (!matchedId || matchedId === workspace.themeId) return;
    dispatch({ type: 'workspace/update', id: workspace.id, changes: { themeId: matchedId } });
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
    <TaleCommandPalette.Root
      open={true}
      size="lg"
      closeOnSelect={false}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <TaleCommandPalette.Backdrop isDismissable>
        <TaleCommandPalette.Popup
          aria-label="Workspace palette"
          className="bento-workspace-palette__dialog"
          modalProps={{ className: 'bento-workspace-palette__popup' }}
        >
          <TaleCommandPalette.Title className="bento-workspace-palette__sr-only">
            Workspaces
          </TaleCommandPalette.Title>
          <TaleCommandPalette.Close aria-label="Close workspace palette" />
          <TaleCommandPalette.Content
            className="bento-workspace-palette__content"
            inputValue={query}
            onInputChange={setQuery}
          >
            <TaleCommandPalette.SearchField>
              <TaleCommandPalette.Input
                placeholder="Search workspaces..."
                className="bento-workspace-palette__input"
                autoFocus
              />
              <TaleCommandPalette.ClearButton aria-label="Clear search" />
            </TaleCommandPalette.SearchField>
            <Column gap="xs" className="bento-workspace-palette__list">
              <Row gap="s" align="center" className="bento-workspace-palette__heading-row">
                <Text variant="label" size="s" color="muted">
                  Workspace
                </Text>
                <Text variant="label" size="s" color="muted">
                  Icon
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
              {filteredWorkspaces.map((workspace) => (
                <WorkspaceEditorRow
                  key={workspace.id}
                  workspace={workspace}
                  draft={
                    drafts[workspace.id] ?? { name: workspace.name, icon: workspace.icon ?? '' }
                  }
                  active={workspace.id === activeId}
                  canDelete={workspaces.length > 1}
                  tabCount={tabCounts[workspace.id] ?? 0}
                  pickerValue={getThemeMeta(workspace.themeId).brand60}
                  onDraftChange={setDraft}
                  onCommitName={commitName}
                  onCommitIcon={commitIcon}
                  onThemeChange={updateTheme}
                  onActivate={activateWorkspace}
                  onDelete={deleteWorkspace}
                />
              ))}
            </Column>
            {filteredWorkspaces.length === 0 ? (
              <TaleCommandPalette.Empty>No matching workspaces.</TaleCommandPalette.Empty>
            ) : null}
            <TaleCommandPalette.Footer className="bento-workspace-palette__footer">
              <Text
                variant="text"
                size="s"
                color="muted"
                className="bento-workspace-palette__footer-text"
              >
                {resultLabel(filteredWorkspaces.length)}
              </Text>
              <Button
                variant="neutral"
                size="sm"
                className="bento-workspace-palette__new-button"
                onPress={createWorkspace}
              >
                <Icon icon={Plus} size="sm" />
                New workspace
              </Button>
            </TaleCommandPalette.Footer>
          </TaleCommandPalette.Content>
        </TaleCommandPalette.Popup>
      </TaleCommandPalette.Backdrop>
    </TaleCommandPalette.Root>
  );
}
