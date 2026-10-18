import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PINNED_DISCARD_WAIT_MS,
  createStartupPinnedTabDiscard,
  discardRestoredPinnedTabs,
  isPendingPinnedTab,
  pinnedTabsToDiscard,
} from './PinnedTabRestore';

function tab(overrides: Partial<TabSnapshot> & { id: number }): TabSnapshot {
  return {
    windowId: 1,
    index: overrides.id,
    title: '',
    pinned: true,
    active: false,
    audible: false,
    muted: false,
    ...overrides,
  };
}

/** The slice of TabRegistry the pass uses, backed by a plain list. */
function fakeRegistry(
  initial: TabSnapshot[],
  extra: { closing?: number[]; private?: number[] } = {},
) {
  const tabs = new Map(initial.map((t) => [t.id, t]));
  return {
    snapshot: vi.fn(() => Array.from(tabs.values())),
    isClosing: (id: number) => extra.closing?.includes(id) ?? false,
    isPrivate: (id: number) => extra.private?.includes(id) ?? false,
    markDiscarded: vi.fn((id: number) => {
      const t = tabs.get(id);
      if (t) t.discarded = true;
    }),
  };
}

type LiveTab = browser.tabs.Tab;

/** A pinned tab as the WebExtension API reports a pending restore: a real browser that never navigated. */
function pendingLive(id: number, overrides: Partial<LiveTab> = {}): LiveTab {
  return {
    id,
    index: id,
    windowId: 1,
    highlighted: false,
    active: false,
    pinned: true,
    incognito: false,
    discarded: false,
    url: 'about:blank',
    status: 'complete',
    audible: false,
    sharingState: { camera: false, microphone: false },
    ...overrides,
  };
}

/**
 * Backs `browser.tabs.get` and `discard` with per-tab live state, which a discard changes the way
 * Firefox does. A tab with no entry is pending; ids in `declined` stay loaded when discarded.
 */
function stubLiveTabs() {
  const live = new Map<number, LiveTab>();
  const declined = new Set<number>();
  const current = (id: number) => {
    let tab = live.get(id);
    if (!tab) live.set(id, (tab = pendingLive(id)));
    return tab;
  };
  vi.stubGlobal('browser', {
    tabs: {
      get: vi.fn(async (id: number) => ({ ...current(id) })),
      discard: vi.fn(async (id: number) => {
        if (!declined.has(id)) current(id).discarded = true;
      }),
    },
  });
  return {
    live,
    declined,
    set: (id: number, changes: Partial<LiveTab>) => Object.assign(current(id), changes),
  };
}

describe('isPendingPinnedTab', () => {
  it('is true for a pinned tab that never navigated', () => {
    expect(isPendingPinnedTab(pendingLive(1))).toBe(true);
  });

  it.each([
    ['loaded', { url: 'https://loaded.example.test/' }],
    ['loading', { status: 'loading' as const }],
    ['selected', { active: true }],
    ['already discarded', { discarded: true }],
    ['unpinned', { pinned: false }],
    ['audible', { audible: true }],
    ['sharing the camera', { sharingState: { camera: true, microphone: false } }],
    ['sharing the microphone', { sharingState: { camera: false, microphone: true } }],
    [
      'sharing the screen',
      { sharingState: { camera: false, microphone: false, screen: 'Window' } },
    ],
    ['hiding its address', { url: undefined }],
  ])('is false for a tab that is %s', (_label, changes) => {
    expect(isPendingPinnedTab(pendingLive(1, changes))).toBe(false);
  });
});

describe('pinnedTabsToDiscard', () => {
  it('picks pinned tabs that are not selected, not discarded and not shown panels', () => {
    const tabs = [
      tab({ id: 1 }),
      tab({ id: 2, active: true }),
      tab({ id: 3, discarded: true }),
      tab({ id: 4 }),
      tab({ id: 5, pinned: false }),
    ];

    expect(pinnedTabsToDiscard(tabs, new Set([4]))).toEqual([1]);
  });

  it('picks a pinned tab in each window while the other window keeps its selected tab', () => {
    const tabs = [
      tab({ id: 1, windowId: 1, active: true }),
      tab({ id: 2, windowId: 1 }),
      tab({ id: 3, windowId: 2, active: true }),
      tab({ id: 4, windowId: 2 }),
    ];

    expect(pinnedTabsToDiscard(tabs, new Set())).toEqual([2, 4]);
  });

  it('leaves pinned tabs that loaded, are loading or play audio', () => {
    // A pending tab has no address in the registry; a loaded one does (the loading and audible
    // ones may not yet).
    const tabs = [
      tab({ id: 1 }),
      tab({ id: 2, url: 'https://loaded.example.test/' }),
      tab({ id: 3, loading: true }),
      tab({ id: 4, audible: true }),
    ];

    expect(pinnedTabsToDiscard(tabs, new Set())).toEqual([1]);
  });

  it('picks nothing when Firefox already reports every pinned tab as discarded', () => {
    expect(pinnedTabsToDiscard([tab({ id: 1, discarded: true })], new Set())).toEqual([]);
  });
});

describe('discardRestoredPinnedTabs', () => {
  let tabsApi: ReturnType<typeof stubLiveTabs>;

  beforeEach(() => {
    vi.restoreAllMocks();
    tabsApi = stubLiveTabs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('marks each discarded tab in the registry before it resolves', async () => {
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 })]);

    await discardRestoredPinnedTabs(registry, new Set());

    expect(browser.tabs.discard).toHaveBeenCalledTimes(2);
    expect(registry.markDiscarded.mock.calls).toEqual([[1], [2]]);
    expect(registry.snapshot().every((t) => t.discarded)).toBe(true);
  });

  it('starts every discard before the first one finishes', async () => {
    const finish: Array<() => void> = [];
    vi.mocked(browser.tabs.discard).mockImplementation(
      (id) =>
        new Promise<void>((resolve) =>
          finish.push(() => {
            tabsApi.set(id as number, { discarded: true });
            resolve();
          }),
        ),
    );
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 }), tab({ id: 3 })]);

    const pass = discardRestoredPinnedTabs(registry, new Set());
    await vi.waitFor(() => expect(browser.tabs.discard).toHaveBeenCalledTimes(3));
    expect(registry.markDiscarded).not.toHaveBeenCalled();

    for (const resolve of finish) resolve();
    await pass;

    expect(registry.markDiscarded).toHaveBeenCalledTimes(3);
  });

  it('does not mark a tab Firefox declined to discard', async () => {
    tabsApi.declined.add(1);
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 })]);

    await discardRestoredPinnedTabs(registry, new Set());

    expect(registry.markDiscarded.mock.calls).toEqual([[2]]);
  });

  it('does not discard a pinned tab that loaded since the registry saw it', async () => {
    // The registry still shows the tab without an address; Firefox has loaded it meanwhile.
    tabsApi.set(1, { url: 'https://loaded.example.test/' });
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 })]);

    await discardRestoredPinnedTabs(registry, new Set());

    expect(browser.tabs.discard).toHaveBeenCalledTimes(1);
    expect(browser.tabs.discard).toHaveBeenCalledWith(2);
    expect(registry.markDiscarded.mock.calls).toEqual([[2]]);
  });

  it('does not discard an audible or sharing tab, or one that was selected or began loading', async () => {
    tabsApi.set(1, { audible: true });
    tabsApi.set(2, { sharingState: { camera: true, microphone: false } });
    tabsApi.set(3, { active: true });
    tabsApi.set(4, { status: 'loading' });
    const registry = fakeRegistry([1, 2, 3, 4, 5].map((id) => tab({ id })));

    await discardRestoredPinnedTabs(registry, new Set());

    expect(vi.mocked(browser.tabs.discard).mock.calls).toEqual([[5]]);
    expect(registry.markDiscarded.mock.calls).toEqual([[5]]);
  });

  it('discards the pending tabs and leaves the loaded ones, as with restore on demand off', async () => {
    // Without restore on demand Firefox loads pinned tabs itself: those that did have an address.
    tabsApi.set(1, { url: 'https://one.example.test/' });
    tabsApi.set(2, { url: 'https://two.example.test/', audible: true });
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 }), tab({ id: 3 })]);

    await discardRestoredPinnedTabs(registry, new Set());

    expect(vi.mocked(browser.tabs.discard).mock.calls).toEqual([[3]]);
  });

  it('leaves selected, shown, closing and private tabs alone', async () => {
    const registry = fakeRegistry(
      [
        tab({ id: 1, active: true }),
        tab({ id: 2 }),
        tab({ id: 3 }),
        tab({ id: 4 }),
        tab({ id: 5 }),
      ],
      { closing: [3], private: [4] },
    );

    await discardRestoredPinnedTabs(registry, new Set([2]));

    expect(browser.tabs.discard).toHaveBeenCalledTimes(1);
    expect(browser.tabs.discard).toHaveBeenCalledWith(5);
  });

  it('logs a failed discard and still discards the others', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.tabs.discard).mockRejectedValueOnce(new Error('Invalid tab ID: 1'));
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 })]);

    await expect(discardRestoredPinnedTabs(registry, new Set())).resolves.toBeUndefined();

    expect(registry.markDiscarded.mock.calls).toEqual([[2]]);
    expect(warn).toHaveBeenCalledWith(
      '[bento-tools] pinned tab discard failed for tab',
      1,
      expect.any(Error),
    );
  });

  it('stops waiting after the cap, and a late discard still lands in the registry', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let finish: () => void = () => undefined;
    vi.mocked(browser.tabs.discard).mockImplementation(
      (id) =>
        new Promise<void>((resolve) => {
          finish = () => {
            tabsApi.set(id as number, { discarded: true });
            resolve();
          };
        }),
    );
    const registry = fakeRegistry([tab({ id: 1 })]);

    let resolved = false;
    const pass = discardRestoredPinnedTabs(registry, new Set()).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(PINNED_DISCARD_WAIT_MS - 1);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pass;
    expect(resolved).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('still running'));
    expect(registry.markDiscarded).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(registry.markDiscarded).toHaveBeenCalledWith(1));
  });

  it('leaves no timer behind when the discards finish in time', async () => {
    vi.useFakeTimers();

    await discardRestoredPinnedTabs(fakeRegistry([tab({ id: 1 })]), new Set());

    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a timer or call Firefox when nothing needs discarding', async () => {
    vi.useFakeTimers();

    await discardRestoredPinnedTabs(fakeRegistry([tab({ id: 1, active: true })]), new Set());

    expect(vi.getTimerCount()).toBe(0);
    expect(browser.tabs.discard).not.toHaveBeenCalled();
  });
});

describe('createStartupPinnedTabDiscard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubLiveTabs();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does nothing until runtime.onStartup has fired, as on a dev reload', async () => {
    const registry = fakeRegistry([tab({ id: 1 })]);
    const startup = createStartupPinnedTabDiscard(registry, () => []);

    await startup.run();

    expect(browser.tabs.discard).not.toHaveBeenCalled();
    expect(registry.snapshot()[0]?.discarded).toBeUndefined();
  });

  it('reports a browser start only after runtime.onStartup has fired', () => {
    const startup = createStartupPinnedTabDiscard(fakeRegistry([]), () => []);

    expect(startup.browserStarted()).toBe(false);
    startup.noteStartup();
    expect(startup.browserStarted()).toBe(true);
  });

  it('has discarded and recorded the pinned tabs by the time run resolves', async () => {
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 }), tab({ id: 3 })]);
    const startup = createStartupPinnedTabDiscard(registry, () => [3]);
    startup.noteStartup();

    await startup.run();

    // A boot that sends its first snapshot after run() resolves sends this.
    expect(registry.snapshot().map((t) => [t.id, t.discarded ?? false])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it('never rejects, so a failing pass cannot stop boot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const registry = fakeRegistry([tab({ id: 1 })]);
    registry.snapshot.mockImplementation(() => {
      throw new Error('registry unavailable');
    });
    const startup = createStartupPinnedTabDiscard(registry, () => []);
    startup.noteStartup();

    await expect(startup.run()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '[bento-tools] startup pinned tab discard failed:',
      expect.any(Error),
    );
  });
});
