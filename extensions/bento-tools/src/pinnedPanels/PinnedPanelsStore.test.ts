import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { load } from './Persistence';
import { PinnedPanelsStore } from './PinnedPanelsStore';

const STORAGE_KEY = 'bento.pinnedPanels';

describe('PinnedPanelsStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({
            [STORAGE_KEY]: {
              version: 4,
              entries: [
                {
                  workspaceId: 'ws-a',
                  panelKey: 'panel-a',
                  url: 'https://a.example.test/',
                  order: 0,
                  title: 'A',
                },
                {
                  workspaceId: 'ws-b',
                  panelKey: 'panel-b',
                  url: 'https://b.example.test/',
                  order: 1,
                  title: 'B',
                },
                {
                  workspaceId: 'ws-a',
                  panelKey: 'devtools-panel',
                  url: 'about:devtools-toolbox?type=tab&id=123&tool=inspector',
                  order: 2,
                  title: 'DevTools',
                },
              ],
            },
          })),
          set: vi.fn(async () => undefined),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({ id: tabId, url: `https://${tabId}.example.test/` })),
      },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('exposes all persisted pins immediately and rebinds lazily restored workspaces', async () => {
    const store = new PinnedPanelsStore();

    await store.init();

    expect(store.entries()).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-a',
        tabId: expect.any(Number),
        order: 0,
        url: 'https://a.example.test/',
        title: 'A',
      }),
      expect.objectContaining({
        workspaceId: 'ws-b',
        tabId: expect.any(Number),
        order: 1,
        url: 'https://b.example.test/',
        title: 'B',
      }),
    ]);
    expect(store.entries().every((entry) => entry.tabId < 0)).toBe(true);
    expect(store.entries().some((entry) => entry.url?.startsWith('about:devtools-toolbox'))).toBe(
      false,
    );

    store.recoverTabIdsAfterPanelRestore('ws-b', {
      panelKeyToTabId: new Map([['panel-b', 42]]),
      urlToTabId: new Map([['https://b.example.test/', 42]]),
    });

    expect(store.entries()).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-a',
        tabId: expect.any(Number),
        order: 0,
        url: 'https://a.example.test/',
      }),
      expect.objectContaining({
        workspaceId: 'ws-b',
        tabId: 42,
        order: 1,
        url: 'https://b.example.test/',
      }),
    ]);
    expect(store.entries()[0]?.tabId).toBeLessThan(0);
  });

  it('reorders the complete pinned rail and normalizes persisted order values', () => {
    const store = new PinnedPanelsStore();
    store.add('ws-a', 1);
    store.add('ws-b', 2);
    store.add('ws-a', 3);

    expect(
      store.reorder([
        { workspaceId: 'ws-a', tabId: 3 },
        { workspaceId: 'ws-a', tabId: 1 },
        { workspaceId: 'ws-b', tabId: 2 },
      ]),
    ).toBe(true);
    expect(store.entries().map((entry) => [entry.workspaceId, entry.tabId, entry.order])).toEqual([
      ['ws-a', 3, 0],
      ['ws-a', 1, 1],
      ['ws-b', 2, 2],
    ]);
    expect(
      store.reorder([
        { workspaceId: 'ws-a', tabId: 3 },
        { workspaceId: 'ws-a', tabId: 1 },
      ]),
    ).toBe(false);
  });
});

describe('PinnedPanelsStore private tabs', () => {
  const set = vi.fn<(payload: Record<string, unknown>) => Promise<void>>(async () => undefined);
  let privateTabGone: boolean;

  beforeEach(() => {
    set.mockClear();
    privateTabGone = false;
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn(async () => ({})), set } },
      tabs: {
        get: vi.fn(async (tabId: number) => {
          if (tabId === 11 && privateTabGone) throw new Error('tab gone');
          return {
            id: tabId,
            url: tabId === 11 ? 'https://private.example.test/secret' : `https://${tabId}.test/`,
            title: tabId === 11 ? 'Private secret title' : `Tab ${tabId}`,
            incognito: tabId === 11,
          };
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never stores a private pin, including after its tab closes', async () => {
    const store = new PinnedPanelsStore();
    store.add('ws', 11, {
      url: 'https://private.example.test/secret',
      title: 'Private secret title',
      favIconUrl: 'https://private.example.test/favicon.ico',
    });
    store.add('ws', 12, { url: 'https://12.test/' });

    await store.persistCurrentState();
    privateTabGone = true;
    await store.persistCurrentState();

    const written = JSON.stringify(set.mock.calls);
    expect(written).toContain('https://12.test/');
    expect(written).not.toContain('private');
    expect(written).not.toContain('Private');
  });
});

describe('PinnedPanelsStore tab closed right after a change', () => {
  interface LiveTab {
    url: string;
    title: string;
    favIconUrl?: string;
    incognito?: boolean;
  }

  let storage: Record<string, unknown>;
  let setMock: ReturnType<typeof vi.fn>;
  const liveTabs = new Map<number, LiveTab>();
  const closedTabIds = new Set<number>();

  beforeEach(() => {
    vi.useFakeTimers();
    storage = {};
    liveTabs.clear();
    closedTabIds.clear();
    setMock = vi.fn(async (payload: Record<string, unknown>) => {
      Object.assign(storage, payload);
    });
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: setMock,
        },
      },
      tabs: {
        // Open or closed is decided when the call is made, like an IPC request
        // already in flight when the tab goes away.
        get: vi.fn(async (tabId: number) => {
          const tab = liveTabs.get(tabId);
          if (!tab || closedTabIds.has(tabId)) throw new Error('tab gone');
          return { id: tabId, ...tab };
        }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('never writes a private pin whose tab closed after it was added', async () => {
    const privateTab = {
      url: 'https://private.example.test/secret',
      title: 'Private secret title',
      favIconUrl: 'https://private.example.test/favicon.ico',
    };
    liveTabs.set(11, { ...privateTab, incognito: true });
    liveTabs.set(12, { url: 'https://12.example.test/', title: 'Regular' });
    const store = new PinnedPanelsStore();

    store.add('ws', 11, privateTab);
    await vi.advanceTimersByTimeAsync(0);
    closedTabIds.add(11);
    store.add('ws', 12, { url: 'https://12.example.test/' });
    await vi.advanceTimersByTimeAsync(500);

    const written = JSON.stringify(setMock.mock.calls);
    expect(written).toContain('https://12.example.test/');
    expect(written).not.toMatch(/private|Private/);
  });

  it('persists a pin added without metadata when its regular tab closes right away', async () => {
    liveTabs.set(21, { url: 'https://21.example.test/', title: 'Tab 21' });
    const store = new PinnedPanelsStore();

    store.add('ws', 21);
    closedTabIds.add(21);
    await vi.advanceTimersByTimeAsync(500);

    expect((await load())?.entries).toEqual([
      expect.objectContaining({
        workspaceId: 'ws',
        url: 'https://21.example.test/',
        title: 'Tab 21',
      }),
    ]);
  });

  it('writes the URL a pinned tab navigated to before it closed', async () => {
    const page = { url: 'https://21.example.test/', title: 'Tab 21' };
    liveTabs.set(21, page);
    liveTabs.set(22, { url: 'https://22.example.test/', title: 'Tab 22' });
    const store = new PinnedPanelsStore();
    store.add('ws', 21, page);
    await vi.advanceTimersByTimeAsync(0);

    page.url = 'https://21.example.test/next';
    store.add('ws', 22);
    closedTabIds.add(21);
    await vi.advanceTimersByTimeAsync(500);

    expect((await load())?.entries).toContainEqual(
      expect.objectContaining({ url: 'https://21.example.test/next' }),
    );
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface FakeTab {
  url?: string;
  title?: string;
  favIconUrl?: string;
  status?: string;
  incognito?: boolean;
}

/** A tab as `tabs.get` returns it. Firefox's `TabBase.convert()` copies url,
 * title and favIconUrl only when truthy, so a page with no icon (or an empty
 * title) yields an object without the key, never an empty string. `status` is
 * always there: 'loading' while the tab is busy, else 'complete'. */
function firefoxTab({ url, title, favIconUrl, status }: FakeTab): FakeTab {
  const tab: FakeTab = {};
  if (url) tab.url = url;
  if (title) tab.title = title;
  if (favIconUrl) tab.favIconUrl = favIconUrl;
  if (status) tab.status = status;
  return tab;
}

/** Persist ordering. `tabs.get` and `storage.local.set` are driven by hand so each
 * test pins the interleaving it is about. */
describe('PinnedPanelsStore persist ordering', () => {
  const SECRET = 'https://private.example.test/secret';
  let storage: Record<string, unknown>;
  let setPayloads: Array<{ entries: Array<{ url: string }> }>;
  let setGates: Array<Deferred<void>>;
  let tabsGet: ReturnType<typeof vi.fn>;
  const liveTabs = new Map<number, FakeTab>();

  /** URLs in the primary slot, in stored order. */
  const storedUrls = () =>
    ((storage[STORAGE_KEY] as { entries: Array<{ url: string }> } | undefined)?.entries ?? []).map(
      (entry) => entry.url,
    );
  const storedEntries = () =>
    (storage[STORAGE_KEY] as { entries: Array<Record<string, unknown>> } | undefined)?.entries ??
    [];
  const everythingWritten = () => JSON.stringify(setPayloads);
  /** Close a tab: later reads fail, but a read already issued still answers. */
  const closeTab = (tabId: number) => liveTabs.delete(tabId);

  beforeEach(() => {
    vi.useFakeTimers();
    storage = {};
    setPayloads = [];
    setGates = [];
    liveTabs.clear();
    tabsGet = vi.fn(async (tabId: number) => {
      const tab = liveTabs.get(tabId);
      if (!tab) throw new Error('tab gone');
      return { id: tabId, ...tab };
    });
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            const gate = setGates.shift();
            if (gate) await gate.promise;
            Object.assign(storage, payload);
            if (STORAGE_KEY in payload) {
              setPayloads.push(JSON.parse(JSON.stringify(payload[STORAGE_KEY])));
            }
          }),
        },
      },
      tabs: { get: tabsGet },
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('overlapping persists', () => {
    it('keeps the newest state when an older tab lookup resolves last', async () => {
      liveTabs.set(2, { url: 'https://two.test/' });
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      const store = new PinnedPanelsStore();

      store.add('ws', 1, { url: 'https://one.test/' });
      store.add('ws', 2, { url: 'https://two.test/' });
      await vi.advanceTimersByTimeAsync(500);
      held.resolve({ url: 'https://one.test/' });
      await vi.advanceTimersByTimeAsync(500);

      expect(storedUrls().sort()).toEqual(['https://one.test/', 'https://two.test/']);
    });

    it('does not bring back a pin removed while an older lookup was in flight', async () => {
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      const store = new PinnedPanelsStore();

      store.add('ws', 1, { url: 'https://one.test/' });
      store.remove('ws', 1);
      await vi.advanceTimersByTimeAsync(500);
      held.resolve({ url: 'https://one.test/' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(storedUrls()).toEqual([]);
      expect(everythingWritten()).not.toContain('one.test');
    });

    it('lands the newest write last when an older storage write is still in flight', async () => {
      const store = new PinnedPanelsStore();
      store.add('ws', 1, { url: 'https://one.test/' });
      store.add('ws', 2, { url: 'https://two.test/' });
      const olderWrite = deferred();
      setGates.push(olderWrite);

      const first = store.persistCurrentState();
      await vi.advanceTimersByTimeAsync(0);
      store.remove('ws', 2);
      const second = store.persistCurrentState();
      await vi.advanceTimersByTimeAsync(0);
      olderWrite.resolve();
      await Promise.all([first, second]);

      expect(storedUrls()).toEqual(['https://one.test/']);
      expect(setPayloads.map((payload) => payload.entries.length)).toEqual([2, 1]);
    });

    it('writes the latest state for an awaited persist that a newer change supersedes', async () => {
      liveTabs.set(1, { url: 'https://one.test/' });
      liveTabs.set(2, { url: 'https://two.test/' });
      const store = new PinnedPanelsStore();
      store.add('ws', 1, { url: 'https://one.test/' });
      await vi.advanceTimersByTimeAsync(500);

      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      const flushed = store.persistCurrentState();
      store.add('ws', 2, { url: 'https://two.test/' });
      held.resolve({ url: 'https://one.test/' });
      await flushed;

      // Durable without waiting for the debounce timer.
      expect(storedUrls().sort()).toEqual(['https://one.test/', 'https://two.test/']);
    });

    it('keeps an awaited persist pending until a write of its state or a newer one lands', async () => {
      for (const id of [1, 2, 3, 4]) liveTabs.set(id, { url: `https://${id}.test/` });
      const store = new PinnedPanelsStore();
      store.add('ws', 1, { url: 'https://1.test/' });
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      let landed = false;
      const awaited = store.persistCurrentState().then(() => {
        landed = true;
      });
      const stuckWrite = deferred();
      setGates.push(stuckWrite);

      // Three later changes, each resolving before the next starts.
      for (const id of [2, 3, 4]) {
        store.add('ws', id, { url: `https://${id}.test/` });
        await vi.advanceTimersByTimeAsync(0);
      }
      held.resolve({ url: 'https://1.test/' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(landed).toBe(false);
      expect(storedUrls()).toEqual([]);
      stuckWrite.resolve();
      await awaited;
      expect(storedUrls().sort()).toEqual([1, 2, 3, 4].map((id) => `https://${id}.test/`));
    });
  });

  // A tab can close between an older lookup and the newest one. What the older
  // lookup read must survive, and so must its verdict on privacy.
  describe('superseded lookups', () => {
    it.each([
      ['without URL metadata', undefined],
      ['with an outdated URL', 'https://outdated.test/'],
    ])('keeps the URL a superseded lookup read before its tab closed, %s', async (_case, url) => {
      liveTabs.set(5, { url: 'https://now.test/', title: 'Now' });
      const store = new PinnedPanelsStore();
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      store.add('ws', 5, url ? { url } : {});
      closeTab(5);
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);
      held.resolve({ url: 'https://now.test/', title: 'Now' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(storedEntries()).toMatchObject([
        { url: 'https://now.test/', title: 'Now', widthPx: 320 },
      ]);
    });

    it('drops a pin whose superseded lookup found it private', async () => {
      const store = new PinnedPanelsStore();
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      store.add('ws', 7, { url: SECRET });
      store.updateWidthForTab(7, 320);
      await vi.advanceTimersByTimeAsync(500);
      held.resolve({ url: SECRET, incognito: true });
      await vi.advanceTimersByTimeAsync(1000);

      expect(storedUrls()).toEqual([]);
      expect(everythingWritten()).not.toMatch(/private|Private/);
    });
  });

  // A tab read and a store update (`updateMetadataForTab`) both carry metadata.
  // The later of the two wins per field, whichever lookup or write finishes last.
  describe('metadata freshness', () => {
    const OLD = { url: 'https://now.test/', title: 'Old', favIconUrl: 'https://now.test/old.ico' };

    it.each([
      [
        'title and favicon',
        { title: 'New', favIconUrl: 'https://now.test/new.ico' },
        { title: 'New', favIconUrl: 'https://now.test/new.ico' },
      ],
      [
        'only the title, leaving the captured favicon',
        { title: 'New' },
        { title: 'New', favIconUrl: 'https://now.test/old.ico' },
      ],
    ])(
      'keeps a metadata update newer than the last capture when its tab closes: %s',
      async (_case, update, expected) => {
        liveTabs.set(5, OLD);
        const store = new PinnedPanelsStore();
        store.add('ws', 5);
        await vi.advanceTimersByTimeAsync(0);

        closeTab(5);
        store.updateMetadataForTab(5, update);
        await vi.advanceTimersByTimeAsync(500);

        expect(storedEntries()).toMatchObject([{ url: OLD.url, ...expected }]);
      },
    );

    it('keeps a metadata update over an older lookup that resolves after it', async () => {
      const store = new PinnedPanelsStore();
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      store.add('ws', 5, { url: OLD.url });
      store.updateMetadataForTab(5, { title: 'New' });
      await vi.advanceTimersByTimeAsync(500);
      held.resolve(OLD);
      await vi.advanceTimersByTimeAsync(1000);

      expect(storedEntries()).toMatchObject([{ url: OLD.url, title: 'New' }]);
    });

    it('prefers the tab read made after a metadata update', async () => {
      liveTabs.set(5, { ...OLD, title: 'Live' });
      const store = new PinnedPanelsStore();
      store.add('ws', 5, { url: OLD.url });
      store.updateMetadataForTab(5, { title: 'Event' });
      await vi.advanceTimersByTimeAsync(500);

      expect(storedEntries()).toMatchObject([{ title: 'Live' }]);
    });

    // An update stamps every field it supplies, including one equal to the entry's
    // value: the value that would be stored can be an older tab read instead.
    it.each([
      [
        'a title and a new favicon',
        { title: 'Original', favIconUrl: 'https://now.test/new.ico' },
        { title: 'Original', favIconUrl: 'https://now.test/new.ico' },
      ],
      [
        'only a title equal to the entry',
        { title: 'Original' },
        { title: 'Original', favIconUrl: 'https://now.test/old.ico' },
      ],
    ])(
      'keeps an update that repeats the entry over a cached tab read: %s',
      async (_case, update, expected) => {
        liveTabs.set(5, { ...OLD, title: 'Transient' });
        const store = new PinnedPanelsStore();
        store.add('ws', 5, { url: OLD.url, title: 'Original' });
        await vi.advanceTimersByTimeAsync(0);

        closeTab(5);
        expect(store.updateMetadataForTab(5, update)).toBe(true);
        await vi.advanceTimersByTimeAsync(500);

        expect(storedEntries()).toMatchObject([{ url: OLD.url, ...expected }]);
      },
    );

    it('ignores an update that supplies nothing', async () => {
      const store = new PinnedPanelsStore();
      store.add('ws', 5, { url: OLD.url, title: 'Original' });
      await vi.advanceTimersByTimeAsync(500);
      tabsGet.mockClear();

      expect(store.updateMetadataForTab(5, { title: '', favIconUrl: undefined })).toBe(false);
      await vi.advanceTimersByTimeAsync(500);

      expect(tabsGet).not.toHaveBeenCalled();
    });

    // The lookup barrier is private; its resolved value shows in the promises the
    // store hands to Promise.all. Each persist chains onto the previous barrier,
    // so a barrier that resolves to a value retains every earlier persist.
    it('settles the lookup barrier to nothing, so persists do not retain each other', async () => {
      liveTabs.set(5, OLD);
      const combined = vi.spyOn(Promise, 'all');
      try {
        const store = new PinnedPanelsStore();
        store.add('ws', 5);
        for (const widthPx of [300, 301, 302, 303]) store.updateWidthForTab(5, widthPx);
        await vi.advanceTimersByTimeAsync(500);

        const inputs = combined.mock.calls.flatMap(([promises]) => Array.from(promises));
        expect(inputs.length).toBeGreaterThanOrEqual(2 * 5);
        expect(await Promise.all(inputs)).toEqual(inputs.map(() => undefined));
      } finally {
        combined.mockRestore();
      }
    });
  });

  // A tab read that succeeds and reports an empty title or favicon says the tab has
  // none. That clears the stored value; only a field a read leaves out (undefined)
  // says nothing.
  describe('metadata clears', () => {
    const OLD = { url: 'https://now.test/', title: 'A', favIconUrl: 'https://now.test/a.ico' };

    it.each([
      [
        'title and favicon',
        { title: '', favIconUrl: '' },
        { title: undefined, favIconUrl: undefined },
      ],
      ['only the favicon', { favIconUrl: '' }, { title: 'A', favIconUrl: undefined }],
      ['only the title', { title: '' }, { title: undefined, favIconUrl: OLD.favIconUrl }],
    ])('removes what a successful read no longer has: %s', async (_case, cleared, expected) => {
      liveTabs.set(5, OLD);
      const store = new PinnedPanelsStore();
      store.add('ws', 5);
      await vi.advanceTimersByTimeAsync(500);
      expect(storedEntries()).toMatchObject([{ title: 'A', favIconUrl: OLD.favIconUrl }]);

      liveTabs.set(5, { ...OLD, ...cleared });
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);

      const [stored] = storedEntries();
      expect({ title: stored?.title, favIconUrl: stored?.favIconUrl }).toEqual(expected);
    });

    // Firefox leaves a falsy title or favicon out of a tab read. Only a completed
    // tab means the page has none; a loading tab (or an unknown status) says nothing.
    it.each([
      ['loading', 'loading'],
      ['of unknown status', undefined],
    ])('keeps a value that a read of a tab %s leaves out', async (_case, status) => {
      liveTabs.set(5, OLD);
      const store = new PinnedPanelsStore();
      store.add('ws', 5);
      await vi.advanceTimersByTimeAsync(500);

      liveTabs.set(5, firefoxTab({ url: OLD.url, status }));
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);

      expect(storedEntries()).toMatchObject([{ title: 'A', favIconUrl: OLD.favIconUrl }]);
    });

    it.each([
      ['no metadata', {}],
      ['stale metadata', { title: 'Entry', favIconUrl: 'https://now.test/entry.ico' }],
    ])(
      'clears the favicon when a completed tab has none, for an imported pin with %s',
      async (_case, imported) => {
        storage[STORAGE_KEY] = {
          version: 4,
          entries: [{ workspaceId: 'ws', panelKey: 'p', url: OLD.url, order: 0, ...imported }],
        };
        const store = new PinnedPanelsStore();
        await store.init();
        liveTabs.set(5, firefoxTab({ ...OLD, status: 'complete' }));
        store.recoverTabIdsAfterPanelRestore('ws', {
          panelKeyToTabId: new Map([['p', 5]]),
          urlToTabId: new Map([[OLD.url, 5]]),
        });
        await vi.advanceTimersByTimeAsync(500);
        expect(storedEntries()).toMatchObject([{ title: 'A', favIconUrl: OLD.favIconUrl }]);

        // Navigated to a completed page without an icon.
        liveTabs.set(
          5,
          firefoxTab({ url: 'https://next.test/', title: 'Next', status: 'complete' }),
        );
        store.updateWidthForTab(5, 320);
        await vi.advanceTimersByTimeAsync(500);

        const [stored] = storedEntries();
        expect(stored).toMatchObject({ url: 'https://next.test/', title: 'Next' });
        expect(stored?.favIconUrl).toBeUndefined();
      },
    );

    it('clears the title when a completed tab has none, and keeps the favicon it still has', async () => {
      liveTabs.set(5, OLD);
      const store = new PinnedPanelsStore();
      store.add('ws', 5, { url: OLD.url, title: 'Entry' });
      await vi.advanceTimersByTimeAsync(500);
      expect(storedEntries()).toMatchObject([{ title: 'A' }]);

      liveTabs.set(5, firefoxTab({ url: OLD.url, favIconUrl: OLD.favIconUrl, status: 'complete' }));
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);

      const [stored] = storedEntries();
      expect(stored).toMatchObject({ favIconUrl: OLD.favIconUrl });
      expect(stored?.title).toBeUndefined();
    });

    // A tab whose URL could not be stored is not the pinned page (a pinned tab
    // before SessionStore sets its address), so it says nothing about the pin's
    // title or icon, whether it omits them or carries its own.
    it.each([
      ['about:blank with no title or icon', { url: 'about:blank' }],
      [
        'about:blank with its own title and icon',
        { url: 'about:blank', title: 'New Tab', favIconUrl: 'chrome://blank.svg' },
      ],
      ['a DevTools toolbox', { url: 'about:devtools-toolbox?type=tab&id=1', title: 'DevTools' }],
    ])('keeps the stored title and favicon when a completed tab is %s', async (_case, blank) => {
      liveTabs.set(5, OLD);
      const store = new PinnedPanelsStore();
      store.add('ws', 5);
      await vi.advanceTimersByTimeAsync(500);

      liveTabs.set(5, firefoxTab({ ...blank, status: 'complete' }));
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);

      expect(storedEntries()).toMatchObject([
        { url: OLD.url, title: 'A', favIconUrl: OLD.favIconUrl },
      ]);
    });

    it('ignores the omission in an older completed lookup that resolves after a newer value', async () => {
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      const store = new PinnedPanelsStore();
      store.add('ws', 5, { url: OLD.url });
      liveTabs.set(5, OLD);
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);
      held.resolve(firefoxTab({ url: OLD.url, status: 'complete' }));
      await vi.advanceTimersByTimeAsync(1000);

      expect(storedEntries()).toMatchObject([{ title: 'A', favIconUrl: OLD.favIconUrl }]);
    });

    it('ignores a clear from an older lookup that resolves after a newer value', async () => {
      const held = deferred<FakeTab>();
      tabsGet.mockImplementationOnce(() => held.promise);
      const store = new PinnedPanelsStore();
      store.add('ws', 5, { url: OLD.url, title: 'Old' });
      liveTabs.set(5, { ...OLD, title: 'New' });
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);
      held.resolve({ url: OLD.url, title: '' });
      await vi.advanceTimersByTimeAsync(1000);

      expect(storedEntries()).toMatchObject([{ title: 'New' }]);
    });

    it.each([
      ['empty', ''],
      ['about:blank', 'about:blank'],
    ])('keeps the usable URL when a later read of the tab is %s', async (_case, blank) => {
      liveTabs.set(5, OLD);
      const store = new PinnedPanelsStore();
      store.add('ws', 5);
      await vi.advanceTimersByTimeAsync(500);

      liveTabs.set(5, { ...OLD, url: blank });
      store.updateWidthForTab(5, 320);
      await vi.advanceTimersByTimeAsync(500);

      expect(storedEntries()).toMatchObject([{ url: OLD.url, title: 'A' }]);
    });
  });

  // Capture semantics are unchanged from before the ordering fix: metadata and
  // privacy are read from tabs.get when a persist runs. Earlier attempts moved
  // that capture and leaked or lost data in these cases.
  describe('capture semantics', () => {
    it('never writes a pin restored into a private window, even after it navigates', async () => {
      storage[STORAGE_KEY] = {
        version: 4,
        entries: [
          { workspaceId: 'ws', panelKey: 'p-a', url: 'https://a.test/', order: 0, title: 'A' },
          { workspaceId: 'ws', panelKey: 'p-b', url: 'https://b.test/', order: 1, title: 'B' },
        ],
      };
      const store = new PinnedPanelsStore();
      await store.init();

      // Panel A is restored into a private window as tab 42.
      liveTabs.set(42, { url: 'https://a.test/', title: 'A', incognito: true });
      store.recoverTabIdsAfterPanelRestore('ws', {
        panelKeyToTabId: new Map([['p-a', 42]]),
        urlToTabId: new Map([['https://a.test/', 42]]),
      });
      await vi.advanceTimersByTimeAsync(500);
      liveTabs.set(42, { url: SECRET, title: 'Private title', incognito: true });
      store.updateMetadataForTab(42, { title: 'Private title' });
      await vi.advanceTimersByTimeAsync(500);
      await store.persistCurrentState();

      expect(everythingWritten()).not.toMatch(/private|Private/);
      expect(storedUrls()).toEqual(['https://b.test/']);
    });

    it('never writes a private pin that is reopened in another private tab', async () => {
      liveTabs.set(11, { url: SECRET, title: 'Private title', incognito: true });
      const store = new PinnedPanelsStore();
      store.add('ws', 11, { url: SECRET, title: 'Private title' });
      await vi.advanceTimersByTimeAsync(500);
      closeTab(11);

      liveTabs.set(78, { url: SECRET, title: 'Private title', incognito: true });
      store.rebindTabId('ws', 11, 78, { url: SECRET, title: 'Private title' });
      await store.persistCurrentState();

      expect(storedUrls()).toEqual([]);
      expect(everythingWritten()).not.toMatch(/private|Private/);
    });

    it('persists a regular pin again once it is reopened regularly after a private reopen', async () => {
      liveTabs.set(11, { url: 'https://11.test/', title: 'Tab 11' });
      const store = new PinnedPanelsStore();
      store.add('ws', 11, { url: 'https://11.test/' });
      await store.persistCurrentState();
      expect(storedUrls()).toEqual(['https://11.test/']);

      closeTab(11);
      liveTabs.set(78, { url: 'https://11.test/', title: 'Tab 11', incognito: true });
      store.rebindTabId('ws', 11, 78, { url: 'https://11.test/' });
      await store.persistCurrentState();
      expect(storedUrls()).toEqual([]);

      closeTab(78);
      liveTabs.set(79, { url: 'https://11.test/', title: 'Tab 11' });
      store.rebindTabId('ws', 78, 79, { url: 'https://11.test/' });
      await store.persistCurrentState();
      expect(storedUrls()).toEqual(['https://11.test/']);
    });

    it('writes the latest URL when a pinned tab navigates and closes before the timer fires', async () => {
      const page = { url: 'https://31.test/a', title: 'Page' };
      liveTabs.set(31, page);
      const store = new PinnedPanelsStore();
      store.add('ws', 31, page);
      await vi.advanceTimersByTimeAsync(0);

      page.url = 'https://31.test/b';
      page.title = 'Page B';
      store.updateMetadataForTab(31, { title: 'Page B' });
      closeTab(31);
      await vi.advanceTimersByTimeAsync(500);

      expect(storedUrls()).toEqual(['https://31.test/b']);
    });
  });
});
