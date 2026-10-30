import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handle, type HandlerContext } from './protocol-handler';
import { createWindowHandoffGuard } from '../workspaces/EmptiedWorkspace';
import { TabRegistry } from '../tabs/TabRegistry';
import { PanelStore } from '../panels/PanelStore';
import { bentoTabMoves } from '../tabs/AdoptedTab';

function createCloseContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const context = {
    tabs: {
      isPrivate: vi.fn(() => false),
      markClosing: vi.fn().mockResolvedValue(undefined),
      unmarkClosing: vi.fn().mockResolvedValue(undefined),
      assignWorkspace: vi.fn().mockResolvedValue(undefined),
      snapshot: vi.fn().mockReturnValue([]),
      isClosing: vi.fn().mockReturnValue(false),
      assignWorkspaceEagerly: vi.fn(),
    },
    workspaces: {
      getActiveId: vi.fn().mockReturnValue('ws-1'),
      has: vi.fn().mockReturnValue(true),
      hasForWindow: vi.fn().mockReturnValue(true),
    },
    settings: {},
    panels: {
      findWorkspacesContainingTab: vi.fn().mockReturnValue(['ws-1']),
      getPanelLayoutStatus: vi.fn().mockReturnValue('root-panel'),
      getPanelRestoreLocation: vi.fn().mockReturnValue({
        workspaceId: 'ws-1',
        rootIndex: 1,
        containingRootNodeId: 'panel:123',
      }),
      getWidth: vi.fn().mockReturnValue(undefined),
      getHeaderHidden: vi.fn().mockReturnValue(false),
      remove: vi.fn().mockReturnValue(true),
      insertAtRestoreLocation: vi.fn().mockReturnValue(true),
      setWidth: vi.fn(),
      setHeaderHidden: vi.fn(),
    },
    pinnedPanels: {},
    savedPanels: {},
    send: vi.fn(),
    emitPanelsSync: vi.fn(),
    syncPanelMarkers: vi.fn(),
    handoff: createWindowHandoffGuard(),
    preferWorkspaceActivationTab: vi.fn(),
    sourceWindowId: 1,
    ...overrides,
  } as unknown as HandlerContext;
  context.panels.isDevtoolsPanel ??= vi.fn(() => false);
  return context;
}

/** Firefox drops a closed tab's id; a tab kept by a beforeunload prompt keeps it. */
function stubClosingBrowser(options: { keep?: ReadonlySet<number> } = {}): void {
  const closed = new Set<number>();
  vi.stubGlobal('browser', {
    sessions: {
      removeTabValue: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      get: vi.fn(async (id: number) => {
        if (closed.has(id)) throw new Error(`Invalid tab ID: ${id}`);
        return { id, windowId: 1 };
      }),
      update: vi.fn().mockResolvedValue({ id: 123 }),
      remove: vi.fn(async (id: number) => {
        if (!options.keep?.has(id)) closed.add(id);
      }),
    },
  });
}

describe('protocol handler panel close', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubClosingBrowser();
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
    expect(ctx.tabs.markClosing).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctx.tabs.markClosing).mock.calls).toEqual([
      [123, { preserveSessionMembership: true }],
      [123, { preserveSessionMembership: true }],
    ]);
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
    expect(ctx.tabs.markClosing).toHaveBeenCalledWith(123, {
      preserveSessionMembership: undefined,
    });
  });

  it('promotes the leftmost panel before closing the active final sidebar tab', async () => {
    const ctx = createCloseContext({
      tabs: {
        isPrivate: vi.fn(() => false),
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
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
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
    expect(vi.mocked(ctx.tabs.markClosing).mock.calls).toEqual([
      [10, { preserveSessionMembership: true }],
      [10, { preserveSessionMembership: true }],
    ]);
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
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tabs/close', ids: [10, 20, 20, 999] }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(10);
      expect(browser.tabs.remove).toHaveBeenCalledWith(20);
    });
    expect(browser.tabs.remove).toHaveBeenCalledTimes(2);
    for (const id of [10, 20]) {
      expect(vi.mocked(ctx.tabs.markClosing).mock.calls.filter(([tabId]) => tabId === id)).toEqual([
        [id, { preserveSessionMembership: true }],
        [id, { preserveSessionMembership: true }],
      ]);
    }
  });
});

describe('protocol handler close that Firefox does not commit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['ws-1', 'ws-2', null])(
    'rolls back retained session membership with the real registry when the window shows %s',
    async (shownWorkspaceId) => {
      stubClosingBrowser({ keep: new Set([123]) });
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
      const values = new Map<string, string | object>([
        ['bento.workspaceId', 'ws-1'],
        ['bento.folderId', 'folder-1'],
      ]);
      Object.assign(browser.sessions, {
        getTabValue: vi.fn(async (_id: number, key: string) => values.get(key)),
        setTabValue: vi.fn(async (_id: number, key: string, value: string | object) => {
          values.set(key, value);
        }),
        removeTabValue: vi.fn(async (_id: number, key: string) => {
          values.delete(key);
        }),
      });
      Object.assign(browser.tabs, {
        query: vi.fn(async () => [
          { id: 123, windowId: 1, index: 0, title: 'Kept', active: false, pinned: false },
        ]),
        ...Object.fromEntries(
          ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached'].map(
            (event) => [event, { addListener: vi.fn() }],
          ),
        ),
      });
      const tabs = new TabRegistry();
      await tabs.init();
      const ctx = createCloseContext({
        tabs,
        workspaces: {
          getActiveId: vi.fn(() => shownWorkspaceId),
          hasForWindow: vi.fn(() => true),
        } as unknown as HandlerContext['workspaces'],
        panels: {
          findWorkspacesContainingTab: vi.fn(() => []),
          findWorkspacesContainingPanelOrSubPanel: vi.fn(() => []),
          getWidth: vi.fn(),
          getHeaderHidden: vi.fn(() => false),
        } as unknown as HandlerContext['panels'],
      });
      handle({ type: 'tab/close', id: 123 }, ctx);
      await vi.waitFor(() => {
        expect(browser.tabs.remove).toHaveBeenCalledWith(123);
        expect(tabs.isClosing(123)).toBe(false);
        expect(tabs.snapshot()[0]?.workspaceId).toBe(shownWorkspaceId ?? undefined);
      });
      await tabs.hydrateWorkspaceIds({ attempts: 1 });
      expect(tabs.snapshot()[0]?.workspaceId).toBe(shownWorkspaceId ?? undefined);
      expect(tabs.snapshot()[0]?.folderId).toBe(
        shownWorkspaceId === 'ws-1' ? 'folder-1' : undefined,
      );
      expect(values.get('bento.workspaceId')).toBe(shownWorkspaceId ?? undefined);
      expect(values.get('bento.folderId')).toBe(
        shownWorkspaceId === 'ws-1' ? 'folder-1' : undefined,
      );
      expect(values.has('bento.closingTab')).toBe(false);
    },
  );

  it('puts a panel back when the user keeps its tab on a beforeunload prompt', async () => {
    stubClosingBrowser({ keep: new Set([123]) });
    const ctx = createCloseContext({
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        snapshot: vi
          .fn()
          .mockReturnValue([{ id: 123, windowId: 1, workspaceId: 'ws-1', active: false }]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn().mockReturnValue(['ws-1']),
        getPanelLayoutStatus: vi.fn().mockReturnValue('root-panel'),
        getPanelRestoreLocation: vi.fn().mockReturnValue({
          workspaceId: 'ws-1',
          rootIndex: 2,
          containingRootNodeId: 'panel:99',
        }),
        getWidth: vi.fn().mockReturnValue(420),
        getHeaderHidden: vi.fn().mockReturnValue(true),
        remove: vi.fn().mockReturnValue(true),
        insertAtRestoreLocation: vi.fn().mockReturnValue(true),
        setWidth: vi.fn(),
        setHeaderHidden: vi.fn(),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tab/close', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(ctx.tabs.unmarkClosing).toHaveBeenCalledWith(123);
    });
    expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(123, 'ws-1', {});
    expect(ctx.panels.insertAtRestoreLocation).toHaveBeenCalledWith('ws-1', 123, {
      workspaceId: 'ws-1',
      rootIndex: 2,
      containingRootNodeId: 'panel:99',
    });
    expect(ctx.panels.setWidth).toHaveBeenCalledWith(123, 420);
    expect(ctx.panels.setHeaderHidden).toHaveBeenCalledWith(123, true);
    // Once for the close, once more for the restore.
    expect(ctx.syncPanelMarkers).toHaveBeenCalledTimes(2);
    expect(ctx.emitPanelsSync).toHaveBeenCalledTimes(2);
  });

  it('gives a kept sidebar tab its workspace and folder back', async () => {
    stubClosingBrowser({ keep: new Set([10]) });
    const ctx = createCloseContext({
      workspaces: {
        getActiveId: vi.fn().mockReturnValue('ws-2'),
        has: vi.fn().mockReturnValue(true),
        hasForWindow: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['workspaces'],
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        snapshot: vi
          .fn()
          .mockReturnValue([
            { id: 10, windowId: 1, workspaceId: 'ws-2', folderId: 'folder-1', active: false },
          ]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn().mockReturnValue([]),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
        insertAtRestoreLocation: vi.fn(),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tab/close', id: 10 }, ctx);

    await vi.waitFor(() => {
      expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(10, 'ws-2', {
        preserveFolderId: 'folder-1',
      });
    });
    expect(ctx.tabs.unmarkClosing).toHaveBeenCalledWith(10);
    expect(ctx.panels.insertAtRestoreLocation).not.toHaveBeenCalled();
    expect(ctx.emitPanelsSync).not.toHaveBeenCalled();
  });

  describe('when the window of the kept tab changed workspace during the prompt', () => {
    // Window 1 held the panel's prompt, then switched to ws-2; window 2 now shows ws-1.
    function switchedContext(panelTabIds: number[]) {
      const shown: Record<number, string> = { 1: 'ws-2', 2: 'ws-1' };
      return createCloseContext({
        workspaces: {
          getActiveId: vi.fn((windowId: number) => shown[windowId] ?? null),
          has: vi.fn().mockReturnValue(true),
          hasForWindow: vi.fn().mockReturnValue(true),
        } as unknown as HandlerContext['workspaces'],
        tabs: {
          markClosing: vi.fn().mockResolvedValue(undefined),
          unmarkClosing: vi.fn().mockResolvedValue(undefined),
          assignWorkspace: vi.fn().mockResolvedValue(undefined),
          snapshot: vi
            .fn()
            .mockReturnValue([
              { id: 123, windowId: 1, workspaceId: 'ws-1', folderId: 'folder-1', active: false },
            ]),
          isClosing: vi.fn().mockReturnValue(false),
        } as unknown as HandlerContext['tabs'],
        panels: {
          findWorkspacesContainingTab: vi.fn().mockReturnValue(panelTabIds.length ? ['ws-1'] : []),
          findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
          getPanelLayoutStatus: vi.fn().mockReturnValue('root-panel'),
          getPanelRestoreLocation: vi.fn().mockReturnValue({
            workspaceId: 'ws-1',
            rootIndex: 0,
            containingRootNodeId: 'panel:123',
          }),
          getWidth: vi.fn().mockReturnValue(420),
          getHeaderHidden: vi.fn().mockReturnValue(false),
          remove: vi.fn().mockReturnValue(true),
          insertAtRestoreLocation: vi.fn().mockReturnValue(true),
          setWidth: vi.fn(),
          setHeaderHidden: vi.fn(),
        } as unknown as HandlerContext['panels'],
      });
    }

    beforeEach(() => {
      stubClosingBrowser({ keep: new Set([123]) });
    });

    it('joins the workspace its window shows as a normal tab, not as a panel of the old one', async () => {
      const ctx = switchedContext([123]);

      handle({ type: 'tab/close', id: 123 }, ctx);

      await vi.waitFor(() => {
        expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(123, 'ws-2');
      });
      // The panel slot in ws-1 would put the tab in a layout window 1 does not render.
      expect(ctx.panels.insertAtRestoreLocation).not.toHaveBeenCalled();
      expect(ctx.panels.setWidth).not.toHaveBeenCalled();
      // The marker would make the next activation treat the tab as a restored panel.
      expect(browser.sessions.removeTabValue).toHaveBeenCalledWith(123, 'bento.isPanel');
      expect(ctx.tabs.assignWorkspace).not.toHaveBeenCalledWith(123, 'ws-1', expect.anything());
    });

    it('also moves a kept sidebar tab to the workspace its window shows', async () => {
      const ctx = switchedContext([]);

      handle({ type: 'tab/close', id: 123 }, ctx);

      await vi.waitFor(() => {
        expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(123, 'ws-2');
      });
      expect(ctx.tabs.assignWorkspace).toHaveBeenCalledTimes(1);
      expect(browser.sessions.removeTabValue).not.toHaveBeenCalledWith(123, 'bento.isPanel');
    });
  });

  it('falls back to the window workspace when the tab workspace was deleted meanwhile', async () => {
    stubClosingBrowser({ keep: new Set([10]) });
    const ctx = createCloseContext({
      workspaces: {
        getActiveId: vi.fn().mockReturnValue('ws-1'),
        has: vi.fn((id: string) => id !== 'ws-gone'),
        hasForWindow: vi.fn((id: string) => id !== 'ws-gone'),
      } as unknown as HandlerContext['workspaces'],
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        snapshot: vi
          .fn()
          .mockReturnValue([
            { id: 10, windowId: 1, workspaceId: 'ws-gone', folderId: 'folder-1', active: false },
          ]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn().mockReturnValue([]),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tab/close', id: 10 }, ctx);

    await vi.waitFor(() => {
      expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(10, 'ws-1');
    });
  });

  it('leaves a closed tab alone', async () => {
    stubClosingBrowser();
    const ctx = createCloseContext();

    handle({ type: 'tab/close', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(123);
    });
    // Let the post-remove existence check settle.
    await vi.waitFor(() => {
      expect(browser.tabs.get).toHaveBeenCalledWith(123);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.tabs.unmarkClosing).not.toHaveBeenCalled();
    expect(ctx.panels.insertAtRestoreLocation).not.toHaveBeenCalled();
  });

  it('restores a kept active tab closed through main-tab promotion', async () => {
    stubClosingBrowser({ keep: new Set([10]) });
    const ctx = createCloseContext({
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn().mockReturnValue([
          { id: 10, windowId: 1, workspaceId: 'ws-1', active: true },
          { id: 11, windowId: 1, workspaceId: 'ws-1', active: false },
        ]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn().mockReturnValue([]),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
        getPanels: vi.fn().mockReturnValue([]),
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'tab/close', id: 10 }, ctx);

    await vi.waitFor(() => {
      expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(10, 'ws-1', {});
    });
    expect(ctx.tabs.unmarkClosing).toHaveBeenCalledWith(10);
  });

  it('puts a pinned panel back when its close is cancelled', async () => {
    stubClosingBrowser({ keep: new Set([123]) });
    const ctx = createCloseContext({
      workspaces: {
        getActiveId: vi.fn().mockReturnValue('ws-1'),
        has: vi.fn().mockReturnValue(true),
        hasForWindow: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['workspaces'],
      tabs: {
        isPrivate: vi.fn(() => false),
        markClosing: vi.fn().mockResolvedValue(undefined),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        snapshot: vi
          .fn()
          .mockReturnValue([{ id: 123, windowId: 1, workspaceId: 'ws-1', active: false }]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      pinnedPanels: {
        has: vi.fn().mockReturnValue(true),
        hasForWindow: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['pinnedPanels'],
      panels: {
        findWorkspacesContainingTab: vi.fn().mockReturnValue(['ws-1']),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue(['ws-1']),
        isDevtoolsPanel: vi.fn().mockReturnValue(false),
        removeWithSubPanels: vi.fn().mockReturnValue([]),
        getPanelRestoreLocation: vi.fn().mockReturnValue({ workspaceId: 'ws-1', rootIndex: 0 }),
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
        insertAtRestoreLocation: vi.fn().mockReturnValue(true),
      } as unknown as HandlerContext['panels'],
    });

    handle({ type: 'pinnedPanel/close', workspaceId: 'ws-1', tabId: 123 }, ctx);

    await vi.waitFor(() => {
      expect(ctx.panels.insertAtRestoreLocation).toHaveBeenCalledWith('ws-1', 123, {
        workspaceId: 'ws-1',
        rootIndex: 0,
      });
    });
    expect(ctx.tabs.unmarkClosing).toHaveBeenCalledWith(123);
  });
});

describe('protocol handler main-tab close with panels in flight', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubClosingBrowser();
  });

  function mainCloseContext(options: { panelTabIds: number[]; closing: Set<number> }) {
    const tabs = [
      { id: 10, windowId: 1, workspaceId: 'ws-1', active: true },
      ...options.panelTabIds.map((id) => ({ id, windowId: 1, workspaceId: 'ws-1', active: false })),
    ];
    return createCloseContext({
      tabs: {
        markClosing: vi.fn().mockResolvedValue(undefined),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        snapshot: vi.fn().mockReturnValue(tabs),
        isClosing: vi.fn((id: number) => options.closing.has(id)),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      panels: {
        findWorkspacesContainingTab: vi.fn((id: number) =>
          options.panelTabIds.includes(id) ? ['ws-1'] : [],
        ),
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue([]),
        getPanels: vi.fn().mockReturnValue(options.panelTabIds),
        getWidth: vi.fn(),
        getHeaderHidden: vi.fn().mockReturnValue(false),
        remove: vi.fn().mockReturnValue(true),
        insertAt: vi.fn(),
      } as unknown as HandlerContext['panels'],
    });
  }

  it('does not promote a panel whose own close is in flight', async () => {
    const ctx = mainCloseContext({ panelTabIds: [20], closing: new Set([20]) });

    handle({ type: 'tab/closeMain', id: 10 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith(10);
    });
    // Promoting it fails to activate, and re-inserting it left a ghost panel in the layout.
    expect(ctx.panels.remove).not.toHaveBeenCalled();
    expect(ctx.panels.insertAt).not.toHaveBeenCalled();
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it('promotes the first panel that is still open when the leftmost one is closing', async () => {
    const ctx = mainCloseContext({ panelTabIds: [20, 21], closing: new Set([20]) });

    handle({ type: 'tab/closeMain', id: 10 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(21, { active: true });
    });
    expect(ctx.panels.remove).toHaveBeenCalledWith('ws-1', 21);
    expect(ctx.panels.remove).not.toHaveBeenCalledWith('ws-1', 20);
  });
});

describe('protocol handler workspace delete', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubClosingBrowser();
    vi.mocked(browser).windows = { remove: vi.fn().mockResolvedValue(undefined) } as never;
    vi.mocked(browser.tabs).create = vi.fn(async () => ({ id: 50 })) as never;
  });

  function deleteContext(options: {
    owner: number | null;
    ownerAfter: number | null;
    /** False when the activation left the replacement without a tab in the window. */
    replacementHasTab?: boolean;
  }) {
    const order: string[] = [];
    const ctx = createCloseContext({
      workspaces: {
        has: vi.fn().mockReturnValue(true),
        hasForWindow: vi.fn().mockReturnValue(true),
        findOwningWindow: vi.fn().mockReturnValue(options.owner),
        delete: vi.fn(() => order.push('delete')),
        flush: vi.fn(async () => {
          order.push('activate');
        }),
        getActiveIdByWindow: vi
          .fn()
          .mockReturnValue(options.ownerAfter === null ? {} : { 1: 'ws-other' }),
        snapshot: vi
          .fn()
          .mockReturnValue({ workspaces: [{ id: 'ws-other', name: 'Workspace 1' }] }),
        create: vi.fn(),
      } as unknown as HandlerContext['workspaces'],
      tabs: {
        markClosing: vi.fn(async (id: number) => {
          order.push(`mark ${id}`);
        }),
        unmarkClosing: vi.fn().mockResolvedValue(undefined),
        assignWorkspace: vi.fn().mockResolvedValue(undefined),
        assignWorkspaceEagerly: vi.fn().mockResolvedValue(true),
        snapshot: vi
          .fn()
          .mockReturnValue([
            { id: 5, windowId: 1, workspaceId: 'ws-gone' },
            { id: 6, windowId: 2, workspaceId: 'ws-gone' },
            ...(options.replacementHasTab === false
              ? []
              : [{ id: 7, windowId: 1, workspaceId: 'ws-other' }]),
          ]),
        isClosing: vi.fn().mockReturnValue(false),
      } as unknown as HandlerContext['tabs'],
      panels: { getPanels: vi.fn().mockReturnValue([]) } as unknown as HandlerContext['panels'],
    });
    return { ctx, order };
  }

  it('marks the tabs closing before the workspace goes, finishes the replacement, then closes them', async () => {
    const { ctx, order } = deleteContext({ owner: 1, ownerAfter: 1 });
    // Earlier tests can still have delayed single-tab removals in flight; only the batch counts.
    vi.mocked(browser.tabs.remove).mockImplementation(async (ids) => {
      if (Array.isArray(ids)) order.push('remove');
    });

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith([5, 6]);
    });
    // The store's own replacement activation is the only one: no global fallback event.
    expect(ctx.workspaces.delete).toHaveBeenCalledWith('ws-gone', { announceFallback: false });
    expect(order).toEqual(['mark 5', 'mark 6', 'delete', 'activate', 'remove']);
    expect(ctx.handoff.isActive(1)).toBe(false);
    expect(browser.windows.remove).not.toHaveBeenCalled();
  });

  it('opens a tab for the replacement itself when its activation left it without one', async () => {
    const { ctx } = deleteContext({ owner: 1, ownerAfter: 1, replacementHasTab: false });

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith([5, 6]);
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({ windowId: 1, active: true });
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(50, 'ws-other');
    expect(ctx.tabs.unmarkClosing).not.toHaveBeenCalled();
  });

  it('keeps the window tabs of the deleted workspace as tabs of the replacement when none can be opened', async () => {
    const { ctx } = deleteContext({ owner: 1, ownerAfter: 1, replacementHasTab: false });
    vi.mocked(browser.tabs.create).mockRejectedValue(new Error('no window'));

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith([6]);
    });
    // Tab 5 is the window's only way to keep working: it leaves the closing state and joins
    // the replacement, and only the tab in the other window is closed.
    expect(ctx.tabs.unmarkClosing).toHaveBeenCalledWith(5);
    expect(ctx.tabs.assignWorkspace).toHaveBeenCalledWith(5, 'ws-other');
    expect(browser.tabs.remove).not.toHaveBeenCalledWith(expect.arrayContaining([5]));
    expect(browser.windows.remove).not.toHaveBeenCalled();
  });

  it('keeps the window marked as handing off until the removals have settled', async () => {
    const { ctx } = deleteContext({ owner: 1, ownerAfter: 1 });
    let settle: () => void = () => undefined;
    vi.mocked(browser.tabs.remove).mockImplementation(
      (ids) =>
        (Array.isArray(ids)
          ? new Promise<void>((resolve) => (settle = resolve))
          : Promise.resolve()) as never,
    );

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith([5, 6]);
    });
    // The removal events are still on their way: the last-tab handler must keep skipping the window.
    expect(ctx.handoff.isActive(1)).toBe(true);
    settle();
    await vi.waitFor(() => {
      expect(ctx.handoff.isActive(1)).toBe(false);
    });
  });

  it('closes the owning window when every other workspace is shown elsewhere', async () => {
    const { ctx } = deleteContext({ owner: 1, ownerAfter: null });

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.windows.remove).toHaveBeenCalledWith(1);
    });
    // The window takes its own tabs with it; only the other window's tab is closed directly.
    expect(browser.tabs.remove).toHaveBeenCalledWith([6]);
    expect(ctx.workspaces.create).not.toHaveBeenCalled();
  });

  it('gives a stranded window with no tabs to close a fresh workspace', async () => {
    const { ctx } = deleteContext({ owner: 1, ownerAfter: null });

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: false }, ctx);

    await vi.waitFor(() => {
      expect(ctx.workspaces.create).toHaveBeenCalledWith({ name: 'Workspace 2' }, 1);
    });
    expect(browser.windows.remove).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });

  it('only deletes a workspace no window shows', async () => {
    const { ctx } = deleteContext({ owner: null, ownerAfter: null });

    handle({ type: 'workspace/delete', id: 'ws-gone', closeTabs: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.remove).toHaveBeenCalledWith([5, 6]);
    });
    expect(browser.windows.remove).not.toHaveBeenCalled();
    expect(ctx.workspaces.create).not.toHaveBeenCalled();
  });
});

describe('protocol handler tab reload controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        reload: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it('reloads each selected live tab once for a batch reload action', async () => {
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi.fn().mockReturnValue([
          { id: 10, windowId: 1, workspaceId: 'ws-1', active: false },
          { id: 20, windowId: 1, workspaceId: 'ws-1', active: false },
        ]),
      } as unknown as HandlerContext['tabs'],
    });

    handle({ type: 'tabs/reload', ids: [10, 20, 20, 999] }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.reload).toHaveBeenCalledWith(10, { bypassCache: false });
      expect(browser.tabs.reload).toHaveBeenCalledWith(20, { bypassCache: false });
    });
    expect(browser.tabs.reload).toHaveBeenCalledTimes(2);
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

describe('protocol handler tab pin controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 123, pinned: false }),
        update: vi.fn().mockResolvedValue({ id: 123, pinned: true }),
      },
    });
  });

  it('sets pinned state explicitly and clears folder membership', async () => {
    const setFolder = vi.fn().mockResolvedValue(undefined);
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi
          .fn()
          .mockReturnValue([
            { id: 123, windowId: 1, workspaceId: 'ws-1', pinned: false, folderId: 'folder-1' },
          ]),
        setFolder,
      } as unknown as HandlerContext['tabs'],
    });

    handle({ type: 'tab/setPinned', id: 123, pinned: true }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(123, { pinned: true });
    });
    expect(setFolder).toHaveBeenCalledWith(123, null);
  });

  it('routes toggle pin through the same folder-clearing path', async () => {
    const setFolder = vi.fn().mockResolvedValue(undefined);
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi
          .fn()
          .mockReturnValue([
            { id: 123, windowId: 1, workspaceId: 'ws-1', pinned: false, folderId: 'folder-1' },
          ]),
        setFolder,
      } as unknown as HandlerContext['tabs'],
    });

    handle({ type: 'tab/togglePin', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(123, { pinned: true });
    });
    expect(setFolder).toHaveBeenCalledWith(123, null);
  });
});

describe('protocol handler tab unload controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 123, active: false, discarded: false }),
        discard: vi.fn().mockResolvedValue({ id: 123, discarded: true }),
      },
    });
  });

  it('discards an inactive loaded tab', async () => {
    const ctx = createCloseContext();

    handle({ type: 'tab/unload', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.discard).toHaveBeenCalledWith(123);
    });
  });

  it('does not discard active or already discarded tabs', async () => {
    vi.mocked(browser.tabs.get).mockResolvedValueOnce({
      id: 123,
      active: true,
      discarded: false,
    } as browser.tabs.Tab);
    const ctx = createCloseContext();

    handle({ type: 'tab/unload', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.get).toHaveBeenCalledWith(123);
    });
    expect(browser.tabs.discard).not.toHaveBeenCalled();

    vi.mocked(browser.tabs.get).mockResolvedValueOnce({
      id: 123,
      active: false,
      discarded: true,
    } as browser.tabs.Tab);

    handle({ type: 'tab/unload', id: 123 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.get).toHaveBeenCalledTimes(2);
    });
    expect(browser.tabs.discard).not.toHaveBeenCalled();
  });
});

describe('protocol handler search engine snapshots', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends searchEngines/snapshot for searchEngines/requestSnapshot', async () => {
    vi.stubGlobal('browser', {
      bentoPrivacy: {
        getSearchEngines: vi.fn().mockResolvedValue([
          {
            id: 'ddg',
            name: 'DuckDuckGo',
            isDefault: true,
            iconUrl: 'data:image/png;base64,ddg',
          },
          { id: 'google', name: 'Google', isDefault: false },
        ]),
        getDefaultSearchEngine: vi.fn().mockResolvedValue('ddg'),
      },
    });
    const ctx = createCloseContext();

    handle({ type: 'searchEngines/requestSnapshot' }, ctx);

    await vi.waitFor(() => {
      expect(ctx.send).toHaveBeenCalledWith({
        type: 'searchEngines/snapshot',
        snapshot: {
          defaultSearchEngine: 'ddg',
          availableSearchEngines: [
            {
              id: 'ddg',
              name: 'DuckDuckGo',
              isDefault: true,
              iconUrl: 'data:image/png;base64,ddg',
            },
            { id: 'google', name: 'Google', isDefault: false },
          ],
        },
      });
    });
  });

  it('sends a disabled snapshot when search engine reads fail', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('browser', {
      bentoPrivacy: {
        getSearchEngines: vi.fn().mockRejectedValue(new Error('search unavailable')),
        getDefaultSearchEngine: vi.fn().mockResolvedValue('ddg'),
      },
    });
    const ctx = createCloseContext();

    try {
      handle({ type: 'searchEngines/requestSnapshot' }, ctx);

      await vi.waitFor(() => {
        expect(ctx.send).toHaveBeenCalledWith({
          type: 'searchEngines/snapshot',
          snapshot: { defaultSearchEngine: '', availableSearchEngines: [] },
        });
      });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('protocol handler tab reopen controls', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('browser', {
      sessions: {
        restore: vi.fn().mockResolvedValue({}),
      },
    });
  });

  it('restores the most recently closed session entry', async () => {
    const ctx = createCloseContext();

    handle({ type: 'tab/reopenClosed' }, ctx);

    await vi.waitFor(() => {
      expect(browser.sessions.restore).toHaveBeenCalledWith();
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
        isPrivate: vi.fn(() => false),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
    });

    handle({ type: 'panel/addDevtools', tabId: 99, forTabId: 1, inspectedTabId: 1 }, ctx);

    expect(ctx.panels.addDevtoolsPanel).toHaveBeenCalledWith('ws-1', 99, 1, 1);
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(99, 'ws-1');
    expect(ctx.panels.setWidth).toHaveBeenCalledWith(99, 640);
    expect(ctx.syncPanelMarkers).toHaveBeenCalledWith('ws-1');
    expect(ctx.emitPanelsSync).toHaveBeenCalledWith('ws-1', {
      scrollToPanelTabId: 99,
      scrollToPanelReveal: 'right-edge',
    });
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
        isPrivate: vi.fn(() => false),
        assignWorkspace,
      },
      workspaces: {
        has: vi.fn((id: string) => id === 'ws-new' || id === 'ws-old'),
        hasForWindow: vi.fn((id: string) => id === 'ws-new' || id === 'ws-old'),
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

  it('moves the window on itself when its workspace is emptied, without a second activation', async () => {
    const calls: string[] = [];
    const tabState = new Map([[1, { id: 1, workspaceId: 'ws-old' }]]);
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => Array.from(tabState.values())),
        isPrivate: vi.fn(() => false),
        assignWorkspace: vi.fn(async (id: number, workspaceId: string) => {
          const tab = tabState.get(id);
          if (tab) tab.workspaceId = workspaceId;
        }),
      },
      workspaces: {
        has: vi.fn((id: string) => id === 'ws-new' || id === 'ws-old'),
        hasForWindow: vi.fn((id: string) => id === 'ws-new' || id === 'ws-old'),
        snapshot: vi.fn(() => ({
          workspaces: [
            { id: 'ws-old', name: 'Personal', createdAt: 1 },
            { id: 'ws-new', name: 'Workspace 2', createdAt: 2 },
          ],
        })),
        getActiveIdByWindow: vi.fn(() => ({ 1: 'ws-old' })),
        getActiveId: vi.fn(() => 'ws-old'),
        create: vi.fn(() => ({ id: 'ws-new', name: 'Workspace 2', createdAt: 2 })),
        forgetWindow: vi.fn(() => calls.push('forget')),
        delete: vi.fn(() => calls.push('delete')),
        activate: vi.fn(() => {
          calls.push('activate');
          return 'activated';
        }),
      },
      settings: {},
      panels: { getPanels: vi.fn(() => []) },
      pinnedPanels: { removeForTab: vi.fn() },
      savedPanels: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'tabs/moveToNewWorkspace', ids: [1] }, ctx);

    await vi.waitFor(() => {
      expect(ctx.workspaces.delete).toHaveBeenCalled();
    });
    // The caller activates the replacement itself, so the delete must not announce the
    // global fallback (which could be the same workspace) as a second activation.
    expect(ctx.workspaces.delete).toHaveBeenCalledWith('ws-old', { announceFallback: false });
    expect(calls.slice(-3)).toEqual(['forget', 'delete', 'activate']);
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
        isPrivate: vi.fn(() => false),
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
        hasForWindow: vi.fn((id: string) => id === 'ws-1' || id === 'ws-2'),
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

  it('demotes a pinned tab before assigning it to a folder', async () => {
    vi.stubGlobal('browser', {
      tabs: {
        update: vi.fn().mockResolvedValue({ id: 1, pinned: false }),
      },
    });
    const setFolder = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      tabs: {
        isPrivate: vi.fn(() => false),
        snapshot: vi.fn(() => [{ id: 1, workspaceId: 'ws-1', pinned: true }]),
        setFolder,
      },
      workspaces: {},
      settings: {},
      panels: {},
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
      },
      savedPanels: {},
      send: vi.fn(),
      emitPanelsSync: vi.fn(),
      syncPanelMarkers: vi.fn(),
      sourceWindowId: 1,
    } as unknown as HandlerContext;

    handle({ type: 'tabs/setFolder', ids: [1], folderId: 'folder-1' }, ctx);

    await vi.waitFor(() => {
      expect(setFolder).toHaveBeenCalledWith(1, 'folder-1');
    });
    expect(browser.tabs.update).toHaveBeenCalledWith(1, { pinned: false });
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
        hasForWindow: vi.fn().mockReturnValue(true),
      },
      panels: {
        findWorkspacesContainingPanelOrSubPanel: vi.fn().mockReturnValue(['ws-1']),
        isDevtoolsPanel: vi.fn().mockReturnValue(true),
      },
      pinnedPanels: {
        add,
      },
      tabs: { isPrivate: vi.fn(() => false) },
      settings: {},
      tabFolders: {},
      savedPanels: {},
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
        isPrivate: vi.fn(() => false),
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
        hasForWindow: vi.fn().mockReturnValue(true),
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
        isPrivate: vi.fn(() => false),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        has: vi.fn().mockReturnValue(true),
        hasForWindow: vi.fn().mockReturnValue(true),
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
        isPrivate: vi.fn(() => false),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        has: vi.fn().mockReturnValue(true),
        hasForWindow: vi.fn().mockReturnValue(true),
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
        move: vi.fn().mockResolvedValue([{ id: 99 }]),
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

  it('moves indexed tab/create into place before activating', async () => {
    const order: string[] = [];
    const ctx = createCloseContext({ sourceWindowId: 7 });
    vi.mocked(browser.tabs.move).mockImplementation(async () => {
      order.push('move');
      return [{ id: 99 }] as browser.tabs.Tab[];
    });
    vi.mocked(browser.tabs.update).mockImplementation(async () => {
      order.push('activate');
      return { id: 99 } as browser.tabs.Tab;
    });

    handle({ type: 'tab/create', index: 4 }, ctx);

    await vi.waitFor(() => {
      expect(browser.tabs.update).toHaveBeenCalledWith(99, { active: true });
    });
    expect(browser.tabs.create).toHaveBeenCalledWith({
      active: false,
      index: 4,
      windowId: 7,
    });
    expect(browser.tabs.move).toHaveBeenCalledWith(99, { index: 4 });
    expect(order).toEqual(['move', 'activate']);
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

describe('protocol handler external merge', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('broadcasts external merge lifecycle events to all shell documents', async () => {
    let resolveSnapshot!: (value: unknown) => void;
    const snapshotPromise = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        readSnapshot: vi.fn(() => snapshotPromise),
      },
      tabs: {
        query: vi.fn(async () => []),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const broadcast = vi.fn();
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(),
        activate: vi.fn(() => 'noop'),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        getPanels: vi.fn(() => []),
      } as unknown as HandlerContext['panels'],
      tabFolders: {
        create: vi.fn(),
      } as unknown as HandlerContext['tabFolders'],
      broadcast,
      sourceWindowId: 5,
    });

    handle({ type: 'externalMerge/merge', sourceId: 'source-1', operationId: 'op-1' }, ctx);

    expect(broadcast).toHaveBeenCalledWith({
      type: 'externalMerge/started',
      operationId: 'op-1',
      windowId: 5,
      sourceId: 'source-1',
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'externalMerge/progress',
      operationId: 'op-1',
      windowId: 5,
      progress: {
        stage: 'preparing',
        totalWorkspaces: 0,
        completedWorkspaces: 0,
        totalTabs: 0,
        completedTabs: 0,
        importedTabs: 0,
      },
    });

    resolveSnapshot({
      sourceId: 'source-1',
      kind: 'firefox',
      browserName: 'Firefox',
      profileName: 'Default',
      lastModified: 1,
      capturedAt: 1,
      format: 'firefox-json',
      json: JSON.stringify({ windows: [] }),
    });

    await vi.waitFor(() => {
      expect(broadcast).toHaveBeenCalledWith({
        type: 'externalMerge/error',
        operationId: 'op-1',
        windowId: 5,
        sourceId: 'source-1',
        code: 'no-importable-tabs',
        message: 'Firefox did not contain any importable tabs.',
      });
    });
    // Once the session is read, progress names the browser for documents that never
    // listed the sources.
    expect(broadcast).toHaveBeenCalledWith({
      type: 'externalMerge/progress',
      operationId: 'op-1',
      windowId: 5,
      progress: {
        stage: 'preparing',
        totalWorkspaces: 0,
        completedWorkspaces: 0,
        totalTabs: 0,
        completedTabs: 0,
        importedTabs: 0,
        sourceName: 'Firefox',
      },
    });
  });

  it('rejects duplicate merge operations before reading another snapshot', async () => {
    let resolveSnapshot!: (value: unknown) => void;
    const snapshotPromise = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        readSnapshot: vi.fn(() => snapshotPromise),
      },
      tabs: {
        query: vi.fn(async () => []),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const ctx = createCloseContext({
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(),
        activate: vi.fn(() => 'noop'),
      } as unknown as HandlerContext['workspaces'],
      panels: {
        getPanels: vi.fn(() => []),
      } as unknown as HandlerContext['panels'],
      tabFolders: {
        create: vi.fn(),
      } as unknown as HandlerContext['tabFolders'],
      send: vi.fn(),
      sourceWindowId: 5,
    });

    handle({ type: 'externalMerge/merge', sourceId: 'source-1', operationId: 'op-1' }, ctx);
    handle({ type: 'externalMerge/merge', sourceId: 'source-1', operationId: 'op-2' }, ctx);

    expect(browser.bentoExternalSessions.readSnapshot).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledWith({
      type: 'externalMerge/error',
      operationId: 'op-2',
      windowId: 5,
      sourceId: 'source-1',
      code: 'busy',
      message: 'Another browser session merge is already running.',
    });

    resolveSnapshot({
      sourceId: 'source-1',
      kind: 'firefox',
      browserName: 'Firefox',
      profileName: 'Default',
      lastModified: 1,
      capturedAt: 1,
      format: 'firefox-json',
      json: JSON.stringify({ windows: [] }),
    });

    await vi.waitFor(() => {
      expect(ctx.send).toHaveBeenCalledWith({
        type: 'externalMerge/error',
        operationId: 'op-1',
        windowId: 5,
        sourceId: 'source-1',
        code: 'no-importable-tabs',
        message: 'Firefox did not contain any importable tabs.',
      });
    });
  });

  it('cancels the active external merge operation', async () => {
    let resolveSnapshot!: (value: unknown) => void;
    const snapshotPromise = new Promise((resolve) => {
      resolveSnapshot = resolve;
    });
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        readSnapshot: vi.fn(() => snapshotPromise),
      },
      tabs: {
        query: vi.fn(async () => []),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const ctx = createCloseContext({
      send: vi.fn(),
      sourceWindowId: 5,
    });

    handle({ type: 'externalMerge/merge', sourceId: 'source-1', operationId: 'op-1' }, ctx);
    handle({ type: 'externalMerge/cancel', operationId: 'op-1' }, ctx);

    expect(ctx.send).toHaveBeenCalledWith({
      type: 'externalMerge/error',
      operationId: 'op-1',
      windowId: 5,
      code: 'cancelled',
      message: 'Browser session merge was cancelled.',
    });

    resolveSnapshot({
      sourceId: 'source-1',
      kind: 'firefox',
      browserName: 'Firefox',
      profileName: 'Default',
      lastModified: 1,
      capturedAt: 1,
      format: 'firefox-json',
      json: JSON.stringify({ windows: [] }),
    });

    await Promise.resolve();
    await Promise.resolve();
  });

  it('still reports the tab that was in flight at a cancel, after the cancelled error', async () => {
    let finishCreate!: (tab: { id: number }) => void;
    const create = vi.fn(
      () =>
        new Promise<{ id: number }>((resolve) => {
          finishCreate = resolve;
        }),
    );
    vi.stubGlobal('browser', {
      bentoExternalSessions: {
        readSnapshot: vi.fn(async () => ({
          sourceId: 'source-1',
          kind: 'firefox',
          browserName: 'Firefox',
          profileName: 'Default',
          lastModified: 1,
          capturedAt: 1,
          format: 'firefox-json',
          json: JSON.stringify({
            windows: [
              {
                tabs: [
                  { entries: [{ url: 'https://first.example/', title: 'First' }], index: 1 },
                  { entries: [{ url: 'https://second.example/', title: 'Second' }], index: 1 },
                ],
              },
            ],
          }),
        })),
      },
      tabs: { query: vi.fn(async () => []), create, update: vi.fn(async (id: number) => ({ id })) },
    });

    const broadcast = vi.fn();
    const ctx = createCloseContext({
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(async () => true),
      } as unknown as HandlerContext['tabs'],
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({ id: 'ws-new', name: 'Firefox: Default Window 1', createdAt: 1 })),
        delete: vi.fn(),
      } as unknown as HandlerContext['workspaces'],
      panels: { getPanels: vi.fn(() => []) } as unknown as HandlerContext['panels'],
      tabFolders: { create: vi.fn() } as unknown as HandlerContext['tabFolders'],
      broadcast,
      sourceWindowId: 5,
    });

    handle({ type: 'externalMerge/merge', sourceId: 'source-1', operationId: 'op-late' }, ctx);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // The cancel lands while the first tab is still being created.
    handle({ type: 'externalMerge/cancel', operationId: 'op-late' }, ctx);
    finishCreate({ id: 100 });

    // The shell raises its cancelled count from the progress that carries the settled total.
    const events = () => broadcast.mock.calls.map(([event]) => event);
    await vi.waitFor(() => {
      expect(events()).toContainEqual(
        expect.objectContaining({
          type: 'externalMerge/progress',
          operationId: 'op-late',
          progress: expect.objectContaining({ importedTabs: 1 }),
        }),
      );
    });
    const cancelledAt = events().findIndex(
      (event) => event.type === 'externalMerge/error' && event.code === 'cancelled',
    );
    const openedAt = events().findIndex(
      (event) => event.type === 'externalMerge/progress' && event.progress.importedTabs === 1,
    );
    expect(cancelledAt).toBeGreaterThan(-1);
    expect(openedAt).toBeGreaterThan(cancelledAt);
    expect(events().filter((event) => event.type === 'externalMerge/error')).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('protocol handler settings and privacy actions', () => {
  function domainContext() {
    const settingsDomain = {
      updateSettings: vi.fn().mockResolvedValue({}),
      reset: vi.fn().mockResolvedValue({}),
      setProtectionLevel: vi.fn().mockResolvedValue({}),
      setAdvanced: vi.fn().mockResolvedValue({}),
      setSearchEngine: vi.fn().mockResolvedValue({}),
    };
    // Snapshot reads fail without a browser.privacy API; the handlers must shrug that off.
    vi.stubGlobal('browser', {});
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const ctx = createCloseContext({
      settingsDomain: settingsDomain as unknown as HandlerContext['settingsDomain'],
      sourceWindowId: 6,
    });
    return { ctx, settingsDomain };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends the full shell settings set (welcome, sidebar) through the shared mutation', async () => {
    const { ctx, settingsDomain } = domainContext();
    handle({ type: 'settings/update', changes: { welcomeSeen: true, sidebarHidden: true } }, ctx);
    expect(settingsDomain.updateSettings).toHaveBeenCalledWith({
      welcomeSeen: true,
      sidebarHidden: true,
    });
  });

  it('runs a reset as a retained operation owned by the shell port', async () => {
    const { ctx, settingsDomain } = domainContext();
    handle({ type: 'settings/reset' }, ctx);
    await vi.waitFor(() => expect(settingsDomain.reset).toHaveBeenCalledTimes(1));
    const [operationId, caller] = settingsDomain.reset.mock.calls[0]!;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(caller).toMatchObject({ ownerId: 'shell-port', windowId: 6, isPrivate: false });
  });

  it('applies privacy and search changes through the domain service', async () => {
    const { ctx, settingsDomain } = domainContext();
    handle({ type: 'privacy/setProtectionLevel', level: 'hardened' }, ctx);
    handle({ type: 'privacy/setAdvanced', key: 'drmEnabled', value: false }, ctx);
    handle({ type: 'privacy/setDefaultSearchEngine', id: 'ddg' }, ctx);
    expect(settingsDomain.setProtectionLevel).toHaveBeenCalledWith('hardened');
    expect(settingsDomain.setAdvanced).toHaveBeenCalledWith('drmEnabled', false);
    expect(settingsDomain.setSearchEngine).toHaveBeenCalledWith('ddg');
  });

  it('logs a failed mutation instead of throwing', async () => {
    const { ctx, settingsDomain } = domainContext();
    settingsDomain.setProtectionLevel.mockRejectedValue(new Error('nope'));
    expect(() =>
      handle({ type: 'privacy/setProtectionLevel', level: 'standard' }, ctx),
    ).not.toThrow();
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[bento-tools] privacy/setProtectionLevel failed:',
        expect.any(Error),
      ),
    );
  });
});

describe('address closed-session restore', () => {
  const session = {
    lastModified: 123,
    tab: { sessionId: 'closed-a', windowId: 1, incognito: false, url: 'https://restore.test/' },
  };
  beforeEach(() => {
    vi.stubGlobal('browser', {
      sessions: {
        getRecentlyClosed: vi.fn().mockResolvedValue([session]),
        restore: vi.fn().mockResolvedValue({ tab: { id: 42, windowId: 1 } }),
      },
      tabs: {
        get: vi.fn().mockResolvedValue({ id: 42, windowId: 1, active: true, pinned: false }),
        update: vi.fn().mockResolvedValue({ id: 42 }),
        create: vi.fn(),
      },
      windows: { get: vi.fn().mockResolvedValue({ id: 1 }), update: vi.fn() },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it('revalidates the exact session and echoes the correlated native result', async () => {
    const ctx = createCloseContext({ sourceWindowPrivate: false });
    vi.mocked((ctx.panels.findWorkspacesContainingPanelOrSubPanel ??= vi.fn())).mockReturnValue([]);
    vi.mocked(ctx.tabs.snapshot).mockReturnValue([
      { id: 42 } as ReturnType<typeof ctx.tabs.snapshot>[number],
    ]);
    handle({ type: 'addrbar/restoreClosed', requestId: 'restore-a', sessionId: 'closed-a' }, ctx);
    await vi.waitFor(() =>
      expect(ctx.send).toHaveBeenCalledWith({
        type: 'addrbar/restoreClosedResult',
        requestId: 'restore-a',
        sessionId: 'closed-a',
        outcome: { status: 'restored', tabId: 42, windowId: 1 },
      }),
    );
    expect(browser.sessions.restore).toHaveBeenCalledExactlyOnceWith('closed-a');
    expect(browser.tabs.update).toHaveBeenCalledWith(42, { active: true });
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });
  it.each([
    { sourceWindowId: 2, sourceWindowPrivate: false },
    { sourceWindowId: 1, sourceWindowPrivate: true },
    { sourceWindowId: null, sourceWindowPrivate: false },
    { sourceWindowId: 1 },
  ])('refuses ineligible or unknown source context %j', async (source) => {
    const ctx = createCloseContext(source);
    handle({ type: 'addrbar/restoreClosed', requestId: 'r', sessionId: 'closed-a' }, ctx);
    await vi.waitFor(() =>
      expect(ctx.send).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: { status: 'unavailable' } }),
      ),
    );
    expect(browser.sessions.restore).not.toHaveBeenCalled();
  });
  it('never restores the latest session as a substitute for a stale selected id', async () => {
    const ctx = createCloseContext({ sourceWindowPrivate: false });
    handle({ type: 'addrbar/restoreClosed', requestId: 'r', sessionId: 'gone' }, ctx);
    await vi.waitFor(() =>
      expect(ctx.send).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: { status: 'unavailable' } }),
      ),
    );
    expect(browser.sessions.restore).not.toHaveBeenCalled();
  });
  it('reports native errors to the private audience without a navigation fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(browser.sessions.getRecentlyClosed).mockResolvedValueOnce([
      { ...session, tab: { ...session.tab, incognito: true } },
    ] as browser.sessions.Session[]);
    vi.mocked(browser.sessions.restore).mockRejectedValueOnce(new Error('closed concurrently'));
    const sendAudience = vi.fn();
    const ctx = createCloseContext({ sourceWindowPrivate: true, sendAudience });
    handle({ type: 'addrbar/restoreClosed', requestId: 'r', sessionId: 'closed-a' }, ctx);
    await vi.waitFor(() =>
      expect(sendAudience).toHaveBeenCalledWith(
        { privateWindowId: 1 },
        expect.objectContaining({ outcome: { status: 'failed' } }),
      ),
    );
    expect(ctx.send).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('address native restore ownership and reveal', () => {
  afterEach(() => {
    bentoTabMoves.forget([42]);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function fixture(panel = false, owner: number | null = 2) {
    const live = { id: 42, windowId: 1, pinned: panel, active: false, incognito: false };
    let shown = owner === 1 ? 'saved' : 'other';
    const ctx = createCloseContext({ sourceWindowPrivate: false, sendAudience: vi.fn() });
    Object.assign(ctx.tabs, {
      snapshot: vi.fn(() => [{ ...live, workspaceId: 'saved' }]),
    });
    Object.assign(ctx.panels, {
      findWorkspacesContainingPanelOrSubPanel: vi.fn(() => (panel ? ['saved'] : [])),
    });
    Object.assign(ctx.workspaces, {
      findOwningWindow: vi.fn(() => owner),
      getActiveId: vi.fn((id: number) => (id === owner ? 'saved' : shown)),
      activate: vi.fn((_ws: string, id: number) => {
        shown = 'saved';
        owner = id;
        return 'activated';
      }),
      flush: vi.fn().mockResolvedValue(undefined),
    });
    ctx.prepareRestoredTab = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('browser', {
      sessions: {
        getRecentlyClosed: vi.fn().mockResolvedValue([
          {
            lastModified: 1,
            tab: { sessionId: 's', windowId: 1, incognito: false, url: 'https://restored.test' },
          },
        ]),
        restore: vi.fn().mockResolvedValue({ tab: { id: 42, windowId: 1 } }),
        removeTabValue: vi.fn(),
      },
      tabs: {
        get: vi.fn(async () => ({ ...live })),
        move: vi.fn(async (ids: number[], options: { windowId: number }) => {
          expect(ids).toEqual([42]);
          live.windowId = options.windowId;
          return [{ ...live }];
        }),
        update: vi.fn(async () => {
          live.active = true;
          return { ...live };
        }),
        create: vi.fn(),
      },
      windows: {
        get: vi.fn(async (id: number) => ({ id, incognito: false })),
        update: vi.fn().mockResolvedValue({ id: 2 }),
      },
    });
    const run = () =>
      handle({ type: 'addrbar/restoreClosed', requestId: 'r', sessionId: 's' }, ctx);
    const outcome = (value: object) =>
      expect(ctx.sendAudience).toHaveBeenCalledWith('regular', {
        type: 'addrbar/restoreClosedResult',
        requestId: 'r',
        sessionId: 's',
        outcome: value,
      });
    return { ctx, live, run, outcome };
  }

  it.each([false, true])(
    'moves the exact restored tab to its owner and awaits %s panel reveal',
    async (panel) => {
      const { ctx, run, outcome } = fixture(panel);
      let prepare!: () => void;
      let reveal!: () => void;
      ctx.prepareRestoredTab = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            prepare = resolve;
          }),
      );
      const revealing = new Promise<void>((resolve) => {
        reveal = resolve;
      });
      if (panel) ctx.emitPanelsSync = vi.fn(() => revealing);
      else
        vi.mocked(browser.tabs.update).mockImplementationOnce(async () => {
          await revealing;
          return { id: 42, windowId: 2, active: true } as browser.tabs.Tab;
        });
      run();
      await vi.waitFor(() => expect(ctx.prepareRestoredTab).toHaveBeenCalledWith(42));
      expect(browser.tabs.move).not.toHaveBeenCalled();
      expect(ctx.sendAudience).not.toHaveBeenCalled();
      prepare();
      await vi.waitFor(() =>
        expect(panel ? ctx.emitPanelsSync : browser.tabs.update).toHaveBeenCalled(),
      );
      expect(browser.tabs.move).toHaveBeenCalledExactlyOnceWith([42], {
        windowId: 2,
        index: panel ? 0 : -1,
      });
      expect(bentoTabMoves.take(42, 2)).toBe('saved');
      expect(ctx.workspaces.activate).toHaveBeenCalledWith('saved', 2);
      expect(ctx.workspaces.flush).toHaveBeenCalledOnce();
      expect(ctx.sendAudience).not.toHaveBeenCalled();
      if (panel) {
        expect(ctx.emitPanelsSync).toHaveBeenCalledWith('saved', {
          scrollToPanelTabId: 42,
          windowId: 2,
        });
        expect(browser.tabs.update).not.toHaveBeenCalled();
      }
      reveal();
      // The native read after activation confirms the selected state too.
      if (!panel)
        vi.mocked(browser.tabs.get).mockResolvedValue({
          id: 42,
          windowId: 2,
          active: true,
        } as browser.tabs.Tab);
      await vi.waitFor(() => outcome({ status: 'restored', tabId: 42, windowId: 2 }));
      expect(browser.windows.update).toHaveBeenCalledWith(2, { focused: true });
      expect(ctx.send).not.toHaveBeenCalled();
      expect(browser.tabs.create).not.toHaveBeenCalled();
      expect(ctx.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
      expect(browser.sessions.removeTabValue).not.toHaveBeenCalled();
    },
  );

  it('activates an unowned saved workspace in the restored source window', async () => {
    const { ctx, run, outcome } = fixture(false, null);
    run();
    await vi.waitFor(() => outcome({ status: 'restored', tabId: 42, windowId: 1 }));
    expect(browser.tabs.move).not.toHaveBeenCalled();
    expect(ctx.workspaces.activate).toHaveBeenCalledWith('saved', 1);
  });

  it.each([
    'move rejects',
    'move skipped',
    'owner vanished',
    'owner switched',
    'activation conflict',
    'activation fails',
    'reveal fails',
    'focus fails',
    'private destination',
  ])('reports failure when %s', async (failure) => {
    const { ctx, run, outcome } = fixture(failure === 'reveal fails');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (failure === 'move rejects')
      vi.mocked(browser.tabs.move).mockRejectedValueOnce(new Error('move failed'));
    if (failure === 'move skipped') vi.mocked(browser.tabs.move).mockResolvedValueOnce([]);
    if (failure === 'owner vanished')
      vi.mocked(browser.windows.get).mockRejectedValueOnce(new Error('Invalid window ID'));
    if (failure === 'owner switched')
      vi.mocked(ctx.workspaces.findOwningWindow).mockReturnValueOnce(2).mockReturnValue(3);
    if (failure === 'activation conflict')
      vi.mocked(ctx.workspaces.activate).mockReturnValueOnce('conflict');
    if (failure === 'activation fails')
      vi.mocked(browser.tabs.update).mockRejectedValueOnce(new Error('activation failed'));
    if (failure === 'reveal fails')
      ctx.emitPanelsSync = vi.fn().mockRejectedValueOnce(new Error('reveal failed'));
    if (failure === 'focus fails')
      vi.mocked(browser.windows.update).mockRejectedValueOnce(new Error('Invalid window ID'));
    if (failure === 'private destination')
      vi.mocked(browser.windows.get).mockResolvedValueOnce({
        id: 2,
        incognito: true,
      } as browser.windows.Window);
    run();
    await vi.waitFor(() => outcome({ status: 'failed' }));
    expect(ctx.sendAudience).toHaveBeenCalledOnce();
    expect(browser.tabs.create).not.toHaveBeenCalled();
    if (failure === 'move rejects') expect(bentoTabMoves.take(42, 2)).toBeUndefined();
    if (failure === 'owner vanished' || failure === 'private destination')
      expect(browser.tabs.move).not.toHaveBeenCalled();
  });
});

describe('actual tab/close DevTools policy with registry session values', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['linked toolbox', 'marker-only main toolbox', 'regular tab'])(
    'keeps the correct repeated-mark policy for %s',
    async (kind) => {
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
      const devtools = kind !== 'regular tab';
      const values = new Map<string, unknown>([
        ['bento.workspaceId', 'ws-1'],
        ['bento.folderId', 'folder-1'],
        ...(devtools ? [['bento.isDevtoolsPanel', '1'] as const] : []),
      ]);
      stubClosingBrowser();
      Object.assign(browser.sessions, {
        getTabValue: vi.fn(async (_id: number, key: string) => values.get(key)),
        setTabValue: vi.fn(async (_id: number, key: string, value: unknown) => {
          values.set(key, value);
        }),
        removeTabValue: vi.fn(async (_id: number, key: string) => {
          values.delete(key);
        }),
      });
      Object.assign(browser.tabs, {
        query: vi.fn(async () => [
          {
            id: 123,
            windowId: 1,
            index: 0,
            title: 'Fixture',
            active: kind === 'marker-only main toolbox',
            pinned: false,
          },
        ]),
        ...Object.fromEntries(
          ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached'].map(
            (event) => [event, { addListener: vi.fn() }],
          ),
        ),
      });
      const tabs = new TabRegistry();
      await tabs.init();
      const mark = vi.spyOn(tabs, 'markClosing');
      const panels = new PanelStore();
      if (kind === 'linked toolbox') panels.addDevtoolsPanel('ws-1', 123, null, 999);
      const ctx = createCloseContext({
        tabs,
        panels,
        pinnedPanels: { removeForTab: vi.fn() } as unknown as HandlerContext['pinnedPanels'],
      });
      handle({ type: 'tab/close', id: 123 }, ctx);
      await vi.waitFor(() => expect(browser.tabs.remove).toHaveBeenCalledWith(123));
      expect(mark.mock.calls).toEqual([
        [123, { preserveSessionMembership: !devtools }],
        [123, { preserveSessionMembership: !devtools }],
      ]);
      expect(values.get('bento.workspaceId')).toBe(devtools ? undefined : 'ws-1');
      expect(values.get('bento.folderId')).toBe(devtools ? undefined : 'folder-1');
      expect(tabs.snapshot()[0]?.workspaceId).toBeUndefined();
      expect(tabs.snapshot()[0]?.folderId).toBeUndefined();
      expect(values.get('bento.closingTab')).toBe('1');
      expect(panels.isDevtoolsPanel('ws-1', 123)).toBe(false);
      if (devtools) expect(values.has('bento.isDevtoolsPanel')).toBe(false);
    },
  );
});
