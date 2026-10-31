import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKMARK_LIMITS,
  type Action,
  type BookmarkItem,
  type BookmarksSnapshot,
} from '@shared/protocol';
import { parseWireAction } from '@shared/wire-action';
import { BookmarksStore } from './BookmarksStore';
import { STORAGE_KEY } from './Persistence';

type TreeNode = browser.bookmarks.BookmarkTreeNode;

interface Env {
  storage: Map<string, unknown>;
  tabs: Map<number, Partial<browser.tabs.Tab>>;
  tree: TreeNode[];
}

/** Stubs the WebExtension globals the store reads. State lives in the returned maps. */
function stubBrowser(): Env {
  const env: Env = { storage: new Map(), tabs: new Map(), tree: [] };
  vi.stubGlobal('browser', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: env.storage.get(key) })),
        set: vi.fn(async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) env.storage.set(key, value);
        }),
      },
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = env.tabs.get(id);
        if (!tab) throw new Error(`Invalid tab ID: ${id}`);
        return tab;
      }),
    },
    bookmarks: { getTree: vi.fn(async () => env.tree) },
  });
  return env;
}

/** Makes the next storage read wait until the returned function is called. */
function holdNextRead(): () => void {
  const read = vi.mocked(browser.storage.local.get).getMockImplementation()!;
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(browser.storage.local.get).mockImplementationOnce(async (key) => {
    await gate;
    return read(key);
  });
  return release;
}

async function createStore(): Promise<BookmarksStore> {
  const store = new BookmarksStore();
  await store.init();
  return store;
}

const link = (url: string, title = url) => ({ kind: 'link' as const, url, title });

/** Ids of the items in a group, in order. */
function itemIds(snapshot: BookmarksSnapshot, groupId: string): string[] {
  return snapshot.items.filter((item) => item.groupId === groupId).map((item) => item.id);
}

/** Every sibling set must be numbered 0..n-1. */
function expectDenseOrder(snapshot: BookmarksSnapshot): void {
  const sets = new Map<string, number[]>();
  const add = (key: string, order: number) => sets.set(key, [...(sets.get(key) ?? []), order]);
  for (const space of snapshot.spaces) add('spaces', space.order);
  for (const group of snapshot.groups) add(`space:${group.spaceId}`, group.order);
  for (const item of snapshot.items) add(`group:${item.groupId}`, item.order);
  for (const orders of sets.values()) {
    expect(orders).toEqual(orders.map((_, index) => index));
  }
}

/** A store with one space "Personal" holding groups A and B, with items a1..a3 and b1. */
async function seededStore() {
  const store = await createStore();
  const spaceId = store.snapshot().spaces[0]!.id;
  const a = store.createGroup(spaceId, 'A')!;
  const b = store.createGroup(spaceId, 'B')!;
  const a1 = store.createItem(a, null, link('https://a1.example/'))!;
  const a2 = store.createItem(a, null, { kind: 'note', text: 'a2' })!;
  const a3 = store.createItem(a, null, { kind: 'todo', text: 'a3' })!;
  const b1 = store.createItem(b, null, link('https://b1.example/'))!;
  return { store, spaceId, a, b, a1, a2, a3, b1 };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('BookmarksStore: first run and persistence', () => {
  it('seeds one empty space "Personal" and selects it', async () => {
    stubBrowser();
    const snapshot = (await createStore()).snapshot();

    expect(snapshot.spaces).toEqual([
      { id: expect.any(String), name: 'Personal', color: 'gray', order: 0 },
    ]);
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.lastSpaceId).toBe(snapshot.spaces[0]!.id);
    expect(snapshot.firefoxImportOffered).toBe(false);
    expect(snapshot.status).toBe('ready');
  });

  it('writes to bento.bookmarks.v1 at once, without the load status, and reloads the same state', async () => {
    const env = stubBrowser();
    const { store, a, a1 } = await seededStore();
    store.updateItem(a1, { title: 'Renamed' });
    await store.flush();

    const { status, ...data } = store.snapshot();
    expect(status).toBe('ready');
    expect(env.storage.get(STORAGE_KEY)).toEqual(data);

    const reloaded = await createStore();
    expect(reloaded.snapshot()).toEqual(store.snapshot());
    expect(reloaded.snapshot().items.find((item) => item.id === a1)).toMatchObject({
      title: 'Renamed',
      groupId: a,
    });
  });

  it('drops malformed records and orphans, and repairs order and lastSpaceId', async () => {
    const env = stubBrowser();
    env.storage.set(STORAGE_KEY, {
      spaces: [
        { id: 's2', name: 'Two', color: 'red', order: 9 },
        { id: 's1', name: 'One', color: 'chartreuse', order: 4 },
        { id: 's1', name: 'Duplicate', color: 'red', order: 0 },
        { name: 'No id' },
      ],
      groups: [
        { id: 'g1', spaceId: 's1', name: 'G', color: 'blue', order: 7 },
        { id: 'g2', spaceId: 'gone', name: 'Orphan', color: 'blue', order: 0 },
      ],
      items: [
        { id: 'i2', groupId: 'g1', kind: 'note', text: 'second', order: 5, createdAt: 2 },
        { id: 'i1', groupId: 'g1', kind: 'link', url: 'https://a.example/', title: 'A', order: 1 },
        { id: 'i3', groupId: 'g1', kind: 'link', url: 'javascript:alert(1)', title: 'x', order: 2 },
        { id: 'i4', groupId: 'g2', kind: 'note', text: 'orphan', order: 0 },
        { id: 'i5', groupId: 'g1', kind: 'sticker', order: 3 },
      ],
      lastSpaceId: 'deleted',
      firefoxImportOffered: 'yes',
    });
    const snapshot = (await createStore()).snapshot();

    expect(snapshot.spaces.map((s) => [s.id, s.color, s.order])).toEqual([
      ['s1', 'gray', 0],
      ['s2', 'red', 1],
    ]);
    expect(snapshot.groups.map((g) => g.id)).toEqual(['g1']);
    expect(snapshot.items.map((i) => [i.id, i.order])).toEqual([
      ['i1', 0],
      ['i2', 1],
    ]);
    expect(snapshot.lastSpaceId).toBe('s1');
    expect(snapshot.firefoxImportOffered).toBe(false);
  });

  it('tells listeners registered before init about the loaded state', async () => {
    const env = stubBrowser();
    const first = await createStore();
    first.createSpace('Work');
    await first.flush();
    expect(env.storage.has(STORAGE_KEY)).toBe(true);

    const store = new BookmarksStore();
    const seen = vi.fn();
    store.onChange(seen);
    await store.init();

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen.mock.calls[0]![0].spaces.map((s: { name: string }) => s.name)).toEqual([
      'Personal',
      'Work',
    ]);
  });

  it('clamps stored fields to their caps when loading', async () => {
    const env = stubBrowser();
    env.storage.set(STORAGE_KEY, {
      spaces: [{ id: 's1', name: 'n'.repeat(BOOKMARK_LIMITS.name + 9), order: 0 }],
      groups: [{ id: 'g1', spaceId: 's1', name: 'g'.repeat(BOOKMARK_LIMITS.name + 9), order: 0 }],
      items: [
        {
          id: 'l',
          groupId: 'g1',
          kind: 'link',
          url: 'https://a.example/',
          title: 't'.repeat(BOOKMARK_LIMITS.linkTitle + 9),
          order: 0,
        },
        {
          id: 'n',
          groupId: 'g1',
          kind: 'note',
          text: 'x'.repeat(BOOKMARK_LIMITS.text + 9),
          order: 1,
        },
        {
          id: 'd',
          groupId: 'g1',
          kind: 'todo',
          text: 'y'.repeat(BOOKMARK_LIMITS.text + 9),
          order: 2,
        },
        {
          id: 'i',
          groupId: 'g1',
          kind: 'link',
          url: 'https://b.example/',
          title: 'b',
          favIconUrl: 'x'.repeat(BOOKMARK_LIMITS.favIconUrl + 1),
          order: 3,
        },
      ],
    });
    const { spaces, groups, items } = (await createStore()).snapshot();

    expect(spaces[0]!.name).toHaveLength(BOOKMARK_LIMITS.name);
    expect(groups[0]!.name).toHaveLength(BOOKMARK_LIMITS.name);
    expect(items.map((item) => item.kind === 'link' && item.title.length)).toEqual([
      BOOKMARK_LIMITS.linkTitle,
      false,
      false,
      1,
    ]);
    expect(items.map((item) => 'text' in item && item.text.length)).toEqual([
      false,
      BOOKMARK_LIMITS.text,
      BOOKMARK_LIMITS.text,
      false,
    ]);
    expect(items[3]).not.toHaveProperty('favIconUrl');
  });

  it('notifies listeners with the full snapshot on change only', async () => {
    stubBrowser();
    const store = await createStore();
    const seen: BookmarksSnapshot[] = [];
    const off = store.onChange((snapshot) => seen.push(snapshot));
    const spaceId = store.snapshot().spaces[0]!.id;

    store.createGroup(spaceId, 'A');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.groups.map((g) => g.name)).toEqual(['A']);

    store.selectSpace(spaceId); // already selected
    store.updateGroup('missing', { name: 'x' });
    store.deleteItem('missing');
    expect(seen).toHaveLength(1);

    off();
    store.createGroup(spaceId, 'B');
    expect(seen).toHaveLength(1);
  });
});

describe('BookmarksStore: load', () => {
  it('holds actions that arrive during the load, in order, instead of overwriting stored data', async () => {
    stubBrowser();
    const first = await createStore();
    const groupId = first.createGroup(first.snapshot().spaces[0]!.id, 'Stored')!;
    await first.flush();
    vi.mocked(browser.storage.local.set).mockClear();

    const releaseRead = holdNextRead();
    const store = new BookmarksStore();
    const seen: BookmarksSnapshot[] = [];
    store.onChange((snapshot) => seen.push(snapshot));
    const init = store.init();
    const ran: string[] = [];
    store.afterInit(() => {
      ran.push('create space');
      store.createSpace('Late');
    });
    store.afterInit(() => {
      ran.push('create item');
      store.createItem(groupId, null, { kind: 'note', text: 'late' });
    });

    // A direct call during the load is refused, not applied to an empty state.
    expect(store.createSpace('Direct')).toBeNull();
    expect(ran).toEqual([]);
    expect(browser.storage.local.set).not.toHaveBeenCalled();

    releaseRead();
    await init;
    await store.flush();

    expect(ran).toEqual(['create space', 'create item']);
    const snapshot = store.snapshot();
    expect(snapshot.spaces.map((space) => space.name)).toEqual(['Personal', 'Late']);
    expect(snapshot.groups.map((group) => group.name)).toEqual(['Stored']);
    expect(snapshot.items).toHaveLength(1);
    // The loaded state was announced before the queued changes.
    expect(seen[0]!.spaces).toHaveLength(1);
    // Every write contains the stored data.
    const writes = vi.mocked(browser.storage.local.set).mock.calls;
    expect(writes.length).toBeGreaterThan(0);
    for (const [written] of writes) {
      expect((written[STORAGE_KEY] as BookmarksSnapshot).groups.map((g) => g.name)).toEqual([
        'Stored',
      ]);
    }
  });

  it('runs afterInit at once when the load has settled', async () => {
    stubBrowser();
    const store = await createStore();
    const run = vi.fn();
    store.afterInit(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('fails closed: no data, every mutation refused, nothing written, listeners told', async () => {
    const env = stubBrowser();
    const first = await createStore();
    const groupId = first.createGroup(first.snapshot().spaces[0]!.id, 'Stored')!;
    await first.flush();
    const stored = structuredClone(env.storage.get(STORAGE_KEY));
    vi.mocked(browser.storage.local.set).mockClear();

    vi.mocked(browser.storage.local.get).mockRejectedValueOnce(new Error('disk'));
    const store = new BookmarksStore();
    const seen: BookmarksSnapshot[] = [];
    store.onChange((snapshot) => seen.push(snapshot));
    await store.init();

    expect(store.snapshot()).toEqual({
      status: 'loadFailed',
      spaces: [],
      groups: [],
      items: [],
      lastSpaceId: null,
      firefoxImportOffered: false,
    });
    expect(seen).toEqual([store.snapshot()]);

    expect(store.createSpace('x')).toBeNull();
    expect(store.createGroup(groupId, 'x')).toBeNull();
    expect(store.createItem(groupId, null, { kind: 'note', text: 'x' })).toBeNull();
    expect(store.updateSpace('x', { name: 'y' })).toBe(false);
    expect(store.selectSpace('x')).toBe(false);
    expect(store.deleteSpace('x')).toBe(false);
    expect(store.dismissImport()).toBe(false);
    await store.importFirefox();
    expect(await store.saveTabs('x', null, [1])).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(seen).toHaveLength(1);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
    expect(browser.bookmarks.getTree).not.toHaveBeenCalled();
    expect(env.storage.get(STORAGE_KEY)).toEqual(stored);
  });

  it('retries the load on a second init and then accepts changes', async () => {
    const env = stubBrowser();
    const first = await createStore();
    first.createGroup(first.snapshot().spaces[0]!.id, 'Stored');
    await first.flush();
    const stored = structuredClone(env.storage.get(STORAGE_KEY));

    vi.mocked(browser.storage.local.get).mockRejectedValueOnce(new Error('disk'));
    const store = new BookmarksStore();
    const seen: BookmarksSnapshot[] = [];
    store.onChange((snapshot) => seen.push(snapshot));
    await store.init();
    expect(store.snapshot().status).toBe('loadFailed');

    // Actions that arrive during the retry wait for it.
    const retry = store.init();
    store.afterInit(() => store.createSpace('After retry'));
    await retry;

    const snapshot = store.snapshot();
    expect(snapshot.status).toBe('ready');
    expect(snapshot.groups.map((group) => group.name)).toEqual(['Stored']);
    expect(snapshot.spaces.map((space) => space.name)).toEqual(['Personal', 'After retry']);
    expect(seen.map((entry) => entry.status)).toEqual(['loadFailed', 'ready', 'ready']);
    await store.flush();
    expect(env.storage.get(STORAGE_KEY)).not.toEqual(stored);
    expect((env.storage.get(STORAGE_KEY) as BookmarksSnapshot).groups).toHaveLength(1);

    // init() after a good load does not read again.
    vi.mocked(browser.storage.local.get).mockClear();
    await store.init();
    expect(browser.storage.local.get).not.toHaveBeenCalled();
  });

  it('keeps failing closed while the retry fails, and recovers when storage does', async () => {
    stubBrowser();
    vi.mocked(browser.storage.local.get).mockRejectedValue(new Error('disk'));
    const store = await createStore();
    await store.init();

    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
    expect(store.snapshot().status).toBe('loadFailed');
    expect(store.createSpace('x')).toBeNull();

    vi.mocked(browser.storage.local.get).mockResolvedValue({});
    await store.init();
    expect(store.snapshot().status).toBe('ready');
    expect(store.snapshot().spaces).toHaveLength(1);
  });
});

describe('BookmarksStore: writes', () => {
  /** A storage `set` that finishes when the test says so. */
  function manualSet() {
    const pending: Array<{ value: Record<string, unknown>; done: () => void; fail: () => void }> =
      [];
    vi.mocked(browser.storage.local.set).mockImplementation(
      (value) =>
        new Promise<void>((resolve, reject) => {
          pending.push({
            value: value as Record<string, unknown>,
            done: resolve,
            fail: () => reject(new Error('quota')),
          });
        }),
    );
    return pending;
  }

  it('writes immediately, one write at a time, and coalesces changes made during a write', async () => {
    stubBrowser();
    const store = await createStore();
    await store.flush();
    vi.mocked(browser.storage.local.set).mockClear();
    const pending = manualSet();
    const spaceId = store.snapshot().spaces[0]!.id;

    store.createGroup(spaceId, 'One');
    expect(pending).toHaveLength(1); // started synchronously, no debounce
    store.createGroup(spaceId, 'Two');
    store.createGroup(spaceId, 'Three');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pending).toHaveLength(1); // serialized: nothing starts while one is in flight

    pending[0]!.done();
    await vi.advanceTimersByTimeAsync(0);
    expect(pending).toHaveLength(2); // one follow-up carries both newer changes
    pending[1]!.done();
    await store.flush();

    expect(pending).toHaveLength(2);
    const names = (value: Record<string, unknown>) =>
      (value[STORAGE_KEY] as BookmarksSnapshot).groups.map((group) => group.name);
    expect(names(pending[0]!.value)).toEqual(['One']);
    expect(names(pending[1]!.value)).toEqual(['One', 'Two', 'Three']);
  });

  it('keeps a failed write dirty and retries with backoff, without losing newer changes', async () => {
    stubBrowser();
    const store = await createStore();
    await store.flush();
    vi.mocked(browser.storage.local.set).mockClear();
    const pending = manualSet();
    const spaceId = store.snapshot().spaces[0]!.id;

    store.createGroup(spaceId, 'Lost?');
    pending[0]!.fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(console.error).toHaveBeenCalled();

    // A change during the backoff waits for the retry instead of writing at once.
    store.createGroup(spaceId, 'Newer');
    await vi.advanceTimersByTimeAsync(900);
    expect(pending).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(200); // 1 s backoff elapsed
    expect(pending).toHaveLength(2);
    pending[1]!.fail(); // fails again: backoff doubles
    await vi.advanceTimersByTimeAsync(1_900);
    expect(pending).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(pending).toHaveLength(3);

    pending[2]!.done();
    await store.flush();
    const written = (pending[2]!.value[STORAGE_KEY] as BookmarksSnapshot).groups.map((g) => g.name);
    expect(written).toEqual(['Lost?', 'Newer']);

    // Success resets the backoff and goes quiet.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(pending).toHaveLength(3);
  });

  it('retries a failed write once storage recovers, and flush skips the wait', async () => {
    const env = stubBrowser();
    const store = await createStore();
    await store.flush();
    const set = vi.mocked(browser.storage.local.set);
    set.mockClear();
    set.mockRejectedValueOnce(new Error('disk'));
    const spaceId = store.snapshot().spaces[0]!.id;

    store.createGroup(spaceId, 'Kept');
    await vi.advanceTimersByTimeAsync(0);
    expect(set).toHaveBeenCalledTimes(1);
    expect((env.storage.get(STORAGE_KEY) as BookmarksSnapshot).groups).toEqual([]);

    await store.flush(); // does not wait for the 1 s backoff
    expect(set).toHaveBeenCalledTimes(2);
    expect((env.storage.get(STORAGE_KEY) as BookmarksSnapshot).groups.map((g) => g.name)).toEqual([
      'Kept',
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('survives a storage.set that throws synchronously', async () => {
    const env = stubBrowser();
    const store = await createStore();
    await store.flush();
    vi.mocked(browser.storage.local.set).mockImplementationOnce(() => {
      throw new Error('sync');
    });

    store.createGroup(store.snapshot().spaces[0]!.id, 'G');
    await vi.advanceTimersByTimeAsync(1_100);

    expect((env.storage.get(STORAGE_KEY) as BookmarksSnapshot).groups).toHaveLength(1);
  });
});

describe('BookmarksStore: spaces', () => {
  it('creates, renames, recolors and selects spaces', async () => {
    stubBrowser();
    const store = await createStore();
    const personal = store.snapshot().spaces[0]!.id;
    const work = store.createSpace('  Work  ')!;

    expect(store.snapshot().spaces.map((s) => [s.name, s.order])).toEqual([
      ['Personal', 0],
      ['Work', 1],
    ]);
    expect(store.snapshot().lastSpaceId).toBe(personal);

    expect(store.updateSpace(work, { name: 'Office', color: 'green' })).toBe(true);
    expect(store.updateSpace(work, { name: '   ' })).toBe(false);
    expect(store.snapshot().spaces[1]).toMatchObject({ name: 'Office', color: 'green' });

    expect(store.selectSpace(work)).toBe(true);
    expect(store.snapshot().lastSpaceId).toBe(work);
    expect(store.selectSpace('missing')).toBe(false);
    expect(store.snapshot().lastSpaceId).toBe(work);
  });

  it('deletes a space with its groups and items, and renumbers the rest', async () => {
    stubBrowser();
    const { store, spaceId, a } = await seededStore();
    const other = store.createSpace('Other')!;
    const otherGroup = store.createGroup(other, 'Keep')!;
    const kept = store.createItem(otherGroup, null, { kind: 'note', text: 'kept' })!;
    const third = store.createSpace('Third')!;

    expect(store.deleteSpace(spaceId)).toBe(true);

    const snapshot = store.snapshot();
    expect(snapshot.spaces.map((s) => [s.id, s.order])).toEqual([
      [other, 0],
      [third, 1],
    ]);
    expect(snapshot.groups.map((g) => g.id)).toEqual([otherGroup]);
    expect(snapshot.items.map((i) => i.id)).toEqual([kept]);
    expect(snapshot.groups.some((g) => g.id === a)).toBe(false);
    expectDenseOrder(snapshot);
  });

  it('moves lastSpaceId to the first remaining space when the selected one is deleted', async () => {
    stubBrowser();
    const store = await createStore();
    const personal = store.snapshot().spaces[0]!.id;
    const work = store.createSpace('Work')!;
    const play = store.createSpace('Play')!;
    store.selectSpace(play);

    store.deleteSpace(work);
    expect(store.snapshot().lastSpaceId).toBe(play);
    store.deleteSpace(play);
    expect(store.snapshot().lastSpaceId).toBe(personal);
  });

  it('keeps one space: deleting the last leaves a fresh empty "Personal", selected', async () => {
    stubBrowser();
    const { store, spaceId } = await seededStore();

    store.deleteSpace(spaceId);

    const snapshot = store.snapshot();
    expect(snapshot.spaces).toHaveLength(1);
    expect(snapshot.spaces[0]).toMatchObject({ name: 'Personal', order: 0 });
    expect(snapshot.spaces[0]!.id).not.toBe(spaceId);
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.items).toEqual([]);
    expect(snapshot.lastSpaceId).toBe(snapshot.spaces[0]!.id);
  });
});

describe('BookmarksStore: groups', () => {
  it('creates, renames and recolors groups, rejecting an unknown space', async () => {
    stubBrowser();
    const store = await createStore();
    const spaceId = store.snapshot().spaces[0]!.id;
    const id = store.createGroup(spaceId, 'Reading')!;

    expect(store.createGroup('missing', 'Nope')).toBeNull();
    expect(store.updateGroup(id, { name: 'Later', color: 'orange' })).toBe(true);
    expect(store.snapshot().groups).toEqual([
      { id, spaceId, name: 'Later', color: 'orange', order: 0 },
    ]);
  });

  it('deletes a group with its items and renumbers its siblings', async () => {
    stubBrowser();
    const { store, spaceId, a, b, a1, b1 } = await seededStore();
    const c = store.createGroup(spaceId, 'C')!;

    expect(store.deleteGroup(a)).toBe(true);

    const snapshot = store.snapshot();
    expect(snapshot.groups.map((g) => [g.id, g.order])).toEqual([
      [b, 0],
      [c, 1],
    ]);
    expect(snapshot.items.map((i) => i.id)).toEqual([b1]);
    expect(snapshot.items.some((i) => i.id === a1)).toBe(false);
  });

  it('reorders within a space and moves across spaces with beforeId', async () => {
    stubBrowser();
    const { store, spaceId, a, b } = await seededStore();
    const c = store.createGroup(spaceId, 'C')!;
    const order = () =>
      store
        .snapshot()
        .groups.filter((g) => g.spaceId === spaceId)
        .map((g) => g.id);
    expect(order()).toEqual([a, b, c]);

    store.moveGroup(c, spaceId, a);
    expect(order()).toEqual([c, a, b]);
    store.moveGroup(c, spaceId, null);
    expect(order()).toEqual([a, b, c]);
    expect(store.moveGroup(c, spaceId, null)).toBe(false); // already last

    const other = store.createSpace('Other')!;
    const x = store.createGroup(other, 'X')!;
    const y = store.createGroup(other, 'Y')!;
    store.moveGroup(b, other, y);

    const snapshot = store.snapshot();
    expect(
      snapshot.groups.filter((g) => g.spaceId === spaceId).map((g) => [g.id, g.order]),
    ).toEqual([
      [a, 0],
      [c, 1],
    ]);
    expect(snapshot.groups.filter((g) => g.spaceId === other).map((g) => [g.id, g.order])).toEqual([
      [x, 0],
      [b, 1],
      [y, 2],
    ]);
    expectDenseOrder(snapshot);
    expect(store.moveGroup(a, 'missing', null)).toBe(false);
    expect(store.moveGroup('missing', other, null)).toBe(false);
  });

  it('keeps the items of a moved group', async () => {
    stubBrowser();
    const { store, a, a1, a2, a3 } = await seededStore();
    const other = store.createSpace('Other')!;

    store.moveGroup(a, other, null);

    expect(itemIds(store.snapshot(), a)).toEqual([a1, a2, a3]);
  });
});

describe('BookmarksStore: items', () => {
  it('creates links, notes and to-dos in order, honoring beforeId', async () => {
    stubBrowser();
    const { store, a, a1, a2, a3 } = await seededStore();
    const first = store.createItem(a, a1, { kind: 'note', text: 'first' })!;
    const middle = store.createItem(a, a3, link('https://mid.example/', '  Mid  '))!;
    const stale = store.createItem(a, 'not-in-group', { kind: 'todo', text: 'end' })!;

    const snapshot = store.snapshot();
    expect(itemIds(snapshot, a)).toEqual([first, a1, a2, middle, a3, stale]);
    expect(snapshot.items.find((i) => i.id === middle)).toMatchObject({
      kind: 'link',
      title: 'Mid',
      url: 'https://mid.example/',
    });
    expect(snapshot.items.find((i) => i.id === stale)).toMatchObject({ kind: 'todo', done: false });
    expect(snapshot.items.find((i) => i.id === first)!.createdAt).toBeGreaterThan(0);
    expectDenseOrder(snapshot);
  });

  it('titles a link by its URL when the title is blank, and drops page-icon favicons', async () => {
    stubBrowser();
    const { store, a } = await seededStore();
    const id = store.createItem(a, null, {
      kind: 'link',
      url: 'https://example.com/x',
      title: '   ',
      favIconUrl: 'page-icon:https://example.com/x',
    })!;
    const kept = store.createItem(a, null, {
      kind: 'link',
      url: 'https://example.com/y',
      title: 'Y',
      favIconUrl: 'https://example.com/favicon.ico',
    })!;

    const items = store.snapshot().items;
    expect(items.find((i) => i.id === id)).toMatchObject({ title: 'https://example.com/x' });
    expect(items.find((i) => i.id === id)).not.toHaveProperty('favIconUrl');
    expect(items.find((i) => i.id === kept)).toMatchObject({
      favIconUrl: 'https://example.com/favicon.ico',
    });
  });

  it('rejects a link with a scheme that cannot be opened and an unknown group', async () => {
    stubBrowser();
    const { store, a } = await seededStore();
    const before = store.snapshot();

    expect(store.createItem(a, null, link('javascript:alert(1)'))).toBeNull();
    expect(store.createItem(a, null, link('moz-extension://x/settings.html'))).toBeNull();
    expect(store.createItem(a, null, link('not a url'))).toBeNull();
    expect(store.createItem('missing', null, { kind: 'note', text: 'x' })).toBeNull();
    expect(store.snapshot()).toEqual(before);
  });

  it('updates a link, a note and a to-do, ignoring fields that do not apply', async () => {
    stubBrowser();
    const { store, a1, a2, a3 } = await seededStore();
    const find = (id: string): BookmarkItem => store.snapshot().items.find((i) => i.id === id)!;

    expect(
      store.updateItem(a1, { title: 'Docs', url: 'https://docs.example/', text: 'ignored' }),
    ).toBe(true);
    expect(find(a1)).toMatchObject({ kind: 'link', title: 'Docs', url: 'https://docs.example/' });
    expect(store.updateItem(a1, { url: 'javascript:alert(1)' })).toBe(false);
    expect(store.updateItem(a1, { title: '  ' })).toBe(true);
    expect(find(a1)).toMatchObject({ title: 'https://docs.example/' });

    expect(store.updateItem(a2, { text: 'edited', done: true, title: 'ignored' })).toBe(true);
    expect(find(a2)).toEqual(expect.objectContaining({ kind: 'note', text: 'edited' }));
    expect(find(a2)).not.toHaveProperty('done');

    expect(store.updateItem(a3, { done: true })).toBe(true);
    expect(find(a3)).toMatchObject({ kind: 'todo', text: 'a3', done: true });
    expect(store.updateItem(a3, { done: true })).toBe(false);
    expect(store.updateItem('missing', { text: 'x' })).toBe(false);
  });

  it('drops the old favicon when a link URL changes', async () => {
    stubBrowser();
    const { store, a } = await seededStore();
    const id = store.createItem(a, null, {
      kind: 'link',
      url: 'https://old.example/',
      title: 'Old',
      favIconUrl: 'https://old.example/favicon.ico',
    })!;

    store.updateItem(id, { url: 'https://new.example/' });

    expect(store.snapshot().items.find((i) => i.id === id)).not.toHaveProperty('favIconUrl');
  });

  it('deletes an item, renumbers the group and lets undo re-create it in place', async () => {
    stubBrowser();
    const { store, a, a1, a2, a3 } = await seededStore();

    expect(store.deleteItem(a2)).toBe(true);
    expect(itemIds(store.snapshot(), a)).toEqual([a1, a3]);
    expectDenseOrder(store.snapshot());
    expect(store.deleteItem(a2)).toBe(false);

    const restored = store.createItem(a, a3, { kind: 'note', text: 'a2' })!;
    expect(itemIds(store.snapshot(), a)).toEqual([a1, restored, a3]);
  });

  it('moves an item within a group and across groups with beforeId', async () => {
    stubBrowser();
    const { store, a, b, a1, a2, a3, b1 } = await seededStore();

    store.moveItem(a3, a, a1);
    expect(itemIds(store.snapshot(), a)).toEqual([a3, a1, a2]);
    store.moveItem(a3, a, null);
    expect(itemIds(store.snapshot(), a)).toEqual([a1, a2, a3]);
    expect(store.moveItem(a3, a, null)).toBe(false);

    store.moveItem(a2, b, b1);
    expect(itemIds(store.snapshot(), a)).toEqual([a1, a3]);
    expect(itemIds(store.snapshot(), b)).toEqual([a2, b1]);
    expect(store.snapshot().items.find((i) => i.id === a2)!.groupId).toBe(b);
    store.moveItem(a1, b, null);
    expect(itemIds(store.snapshot(), b)).toEqual([a2, b1, a1]);
    expectDenseOrder(store.snapshot());

    expect(store.moveItem(a1, 'missing', null)).toBe(false);
    expect(store.moveItem('missing', b, null)).toBe(false);
  });

  it('appends when beforeId is the moved item itself or is not in the target group', async () => {
    stubBrowser();
    const { store, a, b, a1, a2, a3, b1 } = await seededStore();

    store.moveItem(a1, a, a1);
    expect(itemIds(store.snapshot(), a)).toEqual([a2, a3, a1]);
    store.moveItem(a2, b, a3); // a3 is in group A, not B
    expect(itemIds(store.snapshot(), b)).toEqual([b1, a2]);
  });

  it('reports a link URL only for link items', async () => {
    stubBrowser();
    const { store, a1, a2 } = await seededStore();

    expect(store.linkUrl(a1)).toBe('https://a1.example/');
    expect(store.linkUrl(a2)).toBeNull();
    expect(store.linkUrl('missing')).toBeNull();
  });
});

describe('BookmarksStore: tabs/save', () => {
  const tab = (id: number, url: string | undefined, extra: Partial<browser.tabs.Tab> = {}) => ({
    id,
    url,
    title: `Tab ${id}`,
    ...extra,
  });

  it('saves savable tabs in order into a new "Saved tabs" group', async () => {
    const env = stubBrowser();
    const store = await createStore();
    const spaceId = store.snapshot().spaces[0]!.id;
    env.tabs.set(1, tab(1, 'https://one.example/', { favIconUrl: 'https://one.example/f.ico' }));
    env.tabs.set(2, tab(2, 'file:///tmp/two.html'));
    env.tabs.set(
      3,
      tab(3, 'https://three.example/', { favIconUrl: 'page-icon:https://three.example/' }),
    );

    await store.saveTabs(spaceId, null, [3, 1, 2, 1]);

    const snapshot = store.snapshot();
    expect(snapshot.groups).toEqual([
      { id: expect.any(String), spaceId, name: 'Saved tabs', color: 'gray', order: 0 },
    ]);
    expect(snapshot.items.map((i) => [i.kind === 'link' ? i.url : '', i.order])).toEqual([
      ['https://three.example/', 0],
      ['https://one.example/', 1],
      ['file:///tmp/two.html', 2],
    ]);
    expect(snapshot.items[1]).toMatchObject({
      title: 'Tab 1',
      favIconUrl: 'https://one.example/f.ico',
    });
    expect(snapshot.items[0]).not.toHaveProperty('favIconUrl');
  });

  it('skips privileged, private, blank and closed tabs', async () => {
    const env = stubBrowser();
    const { store, spaceId, a, a1 } = await seededStore();
    env.tabs.set(1, tab(1, 'about:preferences'));
    env.tabs.set(2, tab(2, 'moz-extension://abc/dist/settings.html'));
    env.tabs.set(3, tab(3, 'https://private.example/', { incognito: true }));
    env.tabs.set(4, tab(4, undefined));
    env.tabs.set(5, tab(5, 'chrome://browser/content/browser.xhtml'));
    env.tabs.set(6, tab(6, 'view-source:https://example.com/'));
    env.tabs.set(7, tab(7, 'https://ok.example/', { incognito: false }));
    // tab 8 is closed

    await store.saveTabs(spaceId, a, [1, 2, 3, 4, 5, 6, 7, 8]);

    const links = store.snapshot().items.filter((i) => i.groupId === a);
    expect(links.map((i) => i.id)[0]).toBe(a1);
    expect(links.at(-1)).toMatchObject({ kind: 'link', url: 'https://ok.example/' });
    expect(links).toHaveLength(4); // a1, a2, a3 and the one saved tab
  });

  it('creates no group when nothing is savable', async () => {
    const env = stubBrowser();
    const store = await createStore();
    const spaceId = store.snapshot().spaces[0]!.id;
    env.tabs.set(1, tab(1, 'about:newtab'));
    const seen = vi.fn();
    store.onChange(seen);

    await store.saveTabs(spaceId, null, [1, 99]);

    expect(store.snapshot().groups).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
  });

  it('appends to a given group and ignores unknown or mismatched targets', async () => {
    const env = stubBrowser();
    const { store, spaceId, a, b } = await seededStore();
    const other = store.createSpace('Other')!;
    env.tabs.set(1, tab(1, 'https://one.example/'));

    await store.saveTabs(spaceId, a, [1]);
    expect(itemIds(store.snapshot(), a)).toHaveLength(4);
    expect(store.snapshot().items.at(-1)).toMatchObject({ url: 'https://one.example/' });

    const before = store.snapshot();
    await store.saveTabs(other, a, [1]); // group a is not in space `other`
    await store.saveTabs('missing', null, [1]);
    await store.saveTabs(spaceId, 'missing', [1]);
    expect(store.snapshot()).toEqual(before);
    expect(itemIds(store.snapshot(), b)).toHaveLength(1);
  });

  it('inserts the saved run before beforeId in one change, in tabIds order', async () => {
    const env = stubBrowser();
    const { store, spaceId, a, a1, a2, a3 } = await seededStore();
    env.tabs.set(1, tab(1, 'https://one.example/'));
    env.tabs.set(2, tab(2, 'https://two.example/'));
    const seen = vi.fn();
    store.onChange(seen);

    const saved = await store.saveTabs(spaceId, a, [2, 1], { beforeId: a2 });

    expect(saved).toHaveLength(2);
    expect(itemIds(store.snapshot(), a)).toEqual([a1, ...saved, a2, a3]);
    expect(
      store
        .snapshot()
        .items.filter((i) => saved.includes(i.id))
        .map((i) => i.kind === 'link' && i.url),
    ).toEqual(['https://two.example/', 'https://one.example/']);
    expectDenseOrder(store.snapshot());
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('appends when beforeId is null or not in the group, and ignores it for a new group', async () => {
    const env = stubBrowser();
    const { store, spaceId, a, b1 } = await seededStore();
    env.tabs.set(1, tab(1, 'https://one.example/'));

    const [viaNull] = await store.saveTabs(spaceId, a, [1], { beforeId: null });
    const [viaOtherGroup] = await store.saveTabs(spaceId, a, [1], { beforeId: b1 });
    const [inNewGroup] = await store.saveTabs(spaceId, null, [1], { beforeId: b1 });

    expect(itemIds(store.snapshot(), a).slice(-2)).toEqual([viaNull, viaOtherGroup]);
    const created = store.snapshot().items.find((i) => i.id === inNewGroup)!;
    expect(created.order).toBe(0);
    expect(store.snapshot().groups.find((g) => g.id === created.groupId)!.name).toBe('Saved tabs');
  });

  it('matches ids to tabIds by index: a skipped tab keeps its slot unused', async () => {
    const env = stubBrowser();
    const store = await createStore();
    const spaceId = store.snapshot().spaces[0]!.id;
    env.tabs.set(1, tab(1, 'https://one.example/'));
    env.tabs.set(2, tab(2, 'about:config')); // skipped: unsavable
    env.tabs.set(3, tab(3, 'https://three.example/'));
    // tab 4 is closed: skipped. tab 1 repeats at index 4: skipped.
    env.tabs.set(5, tab(5, 'https://five.example/'));
    const [id0, id1, id2, id3, id4, id5] = Array.from({ length: 6 }, () => crypto.randomUUID());

    const saved = await store.saveTabs(spaceId, null, [1, 2, 3, 4, 1, 5], {
      ids: [id0!, id1!, id2!, id3!, id4!, id5!],
    });

    expect(saved).toEqual([id0, id2, id5]);
    const urls = store.snapshot().items.map((i) => [i.id, i.kind === 'link' && i.url]);
    expect(urls).toEqual([
      [id0, 'https://one.example/'],
      [id2, 'https://three.example/'],
      [id5, 'https://five.example/'],
    ]);
  });

  it('generates ids for tabs without an ids slot', async () => {
    const env = stubBrowser();
    const store = await createStore();
    const spaceId = store.snapshot().spaces[0]!.id;
    env.tabs.set(1, tab(1, 'https://one.example/'));
    env.tabs.set(2, tab(2, 'https://two.example/'));
    const id = crypto.randomUUID();

    const saved = await store.saveTabs(spaceId, null, [1, 2], { ids: [id] });

    expect(saved).toHaveLength(2);
    expect(saved[0]).toBe(id);
    expect(saved[1]).not.toBe(id);
  });

  it('saves nothing when an id exists or repeats', async () => {
    const env = stubBrowser();
    const { store, spaceId, a, a1 } = await seededStore();
    env.tabs.set(1, tab(1, 'https://one.example/'));
    env.tabs.set(2, tab(2, 'https://two.example/'));
    const fresh = crypto.randomUUID();
    const before = store.snapshot();

    expect(await store.saveTabs(spaceId, a, [1, 2], { ids: [fresh, a1] })).toEqual([]);
    expect(await store.saveTabs(spaceId, a, [1, 2], { ids: [spaceId, fresh] })).toEqual([]);
    expect(await store.saveTabs(spaceId, null, [1, 2], { ids: [fresh, fresh] })).toEqual([]);
    expect(store.snapshot()).toEqual(before); // no group "Saved tabs" either
  });

  it('caps long tab titles and falls back to the URL for a blank title', async () => {
    const env = stubBrowser();
    const store = await createStore();
    const spaceId = store.snapshot().spaces[0]!.id;
    const longUrl = `https://long.example/${'p'.repeat(6_000)}`;
    env.tabs.set(1, tab(1, 'https://one.example/', { title: 't'.repeat(10_000) }));
    env.tabs.set(2, tab(2, longUrl, { title: '' }));

    await store.saveTabs(spaceId, null, [1, 2]);

    const [first, second] = store.snapshot().items;
    expect(first).toMatchObject({ kind: 'link', title: 't'.repeat(BOOKMARK_LIMITS.linkTitle) });
    expect(second).toMatchObject({ kind: 'link', url: longUrl });
    expect(second!.kind === 'link' && second!.title).toBe(
      longUrl.slice(0, BOOKMARK_LIMITS.linkTitle),
    );
  });
});

describe('BookmarksStore: Firefox import', () => {
  const folder = (title: string, children: TreeNode[]): TreeNode =>
    ({ id: title, title, type: 'folder', children }) as TreeNode;
  const mark = (title: string, url: string): TreeNode =>
    ({ id: url, title, url, type: 'bookmark' }) as TreeNode;

  it('creates a selected "Firefox bookmarks" space with one group per folder of links', async () => {
    const env = stubBrowser();
    env.tree = [
      folder('', [
        folder('Bookmarks Toolbar', [
          mark('Home', 'https://home.example/'),
          mark('Script', 'javascript:alert(1)'),
          mark('Privileged', 'place:parent=toolbar'),
          folder('Dev', [
            mark('MDN', 'https://developer.mozilla.org/'),
            folder('Empty', []),
            folder('Deep', [mark('Spec', 'http://spec.example/')]),
          ]),
          folder('Only folders', [folder('Nested', [mark('N', 'https://n.example/')])]),
        ]),
        folder('Other Bookmarks', []),
      ]),
    ];
    const store = await createStore();
    const personal = store.snapshot().spaces[0]!.id;

    await store.importFirefox();

    const snapshot = store.snapshot();
    const space = snapshot.spaces.find((s) => s.name === 'Firefox bookmarks')!;
    expect(snapshot.spaces.map((s) => s.id)).toEqual([personal, space.id]);
    expect(snapshot.lastSpaceId).toBe(space.id);
    expect(snapshot.firefoxImportOffered).toBe(true);
    expect(snapshot.groups.map((g) => [g.spaceId, g.name, g.order])).toEqual([
      [space.id, 'Bookmarks Toolbar', 0],
      [space.id, 'Bookmarks Toolbar / Dev', 1],
      [space.id, 'Dev / Deep', 2],
      [space.id, 'Only folders / Nested', 3],
    ]);
    const urlsOf = (name: string) =>
      snapshot.items
        .filter((i) => i.groupId === snapshot.groups.find((g) => g.name === name)!.id)
        .map((i) => (i.kind === 'link' ? [i.title, i.url] : []));
    expect(urlsOf('Bookmarks Toolbar')).toEqual([['Home', 'https://home.example/']]);
    expect(urlsOf('Dev / Deep')).toEqual([['Spec', 'http://spec.example/']]);
    expectDenseOrder(snapshot);
  });

  it('caps the import at 2000 links, truncating the last folder', async () => {
    const env = stubBrowser();
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) =>
        mark(`${prefix}${i}`, `https://${prefix}${i}.example/`),
      );
    env.tree = [
      folder('', [
        folder('Big', many('a', 1500)),
        folder('Bigger', many('b', 1500)),
        folder('Late', many('c', 5)),
      ]),
    ];
    const store = await createStore();

    await store.importFirefox();

    const snapshot = store.snapshot();
    expect(snapshot.items).toHaveLength(2000);
    expect(snapshot.groups.map((g) => g.name)).toEqual(['Big', 'Bigger']);
    expect(snapshot.items.filter((i) => i.groupId === snapshot.groups[1]!.id)).toHaveLength(500);
  });

  it('keeps the offer open when the bookmarks cannot be read', async () => {
    stubBrowser();
    vi.mocked(browser.bookmarks.getTree).mockRejectedValueOnce(new Error('places'));
    const store = await createStore();
    const before = store.snapshot();

    await store.importFirefox();

    expect(store.snapshot()).toEqual(before);
    expect(store.snapshot().firefoxImportOffered).toBe(false);
  });

  it('marks the offer as taken when dismissed, once', async () => {
    stubBrowser();
    const store = await createStore();
    const seen = vi.fn();
    store.onChange(seen);

    expect(store.dismissImport()).toBe(true);
    expect(store.dismissImport()).toBe(false);

    expect(store.snapshot().firefoxImportOffered).toBe(true);
    expect(store.snapshot().spaces).toHaveLength(1);
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('BookmarksStore: client ids and to-do state on create', () => {
  it('uses a given id for a space, group or item and refuses one that exists', async () => {
    stubBrowser();
    const store = await createStore();
    const [spaceId, groupId, itemId] = [
      crypto.randomUUID(),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ];

    expect(store.createSpace('Work', spaceId)).toBe(spaceId);
    expect(store.createGroup(spaceId, 'Reading', groupId)).toBe(groupId);
    expect(store.createItem(groupId, null, { kind: 'note', text: 'n' }, itemId)).toBe(itemId);
    const created = store.snapshot();
    expect(created.spaces.map((s) => s.id)).toContain(spaceId);
    expect(created.groups.map((g) => g.id)).toEqual([groupId]);
    expect(created.items.map((i) => i.id)).toEqual([itemId]);

    const seen = vi.fn();
    store.onChange(seen);
    expect(store.createSpace('Again', spaceId)).toBeNull();
    expect(store.createGroup(spaceId, 'Again', groupId)).toBeNull();
    expect(store.createItem(groupId, null, { kind: 'note', text: 'again' }, itemId)).toBeNull();
    // Ids share one namespace: a group id cannot be reused for an item.
    expect(store.createItem(groupId, null, { kind: 'note', text: 'x' }, spaceId)).toBeNull();
    expect(store.snapshot()).toEqual(created);
    expect(seen).not.toHaveBeenCalled();
  });

  it('generates a UUID when no id is given', async () => {
    stubBrowser();
    const { store, a } = await seededStore();

    const id = store.createItem(a, null, { kind: 'note', text: 'n' })!;

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('creates a to-do open by default and done when asked', async () => {
    stubBrowser();
    const { store, a } = await seededStore();
    const open = store.createItem(a, null, { kind: 'todo', text: 'open' })!;
    const done = store.createItem(a, null, { kind: 'todo', text: 'done', done: true })!;
    const explicit = store.createItem(a, null, { kind: 'todo', text: 'no', done: false })!;

    const byId = (id: string) => store.snapshot().items.find((i) => i.id === id);
    expect(byId(open)).toMatchObject({ kind: 'todo', done: false });
    expect(byId(done)).toMatchObject({ kind: 'todo', done: true });
    expect(byId(explicit)).toMatchObject({ kind: 'todo', done: false });
  });
});

describe('BookmarksStore: one cap per field', () => {
  /** The message the shell sends to undo a delete of `item`. */
  function undoAction(item: BookmarkItem): unknown {
    const input =
      item.kind === 'link'
        ? {
            kind: 'link',
            url: item.url,
            title: item.title,
            ...(item.favIconUrl ? { favIconUrl: item.favIconUrl } : {}),
          }
        : item.kind === 'note'
          ? { kind: 'note', text: item.text }
          : { kind: 'todo', text: item.text, done: item.done };
    return { type: 'bookmarks/item/create', groupId: item.groupId, beforeId: null, item: input };
  }

  /** An item without its identity: id, position and creation time. */
  function fieldsOf(item: BookmarkItem): Record<string, unknown> {
    const fields: Record<string, unknown> = { ...item };
    for (const key of ['id', 'order', 'createdAt']) delete fields[key];
    return fields;
  }

  /** Every stored item survives delete + undo: the wire accepts the message and the copy equals it. */
  function expectUndoRoundTrips(store: BookmarksStore): void {
    const items = store.snapshot().items;
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const parsed = parseWireAction(undoAction(item));
      expect(parsed, `${item.kind} ${item.id}`).not.toBeNull();
      const action = parsed!.action as Extract<Action, { type: 'bookmarks/item/create' }>;
      store.deleteItem(item.id);
      const id = store.createItem(action.groupId, null, action.item)!;
      const created = store.snapshot().items.find((entry) => entry.id === id)!;
      expect(fieldsOf(created)).toEqual(fieldsOf(item));
    }
  }

  it('lets a to-do edited to the cap and a link with a capped title round-trip through undo', async () => {
    stubBrowser();
    const { store, a } = await seededStore();
    const todo = store.createItem(a, null, { kind: 'todo', text: 't', done: true })!;
    store.updateItem(todo, { text: 'x'.repeat(BOOKMARK_LIMITS.text) });
    const note = store.createItem(a, null, {
      kind: 'note',
      text: 'n'.repeat(BOOKMARK_LIMITS.text),
    })!;
    const link = store.createItem(a, null, {
      kind: 'link',
      url: 'https://example.com/',
      title: 'l'.repeat(BOOKMARK_LIMITS.linkTitle),
      favIconUrl: 'https://example.com/favicon.ico',
    })!;

    expectUndoRoundTrips(store);
    const items = store.snapshot().items;
    expect(
      items.find((i) => i.kind === 'todo' && i.text.length === BOOKMARK_LIMITS.text),
    ).toBeDefined();
    expect(items.find((i) => i.id === note)).toBeUndefined(); // recreated under new ids
    expect(items.find((i) => i.id === link)).toBeUndefined();
  });

  it('truncates over-long text on update instead of storing what create would refuse', async () => {
    stubBrowser();
    const { store, a1, a2, a3 } = await seededStore();

    store.updateItem(a1, { title: 'T'.repeat(BOOKMARK_LIMITS.linkTitle + 100) });
    store.updateItem(a2, { text: 'N'.repeat(BOOKMARK_LIMITS.text + 100) });
    store.updateItem(a3, { text: 'D'.repeat(BOOKMARK_LIMITS.text + 100) });

    const byId = (id: string) => store.snapshot().items.find((i) => i.id === id)!;
    const a1Item = byId(a1);
    expect(a1Item.kind === 'link' && a1Item.title).toHaveLength(BOOKMARK_LIMITS.linkTitle);
    expect('text' in byId(a2) && (byId(a2) as { text: string }).text).toHaveLength(
      BOOKMARK_LIMITS.text,
    );
    expect('text' in byId(a3) && (byId(a3) as { text: string }).text).toHaveLength(
      BOOKMARK_LIMITS.text,
    );
    expectUndoRoundTrips(store);
  });

  it('caps names on create and rename, and keeps a trimmed name identical through a round trip', async () => {
    stubBrowser();
    const store = await createStore();
    const spaceId = store.createSpace('s'.repeat(BOOKMARK_LIMITS.name + 50))!;
    const groupId = store.createGroup(spaceId, 'g'.repeat(BOOKMARK_LIMITS.name + 50))!;
    // A cut that lands on a space is trimmed so the stored name is a fixed point.
    const edge = 'e'.repeat(BOOKMARK_LIMITS.name - 1) + ' tail';
    store.updateGroup(groupId, { name: edge });

    const snapshot = store.snapshot();
    expect(snapshot.spaces.find((s) => s.id === spaceId)!.name).toHaveLength(BOOKMARK_LIMITS.name);
    const stored = snapshot.groups[0]!.name;
    expect(stored).toBe('e'.repeat(BOOKMARK_LIMITS.name - 1));
    store.updateGroup(groupId, { name: stored });
    expect(store.snapshot().groups[0]!.name).toBe(stored);
  });

  it('caps imported link titles and folder names, and imports stay undo-safe', async () => {
    const env = stubBrowser();
    const folder = (title: string, children: TreeNode[]): TreeNode =>
      ({ id: title, title, type: 'folder', children }) as TreeNode;
    const mark = (title: string, url: string): TreeNode =>
      ({ id: url, title, url, type: 'bookmark' }) as TreeNode;
    env.tree = [
      folder('', [
        folder('F'.repeat(BOOKMARK_LIMITS.name + 500), [
          mark('M'.repeat(BOOKMARK_LIMITS.linkTitle + 500), 'https://long.example/'),
          mark('', `https://blank.example/${'p'.repeat(BOOKMARK_LIMITS.linkTitle + 100)}`),
        ]),
      ]),
    ];
    const store = await createStore();

    await store.importFirefox();

    const snapshot = store.snapshot();
    expect(snapshot.groups[0]!.name).toHaveLength(BOOKMARK_LIMITS.name);
    expect(snapshot.items.map((i) => i.kind === 'link' && i.title.length)).toEqual([
      BOOKMARK_LIMITS.linkTitle,
      BOOKMARK_LIMITS.linkTitle,
    ]);
    expectUndoRoundTrips(store);
  });

  it('keeps only favicon URLs the wire accepts', async () => {
    stubBrowser();
    const { store, a } = await seededStore();
    const make = (favIconUrl: string) => {
      const id = store.createItem(a, null, {
        kind: 'link',
        url: 'https://x.example/',
        title: 'x',
        favIconUrl,
      })!;
      return store.snapshot().items.find((i) => i.id === id)!;
    };

    expect(make('blob:https://x.example/1')).not.toHaveProperty('favIconUrl');
    expect(
      make('data:image/png;base64,' + 'A'.repeat(BOOKMARK_LIMITS.favIconUrl)),
    ).not.toHaveProperty('favIconUrl');
    expect(make('https://x.example/f.ico')).toHaveProperty('favIconUrl');
    expect(make('chrome://branding/content/icon32.png')).toHaveProperty('favIconUrl');
    expectUndoRoundTrips(store);
  });
});
