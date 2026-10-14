import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowClosingTabSnapshot } from '../tabs/TabRegistry';
import { PanelStore } from './PanelStore';
import type { TabSnapshot } from '@shared/protocol';
import {
  hasPanelsInOtherWindow,
  parkableWorkspaceTabs,
  planWorkspaceParking,
} from './ParkedWorkspace';

function closingTab(
  id: number,
  url: string,
  extra: Partial<WindowClosingTabSnapshot> = {},
): WindowClosingTabSnapshot {
  return {
    id,
    windowId: 1,
    index: id,
    title: `title of ${url}`,
    url,
    pinned: false,
    active: false,
    audible: false,
    muted: false,
    workspaceId: 'ws',
    ...extra,
  };
}

describe('parkableWorkspaceTabs', () => {
  const storage: Record<string, unknown> = {};

  beforeEach(() => {
    for (const key of Object.keys(storage)) delete storage[key];
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async (payload: Record<string, unknown>) => {
            Object.assign(storage, payload);
          }),
          remove: vi.fn(async () => undefined),
        },
      },
      tabs: { get: vi.fn(async () => Promise.reject(new Error('tab gone'))) },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const tabsInWindow = [
    closingTab(1, 'https://regular-sidebar.example.test/'),
    closingTab(2, 'https://private-sidebar.example.test/', { customTitle: 'private custom title' }),
    closingTab(3, 'https://regular-panel.example.test/'),
    closingTab(4, 'https://private-panel.example.test/'),
  ];
  const isPrivate = (id: number) => id === 2 || id === 4;

  it('keeps private tabs out of the parked URLs and sidebar tabs', () => {
    const { urlByTabId, sidebarTabs } = parkableWorkspaceTabs(
      tabsInWindow,
      new Set([3, 4]),
      isPrivate,
    );

    expect([...urlByTabId.keys()]).toEqual([1, 3]);
    expect(sidebarTabs.map((tab) => tab.url)).toEqual(['https://regular-sidebar.example.test/']);
  });

  it('parks a workspace without any private panel URL reaching storage', async () => {
    const store = new PanelStore();
    store.add('ws', 3);
    store.add('ws', 4);
    const { urlByTabId, sidebarTabs } = parkableWorkspaceTabs(
      tabsInWindow,
      new Set(store.getPanels('ws')),
      isPrivate,
    );

    store.parkWorkspaceWithResolvedUrls('ws', (tabId) => urlByTabId.get(tabId));
    await store.persistCurrentState();

    const written = JSON.stringify([storage, sidebarTabs]);
    expect(written).toContain('regular-panel.example.test');
    expect(written).not.toContain('private-');
    expect(written).not.toContain('private custom title');
    expect(store.peekAllPersistedEntries().get('ws')).toEqual([
      { panelKey: 'panel-0', url: 'https://regular-panel.example.test/' },
    ]);
  });

  it('parks nothing for a workspace whose tabs are all private', async () => {
    const store = new PanelStore();
    store.add('ws', 4);
    const { urlByTabId, sidebarTabs } = parkableWorkspaceTabs(
      [tabsInWindow[3]!],
      new Set([4]),
      isPrivate,
    );

    expect(store.parkWorkspaceWithResolvedUrls('ws', (tabId) => urlByTabId.get(tabId))).toBe(false);
    await store.persistCurrentState();

    expect(sidebarTabs).toEqual([]);
    expect(JSON.stringify(storage)).not.toContain('private-');
    expect(store.workspacesWithPersistedUrls()).toEqual([]);
  });
});

describe('blank pages', () => {
  it('about:blank is not parked as a sidebar tab, so the blank tab a handover leaves does not come back', () => {
    const tabs = [
      closingTab(1, 'https://kept.example.test/'),
      closingTab(2, 'about:blank'),
      closingTab(3, 'about:newtab'),
    ];

    const { sidebarTabs, urlByTabId } = parkableWorkspaceTabs(tabs, new Set(), () => false);

    // A New Tab page may be a pinned or renamed entry the user chose to keep: it stays.
    expect(sidebarTabs.map((tab) => tab.url)).toEqual([
      'https://kept.example.test/',
      'about:newtab',
    ]);
    expect(urlByTabId.get(2)).toBe('about:blank');
  });
});

function liveTab(id: number, windowId: number): TabSnapshot {
  return {
    id,
    windowId,
    index: id,
    title: '',
    pinned: false,
    active: false,
    audible: false,
    muted: false,
  } as TabSnapshot;
}

describe('hasPanelsInOtherWindow', () => {
  it('is true when a panel tab lives in another window', () => {
    expect(hasPanelsInOtherWindow(new Set([10, 11]), [liveTab(10, 2), liveTab(11, 1)], 2)).toBe(
      true,
    );
  });

  it('is false when every panel tab is still in the closing window, or there are none', () => {
    expect(hasPanelsInOtherWindow(new Set([10]), [liveTab(10, 2), liveTab(12, 1)], 2)).toBe(false);
    expect(hasPanelsInOtherWindow(new Set(), [liveTab(12, 1)], 2)).toBe(false);
  });
});

describe('planWorkspaceParking', () => {
  const baseArgs = { windowId: 2, isPrivate: () => false };

  it('parks the panel layout from the closing window as before when no panel moved', () => {
    const plan = planWorkspaceParking({
      ...baseArgs,
      workspaceTabs: [closingTab(10, 'https://panel.example.test/'), closingTab(1, 'https://a/')],
      panelTabIds: new Set([10]),
      tabsNow: [liveTab(10, 2), liveTab(1, 2)],
    });

    expect(plan.keepPanelLayout).toBe(false);
    expect(plan.sidebarTabs.map((tab) => tab.url)).toEqual(['https://a/']);
  });

  it('keeps the layout of panels that moved with the workspace, and parks a stranded panel as a sidebar tab', () => {
    // Panels 10 and 11 were handed over; 12 failed to move and is all that is left here.
    const plan = planWorkspaceParking({
      ...baseArgs,
      workspaceTabs: [closingTab(12, 'https://stranded.example.test/')],
      panelTabIds: new Set([10, 11, 12]),
      tabsNow: [liveTab(10, 1), liveTab(11, 1), liveTab(12, 2)],
    });

    expect(plan.keepPanelLayout).toBe(true);
    expect(plan.sidebarTabs.map((tab) => tab.url)).toEqual(['https://stranded.example.test/']);
  });
});
