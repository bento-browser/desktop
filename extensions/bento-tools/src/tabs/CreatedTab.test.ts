import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCreatedTabs, type CreatedTabDeps, type CreationKind } from './CreatedTab';

const WORKSPACE_KEY = 'bento.workspaceId';

function setup(kind: CreationKind) {
  /** Session values by tab id and key; tests attach one late to mimic SessionStore. */
  const values = new Map<string, unknown>();
  vi.stubGlobal('browser', {
    sessions: {
      getTabValue: vi.fn(async (tabId: number, key: string) => values.get(`${tabId}:${key}`)),
    },
    bentoTabState: { getCreationKind: vi.fn(async () => kind) },
  });
  let active: string | null = 'ws-a';
  const panelTabs = new Set<number>();
  const deps = {
    adoptionSettled: () => true,
    isPrivate: () => false,
    activeWorkspaceId: vi.fn(() => active),
    restorePanel: vi.fn(async () => false),
    promoteFromPanelOpener: vi.fn(),
    isPanel: (tabId: number) => panelTabs.has(tabId),
    workspaceOf: vi.fn((): string | undefined => undefined),
    hasWorkspace: () => true,
    adoptImportedWorkspaces: vi.fn(async () => undefined),
    tabs: {
      assignWorkspace: vi.fn(async () => undefined),
      assignWorkspaceEagerly: vi.fn(async () => true),
      setWorkspaceInMemory: vi.fn(),
    },
  } satisfies CreatedTabDeps;
  const created = createCreatedTabs(deps);
  const open = (id: number, extra: Partial<browser.tabs.Tab> = {}) => {
    const tab = {
      id,
      windowId: 1,
      index: 0,
      active: true,
      pinned: false,
      ...extra,
    } as browser.tabs.Tab;
    created.onCreated(tab, 1);
    return created.placeUnassigned(id, 1, 1);
  };
  return {
    deps,
    open,
    values,
    panelTabs,
    switchTo: (id: string | null) => (active = id),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createCreatedTabs', () => {
  it('assigns a new link tab to its window workspace without waiting for SessionStore', async () => {
    const { deps, open } = setup('new');

    await open(5);

    expect(deps.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(5, 'ws-a');
    expect(deps.restorePanel).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspace).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the workspace shown at creation when the window switches during classification', async () => {
    const { deps, open, switchTo } = setup('new');
    let resolveKind: (kind: CreationKind) => void = () => {};
    vi.mocked(browser.bentoTabState.getCreationKind).mockReturnValueOnce(
      new Promise((resolve) => (resolveKind = resolve)),
    );

    const placed = open(5);
    switchTo('ws-b');
    resolveKind('new');
    await placed;

    expect(deps.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(5, 'ws-a');
  });

  it.each([
    ['during classification', 'assignWorkspaceEagerly'],
    ['after classification', 'assignWorkspace'],
  ] as const)(
    'files a tab whose window showed no workspace at creation in the one it claims %s',
    async (when, assign) => {
      const { deps, open, switchTo } = setup('new');
      let resolveKind: (kind: CreationKind) => void = () => {};
      vi.mocked(browser.bentoTabState.getCreationKind).mockReturnValueOnce(
        new Promise((resolve) => (resolveKind = resolve)),
      );
      switchTo(null);

      const placed = open(5);
      if (when === 'during classification') switchTo('ws-b');
      resolveKind('new');
      await vi.advanceTimersByTimeAsync(0);
      if (when === 'after classification') switchTo('ws-b');
      await vi.advanceTimersByTimeAsync(1000);
      await placed;

      expect(deps.tabs[assign]).toHaveBeenCalledWith(5, 'ws-b');
    },
  );

  it.each(['restoring', 'unknown'] as const)(
    'waits for a %s tab and takes the session value SessionStore attaches late',
    async (kind) => {
      const { deps, open, values } = setup(kind);

      const placed = open(5);
      await vi.advanceTimersByTimeAsync(120);
      values.set(`5:${WORKSPACE_KEY}`, 'ws-saved');
      await vi.advanceTimersByTimeAsync(400);
      await placed;

      expect(deps.restorePanel).toHaveBeenCalledWith(5, 1);
      expect(deps.tabs.setWorkspaceInMemory).toHaveBeenCalledWith(5, 'ws-saved');
      expect(deps.tabs.assignWorkspace).not.toHaveBeenCalled();
      expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
    },
  );

  it('files an unknown tab with no session value in the workspace shown at creation', async () => {
    const { deps, open, switchTo } = setup('unknown');

    const placed = open(5);
    switchTo('ws-b');
    await vi.advanceTimersByTimeAsync(1000);
    await placed;

    expect(deps.tabs.assignWorkspace).toHaveBeenCalledWith(5, 'ws-a');
  });

  it('takes the restore path for a new tab that already carries a session value', async () => {
    const { deps, open, values } = setup('new');
    values.set(`5:${WORKSPACE_KEY}`, 'ws-saved');

    await open(5);

    expect(deps.restorePanel).toHaveBeenCalledWith(5, 1);
    expect(deps.tabs.setWorkspaceInMemory).toHaveBeenCalledWith(5, 'ws-saved');
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });

  it('leaves a new tab alone when the handler that opened it assigned it meanwhile', async () => {
    const { deps, open } = setup('new');
    deps.workspaceOf.mockReturnValue('ws-import');

    await open(5);

    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });

  it('promotes a new tab opened from a panel instead of adding it to the sidebar', async () => {
    const { deps, open, panelTabs } = setup('new');
    deps.promoteFromPanelOpener.mockImplementation((tab: browser.tabs.Tab) => {
      if (typeof tab.id === 'number') panelTabs.add(tab.id);
    });

    await open(5, { openerTabId: 2 });

    expect(deps.promoteFromPanelOpener).toHaveBeenCalledTimes(1);
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspace).not.toHaveBeenCalled();
  });
});
