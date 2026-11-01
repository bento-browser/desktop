import { describe, expect, it } from 'vitest';
import type { BookmarkGroup, BookmarkItem } from '@shared/protocol';

import {
  groupDrop,
  isGroupMoveNoop,
  isItemMoveNoop,
  itemDrop,
  type Box,
  type ColumnBox,
} from './drop';

const box = (left: number, top: number, right: number, bottom: number): Box => ({
  left,
  top,
  right,
  bottom,
});

/** Two columns 200 wide; each row 40 tall starting at y=100. */
function columns(): ColumnBox[] {
  const rows = (ids: string[], left: number) =>
    ids.map((id, index) => ({
      id,
      box: box(left, 100 + index * 40, left + 200, 140 + index * 40),
    }));
  return [
    { groupId: 'a', box: box(0, 100, 200, 500), items: rows(['a1', 'a2', 'a3'], 0) },
    { groupId: 'b', box: box(200, 100, 400, 500), items: rows(['b1'], 200) },
    { groupId: 'c', box: box(400, 100, 600, 500), items: [] },
  ];
}

describe('itemDrop', () => {
  it('lands before the first row whose middle is below the pointer', () => {
    const drop = itemDrop(columns(), { x: 50, y: 165 }, null);
    expect(drop).toMatchObject({ groupId: 'a', beforeId: 'a3' });
    // The line sits at the top of that row.
    expect(drop?.line).toEqual({ left: 0, right: 200, y: 180 });
  });

  it('lands at the end below the last row, with the line under it', () => {
    const drop = itemDrop(columns(), { x: 50, y: 400 }, null);
    expect(drop).toMatchObject({ groupId: 'a', beforeId: null });
    expect(drop?.line.y).toBe(220);
  });

  it('does not count the dragged row, so a row dropped on itself keeps its slot', () => {
    expect(itemDrop(columns(), { x: 50, y: 160 }, 'a2')).toMatchObject({ beforeId: 'a3' });
    expect(itemDrop(columns(), { x: 50, y: 125 }, 'a1')).toMatchObject({ beforeId: 'a2' });
  });

  it('drops into an empty column at the top of its list', () => {
    const drop = itemDrop(columns(), { x: 500, y: 300 }, null);
    expect(drop).toMatchObject({ groupId: 'c', beforeId: null });
    expect(drop?.line.y).toBe(100);
  });

  it('takes the nearest column when the pointer is beside the board', () => {
    expect(itemDrop(columns(), { x: 900, y: 110 }, null)).toMatchObject({ groupId: 'c' });
    expect(itemDrop(columns(), { x: -30, y: 110 }, null)).toMatchObject({ groupId: 'a' });
  });
});

describe('groupDrop', () => {
  const cols = [
    { groupId: 'a', box: box(0, 50, 200, 500) },
    { groupId: 'b', box: box(200, 50, 400, 500) },
    { groupId: 'c', box: box(400, 50, 600, 500) },
  ];

  it('lands before the first column whose middle is right of the pointer', () => {
    expect(groupDrop(cols, { x: 250, y: 60 }, 'c')).toMatchObject({
      beforeId: 'b',
      line: { x: 200, top: 50, bottom: 500 },
    });
  });

  it('lands last past the final column, with the line at its right edge', () => {
    expect(groupDrop(cols, { x: 590, y: 60 }, 'a')).toMatchObject({
      beforeId: null,
      line: { x: 600 },
    });
  });

  it('ignores the dragged column and has nowhere to land with no other', () => {
    expect(groupDrop(cols, { x: 100, y: 60 }, 'a')).toMatchObject({ beforeId: 'b' });
    expect(groupDrop([cols[0]!], { x: 100, y: 60 }, 'a')).toBeNull();
  });
});

const item = (id: string, groupId: string, order: number): BookmarkItem => ({
  id,
  groupId,
  order,
  createdAt: 0,
  kind: 'note',
  text: id,
});

describe('isItemMoveNoop', () => {
  const items = [item('a1', 'a', 0), item('a2', 'a', 1), item('a3', 'a', 2), item('b1', 'b', 0)];

  it('is true when the item would stay where it is', () => {
    expect(isItemMoveNoop(items, 'a2', 'a', 'a3')).toBe(true);
    expect(isItemMoveNoop(items, 'a3', 'a', null)).toBe(true);
    expect(isItemMoveNoop(items, 'a2', 'a', 'a2')).toBe(true);
  });

  it('is false for a change of order or of group', () => {
    expect(isItemMoveNoop(items, 'a2', 'a', 'a1')).toBe(false);
    expect(isItemMoveNoop(items, 'a2', 'a', null)).toBe(false);
    expect(isItemMoveNoop(items, 'a3', 'b', null)).toBe(false);
  });
});

describe('isGroupMoveNoop', () => {
  const groups: BookmarkGroup[] = ['a', 'b', 'c'].map((id, order) => ({
    id,
    spaceId: 's',
    name: id,
    color: 'gray',
    order,
  }));

  it('is true for the place the group already holds', () => {
    expect(isGroupMoveNoop(groups, 'b', 'c')).toBe(true);
    expect(isGroupMoveNoop(groups, 'c', null)).toBe(true);
  });

  it('is false for a real move', () => {
    expect(isGroupMoveNoop(groups, 'c', 'a')).toBe(false);
    expect(isGroupMoveNoop(groups, 'a', null)).toBe(false);
  });
});
