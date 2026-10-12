import type { TabSnapshot } from '@shared/protocol';
import { describe, expect, it } from 'vitest';
import { livePanelIds, panelToPromoteAfterDetach } from './PanelPromotion';

function tab(id: number, overrides: Partial<TabSnapshot> = {}): TabSnapshot {
  return {
    id,
    windowId: 1,
    index: id,
    title: '',
    pinned: false,
    active: false,
    audible: false,
    muted: false,
    workspaceId: 'ws-a',
    ...overrides,
  } as TabSnapshot;
}

const never = () => false;

describe('livePanelIds', () => {
  it('drops panels whose tab is closing or gone, keeping panel order', () => {
    const tabs = [tab(2), tab(3), tab(4)];
    expect(livePanelIds([2, 3, 4, 9], tabs, (id) => id === 3)).toEqual([2, 4]);
  });
});

describe('panelToPromoteAfterDetach', () => {
  const base = { workspaceId: 'ws-a', leavingTabId: 1, windowId: 1, isClosing: never };

  it('promotes the leftmost live panel when the workspace lost its last sidebar tab', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(panelToPromoteAfterDetach({ ...base, tabs, panelTabIds: [2, 3] })).toBe(2);
  });

  it('skips a closing panel instead of promoting it', () => {
    const tabs = [tab(1), tab(2), tab(3)];
    expect(
      panelToPromoteAfterDetach({
        ...base,
        tabs,
        panelTabIds: [2, 3],
        isClosing: (id) => id === 2,
      }),
    ).toBe(3);
  });

  it('promotes nothing when another sidebar tab of the workspace stays in the window', () => {
    const tabs = [tab(1), tab(2), tab(4)];
    expect(panelToPromoteAfterDetach({ ...base, tabs, panelTabIds: [2] })).toBeNull();
  });

  it('ignores sidebar tabs that are closing, in other windows, or in other workspaces', () => {
    const tabs = [tab(1), tab(2), tab(4, { windowId: 2 }), tab(5, { workspaceId: 'ws-b' }), tab(6)];
    expect(
      panelToPromoteAfterDetach({
        ...base,
        tabs,
        panelTabIds: [2],
        isClosing: (id) => id === 6,
      }),
    ).toBe(2);
  });

  it('promotes nothing without a live panel', () => {
    expect(panelToPromoteAfterDetach({ ...base, tabs: [tab(1)], panelTabIds: [] })).toBeNull();
    expect(
      panelToPromoteAfterDetach({
        ...base,
        tabs: [tab(1), tab(2)],
        panelTabIds: [2],
        isClosing: (id) => id === 2,
      }),
    ).toBeNull();
  });
});
