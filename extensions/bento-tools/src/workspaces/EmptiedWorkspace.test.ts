import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type HandlerContext } from '../messaging/protocol-handler';
import { PanelStore } from '../panels/PanelStore';
import { TabRegistry } from '../tabs/TabRegistry';
import {
  afterTabRemoved,
  createWindowHandoffGuard,
  type EmptiedWorkspaceAction,
  type EmptiedWorkspaceDeps,
} from './EmptiedWorkspace';
import { WorkspaceStore } from './WorkspaceStore';

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
    ...overrides,
  } as TabSnapshot;
}

describe('createWindowHandoffGuard', () => {
  it('stays active until every handoff of the window ended, and ends only once each', () => {
    const guard = createWindowHandoffGuard();
    const endFirst = guard.begin(1);
    const endSecond = guard.begin(1);

    endFirst();
    endFirst();
    expect(guard.isActive(1)).toBe(true);
    expect(guard.isActive(2)).toBe(false);

    endSecond();
    expect(guard.isActive(1)).toBe(false);
  });
});

describe('afterTabRemoved', () => {
  function deps(overrides: Partial<EmptiedWorkspaceDeps> = {}): EmptiedWorkspaceDeps {
    return {
      tabs: { snapshot: () => [], isClosing: () => false, isPendingBatchRemoval: () => false },
      panels: { getPanels: () => [] },
      workspaces: {
        getActiveId: () => 'ws-a',
        getActiveIdByWindow: () => ({ 1: 'ws-a', 2: 'ws-b' }),
        snapshot: () => ({ workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }, { id: 'ws-c' }] }),
      },
      handoff: createWindowHandoffGuard(),
      takeRecentlyRemovedPanel: () => false,
      ...overrides,
    };
  }

  it('does nothing while the window is handing off to a replacement workspace', () => {
    const handoff = createWindowHandoffGuard();
    handoff.begin(1);

    expect(afterTabRemoved(deps({ handoff }), 5, 1)).toEqual({ kind: 'none' });
  });

  it('does nothing while another sidebar tab of the workspace remains', () => {
    const tabs = [tab(6, { workspaceId: 'ws-a' })];

    expect(
      afterTabRemoved(
        deps({
          tabs: {
            snapshot: () => tabs,
            isClosing: () => false,
            isPendingBatchRemoval: () => false,
          },
        }),
        5,
        1,
      ),
    ).toEqual({ kind: 'none' });
  });

  it('promotes the leftmost panel that is still open', () => {
    const tabs = [tab(20, { workspaceId: 'ws-a' }), tab(21, { workspaceId: 'ws-a' })];

    expect(
      afterTabRemoved(
        deps({
          tabs: {
            snapshot: () => tabs,
            isClosing: (id) => id === 20,
            isPendingBatchRemoval: () => false,
          },
          panels: { getPanels: () => [20, 21] },
        }),
        5,
        1,
      ),
    ).toEqual({ kind: 'promote-panel', workspaceId: 'ws-a', panelTabId: 21 });
  });

  it('waits for the last tab of a batched close, in its own window, before deciding', () => {
    // The batch marked its tabs closing first, so none of them carries a workspace any more.
    let tabs = [tab(5), tab(6), tab(7), tab(8, { windowId: 2 })];
    const pending = new Set([5, 6, 7, 8]);
    const batch = deps({
      tabs: {
        snapshot: () => tabs,
        isClosing: () => true,
        isPendingBatchRemoval: (id) => pending.has(id),
      },
    });
    const removed = (id: number) => {
      const action = afterTabRemoved(batch, id, 1);
      tabs = tabs.filter((t) => t.id !== id);
      pending.delete(id);
      return action;
    };

    expect(removed(5)).toEqual({ kind: 'none' });
    expect(removed(6)).toEqual({ kind: 'none' });
    // Tab 8 is pending in another window, which does not hold this window's decision back.
    expect(removed(7)).toMatchObject({ kind: 'switch-window' });
  });

  it('moves the window to a workspace no window shows, else closes it', () => {
    expect(afterTabRemoved(deps(), 5, 1)).toEqual({
      kind: 'switch-window',
      deleteWorkspaceId: 'ws-a',
      candidateId: 'ws-c',
    });

    const allShown = deps({
      workspaces: {
        getActiveId: () => 'ws-a',
        getActiveIdByWindow: () => ({ 1: 'ws-a', 2: 'ws-b' }),
        snapshot: () => ({ workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }] }),
      },
    });
    expect(afterTabRemoved(allShown, 5, 1)).toEqual({ kind: 'close-window' });
  });
});

describe('workspace delete against the tab-removal handler, with a real store', () => {
  // The store hands the window its replacement synchronously, but the replacement only gets
  // a tab when its activation runs later. Deleting the shown workspace and closing its tabs
  // must not let the tab removals see that empty replacement.
  let tabs: TabSnapshot[];
  let closing: Set<number>;
  let workspaces: WorkspaceStore;
  let handoff: ReturnType<typeof createWindowHandoffGuard>;
  let actions: EmptiedWorkspaceAction[];
  let windowsClosed: number[];
  let nextTabId: number;
  let createFails: boolean;

  async function setup(options: { guard: boolean }) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      setTimeout(() => callback(0), 0);
      return 1;
    });
    tabs = [];
    closing = new Set();
    actions = [];
    windowsClosed = [];
    nextTabId = 100;
    createFails = false;
    handoff = createWindowHandoffGuard();
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      sessions: {
        getWindowValue: vi.fn(async () => undefined),
        setWindowValue: vi.fn(async () => undefined),
        removeWindowValue: vi.fn(async () => undefined),
      },
      windows: {
        getAll: vi.fn(async () => []),
        remove: vi.fn(async (id: number) => {
          windowsClosed.push(id);
        }),
      },
      tabs: {
        create: vi.fn(async (props: { windowId: number }) => {
          if (createFails) throw new Error('no window');
          const opened = tab(nextTabId++, { windowId: props.windowId });
          tabs = [...tabs, opened];
          return { id: opened.id };
        }),
        // What Firefox does on close: the tab is gone, then tabs.onRemoved reaches Bento.
        remove: vi.fn(async (ids: number | number[]) => {
          for (const id of Array.isArray(ids) ? ids : [ids]) {
            const removed = tabs.find((t) => t.id === id);
            tabs = tabs.filter((t) => t.id !== id);
            if (!removed) continue;
            actions.push(
              afterTabRemoved(
                {
                  tabs: {
                    snapshot: () => tabs,
                    isClosing: (tabId) => closing.has(tabId),
                    isPendingBatchRemoval: () => false,
                  },
                  panels: { getPanels: () => [] },
                  workspaces,
                  handoff: options.guard ? handoff : { isActive: () => false },
                  takeRecentlyRemovedPanel: () => false,
                },
                id,
                removed.windowId,
              ),
            );
          }
        }),
      },
    });
    workspaces = new WorkspaceStore();
    await workspaces.init();
    const [a] = workspaces.snapshot().workspaces;
    // C comes first in creation order, so once A is gone it is also the global fallback.
    const c = workspaces.create({ name: 'C' }, null, { activate: false });
    const b = workspaces.create({ name: 'B' }, null, { activate: false });
    workspaces.activate(a!.id, 1);
    workspaces.activate(b.id, 2);
    tabs = [
      tab(1, { windowId: 1, workspaceId: a!.id }),
      tab(2, { windowId: 1, workspaceId: a!.id }),
      tab(3, { windowId: 2, workspaceId: b.id }),
    ];
    // Setup's own events are not part of what the tests observe.
    await workspaces.flush();
    return { a: a!.id, b: b.id, c: c.id };
  }

  /**
   * The tools orchestrator: every activation event starts a run that, after some async work,
   * gives an empty workspace a tab. The run is returned to the store like the real listener's.
   */
  function orchestrate(delayMs = 30): Array<[string, number | null]> {
    const runs: Array<[string, number | null]> = [];
    workspaces.onDeltas((deltas) =>
      Promise.all(
        deltas.flatMap((delta) => {
          if (delta.kind !== 'activated') return [];
          const windowId = delta.windowId ?? null;
          runs.push([delta.id, windowId]);
          return [
            (async () => {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
              const present = tabs.some(
                (t) => t.workspaceId === delta.id && (windowId === null || t.windowId === windowId),
              );
              if (!present) {
                tabs = [
                  ...tabs,
                  tab(nextTabId++, { windowId: windowId ?? 1, workspaceId: delta.id }),
                ];
              }
            })(),
          ];
        }),
      ),
    );
    return runs;
  }

  function context(): HandlerContext {
    return {
      tabs: {
        snapshot: () => tabs,
        isClosing: (id: number) => closing.has(id),
        markClosing: async (id: number) => {
          closing.add(id);
          tabs = tabs.map((t) => (t.id === id ? { ...t, workspaceId: undefined } : t));
        },
        unmarkClosing: async (id: number) => {
          closing.delete(id);
        },
        assignWorkspace: async (id: number, workspaceId: string) => {
          tabs = tabs.map((t) => (t.id === id ? { ...t, workspaceId } : t));
        },
        assignWorkspaceEagerly: async (id: number, workspaceId: string) => {
          tabs = tabs.map((t) => (t.id === id ? { ...t, workspaceId } : t));
          return true;
        },
      },
      panels: { getPanels: () => [] },
      workspaces,
      handoff,
      sourceWindowId: 1,
    } as unknown as HandlerContext;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('finishes the replacement before the old tabs go, so the window survives', async () => {
    const ids = await setup({ guard: true });
    const runs = orchestrate();

    handle({ type: 'workspace/delete', id: ids.a, closeTabs: true }, context());

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalled();
      expect(handoff.isActive(1)).toBe(false);
    });
    // C is also the global fallback. Its window-specific activation is the one that runs,
    // and it runs once: a second run on the still empty workspace creates a second tab.
    expect(runs).toEqual([[ids.c, 1]]);
    expect(windowsClosed).toEqual([]);
    expect(workspaces.has(ids.c)).toBe(true);
    expect(workspaces.getActiveId(1)).toBe(ids.c);
    expect(tabs.filter((t) => t.windowId === 1).map((t) => t.workspaceId)).toEqual([ids.c]);
    expect(actions.every((action) => action.kind === 'none')).toBe(true);
  });

  it('opens the replacement tab itself when the activation did not, so the window survives', async () => {
    const ids = await setup({ guard: true });
    // No activation listener: the activation produced no tab, as when its creation failed
    // (that step only logs).

    handle({ type: 'workspace/delete', id: ids.a, closeTabs: true }, context());

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalled();
      expect(handoff.isActive(1)).toBe(false);
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({ windowId: 1, active: true });
    expect(windowsClosed).toEqual([]);
    expect(tabs.filter((t) => t.windowId === 1).map((t) => t.workspaceId)).toEqual([ids.c]);
    expect(actions.every((action) => action.kind === 'none')).toBe(true);
  });

  it('keeps the old tabs as tabs of the replacement when no tab can be opened for it', async () => {
    const ids = await setup({ guard: true });
    createFails = true;

    handle({ type: 'workspace/delete', id: ids.a, closeTabs: true }, context());

    await vi.waitFor(() => {
      expect(handoff.isActive(1)).toBe(false);
      expect(browser.tabs.create).toHaveBeenCalled();
    });
    // Closing them would have left the window without a tab; they live on in the replacement.
    expect(windowsClosed).toEqual([]);
    expect(tabs.filter((t) => t.windowId === 1).map((t) => [t.id, t.workspaceId])).toEqual([
      [1, ids.c],
      [2, ids.c],
    ]);
    expect(actions).toEqual([]);
  });

  it('ignores tabs that close while the replacement is still being set up', async () => {
    const ids = await setup({ guard: true });
    tabs = [...tabs, tab(9, { windowId: 1, workspaceId: ids.a })];
    orchestrate(300);

    handle({ type: 'workspace/delete', id: ids.a, closeTabs: false }, context());
    await vi.waitFor(() => expect(handoff.isActive(1)).toBe(true));
    // The user closes a tab of the old workspace just as the handoff runs.
    await browser.tabs.remove(9);

    await vi.waitFor(() => expect(handoff.isActive(1)).toBe(false));
    expect(actions).toEqual([{ kind: 'none' }]);
    expect(windowsClosed).toEqual([]);
  });

  it('would lose the window to the empty replacement without the handoff', async () => {
    // Control: removing the tabs the way the old code did, with nothing marking the handoff.
    const ids = await setup({ guard: false });
    const owner = workspaces.findOwningWindow(ids.a);
    workspaces.delete(ids.a);
    expect(workspaces.getActiveId(owner!)).toBe(ids.c);

    await browser.tabs.remove(1);
    await browser.tabs.remove(2);

    // C has no tab yet, so the last-tab decision treats the window as emptied.
    expect(actions.at(-1)?.kind).not.toBe('none');
  });
});

describe('batched tab close against the tab-removal handler, with the real registry', () => {
  // Every tab of the batch is marked closing before Firefox removes any, so each removal event
  // sees the tabs behind it as gone. Only the last event may decide what the window does.
  async function closeBatch(kept: ReadonlySet<number>) {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const values = new Map<string, unknown>();
    for (const id of [1, 2, 3]) values.set(`${id}:bento.workspaceId`, 'ws-a');
    let open = [1, 2, 3];
    let fireRemoved: (id: number, info: { windowId: number }) => void = () => undefined;
    const registry = new TabRegistry();
    const actions: EmptiedWorkspaceAction[] = [];
    const panels = new PanelStore();
    const workspaces = {
      getActiveId: () => 'ws-a',
      hasForWindow: () => true,
      getActiveIdByWindow: () => ({ 1: 'ws-a' }),
      snapshot: () => ({ workspaces: [{ id: 'ws-a' }, { id: 'ws-b' }] }),
    };
    const noEvent = { addListener: vi.fn() };
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(async (id: number, key: string) => values.get(`${id}:${key}`)),
        setTabValue: vi.fn(async (id: number, key: string, value: unknown) => {
          values.set(`${id}:${key}`, value);
        }),
        removeTabValue: vi.fn(async (id: number, key: string) => {
          values.delete(`${id}:${key}`);
        }),
      },
      bentoTabState: { onPageErrorChanged: noEvent, getPageErrors: vi.fn(async () => []) },
      tabs: {
        onCreated: noEvent,
        onUpdated: noEvent,
        onActivated: noEvent,
        onMoved: noEvent,
        onAttached: noEvent,
        onRemoved: {
          addListener: (listener: typeof fireRemoved) => {
            fireRemoved = listener;
          },
        },
        query: vi.fn(async () =>
          open.map((id) => ({
            id,
            windowId: 1,
            index: id,
            title: '',
            active: false,
            pinned: false,
          })),
        ),
        get: vi.fn(async (id: number) => {
          if (!open.includes(id)) throw new Error(`Invalid tab ID: ${id}`);
          return { id, windowId: 1 };
        }),
        // Firefox closes the tabs in turn. The last-tab handler in background.ts is registered
        // before the registry's listener, so it hears each removal first.
        remove: vi.fn(async (ids: number[]) => {
          for (const id of ids.filter((candidate) => !kept.has(candidate))) {
            actions.push(
              afterTabRemoved(
                {
                  tabs: registry,
                  panels,
                  workspaces,
                  handoff: createWindowHandoffGuard(),
                  takeRecentlyRemovedPanel: () => false,
                },
                id,
                1,
              ),
            );
            open = open.filter((candidate) => candidate !== id);
            fireRemoved(id, { windowId: 1 });
          }
        }),
      },
    });
    await registry.init();
    const ctx = {
      tabs: registry,
      panels,
      workspaces,
      pinnedPanels: { removeForTab: vi.fn() },
      handoff: createWindowHandoffGuard(),
      sourceWindowId: 1,
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
    } as unknown as HandlerContext;

    handle({ type: 'tabs/close', ids: [1, 2, 3] }, ctx);
    await vi.waitFor(() => expect(browser.tabs.remove).toHaveBeenCalled());
    return { actions, registry };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lets only the last removal decide, then nothing is left pending', async () => {
    const { actions, registry } = await closeBatch(new Set());

    await vi.waitFor(() => expect(actions).toHaveLength(3));
    expect(actions.map((action) => action.kind)).toEqual(['none', 'none', 'switch-window']);
    expect(registry.snapshot()).toEqual([]);
    expect([1, 2, 3].some((id) => registry.isPendingBatchRemoval(id))).toBe(false);
  });

  it('keeps the window as it is when the user stays on one of the tabs', async () => {
    const { actions, registry } = await closeBatch(new Set([2]));

    await vi.waitFor(() => expect(registry.isPendingBatchRemoval(2)).toBe(false));
    expect(actions.map((action) => action.kind)).toEqual(['none', 'none']);
    expect(registry.snapshot().map((tab) => [tab.id, tab.workspaceId])).toEqual([[2, 'ws-a']]);
  });
});
