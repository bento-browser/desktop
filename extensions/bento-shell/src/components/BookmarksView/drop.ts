// Where a dragged row or column lands, computed from measured boxes. Pure: the drag hook reads
// the boxes from the DOM and draws the insertion line from the result.

import type { BookmarkGroup, BookmarkItem } from '@shared/protocol';

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface ColumnBox {
  groupId: string;
  /** The column's item list, which the pointer has to be over to drop into it. */
  box: Box;
  items: Array<{ id: string; box: Box }>;
}

/** Where an item or tab would be inserted: into `groupId` before the item `beforeId` (the end when
 * null). `line` is the insertion line, a horizontal rule across the column. */
export interface ItemDrop {
  groupId: string;
  beforeId: string | null;
  line: { left: number; right: number; y: number };
}

export interface GroupDrop {
  beforeId: string | null;
  /** The insertion line, a vertical rule between columns. */
  line: { x: number; top: number; bottom: number };
}

export const contains = (box: Box, point: Point): boolean =>
  point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom;

/** The column the pointer is over, else the one nearest in x when it is over the board's empty
 * space (past the last column), so dropping beside a column still lands in it. */
function columnAt<T extends { box: Box }>(columns: readonly T[], x: number): T | null {
  let nearest: T | null = null;
  let distance = Infinity;
  for (const column of columns) {
    const d =
      x < column.box.left ? column.box.left - x : x >= column.box.right ? x - column.box.right : 0;
    if (d < distance) {
      distance = d;
      nearest = column;
    }
  }
  return nearest;
}

/** The slot an item or tab dropped at `point` takes: before the first remaining item whose middle
 * is below the pointer. `draggedId` (an item already in a column) is not counted. */
export function itemDrop(
  columns: readonly ColumnBox[],
  point: Point,
  draggedId: string | null,
): ItemDrop | null {
  const column = columnAt(columns, point.x);
  if (!column) return null;
  const items = column.items.filter((item) => item.id !== draggedId);
  const slot = items.findIndex((item) => point.y < (item.box.top + item.box.bottom) / 2);
  const before = slot === -1 ? null : items[slot]!;
  const last = items[items.length - 1];
  const y = before ? before.box.top : last ? last.box.bottom : column.box.top;
  return {
    groupId: column.groupId,
    beforeId: before?.id ?? null,
    line: { left: column.box.left, right: column.box.right, y },
  };
}

/** The slot a column dragged to `point` takes among the other columns, by their middles in x. */
export function groupDrop(
  columns: ReadonlyArray<{ groupId: string; box: Box }>,
  point: Point,
  draggedId: string,
): GroupDrop | null {
  const others = columns.filter((column) => column.groupId !== draggedId);
  if (others.length === 0) return null;
  const slot = others.findIndex((column) => point.x < (column.box.left + column.box.right) / 2);
  const before = slot === -1 ? null : others[slot]!;
  const last = others[others.length - 1]!;
  const edge = before ?? last;
  return {
    beforeId: before?.groupId ?? null,
    line: {
      x: before ? before.box.left : last.box.right,
      top: edge.box.top,
      bottom: edge.box.bottom,
    },
  };
}

/** True when moving `id` into `groupId` before `beforeId` would leave the order as it is. */
export function isItemMoveNoop(
  items: readonly BookmarkItem[],
  id: string,
  groupId: string,
  beforeId: string | null,
): boolean {
  const siblings = items.filter((item) => item.groupId === groupId);
  const index = siblings.findIndex((item) => item.id === id);
  if (index === -1) return false;
  if (beforeId === id) return true;
  const next = siblings[index + 1]?.id ?? null;
  return next === beforeId;
}

/** True when moving the group `id` before `beforeId` among the space's groups changes nothing. */
export function isGroupMoveNoop(
  groups: readonly BookmarkGroup[],
  id: string,
  beforeId: string | null,
): boolean {
  const index = groups.findIndex((group) => group.id === id);
  if (index === -1) return false;
  if (beforeId === id) return true;
  const next = groups[index + 1]?.id ?? null;
  return next === beforeId;
}
