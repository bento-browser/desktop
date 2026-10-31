import { describe, expect, it } from 'vitest';
import type { BookmarkItem } from '@shared/protocol';

import { groupCreate, itemCreate, itemRestore, newId, spaceCreate, tabsSave } from './actions';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('create actions carry a client id', () => {
  it('makes a lowercase UUID when none is given, and a different one each time', () => {
    const ids = [
      spaceCreate('A').id,
      groupCreate('s', 'B').id,
      itemCreate('g', null, { kind: 'note', text: 'n' }).id,
    ];
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set([...ids, newId()]).size).toBe(4);
  });

  it('puts the id and the rest of the contract in the action', () => {
    expect(spaceCreate('Trip', 'id-s')).toEqual({
      type: 'bookmarks/space/create',
      id: 'id-s',
      name: 'Trip',
    });
    expect(groupCreate('space-1', 'Gyms', 'id-g')).toEqual({
      type: 'bookmarks/group/create',
      id: 'id-g',
      spaceId: 'space-1',
      name: 'Gyms',
    });
    expect(itemCreate('group-1', null, { kind: 'todo', text: 'x' }, 'id-i')).toEqual({
      type: 'bookmarks/item/create',
      id: 'id-i',
      groupId: 'group-1',
      beforeId: null,
      item: { kind: 'todo', text: 'x' },
    });
  });
});

describe('tabsSave', () => {
  const ids = ['a', 'b', 'c'];
  const makeId = () => ids.shift()!;

  it('is one action for a drop at a slot: the place and an id per tab', () => {
    expect(tabsSave('space-1', [101, 102], { groupId: 'g', beforeId: 'item-9' }, makeId)).toEqual({
      type: 'bookmarks/tabs/save',
      spaceId: 'space-1',
      groupId: 'g',
      tabIds: [101, 102],
      beforeId: 'item-9',
      ids: ['a', 'b'],
    });
  });

  it('sends a null place for a drop at the end of a group', () => {
    expect(tabsSave('s', [1], { groupId: 'g', beforeId: null }, () => 'x')).toMatchObject({
      groupId: 'g',
      beforeId: null,
    });
  });

  it('sends no place for a new group, where there is nothing to go before', () => {
    const action = tabsSave('s', [1, 2], undefined, () => 'x');
    expect(action.groupId).toBeNull();
    expect('beforeId' in action).toBe(false);
    expect(action.ids).toHaveLength(2);
  });

  it('copies the tab ids, so a later change to the list does not reach the action', () => {
    const tabIds = [1];
    const action = tabsSave('s', tabIds);
    tabIds.push(2);
    expect(action.tabIds).toEqual([1]);
  });
});

describe('itemRestore (undo of a delete)', () => {
  const base = { groupId: 'g', order: 0, createdAt: 0 } as const;
  const a: BookmarkItem = { ...base, id: 'a', kind: 'note', text: 'a' };
  const b: BookmarkItem = {
    ...base,
    id: 'b',
    kind: 'link',
    url: 'https://b.example',
    title: 'B',
    favIconUrl: 'data:image/png;base64,AA==',
  };
  const c: BookmarkItem = { ...base, id: 'c', kind: 'todo', text: 'c', done: true };

  it('is one create before the sibling that followed, reusing the id so a repeat is refused', () => {
    expect(itemRestore(b, [a, b, c])).toEqual({
      type: 'bookmarks/item/create',
      id: 'b',
      groupId: 'g',
      beforeId: 'c',
      item: {
        kind: 'link',
        url: 'https://b.example',
        title: 'B',
        favIconUrl: 'data:image/png;base64,AA==',
      },
    });
  });

  it('puts the last row back at the end', () => {
    expect(itemRestore(c, [a, b, c])).toMatchObject({ beforeId: null });
  });

  it('restores a done to-do in the same action, with done: true', () => {
    expect(itemRestore(c, [a, b, c]).item).toEqual({ kind: 'todo', text: 'c', done: true });
    const open: BookmarkItem = { ...c, done: false };
    expect(itemRestore(open, [open]).item).toEqual({ kind: 'todo', text: 'c', done: false });
  });

  it('leaves out an absent favicon and restores a note as it was', () => {
    const plain: BookmarkItem = { ...b, favIconUrl: undefined };
    expect('favIconUrl' in (itemRestore(plain, [plain]).item as object)).toBe(false);
    expect(itemRestore(a, [a]).item).toEqual({ kind: 'note', text: 'a' });
  });
});
