import { useEffect, useMemo, useRef, useState, type Key, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/shallow';
import { CommandPalette as TaleCommandPalette } from '@tale-ui/react/command-palette';
import { Avatar } from '@tale-ui/react/avatar';
import { Button } from '@tale-ui/react/button';
import { Column } from '@tale-ui/react/column';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { ListBox } from '@tale-ui/react/list-box';
import { Popover } from '@tale-ui/react/popover';
import { Row } from '@tale-ui/react/row';
import { SearchField } from '@tale-ui/react/search-field';
import { Text } from '@tale-ui/react/text';
import { TextField } from '@tale-ui/react/text-field';
import Check from 'lucide-react/dist/esm/icons/check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import XIcon from 'lucide-react/dist/esm/icons/x';
import type { Workspace } from '@shared/protocol';

import { requestConfirm } from '../../bridge/useConfirm';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { BENTO_THEMES, DEFAULT_THEME_ID, getThemeMeta } from '../../theme/presets';
import { WorkspaceThemePicker } from '../WorkspaceThemePicker/WorkspaceThemePicker';
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

type EmojiItem = {
  emoji: string;
  label: string;
  group: string;
  keywords?: string[];
};

type EmojiSeed = readonly [emoji: string, label: string, keywords?: readonly string[]];

const WORKSPACE_EMOJI_GROUPS: Array<{ group: string; items: EmojiSeed[] }> = [
  {
    group: 'Work and tools',
    items: [
      ['💼', 'Briefcase', ['work', 'business', 'office']],
      ['💻', 'Laptop', ['computer', 'code', 'development']],
      ['⌨️', 'Keyboard', ['typing', 'code', 'tools']],
      ['🛠️', 'Hammer and wrench', ['tools', 'build', 'fix']],
      ['⚙️', 'Gear', ['settings', 'operations', 'system']],
      ['📈', 'Chart increasing', ['analytics', 'growth', 'metrics']],
      ['📋', 'Clipboard', ['tasks', 'checklist', 'plan']],
      ['🎯', 'Target', ['goal', 'focus', 'objective']],
    ],
  },
  {
    group: 'Communication',
    items: [
      ['💬', 'Speech balloon', ['chat', 'message']],
      ['✉️', 'Envelope', ['email', 'mail']],
      ['📱', 'Mobile phone', ['mobile', 'call']],
      ['📣', 'Megaphone', ['announce', 'broadcast']],
      ['👥', 'Busts in silhouette', ['team', 'people']],
      ['🤝', 'Handshake', ['deal', 'partner']],
    ],
  },
  {
    group: 'Reading and research',
    items: [
      ['📚', 'Books', ['reading', 'library', 'study']],
      ['📘', 'Blue book', ['read', 'documentation']],
      ['📰', 'Newspaper', ['news', 'articles']],
      ['🔬', 'Microscope', ['research', 'science']],
      ['🔍', 'Magnifying glass', ['search', 'find']],
      ['🧠', 'Brain', ['thinking', 'learning']],
      ['💡', 'Light bulb', ['idea', 'insight']],
    ],
  },
  {
    group: 'Personal',
    items: [
      ['🏠', 'House', ['home', 'personal']],
      ['☕', 'Coffee', ['drink', 'break']],
      ['🎵', 'Musical note', ['music', 'audio']],
      ['🎮', 'Video game', ['play', 'gaming']],
      ['📷', 'Camera', ['photo', 'image']],
      ['🎨', 'Artist palette', ['creative', 'design']],
      ['❤️', 'Red heart', ['love', 'favorite']],
    ],
  },
  {
    group: 'Travel and places',
    items: [
      ['✈️', 'Airplane', ['flight', 'travel']],
      ['🚀', 'Rocket', ['launch', 'startup']],
      ['🚗', 'Car', ['drive', 'travel']],
      ['🚆', 'Train', ['rail', 'commute']],
      ['⛰️', 'Mountain', ['outdoors', 'hike']],
      ['🏙️', 'Cityscape', ['urban', 'place']],
    ],
  },
  {
    group: 'Symbols and shapes',
    items: [
      ['✨', 'Sparkles', ['shine', 'magic']],
      ['⭐', 'Star', ['favorite', 'important']],
      ['🔥', 'Fire', ['hot', 'urgent']],
      ['✅', 'Check mark button', ['done', 'complete']],
      ['⚠️', 'Warning', ['alert', 'risk']],
      ['🔒', 'Lock', ['security', 'private']],
      ['🔵', 'Blue circle', ['blue', 'shape']],
      ['📌', 'Pushpin', ['pinned', 'important']],
    ],
  },
];

const WORKSPACE_EMOJI_ITEMS: EmojiItem[] = WORKSPACE_EMOJI_GROUPS.flatMap(({ group, items }) =>
  items.map(([emoji, label, keywords]) => ({
    emoji,
    label,
    group,
    keywords: keywords ? [...keywords] : undefined,
  })),
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

function isPlainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
}

function emojiMatchesQuery(item: EmojiItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.emoji, item.label, item.group, ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function findEmojiByValue(value: string | undefined | null): EmojiItem | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return WORKSPACE_EMOJI_ITEMS.find((item) => item.emoji === normalized);
}

interface WorkspaceIconPickerProps {
  workspaceName: string;
  value: string | undefined;
  fallback: string;
  onIconChange: (icon: string | undefined) => void;
}

function WorkspaceIconPicker({
  workspaceName,
  value,
  fallback,
  onIconChange,
}: WorkspaceIconPickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedValue = value?.trim() || undefined;
  const selectedEmoji = findEmojiByValue(normalizedValue);
  const displayedIcon = normalizedValue ?? fallback;
  const isLegacyIcon = !!normalizedValue && !selectedEmoji;

  const filteredEmojis = useMemo(
    () => WORKSPACE_EMOJI_ITEMS.filter((item) => emojiMatchesQuery(item, query)),
    [query],
  );

  function closePicker() {
    setIsOpen(false);
    setQuery('');
  }

  function handleOpenChange(next: boolean) {
    setIsOpen(next);
    if (!next) {
      setQuery('');
      return;
    }
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }

  function selectEmoji(key: Key | null) {
    if (key == null) return;
    const emoji = filteredEmojis.find((item) => item.emoji === key);
    if (!emoji) return;
    onIconChange(emoji.emoji);
    closePicker();
  }

  function clearIcon() {
    onIconChange(undefined);
    closePicker();
  }

  function handlePanelKeyDownCapture(event: KeyboardEvent) {
    if (!isPlainEscape(event)) return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  }

  const selectedKeys = selectedEmoji ? [selectedEmoji.emoji] : [];
  const triggerDescription = selectedEmoji
    ? `${selectedEmoji.label} icon`
    : normalizedValue
      ? `${normalizedValue} custom icon`
      : `${fallback} initial`;

  return (
    <Popover.Root isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        className="tale-button tale-button--neutral tale-button--sm bento-workspace-palette__icon-trigger"
        aria-label={`Icon for ${workspaceName}: ${triggerDescription}`}
        data-bento-custom-icon={isLegacyIcon ? 'true' : undefined}
      >
        <span className="bento-workspace-palette__icon-trigger-value">{displayedIcon}</span>
      </Popover.Trigger>
      <Popover.Popup
        aria-label={`Choose icon for ${workspaceName}`}
        className="tale-popover__popup--frameless bento-workspace-palette__icon-popover"
        placement="bottom start"
        offset={8}
      >
        <Column
          gap="2xs"
          className="bento-workspace-palette__icon-panel"
          onKeyDownCapture={handlePanelKeyDownCapture}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Column
            gap="4xs"
            className="tale-popover__search-container bento-workspace-palette__icon-search"
          >
            <SearchField.Root slot={null} variant="inline" value={query} onChange={setQuery}>
              <SearchField.Label>Search workspace icons</SearchField.Label>
              <SearchField.Input ref={searchInputRef} placeholder="Search emoji..." />
              <SearchField.ClearButton aria-label="Clear icon search">
                <Icon icon={XIcon} size="sm" />
              </SearchField.ClearButton>
            </SearchField.Root>
          </Column>
          <Button
            variant="ghost"
            size="sm"
            className="bento-workspace-palette__icon-clear"
            isDisabled={!normalizedValue}
            onPress={clearIcon}
          >
            Clear icon
          </Button>
          {filteredEmojis.length > 0 ? (
            <ListBox.Root
              aria-label="Workspace icon emoji results"
              items={filteredEmojis}
              layout="grid"
              selectionMode="single"
              selectedKeys={selectedKeys}
              className="tale-list-box--frameless bento-workspace-palette__emoji-list"
              onSelectionChange={(keys) => {
                const key = keys === 'all' ? null : ([...keys][0] ?? null);
                selectEmoji(key);
              }}
            >
              {(item) => (
                <ListBox.Item
                  className="tale-list-box__item--emoji bento-workspace-palette__emoji-item"
                  id={item.emoji}
                  textValue={item.label}
                >
                  {item.emoji}
                </ListBox.Item>
              )}
            </ListBox.Root>
          ) : (
            <Text
              as="div"
              color="muted"
              className="tale-popover__empty bento-workspace-palette__icon-empty"
            >
              No emoji found.
            </Text>
          )}
        </Column>
      </Popover.Popup>
    </Popover.Root>
  );
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
  const avatarText = workspace.icon?.trim() || workspaceInitial(displayName);

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
      <WorkspaceIconPicker
        workspaceName={workspace.name}
        value={workspace.icon}
        fallback={workspaceInitial(displayName)}
        onIconChange={(icon) => onIconChange(workspace, icon)}
      />
      <WorkspaceThemePicker
        workspaceName={workspace.name}
        selectedThemeId={workspace.themeId}
        onThemeChange={(themeId) => onThemeChange(workspace, themeId)}
      />
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
              <TaleCommandPalette.ClearButton
                aria-label="Clear search"
                className="tale-button tale-button--ghost tale-button--sm"
              >
                Clear
              </TaleCommandPalette.ClearButton>
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
