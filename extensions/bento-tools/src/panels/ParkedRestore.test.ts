import type { TabSnapshot } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bentoTabMoves } from '../tabs/AdoptedTab';
import { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { createActivationGenerations, isActivationCurrent } from '../workspaces/ActivationGuard';
import { restoreParkedEntries } from './ParkedRestore';
import type { ParkedWorkspaceTab } from './ParkedWorkspace';

function entry(url: string, index: number, extra: Partial<ParkedWorkspaceTab> = {}) {
  return { url, title: url, pinned: false, index, ...extra } satisfies ParkedWorkspaceTab;
}

/** An in-memory browser: tabs.create can be held open, and tabs.move changes a tab's window. */
function fakeBrowser() {
  const live = new Map<number, { id: number; windowId: number; url: string; active: boolean }>();
  const workspaceByTab = new Map<number, string>();
  let nextId = 100;
  let hold: Promise<void> | null = null;
  const created: number[] = [];

  vi.stubGlobal('browser', {
    // What WorkspaceStore reads and writes.
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
    windows: { getAll: vi.fn(async () => []) },
    sessions: {
      getWindowValue: vi.fn(async () => undefined),
      setWindowValue: vi.fn(async () => undefined),
      removeWindowValue: vi.fn(async () => undefined),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        const tab = live.get(id);
        if (!tab) throw new Error('no tab');
        return { ...tab };
      }),
      update: vi.fn(async () => ({})),
      create: vi.fn(async (props: { url: string; active: boolean; windowId?: number }) => {
        const tab = {
          id: nextId++,
          windowId: props.windowId ?? 1,
          url: props.url,
          active: props.active,
        };
        live.set(tab.id, tab);
        created.push(tab.id);
        // The tab exists in Firefox while the call is still pending.
        if (hold) await hold;
        return { ...tab };
      }),
      move: vi.fn(async (ids: number[], props: { windowId: number }) => {
        for (const id of ids) live.get(id)!.windowId = props.windowId;
        return ids.map((id) => ({ ...live.get(id)! }));
      }),
    },
  });

  const registry = {
    snapshot: () =>
      [...live.values()].map(
        (tab) =>
          ({
            ...tab,
            index: tab.id,
            title: '',
            pinned: false,
            audible: false,
            muted: false,
            workspaceId: workspaceByTab.get(tab.id),
          }) as TabSnapshot,
      ),
    rename: vi.fn(async () => undefined),
    assignWorkspaceEagerly: vi.fn(async (id: number, workspaceId: string) => {
      workspaceByTab.set(id, workspaceId);
      return true;
    }),
  };

  return {
    live,
    created,
    registry,
    /** Holds every tabs.create open until the returned function is called. */
    holdCreates(): () => void {
      let release!: () => void;
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
      return release;
    },
    tabsOf(workspaceId: string, windowId: number): string[] {
      return [...live.values()]
        .filter((tab) => workspaceByTab.get(tab.id) === workspaceId && tab.windowId === windowId)
        .map((tab) => tab.url);
    },
  };
}

describe('restoreParkedEntries', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    bentoTabMoves.forget([100, 101, 102]);
  });

  /** A store showing A in window 1, with a second workspace B to switch windows to. */
  async function twoWorkspaces() {
    const store = new WorkspaceStore();
    await store.init();
    const a = store.snapshot().workspaces[0]!;
    const b = store.create({ name: 'B' }, null, { activate: false });
    store.activate(a.id, 1);
    return { store, a: a.id, b: b.id };
  }

  it('opens every entry in the target window and selects the first', async () => {
    const env = fakeBrowser();
    const parked = [entry('https://one/', 0), entry('https://two/', 1, { pinned: true })];

    const result = await restoreParkedEntries({
      workspaceId: 'ws',
      targetWindowId: 1,
      parked,
      tabs: env.registry,
      stillCurrent: () => true,
      findOwningWindow: () => 1,
    });

    expect(result).toEqual({ restored: true, unrestored: [] });
    expect(env.tabsOf('ws', 1)).toEqual(['https://one/', 'https://two/']);
    expect(browser.tabs.create).toHaveBeenNthCalledWith(1, {
      url: 'https://one/',
      active: true,
      windowId: 1,
    });
    expect(browser.tabs.create).toHaveBeenNthCalledWith(2, {
      url: 'https://two/',
      active: false,
      windowId: 1,
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(101, { pinned: true });
  });

  it('matches a live tab at the entry address instead of opening another', async () => {
    const env = fakeBrowser();
    env.live.set(7, { id: 7, windowId: 1, url: 'https://one/', active: false });
    await env.registry.assignWorkspaceEagerly(7, 'ws');

    const result = await restoreParkedEntries({
      workspaceId: 'ws',
      targetWindowId: 1,
      parked: [entry('https://one/', 0, { pinned: true }), entry('https://two/', 1)],
      tabs: env.registry,
      stillCurrent: () => true,
      findOwningWindow: () => 1,
    });

    expect(result.unrestored).toEqual([]);
    expect(env.created).toHaveLength(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(7, { active: true, pinned: true });
  });

  it('opens and selects nothing, and returns every entry, when it was superseded before it began', async () => {
    const env = fakeBrowser();
    const parked = [entry('https://one/', 0), entry('https://two/', 1)];

    const result = await restoreParkedEntries({
      workspaceId: 'ws',
      targetWindowId: 1,
      parked,
      tabs: env.registry,
      stillCurrent: () => false,
      findOwningWindow: () => null,
    });

    expect(result).toEqual({ restored: false, unrestored: parked });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it('stops at a superseded entry, hands the tab in flight to the new owner and returns the rest', async () => {
    // Window 1 restores A, switches to B while the first create is pending, then window 2 claims A.
    const env = fakeBrowser();
    const { store, a, b } = await twoWorkspaces();
    const generations = createActivationGenerations();
    const isLatest = generations.begin(1);
    const stillCurrent = () =>
      isLatest() && isActivationCurrent(a, 1, (windowId) => store.getActiveId(windowId));
    const parked = [entry('https://one/', 0), entry('https://two/', 1), entry('https://three/', 2)];
    const release = env.holdCreates();

    const restore = restoreParkedEntries({
      workspaceId: a,
      targetWindowId: 1,
      parked,
      tabs: env.registry,
      stillCurrent,
      findOwningWindow: (workspaceId) => store.findOwningWindow(workspaceId),
    });
    await vi.waitFor(() => expect(env.created).toHaveLength(1));
    store.activate(b, 1);
    generations.begin(1);
    store.activate(a, 2);
    generations.begin(2);
    release();
    const result = await restore;

    expect(env.created).toHaveLength(1);
    expect(result.restored).toBe(true);
    // The tab in flight moved to the window that owns A now; window 1 keeps no A tab.
    expect(env.tabsOf(a, 1)).toEqual([]);
    expect(env.tabsOf(a, 2)).toEqual(['https://one/']);
    // Every entry is accounted for once: one tab, the others waiting in the parked list.
    expect(result.unrestored.map((rest) => rest.url)).toEqual(['https://two/', 'https://three/']);
  });

  it('leaves the tab in flight where it is when no window shows the workspace', async () => {
    const env = fakeBrowser();
    const { store, a, b } = await twoWorkspaces();
    const generations = createActivationGenerations();
    const isLatest = generations.begin(1);
    const stillCurrent = () =>
      isLatest() && isActivationCurrent(a, 1, (windowId) => store.getActiveId(windowId));
    const release = env.holdCreates();

    const restore = restoreParkedEntries({
      workspaceId: a,
      targetWindowId: 1,
      parked: [entry('https://one/', 0), entry('https://two/', 1)],
      tabs: env.registry,
      stillCurrent,
      findOwningWindow: (workspaceId) => store.findOwningWindow(workspaceId),
    });
    await vi.waitFor(() => expect(env.created).toHaveLength(1));
    store.activate(b, 1);
    generations.begin(1);
    release();
    const result = await restore;

    // Like any tab of a workspace the window switched away from: the next activation of A
    // claims it.
    expect(browser.tabs.move).not.toHaveBeenCalled();
    expect(env.tabsOf(a, 1)).toEqual(['https://one/']);
    expect(result.unrestored.map((rest) => rest.url)).toEqual(['https://two/']);
  });

  it('does not move the tab in flight when the window went A, B, A and shows A again', async () => {
    const env = fakeBrowser();
    const { store, a, b } = await twoWorkspaces();
    const generations = createActivationGenerations();
    const isLatest = generations.begin(1);
    const stillCurrent = () =>
      isLatest() && isActivationCurrent(a, 1, (windowId) => store.getActiveId(windowId));
    const release = env.holdCreates();

    const restore = restoreParkedEntries({
      workspaceId: a,
      targetWindowId: 1,
      parked: [entry('https://one/', 0), entry('https://two/', 1)],
      tabs: env.registry,
      stillCurrent,
      findOwningWindow: (workspaceId) => store.findOwningWindow(workspaceId),
    });
    await vi.waitFor(() => expect(env.created).toHaveLength(1));
    store.activate(b, 1);
    generations.begin(1);
    store.activate(a, 1);
    generations.begin(1);
    release();
    const result = await restore;

    // The first restore is superseded by the second A even though window 1 shows A.
    expect(browser.tabs.move).not.toHaveBeenCalled();
    expect(env.created).toHaveLength(1);
    expect(env.tabsOf(a, 1)).toEqual(['https://one/']);
    expect(result.unrestored.map((rest) => rest.url)).toEqual(['https://two/']);
  });
});
