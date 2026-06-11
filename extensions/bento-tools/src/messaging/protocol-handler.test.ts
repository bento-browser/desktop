import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type HandlerContext } from './protocol-handler';

function createCloseContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    tabs: {
      markClosing: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockReturnValue([]),
      isClosing: vi.fn().mockReturnValue(false),
      assignWorkspaceEagerly: vi.fn(),
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
    preferWorkspaceActivationTab: vi.fn(),
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
        get: vi.fn().mockResolvedValue({ id: 123, windowId: 1 }),
        update: vi.fn().mockResolvedValue({ id: 123 }),
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

  it('removes pinned-panel bindings when a DevTools panel is removed', async () => {
    const removeForTab = vi.fn();
    const ctx = createCloseContext({
      panels: {
        isDevtoolsPanel: vi.fn().mockReturnValue(true),
        remove: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['panels'],
      pinnedPanels: {
        removeForTab,
      } as unknown as HandlerContext['pinnedPanels'],
    });

    handle({ type: 'panel/remove', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(123);
    });
    expect(removeForTab).toHaveBeenCalledWith(123);
    expect(ctx.panels.remove).toHaveBeenCalledWith('ws-1', 123);
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1');
  });

  it('promotes the leftmost panel before closing the active final sidebar tab', async () => {
    const ctx = createCloseContext({
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn().mockReturnValue([
          { id: 10, windowId: 1, workspaceId: 'ws-1', active: true },
          { id: 20, windowId: 1, workspaceId: 'ws-1', active: false },
        ]),
        isClosing: vi.fn().mockReturnValue(false),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn((id: number) => (id === 20 ? ['ws-1'] : [])),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
        getPanels: vi.fn().mockReturnValue([20]),
        remove: vi.fn().mockReturnValue(true),
        insertAt: vi.fn(),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tab/close', id: 10 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(20, { active: true });
    });
    expect(ctx.panels.remove).toHaveBeenCalledWith('ws-1', 20);
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(20, 'ws-1');
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1', { windowId: 1 });
    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(10);
    });
  });

  it('closes each selected tab once for a batch close action', async () => {
    const ctx = createCloseContext({
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn().mockReturnValue([
          { id: 10, windowId: 1, workspaceId: 'ws-1', active: false },
          { id: 20, windowId: 1, workspaceId: 'ws-1', active: false },
        ]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn().mockReturnValue([]),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tabs/close', ids: [10, 20, 20, 999] }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(10);
      expect(browser.tabs.remove).toHaveBeenCalledWith(20);
    });
    expect(browser.tabs.remove).toHaveBeenCalledTimes(2);
    expect(ctx.tabs.markClosing).toHaveBeenCalledWith(10);
    expect(ctx.tabs.markClosing).toHaveBeenCalledWith(20);
  });
});

describe('protocol handler tab mute controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 123, mutedInfo: { muted: false } }),
        update: vi.fn().mockResolvedValue({ id: 123, mutedInfo: { muted: true } }),
      },
    });
  });

  it('toggles the tab muted state from the live Firefox tab state', async () => {
    const ctx = createCloseContext();

    handle({ type: 'tab/toggleMuted', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(123, { muted: true });
    });
  });
});

describe('protocol handler devtools panels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        setTabValue: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('adds a trusted devtools tab as an ephemeral panel', async () => {
    const ctx = createCloseContext({
      settings: {
        snapshot: vi.fn().mockReturnValue({ defaultPanelWidthPx: 640 }),
      } as unknown as HandlerContext['settings'],
      panels: {
        addDevtoolsPanel: vi.fn().mockReturnValue(true),
        setWidth: vi.fn(),
      } as unknown as HandlerContext['panels'],
      tabs: {
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
    });

    handle({ type: 'panel/addDevtools', tabId: 99, forTabId: 1, inspectedTabId: 1 }, ctx);

    expect(ctx.panels.addDevtoolsPanel).toHaveBeenCalledWith('ws-1', 99, 1, 1);
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(99, 'ws-1');
    expect(ctx.panels.setWidth).toHaveBeenCalledWith(99, 640);
    expect(ctx.syncPanelMarkers).toHaveBeenCalledWith('ws-1');
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1', { scrollToPanelTabId: 99 });
    await vi.waitFor(() => {
      expect(browser.sessions.setTabValue).toHaveBeenCalledWith(99, 'bento.isDevtoolsPanel', '1');
    });
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
    expect(ctx.pinnedPanels.removeForTab).not.toHaveBeenCalled();
    expect(ctx.workspaces.delete).toHaveBeenCalledWith('ws-old');
  });
});

describe('protocol handler tab folders', () => {
  it('creates a folder in the active workspace and assigns only valid normal tabs', async () => {
    const setFolder = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn(() => ({
      id: 'folder-1',
      workspaceId: 'ws-1',
      name: 'New folder',
      order: 0,
      collapsed: false,
      createdAt: 1,
    }));
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => [
          { id: 1, workspaceId: 'ws-1', pinned: false },
          { id: 2, workspaceId: 'ws-1', pinned: true },
          { id: 3, workspaceId: 'ws-2', pinned: false },
        ]),
        setFolder,
      },
      workspaces: {
        getActiveId: vi.fn(() => 'ws-1'),
      },
      settings: {},
      panels: {},
      pinnedPanels: {},
      tabFolders: {
        create,
      },
      savedPanels: {},
      backup: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'tabFolder/create', id: 'folder-1', tabIds: [1, 2, 3] }, ctx);

    await vi.waitFor(() => {
      expect(setFolder).toHaveBeenCalledTimes(1);
    });
    expect(create).toHaveBeenCalledWith({
      id: 'folder-1',
      workspaceId: 'ws-1',
      name: undefined,
    });
    expect(setFolder).toHaveBeenCalledWith(1, 'folder-1');
  });

  it('deleting a folder clears live tab memberships', async () => {
    const setFolder = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => [
          { id: 1, folderId: 'folder-1' },
          { id: 2, folderId: 'folder-2' },
        ]),
        setFolder,
      },
      workspaces: {},
      settings: {},
      panels: {},
      pinnedPanels: {},
      tabFolders: {
        delete: vi.fn(() => ({
          id: 'folder-1',
          workspaceId: 'ws-1',
          name: 'Folder',
          order: 0,
          collapsed: false,
          createdAt: 1,
        })),
      },
      savedPanels: {},
      backup: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'tabFolder/delete', id: 'folder-1' }, ctx);

    await vi.waitFor(() => {
      expect(setFolder).toHaveBeenCalledWith(1, null);
    });
    expect(setFolder).toHaveBeenCalledTimes(1);
  });

  it('moves a folder and its member tabs to another workspace', async () => {
    const assignWorkspace = vi.fn().mockResolvedValue(undefined);
    const moveToWorkspace = vi.fn(() => ({
      id: 'folder-1',
      workspaceId: 'ws-2',
      name: 'Folder',
      order: 0,
      collapsed: false,
      createdAt: 1,
    }));
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => [
          { id: 1, workspaceId: 'ws-1', folderId: 'folder-1', pinned: false },
          { id: 2, workspaceId: 'ws-1', folderId: 'folder-1', pinned: true },
          { id: 3, workspaceId: 'ws-1', folderId: 'folder-2', pinned: false },
        ]),
        assignWorkspace,
      },
      workspaces: {
        has: vi.fn((id: string) => id === 'ws-1' || id === 'ws-2'),
        getActiveId: vi.fn(() => 'ws-1'),
        snapshot: vi.fn(() => ({
          workspaces: [
            { id: 'ws-1', name: 'One', createdAt: 1 },
            { id: 'ws-2', name: 'Two', createdAt: 2 },
          ],
          activeId: 'ws-1',
          activeIdByWindow: { 1: 'ws-1' },
        })),
        forgetWindow: vi.fn(),
        delete: vi.fn(),
        activate: vi.fn(() => 'activated'),
      },
      settings: {},
      panels: {
        getPanels: vi.fn(() => []),
      },
      pinnedPanels: {},
      tabFolders: {
        get: vi.fn(() => ({
          id: 'folder-1',
          workspaceId: 'ws-1',
          name: 'Folder',
          order: 0,
          collapsed: false,
          createdAt: 1,
        })),
        moveToWorkspace,
      },
      savedPanels: {},
      backup: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'tabFolder/assignWorkspace', id: 'folder-1', workspaceId: 'ws-2' }, ctx);

    await vi.waitFor(() => {
      expect(moveToWorkspace).toHaveBeenCalledWith('folder-1', 'ws-2');
    });
    expect(assignWorkspace).toHaveBeenCalledTimes(1);
    expect(assignWorkspace).toHaveBeenCalledWith(1, 'ws-2', { preserveFolderId: 'folder-1' });
  });
});

describe('protocol handler pinned panels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({
          id: 99,
          url: 'about:devtools-toolbox?type=tab&id=10&tool=inspector',
          title: 'DevTools',
        }),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not add a pinned-panel binding for DevTools panels', async () => {
    const add = vi.fn();
    const ctx = {
      workspaces: {
        has: vi.fn().mockReturnValue(true),
      },
      panels: {
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue(['ws-1']),
        isDevtoolsPanel: vi.fn().mockReturnValue(true),
      },
      pinnedPanels: {
        add,
      },
      tabs: {},
      settings: {},
      tabFolders: {},
      savedPanels: {},
      backup: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'pinnedPanel/add', workspaceId: 'ws-1', tabId: 99 }, ctx);

    await Promise.resolve();
    expect(add).not.toHaveBeenCalled();
    expect(ctx.emitPanelsSync).not.toHaveBeenCalled();
  });
});

describe('protocol handler command palette navigation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        removeTabValue: vi.fn().mockResolvedValue(undefined),
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 42 }),
        update: vi.fn().mockResolvedValue({ id: 42 }),
      },
      windows: {
        update: vi.fn().mockResolvedValue({ id: 1 }),
      },
    });
  });

  it('activates the owning workspace before focusing a normal tab', async () => {
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi
          .fn()
          .mockReturnValue([{ id: 42, windowId: 1, workspaceId: 'ws-target', active: false }]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        getActiveId: vi.fn().mockReturnValue('ws-old'),
        activate: vi.fn().mockReturnValue('activated'),
        findOwningWindow: vi.fn().mockReturnValue(null),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tab/activate', id: 42 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });
    });
    expect(ctx.workspaces.activate).toHaveBeenCalledWith('ws-target', 1);
    expect(ctx.preferWorkspaceActivationTab).toHaveBeenCalledWith('ws-target', 42, 1);
    expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(42, 'bento.isPanel');
  });

  it('focuses a panel through panels/sync instead of activating it as the main tab', () => {
    const ctx = createCloseContext({
      workspaces: {
        has: vi.fn().mockReturnValue(true),
        findOwningWindow: vi.fn().mockReturnValue(null),
        activate: vi.fn().mockReturnValue('noop'),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue(['ws-1']),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'panel/focus', workspaceId: 'ws-1', id: 77 }, ctx);

    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1', {
      scrollToPanelTabId: 77,
      windowId: 1,
    });
  });
});

describe('protocol handler pinned panels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        create: vi.fn().mockResolvedValue({ id: 88, windowId: 1 }),
        get: vi.fn().mockRejectedValue(new Error('stale synthetic pin')),
      },
      windows: {
        update: vi.fn().mockResolvedValue({ id: 1 }),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces repeated opens for the same URL-backed pin', async () => {
    const ctx = createCloseContext({
      tabs: {
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        has: vi.fn().mockReturnValue(true),
        findOwningWindow: vi.fn().mockReturnValue(null),
        activate: vi.fn().mockReturnValue('noop'),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
        getRootNodeIds: vi.fn().mockReturnValue([]),
        insertAt: vi.fn().mockReturnValue(true),
        setWidth: vi.fn(),
      } as unknown as HandlerContext['panels'],
      pinnedPanels: {
        get: vi.fn().mockReturnValue({
          workspaceId: 'ws-1',
          tabId: -1,
          order: 0,
          url: 'https://panel.example.test/',
          title: 'Panel',
        }),
        rebindTabId: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['pinnedPanels'],
      settings: {
        snapshot: vi.fn().mockReturnValue({ defaultPanelWidthPx: 360 }),
      } as unknown as HandlerContext['settings'],
    });

    handle({ type: 'pinnedPanel/open', workspaceId: 'ws-1', tabId: -1 }, ctx);
    handle({ type: 'pinnedPanel/open', workspaceId: 'ws-1', tabId: -1 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    });
    expect(ctx.panels.insertAt).toHaveBeenCalledTimes(1);
    expect(ctx.pinnedPanels.rebindTabId).toHaveBeenCalledTimes(1);
  });

  it('uses a lazily restored pinned panel instead of creating a duplicate', async () => {
    vi.useFakeTimers();
    vi.mocked(browser.tabs.get).mockImplementation(async (tabId: number) => {
      if (tabId === 77) return { id: 77 } as browser.tabs.Tab;
      throw new Error('stale synthetic pin');
    });
    const entry = {
      workspaceId: 'ws-1',
      tabId: -1,
      order: 0,
      url: 'https://panel.example.test/',
      title: 'Panel',
    };
    const ctx = createCloseContext({
      tabs: {
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        has: vi.fn().mockReturnValue(true),
        findOwningWindow: vi.fn().mockReturnValue(null),
        activate: vi.fn().mockReturnValue('activated'),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        findWorkspacesContainingPanelOrSubPanel: vi.fn((tabId: number) =>
          tabId === 77 ? ['ws-1'] : [],
        ),
        getRootNodeIds: vi.fn().mockReturnValue([]),
        insertAt: vi.fn().mockReturnValue(true),
        setWidth: vi.fn(),
      } as unknown as HandlerContext['panels'],
      pinnedPanels: {
        get: vi.fn().mockReturnValue(entry),
        findByStableIdentity: vi.fn().mockReturnValue({ ...entry, tabId: 77 }),
        rebindTabId: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['pinnedPanels'],
      settings: {
        snapshot: vi.fn().mockReturnValue({ defaultPanelWidthPx: 360 }),
      } as unknown as HandlerContext['settings'],
    });

    handle({ type: 'pinnedPanel/open', workspaceId: 'ws-1', tabId: -1 }, ctx);
    await vi.advanceTimersByTimeAsync(300);

    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(ctx.panels.insertAt).not.toHaveBeenCalled();
    expect(ctx.pinnedPanels.rebindTabId).not.toHaveBeenCalled();
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1', {
      scrollToPanelTabId: 77,
      windowId: 1,
    });
  });
});

describe('protocol handler tab creation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        create: vi.fn().mockResolvedValue({ id: 99, windowId: 7 }),
        update: vi.fn().mockResolvedValue({ id: 99 }),
        query: vi.fn().mockResolvedValue([]),
      },
    });
  });

  it('assigns tab/openUrl to the source workspace before activating the new tab', async () => {
    const order: string[] = [];
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi.fn().mockReturnValue([]),
        assignWorkspaceEagerly: vi.fn(() => order.push('assign')),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        getActiveId: vi.fn().mockReturnValue('ws-current'),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        getPanels: vi.fn().mockReturnValue([]),
      } as unknown as HandlerContext['panels'],
      sourceWindowId: 7,
    });
    vi.mocked(browser.tabs.update).mockImplementation(async () => {
      order.push('activate');
      return { id: 99 } as browser.tabs.Tab;
    });

    handle({ type: 'tab/openUrl', url: 'https://example.com/' }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(99, { active: true });
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: 'https://example.com/',
      active: false,
      windowId: 7,
    });
    expect(ctx.workspaces.getActiveId).toHaveBeenCalledWith(7);
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(99, 'ws-current');
    expect(order).toEqual(['assign', 'activate']);
  });

  it('assigns tab/create to the source workspace before activating the blank tab', async () => {
    const order: string[] = [];
    const ctx = createCloseContext({
      tabs: {
        assignWorkspaceEagerly: vi.fn(() => order.push('assign')),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        getActiveId: vi.fn().mockReturnValue('ws-current'),
      } as unknown as HandlerContext['workspaces'],
      sourceWindowId: 7,
    });
    vi.mocked(browser.tabs.update).mockImplementation(async () => {
      order.push('activate');
      return { id: 99 } as browser.tabs.Tab;
    });

    handle({ type: 'tab/create' }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(99, { active: true });
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      active: false,
      windowId: 7,
    });
    expect(ctx.workspaces.getActiveId).toHaveBeenCalledWith(7);
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(99, 'ws-current');
    expect(order).toEqual(['assign', 'activate']);
  });
});

describe('protocol handler workspace updates', () => {
  it('re-emits panels sync when a workspace theme changes', () => {
    const ctx = createCloseContext({
      workspaces: {
        update: vi.fn(),
      } as unknown as HandlerContext['workspaces'],
    });

    handle({ type: 'workspace/update', id: 'ws-1', changes: { themeId: 'teal' } }, ctx);

    expect(ctx.workspaces.update).toHaveBeenCalledWith('ws-1', { themeId: 'teal' });
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1');
  });

  it('does not re-emit panels sync for non-theme workspace metadata updates', () => {
    const ctx = createCloseContext({
      workspaces: {
        update: vi.fn(),
      } as unknown as HandlerContext['workspaces'],
    });

    handle({ type: 'workspace/update', id: 'ws-1', changes: { name: 'Research' } }, ctx);

    expect(ctx.workspaces.update).toHaveBeenCalledWith('ws-1', { name: 'Research' });
    expect(ctx.emitPanelsSync).not.toHaveBeenCalled();
  });
});
