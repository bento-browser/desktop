import { useEffect, useMemo, useRef, useState, type Key, type KeyboardEvent } from 'react';
import { useShallow } from 'zustand/shallow';
import { Button } from '@tale-ui/react/button';
import { Column } from '@tale-ui/react/column';
import { Dialog } from '@tale-ui/react/dialog';
import { Icon } from '@tale-ui/react/icon';
import { IconButton } from '@tale-ui/react/icon-button';
import { ListBox } from '@tale-ui/react/list-box';
import { Popover } from '@tale-ui/react/popover';
import { Row } from '@tale-ui/react/row';
import { SearchField } from '@tale-ui/react/search-field';
import { Text } from '@tale-ui/react/text';
import { TextField } from '@tale-ui/react/text-field';
import emojiDataUrl from 'emojibase-data/en/data.json?url';
import emojiMessagesUrl from 'emojibase-data/en/messages.json?url';
import Check from 'lucide-react/dist/esm/icons/check';
import Flag from 'lucide-react/dist/esm/icons/flag';
import Package from 'lucide-react/dist/esm/icons/package';
import PaletteIcon from 'lucide-react/dist/esm/icons/palette';
import PawPrint from 'lucide-react/dist/esm/icons/paw-print';
import Plane from 'lucide-react/dist/esm/icons/plane';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Shapes from 'lucide-react/dist/esm/icons/shapes';
import Smile from 'lucide-react/dist/esm/icons/smile';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import Trophy from 'lucide-react/dist/esm/icons/trophy';
import Users from 'lucide-react/dist/esm/icons/users';
import Utensils from 'lucide-react/dist/esm/icons/utensils';
import XIcon from 'lucide-react/dist/esm/icons/x';
import type { Workspace } from '@shared/protocol';

import { requestConfirm } from '../../bridge/useConfirm';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { BENTO_THEMES, DEFAULT_THEME_ID } from '../../theme/presets';
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
  subgroup: string;
  groupOrder: number;
  subgroupOrder: number;
  keywords?: string[];
  order: number;
};

type EmojiSection = {
  id: string;
  group: string;
  subgroup: string;
  groupOrder: number;
  subgroupOrder: number;
  items: EmojiItem[];
};

type EmojiCategory = {
  id: string;
  label: string;
  groupOrder: number;
  icon: typeof Smile;
  sections: EmojiSection[];
};

type EmojiLoadState = 'idle' | 'loading' | 'loaded' | 'error';

type EmojibaseEmoji = {
  emoji?: unknown;
  group?: unknown;
  label?: unknown;
  order?: unknown;
  shortcodes?: unknown;
  skins?: unknown;
  subgroup?: unknown;
  tags?: unknown;
  unicode?: unknown;
};

let workspaceEmojiItemsCache: EmojiItem[] | undefined;
let workspaceEmojiItemsPromise: Promise<EmojiItem[]> | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizedKeywordList(...sources: unknown[]): string[] | undefined {
  const seen = new Set<string>();
  const keywords: string[] = [];

  for (const source of sources) {
    for (const item of stringItems(source)) {
      const keyword = item.trim();
      const key = keyword.toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keywords.push(keyword);
    }
  }

  return keywords.length > 0 ? keywords : undefined;
}

function messageNamesFromMessages(
  messages: unknown,
  key: 'groups' | 'subgroups',
): Map<number, string> {
  const names = new Map<number, string>();
  const entries = isRecord(messages) ? messages[key] : undefined;
  if (!Array.isArray(entries)) return names;

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const order = finiteNumber(entry.order);
    if (order === undefined || typeof entry.message !== 'string') continue;
    names.set(order, entry.message);
  }

  return names;
}

function taxonomyOrder(value: unknown, fallback: unknown): number {
  return finiteNumber(value) ?? finiteNumber(fallback) ?? Number.MAX_SAFE_INTEGER;
}

function taxonomyName(order: number, names: ReadonlyMap<number, string>): string {
  if (order === Number.MAX_SAFE_INTEGER) return 'other';
  return names.get(order) ?? 'other';
}

function emojiItemFromSource(
  source: EmojibaseEmoji,
  groupNames: ReadonlyMap<number, string>,
  subgroupNames: ReadonlyMap<number, string>,
  fallbackOrder: number,
  parent?: EmojibaseEmoji,
): EmojiItem | undefined {
  const emoji =
    typeof source.emoji === 'string'
      ? source.emoji
      : typeof source.unicode === 'string'
        ? source.unicode
        : undefined;
  if (!emoji || typeof source.label !== 'string') return undefined;

  const groupOrder = taxonomyOrder(source.group, parent?.group);
  const subgroupOrder = taxonomyOrder(source.subgroup, parent?.subgroup);

  return {
    emoji,
    label: source.label,
    group: taxonomyName(groupOrder, groupNames),
    subgroup: taxonomyName(subgroupOrder, subgroupNames),
    groupOrder,
    subgroupOrder,
    keywords: normalizedKeywordList(
      parent?.tags,
      parent?.shortcodes,
      source.tags,
      source.shortcodes,
    ),
    order: finiteNumber(source.order) ?? finiteNumber(parent?.order) ?? fallbackOrder,
  };
}

function normalizeEmojibaseData(rawEmojis: unknown, rawMessages: unknown): EmojiItem[] {
  if (!Array.isArray(rawEmojis)) return [];
  const groupNames = messageNamesFromMessages(rawMessages, 'groups');
  const subgroupNames = messageNamesFromMessages(rawMessages, 'subgroups');
  const items: EmojiItem[] = [];

  rawEmojis.forEach((rawEmoji, index) => {
    if (!isRecord(rawEmoji)) return;
    const emoji = rawEmoji as EmojibaseEmoji;
    const baseOrder = finiteNumber(emoji.order) ?? index;
    const baseItem = emojiItemFromSource(emoji, groupNames, subgroupNames, baseOrder);
    if (baseItem) items.push(baseItem);

    const skins = Array.isArray(emoji.skins) ? emoji.skins : [];
    skins.forEach((rawSkin, skinIndex) => {
      if (!isRecord(rawSkin)) return;
      const skin = rawSkin as EmojibaseEmoji;
      const skinItem = emojiItemFromSource(
        skin,
        groupNames,
        subgroupNames,
        baseOrder + (skinIndex + 1) / 10,
        emoji,
      );
      if (skinItem) items.push(skinItem);
    });
  });

  return items.sort(
    (a, b) =>
      a.groupOrder - b.groupOrder ||
      a.subgroupOrder - b.subgroupOrder ||
      a.order - b.order ||
      a.label.localeCompare(b.label),
  );
}

async function fetchJsonAsset(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load emoji data: ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function loadWorkspaceEmojiItems(): Promise<EmojiItem[]> {
  if (workspaceEmojiItemsCache) return Promise.resolve(workspaceEmojiItemsCache);
  workspaceEmojiItemsPromise ??= Promise.all([
    fetchJsonAsset(emojiDataUrl),
    fetchJsonAsset(emojiMessagesUrl),
  ])
    .then(([rawEmojis, rawMessages]) => {
      const items = normalizeEmojibaseData(rawEmojis, rawMessages);
      if (items.length === 0) {
        throw new Error('Emoji dataset did not contain any usable entries.');
      }
      workspaceEmojiItemsCache = items;
      return items;
    })
    .catch((error: unknown) => {
      workspaceEmojiItemsPromise = undefined;
      throw error;
    });

  return workspaceEmojiItemsPromise;
}

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

function isPlainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
  );
}

function emojiMatchesQuery(item: EmojiItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [item.emoji, item.label, item.group, item.subgroup, ...(item.keywords ?? [])]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function groupEmojiSections(items: readonly EmojiItem[]): EmojiSection[] {
  const sectionMap = new Map<string, EmojiSection>();

  for (const item of items) {
    const sectionId = `${item.groupOrder}:${item.subgroupOrder}`;
    let section = sectionMap.get(sectionId);
    if (!section) {
      section = {
        id: sectionId,
        group: item.group,
        subgroup: item.subgroup,
        groupOrder: item.groupOrder,
        subgroupOrder: item.subgroupOrder,
        items: [],
      };
      sectionMap.set(sectionId, section);
    }
    section.items.push(item);
  }

  return [...sectionMap.values()].sort(
    (a, b) =>
      a.groupOrder - b.groupOrder ||
      a.subgroupOrder - b.subgroupOrder ||
      a.group.localeCompare(b.group) ||
      a.subgroup.localeCompare(b.subgroup),
  );
}

function categoryKeyForOrder(groupOrder: number): string {
  return groupOrder === Number.MAX_SAFE_INTEGER
    ? 'emoji-category-other'
    : `emoji-category-${groupOrder}`;
}

function categoryIconForOrder(groupOrder: number): typeof Smile {
  switch (groupOrder) {
    case 0:
      return Smile;
    case 1:
      return Users;
    case 2:
      return PaletteIcon;
    case 3:
      return PawPrint;
    case 4:
      return Utensils;
    case 5:
      return Plane;
    case 6:
      return Trophy;
    case 7:
      return Package;
    case 8:
      return Shapes;
    case 9:
      return Flag;
    default:
      return Shapes;
  }
}

function groupEmojiCategories(sections: readonly EmojiSection[]): EmojiCategory[] {
  const categoryMap = new Map<string, EmojiCategory>();

  for (const section of sections) {
    const categoryId = categoryKeyForOrder(section.groupOrder);
    let category = categoryMap.get(categoryId);
    if (!category) {
      category = {
        id: categoryId,
        label: section.group,
        groupOrder: section.groupOrder,
        icon: categoryIconForOrder(section.groupOrder),
        sections: [],
      };
      categoryMap.set(categoryId, category);
    }
    category.sections.push(section);
  }

  return [...categoryMap.values()].sort(
    (a, b) => a.groupOrder - b.groupOrder || a.label.localeCompare(b.label),
  );
}

function findEmojiByValue(
  value: string | undefined | null,
  items: readonly EmojiItem[] = workspaceEmojiItemsCache ?? [],
): EmojiItem | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return items.find((item) => item.emoji === normalized);
}

function looksLikeEmojiValue(value: string): boolean {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F]/u.test(value);
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
  const [activeCategoryKey, setActiveCategoryKey] = useState<string | null>(null);
  const [emojiItems, setEmojiItems] = useState<EmojiItem[]>(workspaceEmojiItemsCache ?? []);
  const [emojiLoadState, setEmojiLoadState] = useState<EmojiLoadState>(
    workspaceEmojiItemsCache ? 'loaded' : 'idle',
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedValue = value?.trim() || undefined;
  const selectedEmoji = findEmojiByValue(normalizedValue, emojiItems);
  const displayedIcon = normalizedValue ?? fallback;
  const isEmojiIcon =
    !!selectedEmoji || (!!normalizedValue && looksLikeEmojiValue(normalizedValue));
  const isLegacyIcon = !!normalizedValue && !isEmojiIcon;

  const filteredEmojis = useMemo(
    () => emojiItems.filter((item) => emojiMatchesQuery(item, query)),
    [emojiItems, query],
  );
  const emojiSections = useMemo(() => groupEmojiSections(filteredEmojis), [filteredEmojis]);
  const emojiCategories = useMemo(() => groupEmojiCategories(emojiSections), [emojiSections]);
  const selectedEmojiCategoryKey = selectedEmoji
    ? categoryKeyForOrder(selectedEmoji.groupOrder)
    : null;
  const activeCategoryExists =
    activeCategoryKey !== null &&
    emojiCategories.some((category) => category.id === activeCategoryKey);
  const selectedCategoryKey = activeCategoryExists
    ? activeCategoryKey
    : selectedEmojiCategoryKey &&
        emojiCategories.some((category) => category.id === selectedEmojiCategoryKey)
      ? selectedEmojiCategoryKey
      : (emojiCategories[0]?.id ?? null);
  const activeCategory =
    emojiCategories.find((category) => category.id === selectedCategoryKey) ?? null;

  useEffect(() => {
    if (!isOpen || emojiLoadState === 'loaded' || emojiLoadState === 'error') return undefined;
    if (workspaceEmojiItemsCache) {
      setEmojiItems(workspaceEmojiItemsCache);
      setEmojiLoadState('loaded');
      return undefined;
    }

    let isActive = true;
    setEmojiLoadState('loading');
    void loadWorkspaceEmojiItems()
      .then((items) => {
        if (!isActive) return;
        setEmojiItems(items);
        setEmojiLoadState('loaded');
      })
      .catch(() => {
        if (!isActive) return;
        setEmojiLoadState('error');
      });

    return () => {
      isActive = false;
    };
  }, [isOpen]);

  function closePicker() {
    setIsOpen(false);
    setQuery('');
    setActiveCategoryKey(null);
  }

  function handleOpenChange(next: boolean) {
    setIsOpen(next);
    if (!next) {
      setQuery('');
      setActiveCategoryKey(null);
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

  function handlePanelKeyDownCapture(event: KeyboardEvent) {
    if (!isPlainEscape(event)) return;
    event.preventDefault();
    event.stopPropagation();
    closePicker();
  }

  function handleEmojiTabListKeyDown(event: KeyboardEvent) {
    if (emojiCategories.length === 0) return;

    const currentIndex = Math.max(
      0,
      emojiCategories.findIndex((category) => category.id === selectedCategoryKey),
    );
    let nextIndex: number | undefined;

    if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + emojiCategories.length) % emojiCategories.length;
    } else if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % emojiCategories.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = emojiCategories.length - 1;
    }

    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextCategory = emojiCategories[nextIndex];
    if (!nextCategory) return;
    setActiveCategoryKey(nextCategory.id);
    requestAnimationFrame(() => {
      document.getElementById(`${nextCategory.id}-tab`)?.focus();
    });
  }

  const selectedKeys = selectedEmoji ? [selectedEmoji.emoji] : [];
  const triggerDescription = selectedEmoji
    ? `${selectedEmoji.label} icon`
    : normalizedValue && isEmojiIcon
      ? `${normalizedValue} emoji icon`
      : normalizedValue
        ? `${normalizedValue} custom icon`
        : `${fallback} initial`;
  const isEmojiLoading = emojiLoadState === 'idle' || emojiLoadState === 'loading';

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
          {emojiLoadState === 'error' ? (
            <Text
              as="div"
              color="muted"
              className="tale-popover__empty bento-workspace-palette__icon-empty"
            >
              Emoji data unavailable.
            </Text>
          ) : isEmojiLoading ? (
            <Text
              as="div"
              color="muted"
              className="tale-popover__empty bento-workspace-palette__icon-empty"
            >
              Loading emoji...
            </Text>
          ) : activeCategory ? (
            <Column gap="2xs" className="bento-workspace-palette__emoji-tabs">
              <Column
                role="tabpanel"
                id="emoji-category-panel"
                aria-labelledby={`${activeCategory.id}-tab`}
                className="bento-workspace-palette__emoji-tab-panel"
              >
                <ListBox.Root
                  aria-label={`${activeCategory.label} emoji results`}
                  layout="grid"
                  selectionMode="single"
                  selectedKeys={selectedKeys}
                  className="tale-list-box--frameless bento-workspace-palette__emoji-list"
                  onSelectionChange={(keys) => {
                    const key = keys === 'all' ? null : ([...keys][0] ?? null);
                    selectEmoji(key);
                  }}
                >
                  {activeCategory.sections.map((section) => (
                    <ListBox.Section
                      key={section.id}
                      id={`emoji-section-${section.id}`}
                      className="bento-workspace-palette__emoji-section"
                    >
                      <ListBox.Header className="bento-workspace-palette__emoji-section-header">
                        {section.subgroup}
                      </ListBox.Header>
                      {section.items.map((item) => (
                        <ListBox.Item
                          key={item.emoji}
                          className="tale-list-box__item--emoji bento-workspace-palette__emoji-item"
                          id={item.emoji}
                          textValue={item.label}
                        >
                          <span className="bento-workspace-palette__emoji-glyph">{item.emoji}</span>
                        </ListBox.Item>
                      ))}
                    </ListBox.Section>
                  ))}
                </ListBox.Root>
              </Column>
              <Row
                role="tablist"
                aria-label="Emoji categories"
                gap="4xs"
                className="bento-workspace-palette__emoji-tab-list"
                onKeyDown={handleEmojiTabListKeyDown}
              >
                {emojiCategories.map((category) => (
                  <button
                    key={category.id}
                    id={`${category.id}-tab`}
                    type="button"
                    role="tab"
                    aria-label={category.label}
                    aria-selected={category.id === selectedCategoryKey}
                    aria-controls="emoji-category-panel"
                    className="tale-icon-button tale-button tale-button--ghost tale-icon-button--sm bento-workspace-palette__emoji-tab"
                    data-selected={category.id === selectedCategoryKey ? 'true' : undefined}
                    onClick={() => setActiveCategoryKey(category.id)}
                  >
                    <span className="tale-button__content">
                      <Icon icon={category.icon} size="sm" />
                    </span>
                  </button>
                ))}
              </Row>
            </Column>
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
  const iconValue = workspace.icon?.trim();
  const hasIcon = !!iconValue;

  return (
    <Row gap="s" align="center" className="bento-workspace-palette__row">
      <Row className="bento-workspace-palette__icon-cell">
        <WorkspaceIconPicker
          workspaceName={workspace.name}
          value={workspace.icon}
          fallback={workspaceInitial(displayName)}
          onIconChange={(icon) => onIconChange(workspace, icon)}
        />
        {hasIcon ? (
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={`Clear icon for ${workspace.name}`}
            className="bento-workspace-palette__icon-clear-button"
            onPress={() => onIconChange(workspace, undefined)}
          >
            <Icon icon={XIcon} size="sm" strokeWidth={3} />
          </IconButton>
        ) : null}
      </Row>
      <Row gap="s" align="center" className="bento-workspace-palette__name-cell">
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
              event.preventDefault();
              event.currentTarget.blur();
            }}
          />
        </TextField.Root>
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
        className="bento-workspace-palette__delete-button"
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
    <Dialog.Root
      isOpen={true}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Backdrop isDismissable>
        <Dialog.Popup className="bento-workspace-palette__dialog">
          <Dialog.Close aria-label="Close" />
          <Dialog.Title className="bento-workspace-palette__title">Edit workspaces</Dialog.Title>
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
                  onPress={createWorkspace}
                >
                  <Icon icon={Plus} size="sm" />
                  Add workspace
                </Button>
              </Row>
            </Column>
            <Dialog.Actions className="bento-workspace-palette__footer">
              <Text
                variant="text"
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
                onPress={onClose}
              >
                Close
              </Button>
            </Dialog.Actions>
          </Column>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}
