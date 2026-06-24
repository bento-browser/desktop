import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TabRegistry } from './TabRegistry';

interface TabListeners {
  created?: (tab: browser.tabs.Tab) => void;
  updated?: (
    id: number,
    changeInfo: browser.tabs._OnUpdatedChangeInfo,
    tab: browser.tabs.Tab,
  ) => void;
  removed?: (id: number, info: browser.tabs._OnRemovedRemoveInfo) => void;
}

function makeTab(overrides: Partial<browser.tabs.Tab> & { id: number }): browser.tabs.Tab {
  const { id, ...rest } = overrides;
  return {
    id,
    windowId: 1,
    index: overrides.index ?? id,
    title: overrides.title ?? `Tab ${id}`,
    active: false,
    pinned: false,
    ...rest,
  } as browser.tabs.Tab;
}

function stubTabsBrowser(initialTabs: browser.tabs.Tab[] = []): TabListeners {
  const listeners: TabListeners = {};
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('browser', {
    sessions: {
      getTabValue: vi.fn().mockResolvedValue(undefined),
      setTabValue: vi.fn().mockResolvedValue(undefined),
      removeTabValue: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      query: vi.fn(async () => initialTabs),
      onCreated: { addListener: vi.fn((listener) => (listeners.created = listener)) },
      onUpdated: { addListener: vi.fn((listener) => (listeners.updated = listener)) },
      onRemoved: { addListener: vi.fn((listener) => (listeners.removed = listener)) },
      onActivated: { addListener: vi.fn() },
      onMoved: { addListener: vi.fn() },
      onAttached: { addListener: vi.fn() },
    },
  });
  return listeners;
}

describe('TabRegistry closing markers', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn().mockResolvedValue('1'),
        setTabValue: vi.fn().mockResolvedValue(undefined),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('can clear the closing marker when a closed tab is restored', async () => {
    const tabs = new TabRegistry();

    await tabs.markClosing(123);
    expect(tabs.isClosing(123)).toBe(true);

    await tabs.unmarkClosing(123);

    expect(tabs.isClosing(123)).toBe(false);
    await expect(tabs.isClosingOrMarked(123)).resolves.toBe(false);
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(123, 'bento.closingTab');
  });

  it('reports whether eager workspace assignment persisted to the session store', async () => {
    const tabs = new TabRegistry();

    await expect(tabs.assignWorkspaceEagerly(456, 'ws-imported')).resolves.toBe(true);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      456,
      'bento.workspaceId',
      'ws-imported',
    );
  });

  it('returns false when eager workspace assignment cannot persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.sessions.setTabValue).mockRejectedValueOnce(new Error('write failed'));
    const tabs = new TabRegistry();

    try {
      await expect(tabs.assignWorkspaceEagerly(456, 'ws-imported')).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('reports whether eager folder assignment persisted to the session store', async () => {
    const tabs = new TabRegistry();

    await expect(tabs.assignFolderEagerly(456, 'folder-imported')).resolves.toBe(true);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      456,
      'bento.folderId',
      'folder-imported',
    );
  });

  it('returns false when eager folder assignment cannot persist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.sessions.setTabValue).mockRejectedValueOnce(new Error('write failed'));
    const tabs = new TabRegistry();

    try {
      await expect(tabs.assignFolderEagerly(456, 'folder-imported')).resolves.toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('retries boot hydration so delayed session workspace values are recovered', async () => {
    const listeners: Array<(tab: browser.tabs.Tab) => void> = [];
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(async (tabId: number, key: string) => {
          if (tabId !== 123) return undefined;
          const workspaceReads = vi
            .mocked(browser.sessions.getTabValue)
            .mock.calls.filter((call) => call[0] === 123 && call[1] === 'bento.workspaceId').length;
          if (key === 'bento.workspaceId') return workspaceReads >= 2 ? 'ws-imported' : undefined;
          return undefined;
        }),
        setTabValue: vi.fn().mockResolvedValue(undefined),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn(async () => [
          {
            id: 123,
            windowId: 1,
            index: 0,
            title: 'Imported',
            active: true,
            pinned: false,
          },
        ]),
        onCreated: { addListener: vi.fn((listener) => listeners.push(listener)) },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        onMoved: { addListener: vi.fn() },
        onAttached: { addListener: vi.fn() },
      },
    });

    const tabs = new TabRegistry();
    await tabs.init();
    expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();

    await tabs.hydrateWorkspaceIds({ attempts: 3, delayMs: 0 });

    expect(tabs.snapshot()[0]?.workspaceId).toBe('ws-imported');
  });
});

describe('TabRegistry URL snapshots', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('includes tab.url in the initial snapshot', async () => {
    stubTabsBrowser([makeTab({ id: 1, url: 'https://example.com/' })]);
    const tabs = new TabRegistry();

    await tabs.init();

    expect(tabs.snapshot()[0]?.url).toBe('https://example.com/');
  });

  it('uses pendingUrl when url is blank', async () => {
    stubTabsBrowser([
      {
        ...makeTab({
          id: 1,
          url: 'about:blank',
        }),
        pendingUrl: 'https://pending.example/',
      } as browser.tabs.Tab & { pendingUrl: string },
    ]);
    const tabs = new TabRegistry();

    await tabs.init();

    expect(tabs.snapshot()[0]?.url).toBe('https://pending.example/');
  });

  it('emits created tabs with url', async () => {
    const listeners = stubTabsBrowser();
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();

    listeners.created?.(makeTab({ id: 2, url: 'https://created.example/' }));

    expect(emitted).toContainEqual({
      kind: 'created',
      tab: expect.objectContaining({ id: 2, url: 'https://created.example/' }),
    });
  });

  it('emits URL changes on update', async () => {
    const listeners = stubTabsBrowser([makeTab({ id: 1, url: 'https://old.example/' })]);
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();

    listeners.updated?.(
      1,
      { url: 'https://new.example/' } as browser.tabs._OnUpdatedChangeInfo,
      makeTab({ id: 1, url: 'https://new.example/' }),
    );

    expect(emitted).toContainEqual({
      kind: 'updated',
      id: 1,
      changes: expect.objectContaining({ url: 'https://new.example/' }),
    });
    expect(tabs.snapshot()[0]?.url).toBe('https://new.example/');
  });

  it('emits undefined and clears the stored URL when update has no URL', async () => {
    const listeners = stubTabsBrowser([makeTab({ id: 1, url: 'https://old.example/' })]);
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();

    listeners.updated?.(
      1,
      {} as browser.tabs._OnUpdatedChangeInfo,
      makeTab({ id: 1, url: undefined }),
    );

    expect(emitted).toContainEqual({
      kind: 'updated',
      id: 1,
      changes: expect.objectContaining({ url: undefined }),
    });
    expect(tabs.snapshot()[0]?.url).toBeUndefined();
  });

  it('keeps URL available for closing-window snapshots', async () => {
    const listeners = stubTabsBrowser([
      makeTab({ id: 1, windowId: 7, url: 'https://closing.example/' }),
    ]);
    const closing = vi.fn();
    const tabs = new TabRegistry();
    tabs.onWindowClosing(closing);
    await tabs.init();

    listeners.removed?.(1, { windowId: 7, isWindowClosing: true });

    expect(closing).toHaveBeenCalledWith({
      windowId: 7,
      tabs: [expect.objectContaining({ id: 1, url: 'https://closing.example/' })],
    });
  });
});
