import type { Action, BookmarkColor } from '@shared/protocol';

/** The shell actions the Bookmarks view sends to bento-tools. */
export type BookmarksAction = Extract<Action, { type: `bookmarks/${string}` }>;

/** A tab of the window's active workspace that can be saved: the drawer's rows. */
export interface OpenTab {
  id: number;
  title: string;
  url: string;
  favIconUrl?: string;
}

/** A group of the current space as a menu offers it: "Move to group", "Save to group". */
export interface GroupChoice {
  id: string;
  name: string;
  color: BookmarkColor;
}

/** The one inline editor that is open, if any. */
export type EditTarget =
  | { kind: 'item'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'space'; id: string }
  | { kind: 'add-item'; groupId: string }
  | { kind: 'add-group' }
  | { kind: 'add-space' };

/** Opens an editor (a target) or closes the open one (null). A close by keyboard (Enter or Esc)
 * passes `returnFocus`, so the focus goes back to the row or trigger the editor began on; a close
 * by the field losing focus must not move the focus, because the user has already chosen where it
 * goes. */
export type EditHandler = (target: EditTarget | null, returnFocus?: boolean) => void;

export function isEditing(current: EditTarget | null, target: EditTarget): boolean {
  if (!current || current.kind !== target.kind) return false;
  if ('id' in current && 'id' in target) return current.id === target.id;
  if ('groupId' in current && 'groupId' in target) return current.groupId === target.groupId;
  return true;
}

/** The part of the open editor a column cares about: its own rename, its entry, or the edit of one
 * of its rows. Other columns get null, so opening an editor re-renders one column. */
export function editingInColumn(
  current: EditTarget | null,
  groupId: string,
  itemIds: readonly string[],
): EditTarget | null {
  if (!current) return null;
  switch (current.kind) {
    case 'group':
      return current.id === groupId ? current : null;
    case 'add-item':
      return current.groupId === groupId ? current : null;
    case 'item':
      return itemIds.includes(current.id) ? current : null;
    default:
      return null;
  }
}
