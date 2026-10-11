import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowClosingTabSnapshot } from '../tabs/TabRegistry';
import { PanelStore } from './PanelStore';
import { parkableWorkspaceTabs } from './ParkedWorkspace';

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
