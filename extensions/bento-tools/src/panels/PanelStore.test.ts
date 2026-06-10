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
