import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  adoptableTabs,
  bentoTabMoves,
  createAdoptionGate,
  createProgrammaticMoves,
  moveTabsToWindow,
  moveWorkspaceTabsToWindow,
  releaseAdoptedTab,
  settleWorkspaceTabs,
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
  handedOver?: boolean;
}): AdoptedTabDeps {
  return {
    moves: { take: vi.fn().mockReturnValue(options.movedFor) },
    handedOver: vi.fn().mockResolvedValue(options.handedOver ?? false),
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

    expect(deps.moves.take).toHaveBeenCalledWith(7, 2);
    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
    expect(deps.panels.remove).not.toHaveBeenCalled();
    expect(deps.clearPanelMarker).not.toHaveBeenCalled();
  });

  it('keeps the workspace and panel slot of a tab a closing window handed over', async () => {
    // Window 1 showed ws-a and took the live tabs of window 2 (ws-b, with a panel) as it closed.
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 1, workspaceId: 'ws-b' })],
      owner: null,
      destinationWorkspaceId: 'ws-a',
      panelWorkspaceIds: ['ws-b'],
      handedOver: true,
    });

    await releaseAdoptedTab(deps, 7, 1);

    expect(deps.handedOver).toHaveBeenCalledWith(7, 1);
    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
    expect(deps.panels.remove).not.toHaveBeenCalled();
    expect(deps.clearPanelMarker).not.toHaveBeenCalled();
  });

  it('still releases the same tab when it was not handed over (a user drag)', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 1, workspaceId: 'ws-b' })],
      owner: null,
      destinationWorkspaceId: 'ws-a',
    });

    await releaseAdoptedTab(deps, 7, 1);

    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
    expect(deps.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(7, 'ws-a');
  });

  it('leaves a tab alone when it has moved on to another window while the event waited', async () => {
    // The registry already saw the next attach: window 3 releases the tab, not this event.
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 3, workspaceId: 'ws-b' })],
      destinationWorkspaceId: 'ws-a',
    });

    await releaseAdoptedTab(deps, 7, 1);

    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });

  it('ignores a tab that has no workspace', async () => {
    const deps = makeDeps({ tabs: [tab({ id: 7, windowId: 2 })], destinationWorkspaceId: 'ws-b' });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });
});

describe('releaseAdoptedTab with the real handover marker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Tools handles the events of a tab in the order Firefox emits them; the registry has applied
  // each attach to the tab's window by the time the handler for it runs.
  async function setupTab(hops: Array<{ from: number; to: number; at: number }> | undefined) {
    vi.resetModules();
    const { wasHandedOver } = await import('./Handover');
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn().mockResolvedValue(hops),
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
    });
    const current = { windowId: 2 };
    const deps = makeDeps({
      tabs: [],
      destinationWorkspaceId: 'ws-a',
      panelWorkspaceIds: ['ws-b'],
    });
    deps.handedOver = (id, windowId) => wasHandedOver(id, { to: windowId });
    deps.tabs.snapshot = () => [
      tab({ id: 7, windowId: current.windowId, workspaceId: 'ws-b', folderId: 'f' }),
    ];
    return { deps, current, wasHandedOver };
  }
  const bindingsReleased = (deps: AdoptedTabDeps) =>
    vi.mocked(deps.tabs.clearWorkspace).mock.calls.length > 0 ||
    vi.mocked(deps.panels.remove).mock.calls.length > 0;

  it('keeps workspace, folder and panel slot of a tab handed on from window 2 to 1 to 3', async () => {
    // Window 2 closed into window 1 and window 1 into window 3 before tools saw either move.
    const { deps, current, wasHandedOver } = await setupTab([
      { from: 2, to: 1, at: Date.now() },
      { from: 1, to: 3, at: Date.now() },
    ]);

    await expect(wasHandedOver(7, { from: 2 })).resolves.toBe(true);
    current.windowId = 1;
    await releaseAdoptedTab(deps, 7, 1);
    await expect(wasHandedOver(7, { from: 1 })).resolves.toBe(true);
    current.windowId = 3;
    await releaseAdoptedTab(deps, 7, 3);

    expect(bindingsReleased(deps)).toBe(false);
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });

  it('treats a drag out and back within the TTL as a drag, once the handover was seen', async () => {
    const { deps, current, wasHandedOver } = await setupTab([{ from: 2, to: 1, at: Date.now() }]);
    await wasHandedOver(7, { from: 2 });
    current.windowId = 1;
    await releaseAdoptedTab(deps, 7, 1);
    expect(bindingsReleased(deps)).toBe(false);

    // Two seconds later the user drags the tab to window 3, then back to window 1.
    vi.advanceTimersByTime(2_000);
    current.windowId = 3;
    await releaseAdoptedTab(deps, 7, 3);
    current.windowId = 1;
    await releaseAdoptedTab(deps, 7, 1);

    expect(deps.tabs.clearWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.tabs.assignWorkspaceEagerly).toHaveBeenCalledTimes(2);
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
    moves.expect([7, 8], 'ws-a', 2);

    expect(moves.take(7, 2)).toBe('ws-a');
    expect(moves.take(7, 2)).toBeUndefined();
    expect(moves.take(9, 2)).toBeUndefined();
    expect(moves.take(8, 2)).toBe('ws-a');
  });

  it('discards the record of a tab that attaches to another window than the move targeted', () => {
    const moves = createProgrammaticMoves();
    moves.expect([7], 'ws-a', 2);

    expect(moves.take(7, 3)).toBeUndefined();
    // The record is gone, so a later attach to the targeted window is not Bento's either.
    expect(moves.take(7, 2)).toBeUndefined();
  });

  it('drops a move that never attached', () => {
    const moves = createProgrammaticMoves(1000);
    moves.expect([7], 'ws-a', 2);

    vi.advanceTimersByTime(1001);

    expect(moves.take(7, 2)).toBeUndefined();
  });

  it('forgets the tabs of a move that failed', () => {
    const moves = createProgrammaticMoves();
    moves.expect([7, 8], 'ws-a', 2);

    moves.forget([7]);

    expect(moves.take(7, 2)).toBeUndefined();
    expect(moves.take(8, 2)).toBe('ws-a');
  });
});

describe('moveTabsToWindow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('records only the tabs the move reports, so a skipped tab dragged out later is a user move', async () => {
    // tabs.move resolves with the tabs it moved; the pinned tab 8 was skipped.
    vi.stubGlobal('browser', {
      tabs: { move: vi.fn(async () => [{ id: 7 }]) },
    });

    await moveTabsToWindow([7, 8], 2, 'ws-a');

    expect(browser.tabs.move).toHaveBeenCalledWith([7, 8], { windowId: 2, index: -1 });
    expect(bentoTabMoves.take(8, 2)).toBeUndefined();
    expect(bentoTabMoves.take(7, 2)).toBe('ws-a');
  });

  it('has the record in place before the move resolves', async () => {
    // The attach event can arrive ahead of the promise.
    let takenDuringMove: string | undefined;
    vi.stubGlobal('browser', {
      tabs: {
        move: vi.fn(async () => {
          takenDuringMove = bentoTabMoves.take(7, 2);
          return [{ id: 7 }];
        }),
      },
    });

    await moveTabsToWindow([7], 2, 'ws-a');

    expect(takenDuringMove).toBe('ws-a');
  });

  it('forgets every tab when the move fails', async () => {
    vi.stubGlobal('browser', { tabs: { move: vi.fn().mockRejectedValue(new Error('no window')) } });

    await expect(moveTabsToWindow([7, 8], 2, 'ws-a')).rejects.toThrow('no window');

    expect(bentoTabMoves.take(7, 2)).toBeUndefined();
    expect(bentoTabMoves.take(8, 2)).toBeUndefined();
  });
});

describe('moveWorkspaceTabsToWindow', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves pinned tabs first, to the start, since Firefox leaves a pinned tab moved to the end', async () => {
    const move = vi.fn(async (ids: number[]) => ids.map((id) => ({ id })));
    vi.stubGlobal('browser', { tabs: { move } });

    await moveWorkspaceTabsToWindow(
      [
        { id: 7, pinned: false },
        { id: 8, pinned: true },
        { id: 9, pinned: false },
        { id: 10, pinned: true },
      ],
      2,
      'ws-a',
    );

    expect(move.mock.calls).toEqual([
      [[8, 10], { windowId: 2, index: 0 }],
      [[7, 9], { windowId: 2, index: -1 }],
    ]);
    expect(bentoTabMoves.take(8, 2)).toBe('ws-a');
    expect(bentoTabMoves.take(9, 2)).toBe('ws-a');
  });

  it('makes no call for a group with no tabs', async () => {
    const move = vi.fn(async (ids: number[]) => ids.map((id) => ({ id })));
    vi.stubGlobal('browser', { tabs: { move } });

    await moveWorkspaceTabsToWindow([{ id: 7, pinned: false }], 2, 'ws-a');

    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith([7], { windowId: 2, index: -1 });
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

describe('settleWorkspaceTabs', () => {
  const unassigned = tab({ id: 1, windowId: 2 });
  const assigned = tab({ id: 1, windowId: 2, workspaceId: 'ws-a' });

  it('reads the workspace again after the session values, so a tab assigned meanwhile is used', async () => {
    // Another handler assigns the window's initial tab while its session values are read.
    let reads = 0;
    const result = await settleWorkspaceTabs({
      readTabs: () => (++reads === 1 ? [] : [assigned]),
      parkedTabsRestored: false,
      adoptable: async () => [unassigned],
    });

    expect(result.tabs).toEqual([assigned]);
    expect(result.adopt).toEqual([]);
    expect(result.create).toBe(false);
  });

  it('adopts the window tabs when the workspace is still empty afterwards', async () => {
    const result = await settleWorkspaceTabs({
      readTabs: () => [],
      parkedTabsRestored: false,
      adoptable: async () => [unassigned],
    });

    expect(result).toEqual({ tabs: [], adopt: [unassigned], create: false });
  });

  it('creates a tab only when the workspace is empty and nothing can be adopted', async () => {
    const result = await settleWorkspaceTabs({
      readTabs: () => [],
      parkedTabsRestored: false,
      adoptable: async () => [],
    });

    expect(result).toEqual({ tabs: [], adopt: [], create: true });
  });

  it('leaves a workspace that has tabs, or just got its parked tabs back, alone', async () => {
    const adoptable = vi.fn(async () => [unassigned]);

    await expect(
      settleWorkspaceTabs({ readTabs: () => [assigned], parkedTabsRestored: false, adoptable }),
    ).resolves.toEqual({ tabs: [assigned], adopt: [], create: false });
    await expect(
      settleWorkspaceTabs({ readTabs: () => [], parkedTabsRestored: true, adoptable }),
    ).resolves.toEqual({ tabs: [], adopt: [], create: false });
    expect(adoptable).not.toHaveBeenCalled();
  });
});
