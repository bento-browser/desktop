import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('bootstraps imported Zen workspaces from window session data on first run', async () => {
    vi.mocked(browser.windows.getAll).mockResolvedValue([{ id: 7 } as browser.windows.Window]);
    vi.mocked(browser.sessions.getWindowValue).mockResolvedValue([
      {
        id: '{zen-space-1}',
        name: 'Research',
        icon: 'R',
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
            createdAt: 100,
          },
          {
            id: '{zen-space-2}',
            name: 'Personal',
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
        createdAt: 100,
      },
      {
        id: '{zen-space-2}',
        name: 'Personal',
        createdAt: 101,
      },
    ]);
    expect(store.snapshot().activeId).toBe('{zen-space-2}');
    expect(store.snapshot().activeIdByWindow).toEqual({ 7: '{zen-space-2}' });
    expect(browser.sessions.removeWindowValue).toHaveBeenCalledWith(7, 'bento.importedWorkspaces');
  });
});
