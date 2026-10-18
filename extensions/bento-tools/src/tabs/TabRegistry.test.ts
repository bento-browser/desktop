import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabDelta } from '@shared/protocol';
import { TabRegistry } from './TabRegistry';

interface TabListeners {
  created?: (tab: browser.tabs.Tab) => void;
  updated?: (
    id: number,
    changeInfo: browser.tabs._OnUpdatedChangeInfo,
    tab: browser.tabs.Tab,
  ) => void;
  removed?: (id: number, info: browser.tabs._OnRemovedRemoveInfo) => void;
  attached?: (id: number, info: browser.tabs._OnAttachedAttachInfo) => void;
  activated?: (info: browser.tabs._OnActivatedActiveInfo) => void;
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
      onActivated: { addListener: vi.fn((listener) => (listeners.activated = listener)) },
      onMoved: { addListener: vi.fn() },
      onAttached: { addListener: vi.fn((listener) => (listeners.attached = listener)) },
      get: vi.fn(),
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

describe('TabRegistry attach to another window', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function attach(live: Partial<browser.tabs.Tab>) {
    const listeners = stubTabsBrowser([makeTab({ id: 9, windowId: 2, active: true })]);
    vi.mocked(browser.tabs.get).mockResolvedValue(makeTab({ id: 9, windowId: 1, ...live }));
    const tabs = new TabRegistry();
    const deltas: TabDelta[] = [];
    tabs.onDeltas((batch) => deltas.push(...batch));
    await tabs.init();
    listeners.attached?.(9, { newWindowId: 1, newPosition: 3 });
    // The live read is asynchronous.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { tabs, deltas };
  }

  it('moves the tab to the window it was adopted by', async () => {
    const { tabs } = await attach({ active: false });

    expect(tabs.snapshot()[0]).toMatchObject({ windowId: 1, index: 3 });
  });

  it('drops the active flag of a tab that was selected in its old window and is not in the new one', async () => {
    // An adopted tab is not selected and no activation event follows; a stale active flag makes
    // the workspace activation choose no tab and leave another workspace's tab in front.
    const { tabs, deltas } = await attach({ active: false });

    expect(browser.tabs.get).toHaveBeenCalledWith(9);
    expect(tabs.snapshot()[0]?.active).toBe(false);
    expect(deltas).toContainEqual({ kind: 'updated', id: 9, changes: { active: false } });
  });

  it('keeps the flag when the tab is the active one of the new window', async () => {
    const { tabs, deltas } = await attach({ active: true });

    expect(browser.tabs.get).toHaveBeenCalledWith(9);
    expect(tabs.snapshot()[0]?.active).toBe(true);
    expect(deltas).not.toContainEqual({ kind: 'updated', id: 9, changes: { active: true } });
  });
});

describe('TabRegistry live active read after an attach', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // Each attach starts a read of the tab; the test decides when each answer arrives.
  async function attachWithPendingRead() {
    const listeners = stubTabsBrowser([makeTab({ id: 9, windowId: 2, active: false })]);
    const answers: Array<(tab: browser.tabs.Tab) => void> = [];
    vi.mocked(browser.tabs.get).mockImplementation(
      () => new Promise((resolve) => answers.push(resolve)),
    );
    const tabs = new TabRegistry();
    await tabs.init();
    listeners.attached?.(9, { newWindowId: 1, newPosition: 0 });
    const settle = async (tab: browser.tabs.Tab, read = 0) => {
      answers[read]?.(tab);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    return { tabs, listeners, settle };
  }

  it('does not overwrite an activation that arrived while the read was pending', async () => {
    const { tabs, listeners, settle } = await attachWithPendingRead();

    // The user selects the tab in its new window before the read of the attach answers.
    listeners.activated?.({ tabId: 9, windowId: 1, previousTabId: 4 });
    await settle(makeTab({ id: 9, windowId: 1, active: false }));

    expect(tabs.snapshot()[0]?.active).toBe(true);
  });

  it('does not apply the read of a tab that has moved to another window since', async () => {
    const { tabs, listeners, settle } = await attachWithPendingRead();

    // A second move; the registry follows it. Its read answers first, then the first read
    // answers late for window 1.
    listeners.attached?.(9, { newWindowId: 3, newPosition: 0 });
    await settle(makeTab({ id: 9, windowId: 3, active: false }), 1);
    await settle(makeTab({ id: 9, windowId: 1, active: true }), 0);

    expect(tabs.snapshot()[0]).toMatchObject({ windowId: 3, active: false });
  });

  it('still applies the read when nothing newer arrived', async () => {
    const { tabs, settle } = await attachWithPendingRead();

    await settle(makeTab({ id: 9, windowId: 1, active: true }));

    expect(tabs.snapshot()[0]?.active).toBe(true);
  });
});

describe('TabRegistry clearWorkspace', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('forgets a live tab workspace and folder without marking the tab closing', async () => {
    stubTabsBrowser([makeTab({ id: 9 })]);
    vi.mocked(browser.sessions.getTabValue).mockImplementation(async (_id, key) =>
      key === 'bento.workspaceId' ? 'ws-a' : key === 'bento.folderId' ? 'folder-1' : undefined,
    );
    const tabs = new TabRegistry();
    const deltas: TabDelta[] = [];
    tabs.onDeltas((batch) => deltas.push(...batch));
    await tabs.init();
    expect(tabs.snapshot()[0]).toMatchObject({ workspaceId: 'ws-a', folderId: 'folder-1' });

    await tabs.clearWorkspace(9);

    expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();
    expect(tabs.snapshot()[0]?.folderId).toBeUndefined();
    expect(tabs.isClosing(9)).toBe(false);
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(9, 'bento.workspaceId');
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(9, 'bento.folderId');
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
    expect(deltas).toContainEqual({
      kind: 'updated',
      id: 9,
      changes: { workspaceId: undefined, folderId: undefined },
    });
  });
});

describe('TabRegistry confirmUnassigned', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function registryWith(values: Record<string, string>) {
    stubTabsBrowser([makeTab({ id: 1 }), makeTab({ id: 2 })]);
    const tabs = new TabRegistry();
    await tabs.init();
    // Values appear after init, like session values SessionStore attaches late.
    vi.mocked(browser.sessions.getTabValue).mockImplementation(
      async (id, key) => values[`${id}:${key}`],
    );
    return tabs;
  }

  it('confirms only tabs whose session metadata is empty', async () => {
    const tabs = await registryWith({ '2:bento.workspaceId': 'ws-a' });

    await expect(tabs.confirmUnassigned([1, 2])).resolves.toEqual([1]);
  });

  it('applies the value it found to the registry instead of writing anything', async () => {
    const tabs = await registryWith({ '2:bento.folderId': 'folder-1' });

    await tabs.confirmUnassigned([2]);

    await vi.waitFor(() =>
      expect(tabs.snapshot().find((t) => t.id === 2)?.folderId).toBe('folder-1'),
    );
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });

  it('does not confirm a tab whose metadata cannot be read', async () => {
    const tabs = await registryWith({});
    vi.mocked(browser.sessions.getTabValue).mockRejectedValue(new Error('no session'));

    await expect(tabs.confirmUnassigned([1])).resolves.toEqual([]);
  });

  it('trusts a detached tab over the stale value SessionStore copies back onto it', async () => {
    const tabs = await registryWith({ '1:bento.workspaceId': 'ws-old' });
    await expect(tabs.confirmUnassigned([1])).resolves.toEqual([]);

    await tabs.clearWorkspace(1);
    await expect(tabs.confirmUnassigned([1])).resolves.toEqual([1]);

    await tabs.assignWorkspaceEagerly(1, 'ws-new');
    await expect(tabs.confirmUnassigned([1])).resolves.toEqual([]);
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

  it('clears page-title-equivalent custom titles when the tab navigates', async () => {
    const listeners = stubTabsBrowser([
      makeTab({ id: 1, title: 'Imported title', url: 'https://old.example/' }),
    ]);
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();
    await tabs.rename(1, 'Imported title');
    emitted.length = 0;
    vi.mocked(browser.sessions.setTabValue).mockClear();

    listeners.updated?.(
      1,
      { url: 'https://new.example/' } as browser.tabs._OnUpdatedChangeInfo,
      makeTab({ id: 1, title: 'New title', url: 'https://new.example/' }),
    );

    expect(emitted).toContainEqual({
      kind: 'updated',
      id: 1,
      changes: expect.objectContaining({
        customTitle: undefined,
        title: 'New title',
        url: 'https://new.example/',
      }),
    });
    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(1, 'bento.customTitle', '');
    expect(tabs.snapshot()[0]?.customTitle).toBeUndefined();
  });

  it('keeps deliberate custom titles that differ from the page title when the tab navigates', async () => {
    const listeners = stubTabsBrowser([
      makeTab({ id: 1, title: 'Original page title', url: 'https://old.example/' }),
    ]);
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();
    await tabs.rename(1, 'Pinned workflow');
    emitted.length = 0;
    vi.mocked(browser.sessions.setTabValue).mockClear();

    listeners.updated?.(
      1,
      { url: 'https://new.example/' } as browser.tabs._OnUpdatedChangeInfo,
      makeTab({ id: 1, title: 'New title', url: 'https://new.example/' }),
    );

    expect(emitted).toContainEqual({
      kind: 'updated',
      id: 1,
      changes: expect.not.objectContaining({ customTitle: undefined }),
    });
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
    expect(tabs.snapshot()[0]?.customTitle).toBe('Pinned workflow');
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

describe('TabRegistry markDiscarded', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('puts the discard in the snapshot at once and leaves the later tabs.onUpdated nothing to report', async () => {
    const listeners = stubTabsBrowser([makeTab({ id: 1, pinned: true })]);
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();

    tabs.markDiscarded(1);

    expect(tabs.snapshot()[0]?.discarded).toBe(true);
    expect(emitted).toEqual([{ kind: 'updated', id: 1, changes: { discarded: true } }]);

    listeners.updated?.(
      1,
      { discarded: true } as browser.tabs._OnUpdatedChangeInfo,
      makeTab({ id: 1, pinned: true, discarded: true }),
    );
    tabs.markDiscarded(1);

    expect(emitted).toHaveLength(1);
  });

  it('ignores a tab the registry does not hold', async () => {
    stubTabsBrowser([]);
    const emitted: unknown[] = [];
    const tabs = new TabRegistry();
    tabs.onDeltas((deltas) => emitted.push(...deltas));
    await tabs.init();

    tabs.markDiscarded(99);

    expect(emitted).toEqual([]);
  });
});
