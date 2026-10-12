import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceDelta } from '@shared/protocol';
import { WorkspaceStore } from './WorkspaceStore';

describe('WorkspaceStore active workspace persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
      windows: {
        getAll: vi.fn(async () => []),
      },
      sessions: {
        getWindowValue: vi.fn(async () => undefined),
        setWindowValue: vi.fn(async () => undefined),
        removeWindowValue: vi.fn(async () => undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('updates the persisted fallback when the only window changes workspace', async () => {
    const store = new WorkspaceStore();
    await store.init();

    const workspace = store.create({ name: 'Workspace 2' }, 1);

    expect(store.snapshot().activeId).toBe(workspace.id);
    expect(store.snapshot().activeIdByWindow).toEqual({ 1: workspace.id });
    expect(browser.sessions.setWindowValue).toHaveBeenCalledWith(
      1,
      'bento.activeWorkspaceId',
      workspace.id,
    );
  });

  it('keeps multi-window per-window activations out of the global fallback', async () => {
    const store = new WorkspaceStore();
    await store.init();
    const workspace2 = store.create({ name: 'Workspace 2' }, 1);
    const workspace3 = store.create({ name: 'Workspace 3' }, null, { activate: false });

    expect(store.activate(workspace3.id, 2)).toBe('activated');

    expect(store.snapshot().activeId).toBe(workspace2.id);
    expect(store.snapshot().activeIdByWindow).toEqual({
      1: workspace2.id,
      2: workspace3.id,
    });
  });

  it('moves the window of a deleted workspace to one no other window shows', async () => {
    const store = new WorkspaceStore();
    await store.init();
    const [initial] = store.snapshot().workspaces;
    store.activate(initial!.id, 2);
    const doomed = store.create({ name: 'Doomed' }, 1);
    const free = store.create({ name: 'Free' }, null, { activate: false });

    store.delete(doomed.id);

    // The initial workspace comes first in creation order but window 2 shows it.
    expect(store.snapshot().activeIdByWindow).toEqual({ 1: free.id, 2: initial!.id });
  });

  describe('delete announcements', () => {
    async function twoWindows() {
      const store = new WorkspaceStore();
      await store.init();
      const [initial] = store.snapshot().workspaces;
      // The second workspace is both the window's replacement and the global fallback.
      const fallback = store.create({ name: 'Fallback' }, null, { activate: false });
      store.activate(initial!.id, 1);
      await store.flush();
      const events: WorkspaceDelta[] = [];
      store.onDeltas((batch) => void events.push(...batch));
      return { store, initial: initial!.id, fallback: fallback.id, events };
    }

    it('announces the global fallback and the window replacement by default', async () => {
      const { store, initial, fallback, events } = await twoWindows();

      store.delete(initial);
      await store.flush();

      expect(events).toEqual([
        { kind: 'removed', id: initial },
        { kind: 'activated', id: fallback },
        { kind: 'activated', id: fallback, windowId: 1 },
      ]);
    });

    it('leaves the global fallback out when the caller activates the replacement itself', async () => {
      const { store, initial, fallback, events } = await twoWindows();

      store.delete(initial, { announceFallback: false });
      await store.flush();

      expect(events).toEqual([
        { kind: 'removed', id: initial },
        { kind: 'activated', id: fallback, windowId: 1 },
      ]);
      // The fallback itself still moves, so a restart or a new window uses it.
      expect(store.getActiveId(null)).toBe(fallback);
    });

    it('flush delivers pending deltas now and waits for the work listeners return', async () => {
      const store = new WorkspaceStore();
      await store.init();
      await store.flush();
      let finished = false;
      store.onDeltas(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      });

      store.create({ name: 'Another' }, null, { activate: false });
      const flushed = store.flush();
      await vi.advanceTimersByTimeAsync(10);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await flushed;

      expect(finished).toBe(true);
    });
  });

  it('leaves the window without a workspace when every other one is shown elsewhere', async () => {
    const store = new WorkspaceStore();
    await store.init();
    const [initial] = store.snapshot().workspaces;
    store.activate(initial!.id, 2);
    const doomed = store.create({ name: 'Doomed' }, 1);

    store.delete(doomed.id);

    expect(store.snapshot().activeIdByWindow).toEqual({ 2: initial!.id });
    expect(browser.sessions.removeWindowValue).toHaveBeenCalledWith(1, 'bento.activeWorkspaceId');
  });

  it('bootstraps imported Zen workspaces from window session data on first run', async () => {
    vi.mocked(browser.windows.getAll).mockResolvedValue([{ id: 7 } as browser.windows.Window]);
    vi.mocked(browser.sessions.getWindowValue).mockResolvedValue([
      {
        id: '{zen-space-1}',
        name: 'Research',
        icon: 'R',
        themeId: 'teal',
        createdAt: 100,
      },
      {
        id: '{zen-space-2}',
        name: 'Personal',
        createdAt: 101,
      },
    ]);

    const store = new WorkspaceStore();
    await store.init();

    expect(browser.sessions.getWindowValue).toHaveBeenCalledWith(7, 'bento.importedWorkspaces');
    expect(store.snapshot().workspaces).toEqual([
      {
        id: '{zen-space-1}',
        name: 'Research',
        icon: 'R',
        themeId: 'teal',
        createdAt: 100,
      },
      {
        id: '{zen-space-2}',
        name: 'Personal',
        createdAt: 101,
      },
    ]);
    expect(store.snapshot().activeId).toBe('{zen-space-1}');
  });

  it('adopts imported Zen workspaces after the first-run default already exists', async () => {
    const store = new WorkspaceStore();
    await store.init();
    store.assignAvailable(7);

    vi.mocked(browser.windows.getAll).mockResolvedValue([{ id: 7 } as browser.windows.Window]);
    vi.mocked(browser.sessions.getWindowValue).mockImplementation(async (_windowId, key) => {
      if (key === 'bento.importedWorkspaces') {
        return [
          {
            id: '{zen-space-1}',
            name: 'Research',
            themeId: 'legacy-custom',
            createdAt: 100,
          },
          {
            id: '{zen-space-2}',
            name: 'Personal',
            themeId: 'standard-harbour',
            createdAt: 101,
          },
        ];
      }
      if (key === 'bento.activeWorkspaceId') return '{zen-space-2}';
      return undefined;
    });

    await store.adoptImportedWorkspacesFromSession(7);

    expect(store.snapshot().workspaces).toEqual([
      {
        id: '{zen-space-1}',
        name: 'Research',
        themeId: 'legacy-custom',
        createdAt: 100,
      },
      {
        id: '{zen-space-2}',
        name: 'Personal',
        themeId: 'standard-harbour',
        createdAt: 101,
      },
    ]);
    expect(store.snapshot().activeId).toBe('{zen-space-2}');
    expect(store.snapshot().activeIdByWindow).toEqual({ 7: '{zen-space-2}' });
    expect(browser.sessions.removeWindowValue).toHaveBeenCalledWith(7, 'bento.importedWorkspaces');
  });

  it('preserves an explicitly empty imported theme id for presentation-time fallback', async () => {
    vi.mocked(browser.windows.getAll).mockResolvedValue([{ id: 7 } as browser.windows.Window]);
    vi.mocked(browser.sessions.getWindowValue).mockResolvedValue([
      { id: '{zen-space-1}', name: 'Research', themeId: '' },
    ]);

    const store = new WorkspaceStore();
    await store.init();

    expect(store.snapshot().workspaces[0]).toMatchObject({
      id: '{zen-space-1}',
      themeId: '',
    });
  });
});
