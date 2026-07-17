import { describe, expect, it } from 'vitest';
import type { TabFolder, TabSnapshot } from '@shared/protocol';
import {
  buildDisplayRows,
  displayRowsLayoutKey,
  flattenTabOrder,
  pruneSelection,
} from './displayRows';

function tab(partial: Partial<TabSnapshot> & Pick<TabSnapshot, 'id' | 'index'>): TabSnapshot {
  return {
    windowId: 1,
    title: `Tab ${partial.id}`,
    active: false,
    pinned: false,
    audible: false,
    muted: false,
    workspaceId: 'ws-1',
    ...partial,
  };
}

function folder(partial: Partial<TabFolder> & Pick<TabFolder, 'id' | 'order'>): TabFolder {
  return {
    workspaceId: 'ws-1',
    name: partial.id,
    collapsed: false,
    createdAt: partial.order,
    ...partial,
  };
}

describe('buildDisplayRows', () => {
  it('places pinned tabs, folders, action rows, then regular tabs', () => {
    const tabs = {
      1: tab({ id: 1, index: 0, pinned: true }),
      2: tab({ id: 2, index: 1, folderId: 'f-2' }),
      3: tab({ id: 3, index: 2 }),
      4: tab({ id: 4, index: 3, folderId: 'f-1' }),
    };
    const rows = buildDisplayRows(
      [1, 2, 3, 4],
      tabs,
      [folder({ id: 'f-1', order: 0 }), folder({ id: 'f-2', order: 1 })],
      null,
      {},
    );
    expect(rows).toEqual([
      { kind: 'tab', id: 1, indent: false },
      { kind: 'folder', folderId: 'f-1' },
      { kind: 'tab', id: 4, indent: true },
      { kind: 'folder', folderId: 'f-2' },
      { kind: 'tab', id: 2, indent: true },
      { kind: 'new-tab', afterPinnedSection: true },
      { kind: 'tab', id: 3, indent: false },
    ]);
  });

  it('shows only the active member as a peek under a collapsed folder', () => {
    const tabs = {
      1: tab({ id: 1, index: 0, folderId: 'f-1' }),
      2: tab({ id: 2, index: 1, folderId: 'f-1' }),
    };
    const rows = buildDisplayRows(
      [1, 2],
      tabs,
      [folder({ id: 'f-1', order: 0, collapsed: true })],
      2,
      {},
    );
    expect(rows).toEqual([
      { kind: 'folder', folderId: 'f-1' },
      { kind: 'peek', id: 2, folderId: 'f-1' },
      { kind: 'new-tab', afterPinnedSection: true },
    ]);
  });

  it('renders stale or pinned folder members in their defensive regions', () => {
    const tabs = {
      1: tab({ id: 1, index: 0, pinned: true, folderId: 'f-1' }),
      2: tab({ id: 2, index: 1, folderId: 'missing' }),
    };
    expect(buildDisplayRows([1, 2], tabs, [folder({ id: 'f-1', order: 0 })], null, {})).toEqual([
      { kind: 'tab', id: 1, indent: false },
      { kind: 'folder', folderId: 'f-1' },
      { kind: 'new-tab', afterPinnedSection: true },
      { kind: 'tab', id: 2, indent: false },
    ]);
  });

  it('flattens visible tab order and prunes hidden selections', () => {
    const rows = [
      { kind: 'tab' as const, id: 1, indent: false },
      { kind: 'folder' as const, folderId: 'f-1' },
      { kind: 'peek' as const, id: 3, folderId: 'f-1' },
      { kind: 'new-tab' as const, afterPinnedSection: true },
      { kind: 'tab' as const, id: 4, indent: false },
    ];
    expect(flattenTabOrder(rows)).toEqual([1, 3, 4]);
    expect(Array.from(pruneSelection(new Set([2, 3, 4]), flattenTabOrder(rows)))).toEqual([3, 4]);
  });

  it('keeps the layout key stable across sleeping-tab wake metadata updates', () => {
    const sleepingTabs = {
      1: tab({ id: 1, index: 0, active: true }),
      2: tab({ id: 2, index: 1, discarded: true }),
    };
    const wakingTabs = {
      ...sleepingTabs,
      2: tab({ id: 2, index: 1, discarded: false, loading: true, title: 'Loading page' }),
    };

    const sleepingRows = buildDisplayRows([1, 2], sleepingTabs, [], 1, {});
    const wakingRows = buildDisplayRows([1, 2], wakingTabs, [], 1, {});

    expect(displayRowsLayoutKey(wakingRows)).toBe(displayRowsLayoutKey(sleepingRows));
    expect(
      displayRowsLayoutKey(
        buildDisplayRows(
          [1, 2],
          { ...wakingTabs, 2: { ...wakingTabs[2], pinned: true } },
          [],
          1,
          {},
        ),
      ),
    ).not.toBe(displayRowsLayoutKey(sleepingRows));
  });
});
