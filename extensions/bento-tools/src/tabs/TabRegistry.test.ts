import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabDelta, TabSnapshot } from '@shared/protocol';
import { TabRegistry } from './TabRegistry';
import { partitionTabDeltas } from '../messaging/audience';

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
  pageErrorChanged?: (tabId: number, pageError: TabSnapshot['pageError'] | null) => void;
}

type PageErrorRead = Awaited<ReturnType<typeof browser.bentoTabState.getPageErrors>>[number];

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
    bentoTabState: {
      getPageErrors: vi.fn(async (): Promise<PageErrorRead[]> => []),
      onPageErrorChanged: {
        addListener: vi.fn((listener) => (listeners.pageErrorChanged = listener)),
      },
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

describe('TabRegistry private windows', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function registryWithTabs() {
    const listeners = stubTabsBrowser([
      makeTab({ id: 1, windowId: 1 }),
      makeTab({ id: 900, windowId: 9, incognito: true }),
    ]);
    const tabs = new TabRegistry();
    await tabs.init();
    const batches: TabDelta[][] = [];
    tabs.onDeltas((deltas) => batches.push(deltas));
    return { listeners, tabs, batches };
  }

  it('lists regular and private tabs apart', async () => {
    const { tabs } = await registryWithTabs();

    expect(tabs.snapshotRegular().map((tab) => tab.id)).toEqual([1]);
    expect(tabs.snapshotPrivate(9).map((tab) => tab.id)).toEqual([900]);
    expect(tabs.snapshotPrivate(1)).toEqual([]);
  });

  it('names the private window of a delta, including a removal after the tab is forgotten', async () => {
    const { listeners, tabs, batches } = await registryWithTabs();

    listeners.created?.(makeTab({ id: 901, windowId: 9, incognito: true }));
    listeners.created?.(makeTab({ id: 2, windowId: 1 }));
    listeners.removed?.(901, { windowId: 9, isWindowClosing: false });
    listeners.removed?.(2, { windowId: 1, isWindowClosing: false });

    const deltas = batches.flat();
    const windows = deltas.map((delta) => [
      delta.kind,
      delta.kind === 'created' ? delta.tab.id : delta.id,
      tabs.privateWindowOf(delta),
    ]);
    expect(windows).toEqual([
      ['created', 901, 9],
      ['created', 2, undefined],
      ['removed', 901, 9],
      ['removed', 2, undefined],
    ]);
    expect(tabs.isPrivate(901)).toBe(false);
  });

  // An update for a tab that init has queried but not yet stored (its session values are
  // still being read) takes the create-on-unknown path. The delta's audience is fixed when
  // it is queued, so the tab's privacy has to be known by then.
  it('keeps the URL and title of a private tab off the regular audience when its update arrives during init', async () => {
    const privateTab = makeTab({ id: 900, windowId: 9, incognito: true });
    const listeners = stubTabsBrowser([makeTab({ id: 1, windowId: 1 }), privateTab]);
    let release: () => void = () => {};
    const gate = new Promise<undefined>((resolve) => (release = () => resolve(undefined)));
    vi.mocked(browser.sessions.getTabValue).mockImplementation(() => gate);
    const tabs = new TabRegistry();
    const batches: TabDelta[][] = [];
    tabs.onDeltas((deltas) => batches.push(deltas));

    const init = tabs.init();
    await vi.waitFor(() => expect(browser.sessions.getTabValue).toHaveBeenCalled());
    listeners.updated?.(
      900,
      {},
      { ...privateTab, title: 'Secret title', url: 'https://private.example/secret' },
    );
    release();
    await init;

    const { regular, privateByWindow } = partitionTabDeltas(tabs, batches.flat());
    expect(JSON.stringify(regular)).not.toContain('private.example');
    expect(JSON.stringify(regular)).not.toContain('Secret title');
    expect(privateByWindow.get(9)).toEqual([
      expect.objectContaining({
        kind: 'created',
        tab: expect.objectContaining({ id: 900, url: 'https://private.example/secret' }),
      }),
    ]);
    expect(tabs.isPrivate(900)).toBe(true);
  });

  it('keeps a private tab that an update introduces off the regular audience', async () => {
    const { listeners, tabs, batches } = await registryWithTabs();

    listeners.updated?.(
      901,
      {},
      makeTab({ id: 901, windowId: 9, incognito: true, url: 'https://private.example/new' }),
    );

    const { regular, privateByWindow } = partitionTabDeltas(tabs, batches.flat());
    expect(regular).toEqual([]);
    expect(privateByWindow.get(9)).toEqual([
      expect.objectContaining({ kind: 'created', tab: expect.objectContaining({ id: 901 }) }),
    ]);
  });

  it('assigns a tab to a Private workspace in memory only', async () => {
    const { tabs, batches } = await registryWithTabs();

    await tabs.assignWorkspace(900, 'private:abc');
    await expect(tabs.assignWorkspaceEagerly(900, 'private:abc')).resolves.toBe(true);

    expect(tabs.snapshotPrivate(9)[0]?.workspaceId).toBe('private:abc');
    expect(batches.flat()).toContainEqual({
      kind: 'updated',
      id: 900,
      changes: { workspaceId: 'private:abc' },
    });
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });
  it('moves a private tab between two private windows: the old one drops it, the new one learns it whole', async () => {
    const listeners = stubTabsBrowser([
      makeTab({ id: 900, windowId: 9, incognito: true }),
      makeTab({ id: 1000, windowId: 10, incognito: true, index: 0 }),
    ]);
    const tabs = new TabRegistry();
    await tabs.init();
    const batches: TabDelta[][] = [];
    tabs.onDeltas((deltas) => batches.push(deltas));

    listeners.attached?.(900, { newWindowId: 10, newPosition: 1 });

    const { regular, privateByWindow } = partitionTabDeltas(tabs, batches.flat());
    expect(regular).toEqual([]);
    expect(privateByWindow.get(9)).toEqual([{ kind: 'removed', id: 900 }]);
    expect(privateByWindow.get(10)).toEqual([
      { kind: 'created', tab: expect.objectContaining({ id: 900, windowId: 10, index: 1 }) },
    ]);
    expect(tabs.snapshotPrivate(9)).toEqual([]);
    expect(tabs.snapshotPrivate(10).map((tab) => tab.id)).toEqual([1000, 900]);
  });

  it('keeps a private tab name in memory: nothing reaches the session store', async () => {
    const { tabs, batches } = await registryWithTabs();

    await tabs.rename(900, '  Online banking ');
    await tabs.rename(1, 'Reading list');

    expect(tabs.snapshotPrivate(9)[0]?.customTitle).toBe('Online banking');
    expect(batches.flat()).toContainEqual({
      kind: 'updated',
      id: 900,
      changes: { customTitle: 'Online banking' },
    });
    // A regular tab's name is remembered by the session store.
    expect(browser.sessions.setTabValue).toHaveBeenCalledTimes(1);
    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(
      1,
      'bento.customTitle',
      'Reading list',
    );
  });

  it('does not write the cleared name of a private tab that navigates', async () => {
    const { listeners, tabs } = await registryWithTabs();
    await tabs.rename(900, 'Imported title');
    listeners.updated?.(
      900,
      { title: 'Imported title', url: 'https://one.example/' } as browser.tabs._OnUpdatedChangeInfo,
      makeTab({
        id: 900,
        windowId: 9,
        incognito: true,
        title: 'Imported title',
        url: 'https://one.example/',
      }),
    );
    await tabs.rename(900, 'https://one.example/');

    listeners.updated?.(
      900,
      { url: 'https://two.example/' } as browser.tabs._OnUpdatedChangeInfo,
      makeTab({ id: 900, windowId: 9, incognito: true, title: 'Two', url: 'https://two.example/' }),
    );

    expect(tabs.snapshotPrivate(9)[0]?.customTitle).toBeUndefined();
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });
});

describe('TabRegistry explicit restore hydration', () => {
  const membership = {
    hasWorkspace: (id: string) => id === 'saved-workspace',
    folderWorkspaceId: (id: string) => (id === 'saved-folder' ? 'saved-workspace' : undefined),
  };

  function sessionValues(values: Record<string, string | object>) {
    const stored = new Map(Object.entries(values));
    vi.mocked(browser.sessions.getTabValue).mockImplementation(async (_id, key) => stored.get(key));
    vi.mocked(browser.sessions.setTabValue).mockImplementation(async (_id, key, value) => {
      stored.set(key, value);
    });
    vi.mocked(browser.sessions.removeTabValue).mockImplementation(async (_id, key) => {
      stored.delete(key);
    });
    return stored;
  }

  it('round-trips retained membership through repeated marks and a native-style new tab id', async () => {
    const listeners = stubTabsBrowser([makeTab({ id: 41 })]);
    const stored = sessionValues({
      'bento.workspaceId': 'saved-workspace',
      'bento.folderId': 'saved-folder',
      'bento.customTitle': 'Saved title',
    });
    const tabs = new TabRegistry();
    await tabs.init();
    await tabs.markClosing(41, { preserveSessionMembership: true });
    await tabs.markClosing(41, { preserveSessionMembership: true });
    expect(tabs.snapshot()[0]).not.toHaveProperty('workspaceId');
    expect(tabs.snapshot()[0]).not.toHaveProperty('folderId');
    expect(stored.get('bento.closingTab')).toBe('1');
    expect(stored.get('bento.workspaceId')).toBe('saved-workspace');
    expect(stored.get('bento.folderId')).toBe('saved-folder');
    listeners.removed?.(41, { windowId: 1, isWindowClosing: false });
    listeners.created?.(makeTab({ id: 42 }));
    await expect(tabs.hydrateRestoredTab(42, membership)).resolves.toBe(true);
    expect(tabs.snapshot()[0]).toMatchObject({
      id: 42,
      workspaceId: 'saved-workspace',
      folderId: 'saved-folder',
      customTitle: 'Saved title',
    });
    expect(stored.has('bento.closingTab')).toBe(false);
  });

  it.each(['deleted-workspace', 'private:old-window'])(
    'drops retained membership for invalid workspace %s before unmarking',
    async (workspaceId) => {
      const listeners = stubTabsBrowser();
      const stored = sessionValues({
        'bento.workspaceId': workspaceId,
        'bento.folderId': 'saved-folder',
        'bento.closingTab': '1',
      });
      const tabs = new TabRegistry();
      await tabs.init();
      listeners.created?.(makeTab({ id: 42 }));
      await tabs.hydrateRestoredTab(42, membership);
      expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();
      expect(tabs.snapshot()[0]?.folderId).toBeUndefined();
      expect(stored.size).toBe(0);
      expect(vi.mocked(browser.sessions.removeTabValue).mock.calls.map(([, key]) => key)).toEqual([
        'bento.workspaceId',
        'bento.folderId',
        'bento.closingTab',
      ]);
    },
  );

  it.each(['deleted-folder', 'moved-folder'])(
    'drops %s without changing a valid saved workspace',
    async (folderId) => {
      const listeners = stubTabsBrowser();
      const stored = sessionValues({
        'bento.workspaceId': 'saved-workspace',
        'bento.folderId': folderId,
        'bento.closingTab': '1',
      });
      const tabs = new TabRegistry();
      await tabs.init();
      listeners.created?.(makeTab({ id: 42 }));
      await tabs.hydrateRestoredTab(42, {
        ...membership,
        folderWorkspaceId: (id) => (id === 'moved-folder' ? 'other-workspace' : undefined),
      });
      expect(tabs.snapshot()[0]?.workspaceId).toBe('saved-workspace');
      expect(tabs.snapshot()[0]?.folderId).toBeUndefined();
      expect(stored.has('bento.folderId')).toBe(false);
    },
  );

  it('leaves genuine unmarked import membership available for adoption', async () => {
    const listeners = stubTabsBrowser();
    const stored = sessionValues({ 'bento.workspaceId': 'imported-workspace' });
    const tabs = new TabRegistry();
    await tabs.init();
    listeners.created?.(makeTab({ id: 42 }));
    await expect(tabs.hydrateRestoredTab(42, membership)).resolves.toBe(false);
    expect(tabs.snapshot()[0]?.workspaceId).toBe('imported-workspace');
    expect(stored.get('bento.workspaceId')).toBe('imported-workspace');
  });

  it('sweeps a startup marked live tab destructively even if user close retained membership', async () => {
    stubTabsBrowser([makeTab({ id: 42 })]);
    const stored = sessionValues({
      'bento.workspaceId': 'saved-workspace',
      'bento.folderId': 'saved-folder',
      'bento.closingTab': '1',
    });
    browser.tabs.remove = vi.fn().mockResolvedValue(undefined);
    const tabs = new TabRegistry();
    await tabs.init();
    await tabs.hydrateWorkspaceIds({ attempts: 1 });
    expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();
    await tabs.closeMarkedTabs();
    expect(browser.tabs.remove).toHaveBeenCalledWith(42);
    expect(stored.has('bento.workspaceId')).toBe(false);
    expect(stored.has('bento.folderId')).toBe(false);
    expect(stored.get('bento.closingTab')).toBe('1');
  });

  it('clears private session membership even when preservation is requested', async () => {
    stubTabsBrowser([makeTab({ id: 42, incognito: true })]);
    const stored = sessionValues({
      'bento.workspaceId': 'private:window',
      'bento.folderId': 'private-folder',
    });
    const tabs = new TabRegistry();
    await tabs.init();
    await tabs.markClosing(42, { preserveSessionMembership: true });
    expect(stored.has('bento.workspaceId')).toBe(false);
    expect(stored.has('bento.folderId')).toBe(false);
    expect(browser.sessions.setTabValue).toHaveBeenCalledExactlyOnceWith(
      42,
      'bento.closingTab',
      '1',
    );
  });

  it('clears pending assignments and lets a later destructive mark discard retained keys', async () => {
    const listeners = stubTabsBrowser();
    const stored = sessionValues({});
    const tabs = new TabRegistry();
    await tabs.init();
    await tabs.assignWorkspaceEagerly(42, 'saved-workspace');
    await tabs.assignFolderEagerly(42, 'saved-folder');
    await tabs.markClosing(42, { preserveSessionMembership: true });
    listeners.created?.(makeTab({ id: 42 }));
    await tabs.hydrateWorkspaceIds({ attempts: 1 });
    expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();
    expect(tabs.snapshot()[0]?.folderId).toBeUndefined();
    expect(stored.get('bento.folderId')).toBe('saved-folder');
    await tabs.markClosing(42);
    expect(stored.has('bento.workspaceId')).toBe(false);
    expect(stored.has('bento.folderId')).toBe(false);
  });

  it('clears live folder-only membership while retaining its session value when opted in', async () => {
    stubTabsBrowser([makeTab({ id: 42 })]);
    const stored = sessionValues({ 'bento.folderId': 'saved-folder' });
    const tabs = new TabRegistry();
    await tabs.init();
    await tabs.markClosing(42, { preserveSessionMembership: true });
    expect(tabs.snapshot()[0]?.folderId).toBeUndefined();
    expect(stored.get('bento.folderId')).toBe('saved-folder');
  });

  it('does not let an older hydration read reapply an invalidated retained workspace', async () => {
    const listeners = stubTabsBrowser();
    sessionValues({
      'bento.workspaceId': 'deleted-workspace',
      'bento.closingTab': '1',
    });
    const tabs = new TabRegistry();
    await tabs.init();
    let finishRead!: (value: string) => void;
    const oldRead = new Promise<string>((resolve) => (finishRead = resolve));
    vi.mocked(browser.sessions.getTabValue).mockImplementationOnce(() => oldRead);
    listeners.created?.(makeTab({ id: 42 }));
    await tabs.hydrateRestoredTab(42, membership);
    finishRead('deleted-workspace');
    await oldRead;
    // Let the suspended #hydrateOne finish, including its Promise.all continuation.
    await Promise.resolve();
    await Promise.resolve();
    expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();
    expect(tabs.isClosing(42)).toBe(false);
  });

  it('recovers native workspace, folder and title after clearing the close mark', async () => {
    const listeners = stubTabsBrowser();
    const tabs = new TabRegistry();
    await tabs.init();
    vi.mocked(browser.sessions.getTabValue).mockImplementation(
      async (_id, key) =>
        ({
          'bento.workspaceId': 'saved-workspace',
          'bento.folderId': 'saved-folder',
          'bento.customTitle': 'Saved title',
          'bento.closingTab': '1',
        })[key],
    );
    listeners.created?.(makeTab({ id: 42 }));
    await tabs.hydrateRestoredTab(42, membership);
    expect(tabs.snapshot()[0]).toMatchObject({
      id: 42,
      workspaceId: 'saved-workspace',
      folderId: 'saved-folder',
      customTitle: 'Saved title',
    });
    expect(tabs.isClosing(42)).toBe(false);
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });
});

describe('TabRegistry page errors', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  async function registryWithTabs(atStart: PageErrorRead[] = []) {
    const listeners = stubTabsBrowser([
      makeTab({ id: 1, windowId: 1 }),
      makeTab({ id: 2, windowId: 1 }),
      makeTab({ id: 900, windowId: 9, incognito: true }),
    ]);
    vi.mocked(browser.bentoTabState.getPageErrors).mockResolvedValue(atStart);
    const tabs = new TabRegistry();
    await tabs.init();
    const batches: TabDelta[][] = [];
    tabs.onDeltas((deltas) => batches.push(deltas));
    return { listeners, tabs, batches };
  }

  const errorsOf = (tabs: TabRegistry) =>
    Object.fromEntries(
      tabs
        .snapshot()
        .filter((tab) => tab.pageError)
        .map((tab) => [tab.id, tab.pageError]),
    );
  const flushReads = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('marks tabs that already show a failure page in the initial snapshot', async () => {
    const { tabs } = await registryWithTabs([{ tabId: 2, pageError: 'certificate-warning' }]);

    expect(errorsOf(tabs)).toEqual({ 2: 'certificate-warning' });
  });

  it('emits a delta when a tab starts, changes and stops showing a failure page', async () => {
    const { listeners, tabs, batches } = await registryWithTabs();

    listeners.pageErrorChanged?.(1, 'unavailable');
    expect(errorsOf(tabs)).toEqual({ 1: 'unavailable' });
    listeners.pageErrorChanged?.(1, 'crashed');
    listeners.pageErrorChanged?.(1, null);
    expect(errorsOf(tabs)).toEqual({});
    expect(tabs.snapshot().find((tab) => tab.id === 1)).not.toHaveProperty('pageError');

    expect(batches.flat()).toEqual([
      { kind: 'updated', id: 1, changes: { pageError: 'unavailable' } },
      { kind: 'updated', id: 1, changes: { pageError: 'crashed' } },
      { kind: 'updated', id: 1, changes: { pageError: null } },
    ]);
    // A private window's relay JSON-serialises deltas: the clear must survive that.
    expect(JSON.parse(JSON.stringify(batches.flat()))).toEqual(batches.flat());
  });

  it('ignores a repeat of the state a tab already has', async () => {
    const { listeners, batches } = await registryWithTabs();

    listeners.pageErrorChanged?.(1, null);
    listeners.pageErrorChanged?.(1, 'blocked');
    listeners.pageErrorChanged?.(1, 'blocked');

    expect(batches.flat()).toEqual([{ kind: 'updated', id: 1, changes: { pageError: 'blocked' } }]);
  });

  it('keeps a private tab out of the regular audience', async () => {
    const { listeners, tabs, batches } = await registryWithTabs();

    listeners.pageErrorChanged?.(900, 'crashed');

    const { regular, privateByWindow } = partitionTabDeltas(tabs, batches.flat());
    expect(regular).toEqual([]);
    expect(privateByWindow.get(9)).toEqual([
      { kind: 'updated', id: 900, changes: { pageError: 'crashed' } },
    ]);
  });

  it('keeps the state when onCreated reports a tab it already tracks', async () => {
    const { listeners, tabs } = await registryWithTabs([{ tabId: 2, pageError: 'crashed' }]);

    listeners.created?.(makeTab({ id: 2, windowId: 1 }));

    expect(errorsOf(tabs)).toEqual({ 2: 'crashed' });
  });

  describe('for a tab onCreated has not delivered yet', () => {
    it('applies the state its first event reported, without a separate delta', async () => {
      const { listeners, tabs, batches } = await registryWithTabs();

      listeners.pageErrorChanged?.(50, 'unavailable');
      expect(batches).toEqual([]);
      listeners.created?.(makeTab({ id: 50, windowId: 1 }));

      expect(errorsOf(tabs)).toEqual({ 50: 'unavailable' });
      expect(batches.flat()).toEqual([
        {
          kind: 'created',
          tab: expect.objectContaining({ id: 50, pageError: 'unavailable' }),
        },
      ]);
    });

    it('applies the state a read found', async () => {
      const { listeners, tabs } = await registryWithTabs([{ tabId: 50, pageError: 'blocked' }]);

      listeners.created?.(makeTab({ id: 50, windowId: 1 }));

      expect(errorsOf(tabs)).toEqual({ 50: 'blocked' });
    });

    it('does not let a state kept during init outlive the read that follows it', async () => {
      const listeners = stubTabsBrowser();
      // The event arrives while init waits for the tab list, before the registry knows the tab.
      vi.mocked(browser.tabs.query).mockImplementation(async () => {
        listeners.pageErrorChanged?.(60, 'unavailable');
        return [makeTab({ id: 60, windowId: 1 })];
      });
      vi.mocked(browser.bentoTabState.getPageErrors).mockResolvedValue([]);
      const tabs = new TabRegistry();
      await tabs.init();

      // SessionStore can deliver onCreated for a tab init already saw.
      listeners.created?.(makeTab({ id: 60, windowId: 1 }));

      expect(errorsOf(tabs)).toEqual({});
    });

    it('drops the state when it ended or the tab closed first', async () => {
      const { listeners, tabs } = await registryWithTabs();

      listeners.pageErrorChanged?.(50, 'crashed');
      listeners.pageErrorChanged?.(50, null);
      listeners.pageErrorChanged?.(51, 'crashed');
      listeners.removed?.(51, { windowId: 1, isWindowClosing: false });
      listeners.created?.(makeTab({ id: 50, windowId: 1 }));
      listeners.created?.(makeTab({ id: 51, windowId: 1 }));

      expect(errorsOf(tabs)).toEqual({});
    });
  });

  describe('after a tab moves to another window', () => {
    async function moveTab2(readsAfter: PageErrorRead[]) {
      const setup = await registryWithTabs([{ tabId: 2, pageError: 'crashed' }]);
      vi.mocked(browser.bentoTabState.getPageErrors).mockResolvedValue(readsAfter);
      vi.mocked(browser.tabs.get).mockResolvedValue(makeTab({ id: 2, windowId: 5 }));
      setup.listeners.attached?.(2, { newWindowId: 5, newPosition: 0 });
      await flushReads();
      return setup;
    }

    it('keeps the crashed page the adopted document still shows', async () => {
      const { tabs, batches } = await moveTab2([{ tabId: 2, pageError: 'crashed' }]);

      expect(errorsOf(tabs)).toEqual({ 2: 'crashed' });
      expect(
        batches.flat().filter((d) => d.kind === 'updated' && 'pageError' in d.changes),
      ).toEqual([]);
    });

    it('clears it when the adopted tab no longer shows the page', async () => {
      const { tabs } = await moveTab2([]);

      expect(errorsOf(tabs)).toEqual({});
    });
  });

  it('still starts when the experiment is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubTabsBrowser([makeTab({ id: 1 })]);
    vi.mocked(browser.bentoTabState.onPageErrorChanged.addListener).mockImplementation(() => {
      throw new Error('no experiment');
    });
    vi.mocked(browser.bentoTabState.getPageErrors).mockRejectedValue(new Error('no experiment'));
    const tabs = new TabRegistry();

    await tabs.init();

    expect(tabs.snapshot().map((tab) => tab.id)).toEqual([1]);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
