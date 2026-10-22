import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelStore } from './PanelStore';

function subdivisionIds(store: PanelStore): { groupId: string; chooserId: string } {
  const root = store.getPanelLayout('ws').root[0];
  if (
    !root ||
    root.kind !== 'group' ||
    root.axis !== 'vertical' ||
    root.children[1].kind !== 'chooser'
  ) {
    throw new Error('Expected a vertical subdivision with a chooser');
  }
  return { groupId: root.id, chooserId: root.children[1].id };
}

describe('PanelStore headerHidden', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: `https://${tabId}.example.test/`,
        })),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes and removes headerHidden in panel persistence snapshots', async () => {
    const store = new PanelStore();
    store.add('ws', 1);

    store.setHeaderHidden(1, true);
    await expect(
      store.buildPanelPersistenceSnapshot('ws', async () => 'https://a.test/'),
    ).resolves.toMatchObject({
      entries: [{ panelKey: 'panel-0', tabId: 1, url: 'https://a.test/', headerHidden: true }],
    });

    store.setHeaderHidden(1, false);
    await expect(
      store.buildPanelPersistenceSnapshot('ws', async () => 'https://a.test/'),
    ).resolves.toMatchObject({
      entries: [{ panelKey: 'panel-0', tabId: 1, url: 'https://a.test/' }],
    });
  });

  it('clears headerHidden when a panel is removed', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.setHeaderHidden(1, true);

    expect(store.remove('ws', 1)).toBe(true);

    expect(store.getHeaderHidden(1)).toBe(false);
  });

  it('clears headerHidden when a panel and its sub-panels are removed', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.subdivide('ws', 1);
    store.fillChooser('ws', subdivisionIds(store).chooserId, 'single', [2]);
    store.setHeaderHidden(1, true);
    store.setHeaderHidden(2, true);

    expect(store.removeWithSubPanels('ws', 1)).toEqual([2]);

    expect(store.getHeaderHidden(1)).toBe(false);
    expect(store.getHeaderHidden(2)).toBe(false);
  });

  it('clears headerHidden when a workspace is removed', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.setHeaderHidden(1, true);

    expect(store.removeWorkspace('ws')).toEqual([1]);

    expect(store.getHeaderHidden(1)).toBe(false);
  });

  it('clears headerHidden when a vertical group is removed', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.subdivide('ws', 1);
    const ids = subdivisionIds(store);
    store.fillChooser('ws', ids.chooserId, 'single', [2]);
    store.setHeaderHidden(2, true);

    expect(store.removeVerticalGroup('ws', ids.groupId)).toEqual([2]);

    expect(store.getHeaderHidden(2)).toBe(false);
  });
});

describe('PanelStore group ratio', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function twoSubdivisions() {
    const store = new PanelStore();
    store.add('ws-a', 1);
    store.subdivide('ws-a', 1);
    store.add('ws-b', 2);
    store.subdivide('ws-b', 2);
    const ratio = (workspaceId: string) => {
      const root = store.getPanelLayout(workspaceId).root[0];
      if (!root || root.kind !== 'group') throw new Error('Expected a subdivision');
      return { id: root.id, ratio: root.ratio };
    };
    return { store, ratio };
  }

  it('sets only the named workspace', () => {
    const { store, ratio } = twoSubdivisions();
    const other = ratio('ws-b');

    store.setGroupRatioIn('ws-b', ratio('ws-a').id, 0.8);
    expect(ratio('ws-a').ratio).not.toBe(0.8);

    store.setGroupRatioIn('ws-a', ratio('ws-a').id, 0.8);
    expect(ratio('ws-a').ratio).toBe(0.8);
    expect(ratio('ws-b')).toEqual(other);
  });

  // The archived rollback source calls it with this shape and has no private windows.
  it('keeps the two-argument call of the archived rollback source searching every workspace', () => {
    const { store, ratio } = twoSubdivisions();

    store.setGroupRatio(ratio('ws-b').id, 0.2);

    expect(ratio('ws-b').ratio).toBe(0.2);
  });
});

describe('PanelStore devtools panels', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('inserts devtools panels adjacent to callers and normalizes after reorder', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.add('ws', 2);

    expect(store.addDevtoolsPanel('ws', 99, 1, 1)).toBe(true);
    expect(store.getVisiblePanelIds('ws')).toEqual([1, 99, 2]);

    expect(store.reorderRootNodes('ws', ['panel:2', 'panel:99', 'panel:1'])).toBe(true);
    expect(store.getVisiblePanelIds('ws')).toEqual([2, 99, 1]);
  });

  it('rejects non-root moves and layout mutations for devtools panels', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.subdivide('ws', 1);
    const ids = subdivisionIds(store);
    store.fillChooser('ws', ids.chooserId, 'single', [2]);
    store.addDevtoolsPanel('ws', 99, 2, 2);

    expect(store.movePanel('ws', 99, { type: 'chooser', chooserId: ids.chooserId })).toBe(false);
    expect(store.subdivide('ws', 99)).toBe(false);
    expect(store.splitTopPanel('ws', 99, 100)).toBe(false);
    expect(store.splitBottomPanel('ws', 99, 100)).toBe(false);
  });

  it('excludes devtools panels from persistence snapshots', async () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.addDevtoolsPanel('ws', 99, 1, 1);

    await expect(
      store.buildPanelPersistenceSnapshot('ws', async (tabId) => `https://${tabId}.test/`),
    ).resolves.toMatchObject({
      entries: [{ panelKey: 'panel-0', tabId: 1, url: 'https://1.test/' }],
      layout: { root: [{ kind: 'panel', panelKey: 'panel-0' }] },
    });
  });

  it('returns orphaned devtools tabs once when a caller is removed', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.addDevtoolsPanel('ws', 99, 1, 1);

    expect(store.removeWithSubPanels('ws', 1)).toEqual([]);
    expect(store.takeOrphanedDevtoolsTabs('ws')).toEqual(new Set([99]));
    expect(store.takeOrphanedDevtoolsTabs('ws')).toEqual(new Set());
  });

  it('tracks main devtools links independently by inspected tab', () => {
    const store = new PanelStore();

    expect(store.addDevtoolsPanel('ws', 99, null, 10)).toBe(true);
    expect(store.findMainDevtoolsLink('ws')).toEqual({
      devtoolsTabId: 99,
      callerTabId: null,
      inspectedTabId: 10,
    });
    expect(store.findDevtoolsLink('ws', null, 10)?.devtoolsTabId).toBe(99);
    expect(store.findDevtoolsLink('ws', null, 11)).toBeUndefined();
  });
});

describe('PanelStore persistence triggers', () => {
  const set = vi.fn<(payload: Record<string, unknown>) => Promise<void>>(async () => undefined);

  beforeEach(() => {
    vi.useFakeTimers();
    set.mockClear();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set,
          remove: vi.fn(async () => undefined),
        },
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: `https://${tabId}.example.test/`,
        })),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('coalesces a burst of URL-change persists into one trailing write', async () => {
    const store = new PanelStore();
    store.add('ws', 1);
    await store.persistCurrentState();
    set.mockClear();

    for (let i = 0; i < 20; i++) {
      store.schedulePersistCurrentState();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(set).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('drops a removed workspace strip scroll from storage', async () => {
    const store = new PanelStore();
    store.setStripScroll('ws', 120);
    await vi.advanceTimersByTimeAsync(500);
    expect(set).toHaveBeenLastCalledWith(
      expect.objectContaining({ 'bento.panelStripScroll': { ws: 120 } }),
    );

    store.removeWorkspace('ws');
    await vi.advanceTimersByTimeAsync(500);

    expect(set).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ 'bento.panelStripScroll': expect.anything() }),
    );
  });
});

describe('PanelStore restorePersistedLayout', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
          remove: vi.fn(async () => undefined),
        },
      },
      tabs: { get: vi.fn(async (tabId: number) => ({ id: tabId, url: `https://${tabId}/` })) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('places each bound key in the persisted order', () => {
    const store = new PanelStore();
    store.add('ws', 7);
    store.add('ws', 4);

    store.restorePersistedLayout(
      'ws',
      {
        root: [
          { kind: 'panel', panelKey: 'panel-0' },
          { kind: 'panel', panelKey: 'panel-1' },
        ],
      },
      new Map([
        ['panel-0', 4],
        ['panel-1', 7],
      ]),
    );

    expect(store.getPanels('ws')).toEqual([4, 7]);
  });

  it('keeps a live panel no key claims at the end of the strip, not in the sidebar', () => {
    const store = new PanelStore();
    store.add('ws', 1);
    store.add('ws', 2);

    store.restorePersistedLayout(
      'ws',
      { root: [{ kind: 'panel', panelKey: 'panel-0' }] },
      new Map([['panel-0', 2]]),
    );

    expect(store.getPanels('ws')).toEqual([2, 1]);
  });
});
