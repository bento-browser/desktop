import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptableTabs,
  createAdoptionGate,
  createProgrammaticMoves,
  releaseAdoptedTab,
  tabsToAdopt,
  type AdoptedTabDeps,
} from './AdoptedTab';
import { TabRegistry } from './TabRegistry';

function tab(overrides: Partial<TabSnapshot> & { id: number }): TabSnapshot {
  return {
    windowId: 1,
    index: overrides.id,
    title: '',
    pinned: false,
    active: false,
    audible: false,
    muted: false,
    ...overrides,
  } as TabSnapshot;
}

function makeDeps(options: {
  tabs: TabSnapshot[];
  owner?: number | null;
  destinationWorkspaceId?: string | null;
  panelWorkspaceIds?: string[];
  movedFor?: string;
}): AdoptedTabDeps {
  return {
    moves: { take: vi.fn().mockReturnValue(options.movedFor) },
    tabs: {
      snapshot: vi.fn().mockReturnValue(options.tabs),
      clearWorkspace: vi.fn().mockResolvedValue(undefined),
      assignWorkspaceEagerly: vi.fn().mockResolvedValue(true),
    },
    workspaces: {
      findOwningWindow: vi.fn().mockReturnValue(options.owner ?? null),
      getActiveId: vi.fn().mockReturnValue(options.destinationWorkspaceId ?? null),
    },
    panels: {
      findWorkspacesContainingTab: vi.fn().mockReturnValue(options.panelWorkspaceIds ?? []),
      remove: vi.fn().mockReturnValue(true),
    },
    clearPanelMarker: vi.fn().mockResolvedValue(undefined),
    syncPanelMarkers: vi.fn(),
    emitPanelsSync: vi.fn(),
  };
}

describe('releaseAdoptedTab', () => {
  it('moves a tab torn out of another window into the destination workspace', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a', folderId: 'f' })],
      owner: 1,
      destinationWorkspaceId: 'ws-b',
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
    expect(deps.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(7, 'ws-b');
    expect(deps.panels.remove).not.toHaveBeenCalled();
  });

  it('drops a torn-out panel from its layout and refreshes the source workspace', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: 1,
      panelWorkspaceIds: ['ws-a'],
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.panels.remove).toHaveBeenCalledWith('ws-a', 7);
    expect(deps.clearPanelMarker).toHaveBeenCalledWith(7);
    expect(deps.syncPanelMarkers).toHaveBeenCalledWith('ws-a');
    expect(deps.emitPanelsSync).toHaveBeenCalledWith('ws-a');
    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
  });

  it('leaves the tab unassigned while the new window has no workspace yet', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: 1,
      destinationWorkspaceId: null,
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });

  it('keeps the workspace of a tab Bento moved to the window that shows it', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: 2,
      panelWorkspaceIds: ['ws-a'],
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.panels.remove).not.toHaveBeenCalled();
  });

  it('keeps the workspace of a tab Bento moved even if the window switched workspace meanwhile', async () => {
    // Window 2 activated ws-a (starting the move), then switched to ws-c before the attach.
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: null,
      destinationWorkspaceId: 'ws-c',
      panelWorkspaceIds: ['ws-a'],
      movedFor: 'ws-a',
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.moves.take).toHaveBeenCalledWith(7);
    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
    expect(deps.panels.remove).not.toHaveBeenCalled();
    expect(deps.clearPanelMarker).not.toHaveBeenCalled();
  });

  it('ignores a tab that has no workspace', async () => {
    const deps = makeDeps({ tabs: [tab({ id: 7, windowId: 2 })], destinationWorkspaceId: 'ws-b' });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });
});

describe('adoptableTabs', () => {
  const never = () => false;

  it('takes every tab of a window where no tab has a workspace', () => {
    const picked = adoptableTabs([tab({ id: 1 }), tab({ id: 2, active: true })], never, never);
    expect(picked.map((t) => t.id)).toEqual([1, 2]);
  });

  it('takes nothing once a tab in the window has a workspace', () => {
    expect(
      adoptableTabs([tab({ id: 1 }), tab({ id: 2, workspaceId: 'ws-a' })], never, never),
    ).toEqual([]);
  });

  it('skips closing and private tabs', () => {
    const picked = adoptableTabs(
      [tab({ id: 1, active: true }), tab({ id: 2 }), tab({ id: 3 })],
      (id) => id === 1,
      (id) => id === 2,
    );
    expect(picked.map((t) => t.id)).toEqual([3]);
  });
});

describe('createProgrammaticMoves', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('hands back the workspace once, then treats the next attach as a user move', () => {
    const moves = createProgrammaticMoves();
    moves.expect([7, 8], 'ws-a');

    expect(moves.take(7)).toBe('ws-a');
    expect(moves.take(7)).toBeUndefined();
    expect(moves.take(9)).toBeUndefined();
    expect(moves.take(8)).toBe('ws-a');
  });

  it('drops a move that never attached', () => {
    const moves = createProgrammaticMoves(1000);
    moves.expect([7], 'ws-a');

    vi.advanceTimersByTime(1001);

    expect(moves.take(7)).toBeUndefined();
  });

  it('forgets the tabs of a move that failed', () => {
    const moves = createProgrammaticMoves();
    moves.expect([7, 8], 'ws-a');

    moves.forget([7]);

    expect(moves.take(7)).toBeUndefined();
    expect(moves.take(8)).toBe('ws-a');
  });
});

describe('createAdoptionGate', () => {
  it('only allows windows created after startup settled', () => {
    const gate = createAdoptionGate();
    gate.noteWindow(1);
    expect(gate.allows(1)).toBe(false);
    expect(gate.allows(2)).toBe(false);

    gate.settle();
    gate.noteWindow(3);

    expect(gate.isSettled()).toBe(true);
    expect(gate.allows(1)).toBe(false);
    expect(gate.allows(2)).toBe(true);
    // A window that appears after the gate settled was never a startup window.
    expect(gate.allows(3)).toBe(true);
  });
});

describe('tabsToAdopt', () => {
  const never = () => false;
  const open = createAdoptionGate();
  open.settle();

  it('adopts the tabs of an allowed window once they are confirmed unassigned', async () => {
    const confirmUnassigned = vi.fn(async (ids: number[]) => ids);

    const picked = await tabsToAdopt({
      gate: open,
      windowId: 2,
      snapshot: () => [tab({ id: 1, windowId: 2 }), tab({ id: 2, windowId: 2 })],
      isClosing: never,
      isPrivate: never,
      confirmUnassigned,
    });

    expect(confirmUnassigned).toHaveBeenCalledWith([1, 2]);
    expect(picked.map((t) => t.id)).toEqual([1, 2]);
  });

  it('adopts nothing, and reads nothing, for a window the gate does not allow', async () => {
    const confirmUnassigned = vi.fn(async (ids: number[]) => ids);

    const picked = await tabsToAdopt({
      gate: createAdoptionGate(),
      windowId: 2,
      snapshot: () => [tab({ id: 1, windowId: 2 })],
      isClosing: never,
      isPrivate: never,
      confirmUnassigned,
    });

    expect(picked).toEqual([]);
    expect(confirmUnassigned).not.toHaveBeenCalled();
  });

  it('adopts nothing when any tab could not be confirmed unassigned', async () => {
    const picked = await tabsToAdopt({
      gate: open,
      windowId: 2,
      snapshot: () => [tab({ id: 1, windowId: 2 }), tab({ id: 2, windowId: 2 })],
      isClosing: never,
      isPrivate: never,
      confirmUnassigned: async () => [1],
    });

    expect(picked).toEqual([]);
  });

  it('judges the window as it is after the metadata was read', async () => {
    let tabs = [tab({ id: 1, windowId: 2 })];

    const picked = await tabsToAdopt({
      gate: open,
      windowId: 2,
      snapshot: () => tabs,
      isClosing: never,
      isPrivate: never,
      confirmUnassigned: async (ids) => {
        // Another tab opens while the session values are read.
        tabs = [...tabs, tab({ id: 3, windowId: 2 })];
        return ids;
      },
    });

    expect(picked).toEqual([]);
  });
});

describe('startup ordering against a real registry', () => {
  // SessionStore restores tabs after the registry's first read, and the tab objects in
  // onCreated carry no session values; the values only come from sessions.getTabValue.
  let created: (tab: browser.tabs.Tab) => void;
  const sessionValues = new Map<string, string>();

  function stubStartup(): void {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(async (id: number, key: string) => sessionValues.get(`${id}:${key}`)),
        setTabValue: vi.fn().mockResolvedValue(undefined),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        query: vi.fn(async () => []),
        onCreated: { addListener: vi.fn((listener) => (created = listener)) },
        onUpdated: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
        onActivated: { addListener: vi.fn() },
        onMoved: { addListener: vi.fn() },
        onAttached: { addListener: vi.fn() },
      },
    });
  }

  beforeEach(() => {
    sessionValues.clear();
    stubStartup();
  });

  const restore = (id: number, windowId: number) =>
    created({
      id,
      windowId,
      index: 0,
      title: '',
      active: false,
      pinned: false,
    } as browser.tabs.Tab);

  it('never writes a workspace onto restored tabs, before or after startup settles', async () => {
    sessionValues.set('11:bento.workspaceId', 'ws-a');
    sessionValues.set('12:bento.workspaceId', 'ws-b');
    const registry = new TabRegistry();
    await registry.init();
    const gate = createAdoptionGate();
    const adopt = (windowId: number) =>
      tabsToAdopt({
        gate,
        windowId,
        snapshot: () => registry.snapshot(),
        isClosing: (id) => registry.isClosing(id),
        isPrivate: (id) => registry.isPrivate(id),
        confirmUnassigned: (ids) => registry.confirmUnassigned(ids),
      });

    // Boot: window 1 is restored and its activation is emitted before hydration finished.
    gate.noteWindow(1);
    restore(11, 1);
    restore(12, 1);
    expect(await adopt(1)).toEqual([]);

    // Startup settles. Window 1 stays excluded even though its registry entries still
    // look unassigned.
    gate.settle();
    expect(await adopt(1)).toEqual([]);

    // An undone window close brings back a window after startup, with its stored values.
    sessionValues.set('21:bento.workspaceId', 'ws-c');
    restore(21, 2);
    expect(await adopt(2)).toEqual([]);
    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
    expect(browser.sessions.removeTabValue).not.toHaveBeenCalled();
    // The value that stopped the adoption is applied to the registry instead.
    await vi.waitFor(() =>
      expect(registry.snapshot().find((t) => t.id === 21)?.workspaceId).toBe('ws-c'),
    );
  });

  it('adopts the tab of a window opened after startup when it has no stored values', async () => {
    const registry = new TabRegistry();
    await registry.init();
    const gate = createAdoptionGate();
    gate.settle();
    restore(31, 3);

    const picked = await tabsToAdopt({
      gate,
      windowId: 3,
      snapshot: () => registry.snapshot(),
      isClosing: (id) => registry.isClosing(id),
      isPrivate: (id) => registry.isPrivate(id),
      confirmUnassigned: (ids) => registry.confirmUnassigned(ids),
    });

    expect(picked.map((t) => t.id)).toEqual([31]);
  });
});
