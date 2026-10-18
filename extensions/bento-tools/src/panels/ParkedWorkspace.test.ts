import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowClosingTabSnapshot } from '../tabs/TabRegistry';
import { PanelStore } from './PanelStore';
import type { TabSnapshot } from '@shared/protocol';
import {
  hasPanelsInOtherWindow,
  parkableWorkspaceTabs,
  parkedWorkspacesToDiscard,
  planParkedRestore,
  planWorkspaceParking,
  type ParkedWorkspaceTab,
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

describe('planParkedRestore', () => {
  const entry = (index: number, url: string, pinned = false): ParkedWorkspaceTab => ({
    url,
    title: '',
    pinned,
    index,
  });

  it('selects the first entry of a workspace that has no live tab', () => {
    const steps = planParkedRestore([entry(0, 'https://a/'), entry(1, 'https://b/')], new Map(), 0);

    expect(steps.map((step) => [step.entry.url, step.existingTabId, step.active])).toEqual([
      ['https://a/', null, true],
      ['https://b/', null, false],
    ]);
  });

  it('does not let a parked New Tab take the selection from live tabs a handover left', () => {
    // The live tabs are pages handed over from a closed window; the New Tab was parked with it.
    const steps = planParkedRestore(
      [entry(0, 'about:newtab'), entry(1, 'https://kept/')],
      new Map([[7, 'https://handed-over/']]),
      2,
    );

    expect(steps.every((step) => !step.active)).toBe(true);
    expect(steps.map((step) => step.existingTabId)).toEqual([null, null]);
  });

  it('still selects the first entry when a live tab already shows its address', () => {
    const steps = planParkedRestore(
      [entry(0, 'https://a/'), entry(1, 'https://b/')],
      new Map([
        [7, 'https://a/'],
        [8, 'https://other/'],
      ]),
      2,
    );

    expect(steps.map((step) => [step.existingTabId, step.active])).toEqual([
      [7, true],
      [null, false],
    ]);
  });

  it('pairs each live tab with one entry, in order', () => {
    const steps = planParkedRestore(
      [entry(0, 'https://a/'), entry(1, 'https://a/', true), entry(2, 'https://a/')],
      new Map([
        [7, 'https://a/'],
        [8, 'https://a/'],
      ]),
      2,
    );

    expect(steps.map((step) => step.existingTabId)).toEqual([7, 8, null]);
  });
});

describe('parkedWorkspacesToDiscard', () => {
  const parkedList = (url: string): ParkedWorkspaceTab[] => [
    { url, title: '', pinned: false, index: 0 },
  ];
  const parked = new Map([
    ['shown', parkedList('https://shown/')],
    ['hidden', parkedList('https://hidden/')],
    ['closed', parkedList('https://closed/')],
  ]);
  /** A tab in a workspace; like a restored one that is still loading, it has no address. */
  const tabOf = (id: number, windowId: number, workspaceId: string): TabSnapshot => ({
    ...liveTab(id, windowId),
    workspaceId,
  });

  /** What startup replays: the lists left after the discard, planned against the live tabs. */
  function replayedAtStartup(liveTabs: TabSnapshot[], restoredWindowIds: Set<number>) {
    const discarded = new Set(
      parkedWorkspacesToDiscard(parked.keys(), liveTabs, restoredWindowIds, true),
    );
    return [...parked]
      .filter(([workspaceId]) => !discarded.has(workspaceId))
      .map(([workspaceId, entries]) => ({
        workspaceId,
        steps: planParkedRestore(
          entries,
          new Map(),
          liveTabs.filter((tab) => tab.workspaceId === workspaceId).length,
        ),
      }));
  }

  it('drops the list of every workspace that has tabs in a restored window, shown or not', () => {
    const liveTabs = [tabOf(1, 1, 'shown'), tabOf(2, 1, 'hidden')];

    expect(parkedWorkspacesToDiscard(parked.keys(), liveTabs, new Set([1]), true)).toEqual([
      'shown',
      'hidden',
    ]);
  });

  it('replays nothing for a restored workspace, even when its tab reports no address', () => {
    // Matching by address misses a restored tab that is still loading, so the old replay opened
    // its entry again beside it.
    const [step] = planParkedRestore(parkedList('https://shown/'), new Map(), 1);
    expect(step?.existingTabId).toBeNull();

    const replayed = replayedAtStartup([tabOf(1, 1, 'shown')], new Set([1]));

    expect(replayed.map((plan) => plan.workspaceId)).not.toContain('shown');
  });

  it('keeps the list of a workspace without restored tabs, and replays it as before', () => {
    const [plan] = replayedAtStartup([tabOf(1, 1, 'shown'), tabOf(2, 1, 'hidden')], new Set([1]));

    expect(plan?.workspaceId).toBe('closed');
    expect(plan?.steps.map((step) => [step.entry.url, step.existingTabId, step.active])).toEqual([
      ['https://closed/', null, true],
    ]);
  });

  it('keeps a list when bento-tools reloads under a running browser, even with a surviving window', () => {
    // Window A closed, handed the tabs it could move to window B and parked the one that could not
    // (a New Tab it held). bento-tools then reloads while B is open: B counts as restored, but
    // the list is the only record of the tab that stayed behind.
    const liveTabs = [tabOf(1, 2, 'shown')];
    const stranded = parked.get('shown')!;

    expect(parkedWorkspacesToDiscard(parked.keys(), liveTabs, new Set([2]), false)).toEqual([]);
    expect(
      planParkedRestore(stranded, new Map(), liveTabs.length).map((step) => step.entry.url),
    ).toEqual(['https://shown/']);
  });

  it('still drops the same list on a real browser start', () => {
    const liveTabs = [tabOf(1, 2, 'shown')];

    expect(parkedWorkspacesToDiscard(parked.keys(), liveTabs, new Set([2]), true)).toEqual([
      'shown',
    ]);
  });

  it('ignores a tab in a window that did not come back from the session', () => {
    // A fresh start opens its own window; its blank tab may already belong to a workspace.
    const liveTabs = [tabOf(1, 1, 'shown'), tabOf(2, 2, 'closed')];

    expect(parkedWorkspacesToDiscard(parked.keys(), liveTabs, new Set([1]), true)).toEqual([
      'shown',
    ]);
  });
});
