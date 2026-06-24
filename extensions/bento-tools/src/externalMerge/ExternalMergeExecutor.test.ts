import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeExternalMerge } from './ExternalMergeExecutor';
import type { HandlerContext } from '../messaging/protocol-handler';
import type { NormalizedExternalSession } from './sourceTypes';

describe('executeExternalMerge', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('deduplicates URLs, creates inactive workspace, preserves folders, and leaves pinned tabs un-foldered', async () => {
    let nextTabId = 100;
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: 'https://existing.example/' }]),
        create: vi.fn(async () => ({ id: nextTabId++ })),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const createWorkspace = vi.fn((input: { name: string }) => ({
      id: 'imported-workspace',
      name: input.name,
      createdAt: Date.now(),
    }));
    const assignWorkspaceEagerly = vi.fn(async () => true);
    const assignFolderEagerly = vi.fn().mockResolvedValue(true);
    const folderCreate = vi.fn(() => ({
      id: 'folder-1',
      workspaceId: 'imported-workspace',
      name: 'Research',
      order: 0,
      collapsed: false,
      createdAt: Date.now(),
    }));
    const activate = vi.fn(() => 'activated');
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => [{ id: 1, workspaceId: 'ws-existing' }]),
        assignWorkspaceEagerly,
        assignFolderEagerly,
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({
          workspaces: [{ id: 'ws-existing', name: 'Chrome: Default Window 1', createdAt: 1 }],
        })),
        create: createWorkspace,
        activate,
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: folderCreate,
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    const session: NormalizedExternalSession = {
      sourceId: 'chrome-default',
      kind: 'chrome',
      browserName: 'Chrome',
      profileName: 'Default',
      capturedAt: 1,
      lastModified: 1,
      windows: [
        {
          id: 'window-1',
          active: true,
          groups: [{ id: 'group-1', name: 'Research', index: 0 }],
          tabs: [
            {
              id: 'duplicate',
              url: 'https://existing.example/',
              title: 'Duplicate',
              index: 0,
              active: false,
              pinned: false,
            },
            {
              id: 'unsupported',
              url: 'javascript:alert(1)',
              title: 'Unsupported',
              index: 1,
              active: false,
              pinned: false,
            },
            {
              id: 'pinned',
              url: 'https://pinned.example/',
              title: 'Pinned',
              index: 2,
              active: false,
              pinned: true,
              groupId: 'group-1',
            },
            {
              id: 'normal',
              url: 'https://normal.example/',
              title: 'Normal',
              index: 3,
              active: true,
              pinned: false,
              groupId: 'group-1',
            },
          ],
        },
      ],
    };

    const summary = await executeExternalMerge(session, ctx);

    expect(createWorkspace).toHaveBeenCalledWith(
      { name: 'Chrome: Default Window 1 (imported)' },
      7,
      { activate: false },
    );
    expect(browser.tabs.create).toHaveBeenCalledTimes(2);
    expect(assignWorkspaceEagerly).toHaveBeenCalledWith(100, 'imported-workspace');
    expect(assignWorkspaceEagerly).toHaveBeenCalledWith(101, 'imported-workspace');
    expect(browser.tabs.update).toHaveBeenCalledWith(100, { pinned: true });
    expect(folderCreate).toHaveBeenCalledWith({
      id: expect.any(String),
      workspaceId: 'imported-workspace',
      name: 'Research',
    });
    expect(assignFolderEagerly).toHaveBeenCalledTimes(1);
    expect(assignFolderEagerly).toHaveBeenCalledWith(101, 'folder-1');
    expect(activate).toHaveBeenCalledWith('imported-workspace', 7);
    expect(browser.tabs.update).toHaveBeenCalledWith(101, { active: true });
    expect(summary).toMatchObject({
      workspacesCreated: 1,
      foldersCreated: 1,
      tabsOpened: 2,
      pinnedTabsOpened: 1,
      skippedDuplicates: 1,
      skippedUnsupportedUrls: 1,
      failedTabs: 0,
    });
  });

  it('discards imported folders when no member can be assigned to the folder', async () => {
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 100 })),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const deleteFolder = vi.fn();
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(async () => true),
        assignFolderEagerly: vi.fn(async () => false),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({
          id: 'imported-workspace',
          name: 'Zen Browser: Space A',
          createdAt: 1,
        })),
        activate: vi.fn(() => 'activated'),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(() => ({
          id: 'folder-1',
          workspaceId: 'imported-workspace',
          name: 'Research',
          order: 0,
          collapsed: false,
          createdAt: 1,
        })),
        delete: deleteFolder,
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    const summary = await executeExternalMerge(
      {
        sourceId: 'zen-default',
        kind: 'zen',
        browserName: 'Zen Browser',
        profileName: 'Default',
        capturedAt: 1,
        lastModified: 1,
        workspaces: [{ id: 'space-a', name: 'Space A', windowIds: ['zen-window-space-a'] }],
        windows: [
          {
            id: 'zen-window-space-a',
            workspaceId: 'space-a',
            active: true,
            groups: [{ id: 'group-1', name: 'Research', index: 0 }],
            tabs: [
              {
                id: 'tab-1',
                url: 'https://research.example/',
                title: 'Research',
                index: 0,
                active: true,
                pinned: false,
                groupId: 'group-1',
              },
            ],
          },
        ],
      },
      ctx,
    );

    expect(ctx.tabFolders.create).toHaveBeenCalledWith({
      id: expect.any(String),
      workspaceId: 'imported-workspace',
      name: 'Research',
    });
    expect(ctx.tabs.assignFolderEagerly).toHaveBeenCalledWith(100, 'folder-1');
    expect(deleteFolder).toHaveBeenCalledWith('folder-1');
    expect(summary).toMatchObject({
      tabsOpened: 1,
      foldersCreated: 0,
    });
  });

  it('waits for imported tab workspace session persistence before completing', async () => {
    let releaseAssignment!: () => void;
    const assignmentPersisted = new Promise<boolean>((resolve) => {
      releaseAssignment = () => resolve(true);
    });

    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 100 })),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const assignWorkspaceEagerly = vi.fn(() => assignmentPersisted);
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly,
        setFolder: vi.fn(),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({
          id: 'imported-workspace',
          name: 'Chrome: Default Window 1',
          createdAt: 1,
        })),
        activate: vi.fn(() => 'activated'),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(),
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    const pending = executeExternalMerge(
      {
        sourceId: 'chrome-default',
        kind: 'chrome',
        browserName: 'Chrome',
        profileName: 'Default',
        capturedAt: 1,
        lastModified: 1,
        windows: [
          {
            id: 'window-1',
            active: true,
            groups: [],
            tabs: [
              {
                id: 'tab-1',
                url: 'https://chrome.example/',
                title: 'Chrome',
                index: 0,
                active: true,
                pinned: false,
              },
            ],
          },
        ],
      },
      ctx,
    );

    await vi.waitFor(() =>
      expect(assignWorkspaceEagerly).toHaveBeenCalledWith(100, 'imported-workspace'),
    );
    let settled = false;
    void pending.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAssignment();

    await expect(pending).resolves.toMatchObject({
      workspacesCreated: 1,
      tabsOpened: 1,
      failedTabs: 0,
    });
  });

  it('removes a created tab when its workspace marker cannot be persisted', async () => {
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 100 })),
        remove: vi.fn(async () => undefined),
        update: vi.fn(),
      },
    });

    const deleteWorkspace = vi.fn();
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(async () => false),
        setFolder: vi.fn(),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({
          id: 'imported-workspace',
          name: 'Chrome: Default Window 1',
          createdAt: 1,
        })),
        delete: deleteWorkspace,
        activate: vi.fn(() => 'activated'),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(),
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    await expect(
      executeExternalMerge(
        {
          sourceId: 'chrome-default',
          kind: 'chrome',
          browserName: 'Chrome',
          profileName: 'Default',
          capturedAt: 1,
          lastModified: 1,
          windows: [
            {
              id: 'window-1',
              active: true,
              groups: [],
              tabs: [
                {
                  id: 'tab-1',
                  url: 'https://chrome.example/',
                  title: 'Chrome',
                  index: 0,
                  active: true,
                  pinned: false,
                },
              ],
            },
          ],
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'no-importable-tabs',
      message: 'Chrome tabs could not be opened in Bento.',
    });

    expect(browser.tabs.remove).toHaveBeenCalledWith(100);
    expect(deleteWorkspace).toHaveBeenCalledWith('imported-workspace');
    expect(ctx.workspaces.activate).not.toHaveBeenCalled();
  });

  it('stops importing after cancellation without rolling back already-created tabs', async () => {
    const controller = new AbortController();
    let nextTabId = 100;
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => {
          const id = nextTabId++;
          controller.abort();
          return { id };
        }),
        update: vi.fn(async (id: number) => ({ id })),
      },
    });

    const deleteWorkspace = vi.fn();
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(async () => true),
        setFolder: vi.fn(),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({
          id: 'imported-workspace',
          name: 'Chrome: Default Window 1',
          createdAt: 1,
        })),
        delete: deleteWorkspace,
        activate: vi.fn(() => 'activated'),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(),
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    await expect(
      executeExternalMerge(
        {
          sourceId: 'chrome-default',
          kind: 'chrome',
          browserName: 'Chrome',
          profileName: 'Default',
          capturedAt: 1,
          lastModified: 1,
          windows: [
            {
              id: 'window-1',
              active: true,
              groups: [],
              tabs: [
                {
                  id: 'tab-1',
                  url: 'https://first.example/',
                  title: 'First',
                  index: 0,
                  active: false,
                  pinned: false,
                },
                {
                  id: 'tab-2',
                  url: 'https://second.example/',
                  title: 'Second',
                  index: 1,
                  active: true,
                  pinned: false,
                },
              ],
            },
          ],
        },
        ctx,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'cancelled',
      message: 'Browser session merge was cancelled.',
    });

    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(ctx.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(100, 'imported-workspace');
    expect(deleteWorkspace).not.toHaveBeenCalled();
    expect(ctx.workspaces.activate).not.toHaveBeenCalled();
  });

  it('reports duplicate-only sessions as no-op before creating workspaces', async () => {
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => [{ id: 1, url: 'https://existing.example/' }]),
        create: vi.fn(),
        update: vi.fn(),
      },
    });

    const createWorkspace = vi.fn();
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => [{ id: 1, workspaceId: 'ws-existing' }]),
        assignWorkspaceEagerly: vi.fn(async () => true),
        setFolder: vi.fn(),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({
          workspaces: [{ id: 'ws-existing', name: 'Existing', createdAt: 1 }],
        })),
        create: createWorkspace,
        activate: vi.fn(),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(),
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    const session: NormalizedExternalSession = {
      sourceId: 'firefox-default',
      kind: 'firefox',
      browserName: 'Firefox',
      profileName: 'Default',
      capturedAt: 1,
      lastModified: 1,
      windows: [
        {
          id: 'window-1',
          active: true,
          groups: [],
          tabs: [
            {
              id: 'duplicate',
              url: 'https://existing.example/',
              title: 'Duplicate',
              index: 0,
              active: true,
              pinned: false,
            },
          ],
        },
      ],
    };

    await expect(executeExternalMerge(session, ctx)).rejects.toMatchObject({
      code: 'no-importable-tabs',
      message: 'All tabs from Firefox are already open in Bento.',
    });
    expect(createWorkspace).not.toHaveBeenCalled();
    expect(browser.tabs.create).not.toHaveBeenCalled();
  });

  it('does not wait for final tab focus before completing the merge', async () => {
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: 100 })),
        update: vi.fn(() => new Promise(() => undefined)),
      },
      sessions: {
        setTabValue: vi.fn(async () => undefined),
      },
    });

    const ctx = {
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(async () => true),
        setFolder: vi.fn(),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({
          id: 'imported-workspace',
          name: 'Firefox: Default Window 1',
          createdAt: 1,
        })),
        activate: vi.fn(() => 'activated'),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(),
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    const summary = await executeExternalMerge(
      {
        sourceId: 'firefox-default',
        kind: 'firefox',
        browserName: 'Firefox',
        profileName: 'Default',
        capturedAt: 1,
        lastModified: 1,
        windows: [
          {
            id: 'window-1',
            active: true,
            groups: [],
            tabs: [
              {
                id: 'tab-1',
                url: 'https://firefox.example/',
                title: 'Firefox',
                index: 0,
                active: true,
                pinned: false,
              },
            ],
          },
        ],
      },
      ctx,
    );

    expect(summary.tabsOpened).toBe(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(100, { active: true });
  });

  it('times out hung tab creation and removes the empty workspace', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', {
      tabs: {
        query: vi.fn(async () => []),
        create: vi.fn(() => new Promise(() => undefined)),
        update: vi.fn(),
      },
      sessions: {
        setTabValue: vi.fn(async () => undefined),
      },
    });

    const deleteWorkspace = vi.fn();
    const ctx = {
      tabs: {
        snapshot: vi.fn(() => []),
        assignWorkspaceEagerly: vi.fn(async () => true),
        setFolder: vi.fn(),
        rename: vi.fn(),
      },
      workspaces: {
        snapshot: vi.fn(() => ({ workspaces: [] })),
        create: vi.fn(() => ({
          id: 'imported-workspace',
          name: 'Firefox: Default Window 1',
          createdAt: 1,
        })),
        delete: deleteWorkspace,
        activate: vi.fn(() => 'activated'),
      },
      panels: {
        getPanels: vi.fn(() => []),
      },
      tabFolders: {
        create: vi.fn(),
      },
      sourceWindowId: 7,
    } as unknown as HandlerContext;

    const pending = executeExternalMerge(
      {
        sourceId: 'firefox-default',
        kind: 'firefox',
        browserName: 'Firefox',
        profileName: 'Default',
        capturedAt: 1,
        lastModified: 1,
        windows: [
          {
            id: 'window-1',
            active: true,
            groups: [],
            tabs: [
              {
                id: 'tab-1',
                url: 'https://firefox.example/',
                title: 'Firefox',
                index: 0,
                active: true,
                pinned: false,
              },
            ],
          },
        ],
      },
      ctx,
    );
    const expectedFailure = expect(pending).rejects.toMatchObject({
      code: 'no-importable-tabs',
      message: 'Firefox tabs could not be opened in Bento.',
    });
    await vi.advanceTimersByTimeAsync(8000);
    await expectedFailure;
    expect(deleteWorkspace).toHaveBeenCalledWith('imported-workspace');
    expect(ctx.workspaces.activate).not.toHaveBeenCalled();
  });
});
