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
  movePanel,
  removePanel,
  removeVerticalGroup,
  reorderRootNodes,
  setGroupRatio,
  splitBottomPanel,
  splitTopPanel,
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

  it('re-splits a bottom survivor after one split child is removed', () => {
    const layout = emptyLayout();
    addPanel(layout, 23);
    subdividePanel(layout, 23, { groupId: 'v23', chooserId: 'c23' });
    fillChooser(layout, 'c23', 'dual', [24, 25], { horizontalGroupId: 'h23-a' });

    expect(removePanel(layout, 25)).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([23, 24]);
    expect(getPanelLayoutStatus(layout, 24)).toBe('subdivision-bottom');

    expect(splitBottomPanel(layout, 24, 26, { horizontalGroupId: 'h23-b' })).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([23, 24, 26]);
    expect(getPanelLayoutStatus(layout, 24)).toBe('split-child');
    expect(getPanelLayoutStatus(layout, 26)).toBe('split-child');
    expect(getRootNodeIds(layout)).toEqual(['v23']);
  });

  it('splits the top of a vertical group so top and bottom can form a 2x2 grid', () => {
    const layout = emptyLayout();
    addPanel(layout, 25);
    subdividePanel(layout, 25, { groupId: 'v25', chooserId: 'c25' });

    expect(splitTopPanel(layout, 25, 26, { horizontalGroupId: 'h25-top' })).toBe(true);
    expect(fillChooser(layout, 'c25', 'dual', [27, 28], { horizontalGroupId: 'h25-bottom' })).toBe(
      true,
    );

    expect(getVisiblePanelIds(layout)).toEqual([25, 26, 27, 28]);
    expect(getPanelLayoutStatus(layout, 25)).toBe('split-child');
    expect(getPanelLayoutStatus(layout, 26)).toBe('split-child');
    expect(getPanelLayoutStatus(layout, 27)).toBe('split-child');
    expect(getPanelLayoutStatus(layout, 28)).toBe('split-child');

    expect(setGroupRatio(layout, 'h25-top', 0.65)).toBe(true);
    expect(setGroupRatio(layout, 'h25-bottom', 0.35)).toBe(true);
    expect(getRootNodeIds(layout)).toEqual(['v25']);
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

  it('keeps top split children when removing a vertical group', () => {
    const layout = emptyLayout();
    addPanel(layout, 45);
    subdividePanel(layout, 45, { groupId: 'v45', chooserId: 'c45' });
    splitTopPanel(layout, 45, 46, { horizontalGroupId: 'h45-top' });
    fillChooser(layout, 'c45', 'dual', [47, 48], { horizontalGroupId: 'h45-bottom' });

    expect(removeVerticalGroup(layout, 'v45')).toEqual([47, 48]);
    expect(getVisiblePanelIds(layout)).toEqual([45, 46]);
    expect(getRootNodeIds(layout)).toEqual(['panel:45', 'panel:46']);
  });

  it('removes an unfilled subdivision chooser and promotes the top panel', () => {
    const layout = emptyLayout();
    addPanel(layout, 49);
    subdividePanel(layout, 49, { groupId: 'v49', chooserId: 'c49' });

    expect(removeVerticalGroup(layout, 'v49')).toEqual([]);
    expect(getVisiblePanelIds(layout)).toEqual([49]);
    expect(getPanelLayoutStatus(layout, 49)).toBe('root-panel');
    expect(getRootNodeIds(layout)).toEqual(['panel:49']);
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

  it('moves a split child out to a root slot and normalizes the source row', () => {
    const layout = emptyLayout();
    addPanel(layout, 110);
    addPanel(layout, 120);
    subdividePanel(layout, 110, { groupId: 'v110', chooserId: 'c110' });
    fillChooser(layout, 'c110', 'dual', [111, 112], { horizontalGroupId: 'h110' });

    expect(movePanel(layout, 111, { type: 'root', index: 2 })).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([110, 112, 120, 111]);
    expect(getPanelLayoutStatus(layout, 112)).toBe('subdivision-bottom');
    expect(getPanelLayoutStatus(layout, 111)).toBe('root-panel');
  });

  it('moves a root panel into an eligible one-panel subdivision row', () => {
    const layout = emptyLayout();
    addPanel(layout, 130);
    addPanel(layout, 140);
    subdividePanel(layout, 130, { groupId: 'v130', chooserId: 'c130' });
    fillChooser(layout, 'c130', 'single', [131], {});

    expect(
      movePanel(
        layout,
        140,
        { type: 'horizontal', groupId: 'v130', row: 'bottom', position: 'after' },
        {
          horizontalGroupId: 'h130',
        },
      ),
    ).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([130, 131, 140]);
    expect(getPanelLayoutStatus(layout, 131)).toBe('split-child');
    expect(getPanelLayoutStatus(layout, 140)).toBe('split-child');
    expect(getRootNodeIds(layout)).toEqual(['v130']);
  });

  it('moves an existing panel into an unfilled subdivision chooser', () => {
    const layout = emptyLayout();
    addPanel(layout, 170);
    addPanel(layout, 180);
    subdividePanel(layout, 170, { groupId: 'v170', chooserId: 'c170' });

    expect(movePanel(layout, 180, { type: 'chooser', chooserId: 'c170' })).toBe(true);
    expect(getVisiblePanelIds(layout)).toEqual([170, 180]);
    expect(getPanelLayoutStatus(layout, 170)).toBe('subdivision-top');
    expect(getPanelLayoutStatus(layout, 180)).toBe('subdivision-bottom');
    expect(getRootNodeIds(layout)).toEqual(['v170']);
  });

  it('rejects moving a chooser owner into its own unfilled subdivision chooser', () => {
    const layout = emptyLayout();
    addPanel(layout, 190);
    subdividePanel(layout, 190, { groupId: 'v190', chooserId: 'c190' });

    expect(movePanel(layout, 190, { type: 'chooser', chooserId: 'c190' })).toBe(false);
    expect(getVisiblePanelIds(layout)).toEqual([190]);
    expect(getPanelLayoutStatus(layout, 190)).toBe('chooser-owner');
    expect(getRootNodeIds(layout)).toEqual(['v190']);
  });

  it('rejects moving into a subdivision row that already has two panels', () => {
    const layout = emptyLayout();
    addPanel(layout, 150);
    addPanel(layout, 160);
    subdividePanel(layout, 150, { groupId: 'v150', chooserId: 'c150' });
    fillChooser(layout, 'c150', 'dual', [151, 152], { horizontalGroupId: 'h150' });

    expect(
      movePanel(
        layout,
        160,
        { type: 'horizontal', groupId: 'v150', row: 'bottom', position: 'after' },
        {
          horizontalGroupId: 'h151',
        },
      ),
    ).toBe(false);
    expect(getVisiblePanelIds(layout)).toEqual([150, 151, 152, 160]);
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
