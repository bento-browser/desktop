// What the bookmarks toolbar shows for one snapshot, and how many of its group buttons fit.
// Pure, so it is tested on plain data.

import type { BookmarkGroup, BookmarkSpace, BookmarksSnapshot } from '@shared/protocol';

export interface ToolbarModel {
  /** The space shown: `lastSpaceId`, else the first space. */
  space: BookmarkSpace;
  /** Its groups, in order. */
  groups: BookmarkGroup[];
  /** Links in the space; the toolbar shows a hint when there are none. */
  linkCount: number;
}

/** Null while there is nothing to show: no snapshot, a failed load, or no space. */
export function toolbarModel(snapshot: BookmarksSnapshot | null): ToolbarModel | null {
  if (snapshot?.status !== 'ready') return null;
  const space =
    snapshot.spaces.find((entry) => entry.id === snapshot.lastSpaceId) ?? snapshot.spaces[0];
  if (!space) return null;
  const groups = snapshot.groups.filter((group) => group.spaceId === space.id);
  const groupIds = new Set(groups.map((group) => group.id));
  const linkCount = snapshot.items.filter(
    (item) => item.kind === 'link' && groupIds.has(item.groupId),
  ).length;
  return { space, groups, linkCount };
}

/**
 * How many group buttons, from the start, fit in `available` px. When they all fit there is no
 * overflow button; otherwise the overflow button takes `overflowWidth` plus one gap, and the
 * buttons that still fit stay. `widths` are the buttons' own widths, `gap` the space between
 * neighbours.
 */
export function visibleGroupCount(
  widths: readonly number[],
  available: number,
  gap: number,
  overflowWidth: number,
): number {
  const fits = (count: number, room: number) => {
    const used = widths.slice(0, count).reduce((sum, width) => sum + width, 0);
    return used + Math.max(0, count - 1) * gap <= room;
  };
  if (fits(widths.length, available)) return widths.length;
  const room = available - overflowWidth - gap;
  let count = 0;
  while (count < widths.length && fits(count + 1, room)) count += 1;
  return count;
}
