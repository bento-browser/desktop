import { describe, expect, it } from 'vitest';
import type { BookmarksSnapshot } from '@shared/protocol';

import { itemRestore, tabsSave } from '../components/BookmarksView/actions';
import {
  LOAD_FAILED_SNAPSHOT,
  SAMPLE_SNAPSHOT,
  SAMPLE_TABS,
  applyFakeAction,
} from './__fixtures__/bookmarks';

const gyms = SAMPLE_SNAPSHOT.items.filter((item) => item.groupId === 'group-gyms');
const idsIn = (snapshot: BookmarksSnapshot, groupId: string) =>
  snapshot.items.filter((item) => item.groupId === groupId).map((item) => item.id);

describe('applyFakeAction follows the tools contract', () => {
  it('creates with a client id and refuses an id that exists in any list', () => {
    const created = applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/space/create',
      id: 'new-space',
      name: 'Trip',
    });
    expect(created.spaces.at(-1)).toMatchObject({ id: 'new-space', name: 'Trip' });
    expect(
      applyFakeAction(created, { type: 'bookmarks/space/create', id: 'new-space', name: 'Again' })
        .spaces,
    ).toHaveLength(created.spaces.length);
    // One namespace: a group may not take the id of an item.
    const clash = applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/group/create',
      id: gyms[0]!.id,
      spaceId: 'space-climbing',
      name: 'Clash',
    });
    expect(clash.groups).toHaveLength(SAMPLE_SNAPSHOT.groups.length);
  });

  it('creates a done to-do in one action, and undo of a delete restores it in place', () => {
    const todo = SAMPLE_SNAPSHOT.items.find((item) => item.kind === 'todo' && item.done)!;
    const siblings = SAMPLE_SNAPSHOT.items.filter((item) => item.groupId === todo.groupId);
    const deleted = applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/item/delete',
      id: todo.id,
    });
    const restored = applyFakeAction(deleted, itemRestore(todo, siblings));
    expect(restored.items.find((item) => item.id === todo.id)).toMatchObject({
      kind: 'todo',
      done: true,
    });
    expect(idsIn(restored, todo.groupId)).toEqual(siblings.map((item) => item.id));
    // A second Undo creates nothing.
    expect(applyFakeAction(restored, itemRestore(todo, siblings)).items).toHaveLength(
      restored.items.length,
    );
  });

  it('saves a tab run before beforeId, with the client ids, in one action', () => {
    const action = tabsSave(
      'space-climbing',
      [101, 102],
      { groupId: 'group-gyms', beforeId: gyms[1]!.id },
      (() => {
        let n = 0;
        return () => `tab-link-${++n}`;
      })(),
    );
    const saved = applyFakeAction(SAMPLE_SNAPSHOT, action);
    expect(idsIn(saved, 'group-gyms')).toEqual([
      gyms[0]!.id,
      'tab-link-1',
      'tab-link-2',
      ...gyms.slice(1).map((item) => item.id),
    ]);
  });

  it('skips a tab that is gone and leaves its id slot unused', () => {
    const saved = applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/tabs/save',
      spaceId: 'space-climbing',
      groupId: 'group-gyms',
      tabIds: [101, 999, 102, 101],
      ids: ['x', 'y', 'z', 'w'],
    });
    expect(idsIn(saved, 'group-gyms').slice(-2)).toEqual(['x', 'z']);
  });

  it('saves into a new group when groupId is null, and refuses taken or repeated ids', () => {
    const saved = applyFakeAction(
      SAMPLE_SNAPSHOT,
      tabsSave('space-climbing', [101, 102]),
      SAMPLE_TABS,
    );
    const group = saved.groups.find((entry) => entry.name === 'Saved tabs')!;
    expect(idsIn(saved, group.id)).toHaveLength(2);

    const taken = applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/tabs/save',
      spaceId: 'space-climbing',
      groupId: null,
      tabIds: [101],
      ids: [gyms[0]!.id],
    });
    expect(taken.groups).toHaveLength(SAMPLE_SNAPSHOT.groups.length);
    const repeated = applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/tabs/save',
      spaceId: 'space-climbing',
      groupId: 'group-gyms',
      tabIds: [101, 102],
      ids: ['same', 'same'],
    });
    expect(repeated.items).toHaveLength(SAMPLE_SNAPSHOT.items.length);
  });

  it('refuses every change while the load has failed until a requestSnapshot retries', () => {
    const refused = applyFakeAction(LOAD_FAILED_SNAPSHOT, {
      type: 'bookmarks/space/create',
      name: 'Nope',
    });
    expect(refused).toBe(LOAD_FAILED_SNAPSHOT);
    const retried = applyFakeAction(LOAD_FAILED_SNAPSHOT, { type: 'bookmarks/requestSnapshot' });
    expect(retried.status).toBe('ready');
    expect(retried.spaces).toHaveLength(1);
    expect(retried.lastSpaceId).toBe(retried.spaces[0]!.id);
  });
});
