import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PINNED_DISCARD_WAIT_MS,
  createStartupPinnedTabDiscard,
  discardRestoredPinnedTabs,
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

  it('picks nothing when Firefox already reports every pinned tab as discarded', () => {
    expect(pinnedTabsToDiscard([tab({ id: 1, discarded: true })], new Set())).toEqual([]);
  });
});

describe('discardRestoredPinnedTabs', () => {
  /** What `tabs.get` reports once `tabs.discard` has run, per tab id. */
  const discardedAfter: Record<number, boolean> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    for (const id of Object.keys(discardedAfter)) delete discardedAfter[Number(id)];
    vi.stubGlobal('browser', {
      tabs: {
        discard: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (id: number) => ({ id, discarded: discardedAfter[id] ?? true })),
      },
    });
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
      () => new Promise<void>((resolve) => finish.push(resolve)),
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
    discardedAfter[1] = false;
    const registry = fakeRegistry([tab({ id: 1 }), tab({ id: 2 })]);

    await discardRestoredPinnedTabs(registry, new Set());

    expect(registry.markDiscarded.mock.calls).toEqual([[2]]);
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
      () => new Promise<void>((resolve) => (finish = resolve)),
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
    vi.stubGlobal('browser', {
      tabs: {
        discard: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (id: number) => ({ id, discarded: true })),
      },
    });
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
