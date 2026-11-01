// The actions the view sends that create something. Each create carries a client id (a UUID from
// `crypto.randomUUID()`) so a follow-up (select the new space, scroll to the new row, focus it)
// names exactly what the view made instead of guessing from the next snapshot. Tools refuses an id
// that exists, so a repeated send creates nothing twice.

import type { BookmarkItem, BookmarkItemInput } from '@shared/protocol';
import type { BookmarksAction } from './types';

type Of<T extends BookmarksAction['type']> = Extract<BookmarksAction, { type: T }>;

export const newId = (): string => crypto.randomUUID();

export const spaceCreate = (
  name: string,
  id: string = newId(),
): Of<'bookmarks/space/create'> & { id: string } => ({ type: 'bookmarks/space/create', id, name });

export const groupCreate = (
  spaceId: string,
  name: string,
  id: string = newId(),
): Of<'bookmarks/group/create'> & { id: string } => ({
  type: 'bookmarks/group/create',
  id,
  spaceId,
  name,
});

export const itemCreate = (
  groupId: string,
  beforeId: string | null,
  item: BookmarkItemInput,
  id: string = newId(),
): Of<'bookmarks/item/create'> & { id: string } => ({
  type: 'bookmarks/item/create',
  id,
  groupId,
  beforeId,
  item,
});

/** Where saved tabs go: a group (before `beforeId`, the end when null), or a new group. */
export interface TabsTarget {
  groupId: string | null;
  beforeId: string | null;
}

/** One `tabs/save` for any number of tabs. `ids[i]` is the id of the link saved from `tabIds[i]`,
 * and `beforeId` places the whole run, so a drop at a slot is a single action. */
export function tabsSave(
  spaceId: string,
  tabIds: readonly number[],
  target: TabsTarget = { groupId: null, beforeId: null },
  makeId: () => string = newId,
): Of<'bookmarks/tabs/save'> & { ids: string[] } {
  return {
    type: 'bookmarks/tabs/save',
    spaceId,
    groupId: target.groupId,
    tabIds: [...tabIds],
    // Tools ignores a place for a new group, so none is sent.
    ...(target.groupId === null ? {} : { beforeId: target.beforeId }),
    ids: tabIds.map(() => makeId()),
  };
}

function inputOf(item: BookmarkItem): BookmarkItemInput {
  switch (item.kind) {
    case 'link':
      return {
        kind: 'link',
        url: item.url,
        title: item.title,
        ...(item.favIconUrl ? { favIconUrl: item.favIconUrl } : {}),
      };
    case 'note':
      return { kind: 'note', text: item.text };
    case 'todo':
      return { kind: 'todo', text: item.text, done: item.done };
  }
}

/** The one action that puts a deleted item back where it was, before the sibling that followed
 * it, a to-do with its tick. It reuses the item's id (gone after the delete), so a second Undo, or
 * an Undo of a delete that never happened, is refused instead of making a copy. `groupItems` are
 * the group's items in order as they were before the delete. */
export function itemRestore(
  item: BookmarkItem,
  groupItems: readonly BookmarkItem[],
): Of<'bookmarks/item/create'> & { id: string } {
  const index = groupItems.findIndex((entry) => entry.id === item.id);
  const beforeId = index === -1 ? null : (groupItems[index + 1]?.id ?? null);
  return itemCreate(item.groupId, beforeId, inputOf(item), item.id);
}
