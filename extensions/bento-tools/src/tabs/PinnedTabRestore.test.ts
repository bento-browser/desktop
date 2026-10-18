import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discardRestoredPinnedTabs, pinnedTabsToDiscard } from './PinnedTabRestore';

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
  const live: Record<number, Partial<browser.tabs.Tab>> = {};

  beforeEach(() => {
    vi.restoreAllMocks();
    for (const id of Object.keys(live)) delete live[Number(id)];
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn(async (id: number) => ({ id, pinned: true, active: false, ...live[id] })),
        discard: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('discards the selected tabs', async () => {
    await discardRestoredPinnedTabs([tab({ id: 1 }), tab({ id: 2 })], new Set());

    expect(browser.tabs.discard).toHaveBeenCalledTimes(2);
    expect(browser.tabs.discard).toHaveBeenNthCalledWith(1, 1);
    expect(browser.tabs.discard).toHaveBeenNthCalledWith(2, 2);
  });

  it('leaves a tab the user selected after the snapshot was taken', async () => {
    live[1] = { active: true };

    await discardRestoredPinnedTabs([tab({ id: 1 }), tab({ id: 2 })], new Set());

    expect(browser.tabs.discard).toHaveBeenCalledTimes(1);
    expect(browser.tabs.discard).toHaveBeenCalledWith(2);
  });

  it('logs a failed discard and carries on with the next tab', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(browser.tabs.discard).mockRejectedValueOnce(new Error('Invalid tab ID: 1'));

    await expect(
      discardRestoredPinnedTabs([tab({ id: 1 }), tab({ id: 2 })], new Set()),
    ).resolves.toBeUndefined();

    expect(browser.tabs.discard).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(
      '[bento-tools] pinned tab discard failed for tab',
      1,
      expect.any(Error),
    );
  });
});
