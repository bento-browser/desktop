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
