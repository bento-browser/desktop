import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type HandlerContext } from './protocol-handler';

function createCloseContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    tabs: {
      markClosing: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockReturnValue([]),
      isClosing: vi.fn().mockReturnValue(false),
    },
    workspaces: {
      getActiveId: vi.fn().mockReturnValue('ws-1'),
    },
    settings: {},
    panels: {
      findWorkspacesContainingTab: vi.fn().mockReturnValue(['ws-1']),
      getPanelLayoutStatus: vi.fn().mockReturnValue('root-panel'),
      remove: vi.fn().mockReturnValue(true),
    },
    pinnedPanels: {},
    savedPanels: {},
    backup: {},
    send: vi.fn(),
    emitPanelsSync: vi.fn(),
    syncPanelMarkers: vi.fn(),
    sourceWindowId: 1,
    ...overrides,
  } as unknown as HandlerContext;
}

describe('protocol handler panel close', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 123 }),
        remove: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('preserves panel session markers when closing a panel for Cmd+Shift+T restore', async () => {
    const ctx = createCloseContext();

    handle({ type: 'tab/close', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(123);
    });
    expect(browser.sessions.removeTabValue).not.toHaveBeenCalled();
    expect(ctx.panels.remove).toHaveBeenCalledWith('ws-1', 123);
    expect(ctx.syncPanelMarkers).toHaveBeenCalledWith('ws-1');
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1');
  });
});

describe('protocol handler batch tab workspace moves', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 1 }),
        update: vi.fn().mockResolvedValue({ id: 1 }),
      },
    });
  });

  it('creates a new workspace and assigns each selected tab to it', async () => {
    const tabState = new Map([
      [1, { id: 1, workspaceId: 'ws-old' }],
      [2, { id: 2, workspaceId: 'ws-old' }],
    ]);
    const assignWorkspace = vi.fn(async (id: number, workspaceId: string) => {
      const tab = tabState.get(id);
      if (tab) tab.workspaceId = workspaceId;
    });
    let activeWorkspaceId = 'ws-old';
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => Array.from(tabState.values())),
        assignWorkspace,
      },
      workspaces: {
        has: vi.fn((id: string) => id === 'ws-new' || id === 'ws-old'),
        snapshot: vi.fn(() => ({
          workspaces: [{ id: 'ws-old', name: 'Personal', createdAt: 1 }],
          activeId: 'ws-old',
          activeIdByWindow: { 1: 'ws-old' },
        })),
        create: vi.fn(() => ({ id: 'ws-new', name: 'Workspace 2', createdAt: 2 })),
        activate: vi.fn((id: string) => {
          activeWorkspaceId = id;
          return 'activated';
        }),
        getActiveId: vi.fn(() => activeWorkspaceId),
        delete: vi.fn(),
      },
      settings: {},
      panels: {
        getPanels: vi.fn(() => []),
      },
      pinnedPanels: {
        removeForTab: vi.fn(),
      },
      savedPanels: {},
      backup: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'tabs/moveToNewWorkspace', ids: [1, 2, 2, 999] }, ctx);

    await vi.waitFor(() => {
      expect(assignWorkspace).toHaveBeenCalledTimes(2);
    });
    expect(ctx.workspaces.create).toHaveBeenCalledWith({ name: 'Workspace 2' }, 1, {
      activate: false,
    });
    expect(ctx.workspaces.activate).toHaveBeenCalledWith('ws-new', 1);
    expect(assignWorkspace).toHaveBeenNthCalledWith(1, 1, 'ws-new');
    expect(assignWorkspace).toHaveBeenNthCalledWith(2, 2, 'ws-new');
    expect(ctx.pinnedPanels.removeForTab).toHaveBeenCalledWith(1);
    expect(ctx.pinnedPanels.removeForTab).toHaveBeenCalledWith(2);
    expect(ctx.workspaces.delete).toHaveBeenCalledWith('ws-old');
  });
});
