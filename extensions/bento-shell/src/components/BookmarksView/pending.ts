// Follow-up to an action that creates items. Tools assigns the ids of what it creates and the
// create actions return nothing, so the view finds the new items in the next snapshot: the ones in
// the group that were not there when it asked. Used to place a dropped tab where it was dropped
// and to mark a restored to-do as done again.

import type { BookmarkItem, BookmarkItemInput } from '@shared/protocol';
import type { BookmarksAction } from './types';

export interface PendingCreate {
  groupId: string;
  /** Ids the group held when the action was sent. */
  knownIds: ReadonlySet<string>;
  /** What to send once the new items are known, in the group's order. */
  then: (newIds: string[]) => BookmarksAction[];
  /** When it was sent (ms), so a create that never arrives is dropped. */
  at: number;
}

/** How long a pending create waits for its items before it is dropped. */
export const PENDING_CREATE_TTL_MS = 5000;

export function itemIdsIn(items: readonly BookmarkItem[], groupId: string): Set<string> {
  return new Set(items.filter((item) => item.groupId === groupId).map((item) => item.id));
}

/** The pending follow-up's actions when its items have arrived, else null. */
export function resolvePending(
  pending: PendingCreate,
  items: readonly BookmarkItem[],
): BookmarksAction[] | null {
  const fresh = items
    .filter((item) => item.groupId === pending.groupId && !pending.knownIds.has(item.id))
    .map((item) => item.id);
  return fresh.length > 0 ? pending.then(fresh) : null;
}

/** A tab dropped before `beforeId` is saved at the end of the group; this moves what was saved
 * to the drop position. Nothing to do when the drop was at the end. */
export function placeAt(groupId: string, beforeId: string | null) {
  return (newIds: string[]): BookmarksAction[] =>
    beforeId === null
      ? []
      : newIds.map((id) => ({ type: 'bookmarks/item/move', id, groupId, beforeId }));
}

/** The actions that put a deleted item back where it was. A to-do is created open, because
 * creating one takes no `done`; a done one carries a follow-up that ticks it once it exists. */
export interface RestorePlan {
  create: BookmarksAction;
  pending: Omit<PendingCreate, 'knownIds' | 'at'> | null;
}

function inputOf(item: BookmarkItem): BookmarkItemInput {
  if (item.kind === 'link') {
    return {
      kind: 'link',
      url: item.url,
      title: item.title,
      ...(item.favIconUrl ? { favIconUrl: item.favIconUrl } : {}),
    };
  }
  return item.kind === 'note'
    ? { kind: 'note', text: item.text }
    : { kind: 'todo', text: item.text };
}

/** `groupItems` are the group's items in order, as they were before the delete. */
export function restorePlan(item: BookmarkItem, groupItems: readonly BookmarkItem[]): RestorePlan {
  const index = groupItems.findIndex((entry) => entry.id === item.id);
  const beforeId = index === -1 ? null : (groupItems[index + 1]?.id ?? null);
  return {
    create: { type: 'bookmarks/item/create', groupId: item.groupId, beforeId, item: inputOf(item) },
    pending:
      item.kind === 'todo' && item.done
        ? {
            groupId: item.groupId,
            then: ([id]) => (id ? [{ type: 'bookmarks/item/update', id, done: true }] : []),
          }
        : null,
  };
}
