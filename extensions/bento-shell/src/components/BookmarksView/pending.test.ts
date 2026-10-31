import { describe, expect, it } from 'vitest';
import type { BookmarkItem } from '@shared/protocol';

import { itemIdsIn, placeAt, resolvePending, restorePlan, type PendingCreate } from './pending';

const link = (
  id: string,
  groupId: string,
  order: number,
): Extract<BookmarkItem, { kind: 'link' }> => ({
  id,
  groupId,
  order,
  createdAt: 0,
  kind: 'link',
  url: `https://${id}.example`,
  title: id,
});

describe('resolvePending', () => {
  const known = [link('a', 'g', 0), link('b', 'g', 1)];
  const pending = (then: PendingCreate['then']): PendingCreate => ({
    groupId: 'g',
    knownIds: itemIdsIn(known, 'g'),
    then,
    at: 0,
  });

  it('waits until an item that was not there shows up in the group', () => {
    const wait = pending((ids) => [{ type: 'bookmarks/item/delete', id: ids[0]! }]);
    expect(resolvePending(wait, known)).toBeNull();
    // Another group's new item is not its business.
    expect(resolvePending(wait, [...known, link('x', 'other', 0)])).toBeNull();
    expect(resolvePending(wait, [...known, link('c', 'g', 2)])).toEqual([
      { type: 'bookmarks/item/delete', id: 'c' },
    ]);
  });

  it('hands over every new item, in the group order', () => {
    const both = pending((ids) => ids.map((id) => ({ type: 'bookmarks/item/delete', id })));
    expect(resolvePending(both, [...known, link('c', 'g', 2), link('d', 'g', 3)])).toEqual([
      { type: 'bookmarks/item/delete', id: 'c' },
      { type: 'bookmarks/item/delete', id: 'd' },
    ]);
  });
});

describe('placeAt', () => {
  it('moves what was saved before the drop target, keeping its order', () => {
    expect(placeAt('g', 'b')(['c', 'd'])).toEqual([
      { type: 'bookmarks/item/move', id: 'c', groupId: 'g', beforeId: 'b' },
      { type: 'bookmarks/item/move', id: 'd', groupId: 'g', beforeId: 'b' },
    ]);
  });

  it('does nothing for a drop at the end, where tools already put it', () => {
    expect(placeAt('g', null)(['c'])).toEqual([]);
  });
});

describe('restorePlan', () => {
  const items = [link('a', 'g', 0), link('b', 'g', 1), link('c', 'g', 2)];

  it('recreates a link before the sibling that followed it, favicon included', () => {
    const withIcon: BookmarkItem = {
      ...link('b', 'g', 1),
      favIconUrl: 'data:image/png;base64,AA==',
    };
    const plan = restorePlan(withIcon, [items[0]!, withIcon, items[2]!]);
    expect(plan.create).toEqual({
      type: 'bookmarks/item/create',
      groupId: 'g',
      beforeId: 'c',
      item: {
        kind: 'link',
        url: 'https://b.example',
        title: 'b',
        favIconUrl: 'data:image/png;base64,AA==',
      },
    });
    expect(plan.pending).toBeNull();
  });

  it('puts the last item back at the end', () => {
    expect(restorePlan(items[2]!, items).create).toMatchObject({ beforeId: null });
  });

  it('recreates a note and an open to-do as they were', () => {
    const note: BookmarkItem = {
      id: 'n',
      groupId: 'g',
      order: 0,
      createdAt: 0,
      kind: 'note',
      text: 'hi',
    };
    expect(restorePlan(note, [note]).create).toMatchObject({ item: { kind: 'note', text: 'hi' } });
    const todo: BookmarkItem = {
      id: 't',
      groupId: 'g',
      order: 0,
      createdAt: 0,
      kind: 'todo',
      text: 'x',
      done: false,
    };
    const plan = restorePlan(todo, [todo]);
    expect(plan.create).toMatchObject({ item: { kind: 'todo', text: 'x' } });
    expect(plan.pending).toBeNull();
  });

  it('ticks a done to-do again once it exists', () => {
    const done: BookmarkItem = {
      id: 't',
      groupId: 'g',
      order: 0,
      createdAt: 0,
      kind: 'todo',
      text: 'x',
      done: true,
    };
    const plan = restorePlan(done, [done]);
    expect(plan.pending?.then(['new-id'])).toEqual([
      { type: 'bookmarks/item/update', id: 'new-id', done: true },
    ]);
  });
});
