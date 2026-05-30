import { describe, expect, it } from 'vitest';
import {
  addPanel,
  breakOutPanel,
  emptyLayout,
  fillChooser,
  getPanelLayoutStatus,
  getPanelRestoreLocation,
  getRootNodeIds,
  getVisiblePanelIds,
  migrateLegacyEntriesToPersistence,
  removePanel,
  reorderRootNodes,
  setGroupRatio,
  subdividePanel,
} from './PanelLayout';

describe('PanelLayout', () => {
  it('adds, inserts, removes, and reports root panels', () => {
    const layout = emptyLayout();
    expect(addPanel(layout, 1)).toBe(true);
    expect(addPanel(layout, 3)).toBe(true);
    expect(addPanel(layout, 1)).toBe(false);
    expect(getVisiblePanelIds(layout)).toEqual([1, 3]);

    expect(addPanel(layout, 2)).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([1, 3, 2]);
    expect(removePanel(layout, 3)).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([1, 2]);
    expect(getRootNodeIds(layout)).toEqual(['panel:1', 'panel:2']);
  });

  it('subdivides a root panel into a chooser and fills it with one panel', () => {
    const layout = emptyLayout();
    addPanel(layout, 10);

    expect(subdividePanel(layout, 10, { groupId: 'v1', chooserId: 'c1' })).toBe(true);
    expect(getPanelLayoutStatus(layout, 10)).toBe('chooser-owner');
    expect(fillChooser(layout, 'c1', 'single', [11], {})).toBe(true);

    expect(getVisiblePanelIds(layout)).toEqual([10, 11]);
    expect(getPanelLayoutStatus(layout, 10)).toBe('subdivision-top');
    expect(getPanelLayoutStatus(layout, 11)).toBe('subdivision-bottom');
  });

  it('fills a chooser with a horizontal split and derives split-child status', () => {
    const layout = emptyLayout();
    addPanel(layout, 20);
    subdividePanel(layout, 20, { groupId: 'v2', chooserId: 'c2' });

    expect(fillChooser(layout, 'c2', 'dual', [21, 22], { horizontalGroupId: 'h2' })).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([20, 21, 22]);
    expect(getPanelLayoutStatus(layout, 21)).toBe('split-child');
    expect(getPanelLayoutStatus(layout, 22)).toBe('split-child');

    expect(setGroupRatio(layout, 'h2', 0.9)).toBe(true);
    expect(
      layout.root[0]?.kind === 'group' && layout.root[0].children[1].kind === 'group'
        ? layout.root[0].children[1].ratio
        : null,
    ).toBe(0.8);
  });

  it('promotes a single bottom panel when the top panel is removed', () => {
    const layout = emptyLayout();
    addPanel(layout, 30);
    subdividePanel(layout, 30, { groupId: 'v3', chooserId: 'c3' });
    fillChooser(layout, 'c3', 'single', [31], {});

    expect(removePanel(layout, 30)).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([31]);
    expect(getPanelLayoutStatus(layout, 31)).toBe('root-panel');
  });

  it('flattens horizontal split children when the top panel is removed', () => {
    const layout = emptyLayout();
    addPanel(layout, 40);
    addPanel(layout, 50);
    subdividePanel(layout, 40, { groupId: 'v4', chooserId: 'c4' });
    fillChooser(layout, 'c4', 'dual', [41, 42], { horizontalGroupId: 'h4' });

    expect(removePanel(layout, 40)).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([41, 42, 50]);
    expect(getRootNodeIds(layout)).toEqual(['panel:41', 'panel:42', 'panel:50']);
  });

  it('rejects malformed root reorder payloads', () => {
    const layout = emptyLayout();
    addPanel(layout, 60);
    addPanel(layout, 70);
    subdividePanel(layout, 60, { groupId: 'v5', chooserId: 'c5' });

    expect(getRootNodeIds(layout)).toEqual(['v5', 'panel:70']);
    expect(reorderRootNodes(layout, ['panel:60', 'panel:70'])).toBe(false);
    expect(reorderRootNodes(layout, ['v5', 'v5'])).toBe(false);
    expect(reorderRootNodes(layout, ['panel:70', 'v5'])).toBe(true);
    expect(getRootNodeIds(layout)).toEqual(['panel:70', 'v5']);
  });

  it('distinguishes visible leaves from root-slot restore locations', () => {
    const layout = emptyLayout();
    addPanel(layout, 80);
    addPanel(layout, 90);
    subdividePanel(layout, 80, { groupId: 'v6', chooserId: 'c6' });
    fillChooser(layout, 'c6', 'dual', [81, 82], { horizontalGroupId: 'h6' });

    expect(getVisiblePanelIds(layout)).toEqual([80, 81, 82, 90]);
    expect(getRootNodeIds(layout)).toEqual(['v6', 'panel:90']);
    expect(getPanelRestoreLocation(layout, 'ws', 82)).toEqual({
      workspaceId: 'ws',
      rootIndex: 0,
      containingRootNodeId: 'v6',
    });
  });

  it('breaks out a split child and normalizes the remaining layout', () => {
    const layout = emptyLayout();
    addPanel(layout, 100);
    addPanel(layout, 200);
    subdividePanel(layout, 100, { groupId: 'v7', chooserId: 'c7' });
    fillChooser(layout, 'c7', 'dual', [101, 102], { horizontalGroupId: 'h7' });

    expect(breakOutPanel(layout, 101)).toEqual({
      promotedTabId: 101,
      containingRootNodeId: 'v7',
    });
    expect(getVisiblePanelIds(layout)).toEqual([100, 102, 101, 200]);
    expect(getPanelLayoutStatus(layout, 102)).toBe('subdivision-bottom');
    expect(getPanelLayoutStatus(layout, 101)).toBe('root-panel');
  });

  it('migrates legacy duplicate URLs and top-closed subdivisions', () => {
    const migrated = migrateLegacyEntriesToPersistence(
      [
        { url: 'https://example.test/a', widthPx: 500 },
        {
          url: 'https://example.test/a',
          widthPx: 600,
          subdivision: {
            mode: 'dual',
            topHeightFraction: 0,
            subPanelUrls: ['https://example.test/b', 'https://example.test/b'],
            splitRatio: 0.4,
          },
        },
      ],
      'ws',
    );

    expect(migrated.entries.map((entry) => entry.url)).toEqual([
      'https://example.test/a',
      'https://example.test/b',
      'https://example.test/b',
    ]);
    expect(new Set(migrated.entries.map((entry) => entry.panelKey)).size).toBe(3);
    expect(migrated.layout.root).toEqual([
      { kind: 'panel', panelKey: 'ws-panel-0' },
      { kind: 'panel', panelKey: 'ws-panel-1' },
      { kind: 'panel', panelKey: 'ws-panel-2' },
    ]);
  });
});
