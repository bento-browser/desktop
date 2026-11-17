import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabRegistry } from '../tabs/TabRegistry';
import { persistFirstLaunchWorkspace, type FirstLaunchMarkerDeps } from './FirstLaunchMarkers';

const WORKSPACE_KEY = 'bento.workspaceId';

/** A registry over `tabs`, with every session value unset unless `sessionValues` names it. */
async function bootTabs(
  tabs: Array<{ id: number; incognito?: boolean }>,
  sessionValues: Record<string, unknown> = {},
) {
  const listener = { addListener: vi.fn() };
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal('browser', {
    sessions: {
      getTabValue: vi.fn(async (id: number, key: string) => sessionValues[`${id}:${key}`]),
      setTabValue: vi.fn(async () => undefined),
      removeTabValue: vi.fn(async () => undefined),
    },
    tabs: {
      query: vi.fn(async () =>
        tabs.map((tab) => ({ windowId: 1, index: tab.id, active: false, pinned: false, ...tab })),
      ),
      onCreated: listener,
      onUpdated: listener,
      onRemoved: listener,
      onActivated: listener,
      onMoved: listener,
      onAttached: listener,
      onDetached: listener,
    },
    bentoTabState: { getPageErrors: vi.fn(async () => []), onPageErrorChanged: listener },
  });
  const registry = new TabRegistry();
  await registry.init();
  return registry;
}

/** The boot backfill: every regular tab without a workspace gets `workspaceId` in memory. */
function backfill(registry: TabRegistry, workspaceId: string): number[] {
  const ids: number[] = [];
  for (const tab of registry.snapshot()) {
    if (registry.isPrivate(tab.id) || tab.workspaceId) continue;
    registry.setWorkspaceInMemory(tab.id, workspaceId);
    ids.push(tab.id);
  }
  return ids;
}

function freshDeps(
  registry: TabRegistry,
  overrides: Partial<FirstLaunchMarkerDeps> = {},
): FirstLaunchMarkerDeps {
  return {
    bootstrappedDefaultId: 'ws-default',
    workspaceIds: () => ['ws-default'],
    sessionHadMarkers: false,
    tabs: registry,
    ...overrides,
  };
}

describe('persistFirstLaunchWorkspace', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the boot tab's marker when Bento never stored workspaces", async () => {
    const registry = await bootTabs([{ id: 1 }]);
    const ids = backfill(registry, 'ws-default');

    await persistFirstLaunchWorkspace(freshDeps(registry), 'ws-default', ids);

    expect(browser.sessions.setTabValue).toHaveBeenCalledWith(1, WORKSPACE_KEY, 'ws-default');
  });

  it.each([
    ['a later launch', { bootstrappedDefaultId: null }],
    ['a session from an earlier launch', { sessionHadMarkers: true }],
    ['an imported set that replaced the default', { workspaceIds: () => ['ws-imported'] }],
  ])('keeps the backfill in memory only on %s', async (_case, overrides) => {
    const registry = await bootTabs([{ id: 1 }]);
    const ids = backfill(registry, 'ws-default');

    await persistFirstLaunchWorkspace(freshDeps(registry, overrides), 'ws-default', ids);

    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
    expect(registry.snapshot()[0]?.workspaceId).toBe('ws-default');
  });

  it('does not overwrite a session value found when the tab is read again', async () => {
    const registry = await bootTabs([{ id: 1 }]);
    const ids = backfill(registry, 'ws-default');
    // SessionStore attached the tab's own value after the boot hydrate read it.
    vi.mocked(browser.sessions.getTabValue).mockImplementation(async (_id, key) =>
      key === WORKSPACE_KEY ? 'ws-restored' : undefined,
    );

    await persistFirstLaunchWorkspace(freshDeps(registry), 'ws-default', ids);

    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(registry.snapshot()[0]?.workspaceId).toBe('ws-restored'));
  });

  it("writes no tab's marker when a sibling's restored marker turns up on the second read", async () => {
    const registry = await bootTabs([{ id: 1 }, { id: 2 }]);
    const ids = backfill(registry, 'ws-default');
    // Tab 2's session value arrived after the boot hydrate; tab 1 still reads empty. The
    // registry's own hydrate of tab 2 (a later read) has not finished when the write decides.
    let tab2Reads = 0;
    vi.mocked(browser.sessions.getTabValue).mockImplementation((id, key) => {
      if (id !== 2 || key !== WORKSPACE_KEY) return Promise.resolve(undefined);
      return tab2Reads++ === 0 ? Promise.resolve('ws-restored') : new Promise(() => undefined);
    });

    await persistFirstLaunchWorkspace(freshDeps(registry), 'ws-default', ids);

    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });

  it("writes no tab's marker when a session read fails", async () => {
    const registry = await bootTabs([{ id: 1 }, { id: 2 }]);
    const ids = backfill(registry, 'ws-default');
    vi.mocked(browser.sessions.getTabValue).mockImplementation(async (id) => {
      if (id === 2) throw new Error('no tab');
      return undefined;
    });

    await persistFirstLaunchWorkspace(freshDeps(registry), 'ws-default', ids);

    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });

  it('writes nothing for a private tab', async () => {
    const registry = await bootTabs([{ id: 1, incognito: true }]);
    // Even one placed in the workspace in memory.
    registry.setWorkspaceInMemory(1, 'ws-default');

    await persistFirstLaunchWorkspace(freshDeps(registry), 'ws-default', [1]);

    expect(browser.sessions.setTabValue).not.toHaveBeenCalled();
  });
});
