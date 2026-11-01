// What each menu of the Bookmarks view offers, as data. A row's "More actions", a column's "...",
// a space's "...", an open tab's "Save" and the right-click menu (contextMenuModel.ts) all build their
// items here, so an action means the same thing wherever it is offered: one list per kind of
// element, one handler behind each entry. `MenuEntries.tsx` draws a list with the public Mux
// `Menu` parts. Pure: nothing here touches the DOM or React.

import {
  BOOKMARK_COLORS,
  type BookmarkColor,
  type BookmarkGroup,
  type BookmarkItem,
} from '@shared/protocol';

import type { SpaceSummary } from './model';
import type { BookmarksAction, EditHandler, GroupChoice, OpenTab } from './types';

export type MenuEntry =
  | {
      type: 'action';
      id: string;
      label: string;
      /** Missing on a disabled entry. */
      onAction?: () => void;
      disabled?: boolean;
      /** A colour dot before the label. */
      swatch?: BookmarkColor;
      /** A tick after the label: the current colour. */
      checked?: boolean;
    }
  | { type: 'separator'; id: string }
  | { type: 'submenu'; id: string; label: string; entries: readonly MenuEntry[] };

const COLOR_LABELS: Record<BookmarkColor, string> = {
  gray: 'Gray',
  red: 'Red',
  orange: 'Orange',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  purple: 'Purple',
};

const separator = (id: string): MenuEntry => ({ type: 'separator', id });

const colourEntry = (color: BookmarkColor, onColor: (color: BookmarkColor) => void): MenuEntry => ({
  type: 'submenu',
  id: 'colour',
  label: 'Colour',
  entries: BOOKMARK_COLORS.map((entry) => ({
    type: 'action',
    id: `colour:${entry}`,
    label: COLOR_LABELS[entry],
    swatch: entry,
    checked: entry === color,
    onAction: () => onColor(entry),
  })),
});

/** A submenu of the space's groups, each with its colour dot, then (when `onNewGroup` is given) a
 * "New group" item. With nothing to pick the entry is disabled instead of opening an empty list. */
function groupPicker(
  id: string,
  label: string,
  groups: readonly GroupChoice[],
  onPick: (groupId: string) => void,
  onNewGroup?: () => void,
): MenuEntry {
  if (groups.length === 0 && !onNewGroup) return { type: 'action', id, label, disabled: true };
  const entries: MenuEntry[] = groups.map((group) => ({
    type: 'action',
    id: `group:${group.id}`,
    label: group.name,
    swatch: group.color,
    onAction: () => onPick(group.id),
  }));
  if (onNewGroup) {
    if (groups.length > 0) entries.push(separator('group:separator'));
    entries.push({ type: 'action', id: 'group:new', label: 'New group', onAction: onNewGroup });
  }
  return { type: 'submenu', id, label, entries };
}

// ---- A link, note or to-do ----------------------------------------------------------------

/** What an item row's menus call. The row receives the same ones as props. */
export interface ItemHandlers {
  send: (action: BookmarksAction) => void;
  onEdit: EditHandler;
  /** Opens the link and leaves the view. */
  onOpen: (id: string, where: 'panel' | 'tab') => void;
  onCopy: (text: string) => void;
  /** Deletes the item and offers the undo. */
  onDelete: (item: BookmarkItem) => void;
  /** Moves the item into `groupId` before `beforeId` (the end when null). */
  onMove: (id: string, groupId: string, beforeId: string | null) => void;
}

/** Where an item can go: the space's groups and the neighbour slots (see `neighbourMoves`). */
export interface ItemSlots {
  groups: readonly GroupChoice[];
  /** The `beforeId` of "Move up" (the item above). Undefined: the row is first. */
  moveUpBefore: string | undefined;
  /** The `beforeId` of "Move down" (null: the end). Undefined: the row is last. */
  moveDownBefore: string | null | undefined;
}

export function itemEntries(
  item: BookmarkItem,
  { groups, moveUpBefore, moveDownBefore }: ItemSlots,
  { send, onEdit, onOpen, onCopy, onDelete, onMove }: ItemHandlers,
): MenuEntry[] {
  const entries: MenuEntry[] = [];
  if (item.kind === 'link') {
    entries.push(
      {
        type: 'action',
        id: 'open-panel',
        label: 'Open in panel',
        onAction: () => onOpen(item.id, 'panel'),
      },
      {
        type: 'action',
        id: 'open-tab',
        label: 'Open in new tab',
        onAction: () => onOpen(item.id, 'tab'),
      },
      { type: 'action', id: 'copy-link', label: 'Copy link', onAction: () => onCopy(item.url) },
    );
  }
  entries.push({
    type: 'action',
    id: 'edit',
    label: 'Edit',
    onAction: () => onEdit({ kind: 'item', id: item.id }),
  });
  if (item.kind === 'todo') {
    entries.push({
      type: 'action',
      id: 'done',
      label: item.done ? 'Mark not done' : 'Mark done',
      onAction: () => send({ type: 'bookmarks/item/update', id: item.id, done: !item.done }),
    });
  }
  entries.push(
    {
      type: 'submenu',
      id: 'move',
      label: 'Move',
      entries: [
        groupPicker(
          'move-group',
          'Move to group',
          groups.filter((group) => group.id !== item.groupId),
          (groupId) => onMove(item.id, groupId, null),
        ),
        {
          type: 'action',
          id: 'move-up',
          label: 'Move up',
          disabled: moveUpBefore === undefined,
          onAction:
            moveUpBefore === undefined
              ? undefined
              : () => onMove(item.id, item.groupId, moveUpBefore),
        },
        {
          type: 'action',
          id: 'move-down',
          label: 'Move down',
          disabled: moveDownBefore === undefined,
          onAction:
            moveDownBefore === undefined
              ? undefined
              : () => onMove(item.id, item.groupId, moveDownBefore),
        },
      ],
    },
    separator('separator'),
    { type: 'action', id: 'delete', label: 'Delete', onAction: () => onDelete(item) },
  );
  return entries;
}

// ---- A group (column) ---------------------------------------------------------------------

export interface GroupHandlers {
  send: (action: BookmarksAction) => void;
  onEdit: EditHandler;
  onMoveGroup: (id: string, beforeId: string | null) => void;
  /** Opens every link in a panel and leaves the view. */
  onOpenAll: (links: BookmarkItem[]) => void;
  onDeleteGroup: (group: BookmarkGroup, itemCount: number) => void;
}

/** Where a column can go: the `beforeId` of "Move left" and "Move right", undefined when it
 * cannot move that way. */
export interface GroupSlots {
  moveLeftBefore: string | undefined;
  moveRightBefore: string | null | undefined;
}

export function groupEntries(
  group: BookmarkGroup,
  items: readonly BookmarkItem[],
  { moveLeftBefore, moveRightBefore }: GroupSlots,
  { send, onEdit, onMoveGroup, onOpenAll, onDeleteGroup }: GroupHandlers,
): MenuEntry[] {
  const links = items.filter((item) => item.kind === 'link');
  return [
    ...(links.length > 0
      ? [
          {
            type: 'action',
            id: 'open-all',
            label: `Open all ${links.length} in panels`,
            onAction: () => onOpenAll(links),
          } satisfies MenuEntry,
        ]
      : []),
    {
      type: 'action',
      id: 'rename',
      label: 'Rename',
      onAction: () => onEdit({ kind: 'group', id: group.id }),
    },
    colourEntry(group.color, (color) =>
      send({ type: 'bookmarks/group/update', id: group.id, color }),
    ),
    {
      type: 'action',
      id: 'move-left',
      label: 'Move left',
      disabled: moveLeftBefore === undefined,
      onAction:
        moveLeftBefore === undefined ? undefined : () => onMoveGroup(group.id, moveLeftBefore),
    },
    {
      type: 'action',
      id: 'move-right',
      label: 'Move right',
      disabled: moveRightBefore === undefined,
      onAction:
        moveRightBefore === undefined ? undefined : () => onMoveGroup(group.id, moveRightBefore),
    },
    separator('separator'),
    {
      type: 'action',
      id: 'delete',
      label: 'Delete group',
      onAction: () => onDeleteGroup(group, items.length),
    },
  ];
}

// ---- A space ------------------------------------------------------------------------------

export interface SpaceHandlers {
  send: (action: BookmarksAction) => void;
  onEdit: EditHandler;
  /** Asks first (the view's confirmation), then deletes. */
  onDeleteSpace: (summary: SpaceSummary) => void;
}

export function spaceEntries(
  summary: SpaceSummary,
  { send, onEdit, onDeleteSpace }: SpaceHandlers,
): MenuEntry[] {
  const { space } = summary;
  return [
    {
      type: 'action',
      id: 'rename',
      label: 'Rename',
      onAction: () => onEdit({ kind: 'space', id: space.id }),
    },
    colourEntry(space.color, (color) =>
      send({ type: 'bookmarks/space/update', id: space.id, color }),
    ),
    separator('separator'),
    { type: 'action', id: 'delete', label: 'Delete space', onAction: () => onDeleteSpace(summary) },
  ];
}

// ---- An open tab and the board ------------------------------------------------------------

/** Saves one tab at the end of `groupId`, or into a new group when null. */
export type SaveTab = (tab: OpenTab, groupId: string | null) => void;

/** "Save to group": the space's groups, then "New group". */
export function tabEntries(
  tab: OpenTab,
  groups: readonly GroupChoice[],
  onSaveTab: SaveTab,
): MenuEntry[] {
  return [
    groupPicker(
      'save-to-group',
      'Save to group',
      groups,
      (groupId) => onSaveTab(tab, groupId),
      () => onSaveTab(tab, null),
    ),
  ];
}

export interface BoardHandlers {
  onEdit: EditHandler;
  /** Saves every open tab into a new group. */
  onSaveAllTabs: () => void;
}

/** The board's own background: a new group, and the open tabs in one go. */
export function boardEntries(
  tabCount: number,
  { onEdit, onSaveAllTabs }: BoardHandlers,
): MenuEntry[] {
  return [
    {
      type: 'action',
      id: 'new-group',
      label: 'New group',
      onAction: () => onEdit({ kind: 'add-group' }),
    },
    ...(tabCount > 0
      ? [
          {
            type: 'action',
            id: 'save-all-tabs',
            label: 'Save all open tabs to new group',
            onAction: onSaveAllTabs,
          } satisfies MenuEntry,
        ]
      : []),
  ];
}
