import type { TabSnapshot } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';
import { adoptableTabs, releaseAdoptedTab, type AdoptedTabDeps } from './AdoptedTab';

function tab(overrides: Partial<TabSnapshot> & { id: number }): TabSnapshot {
  return {
    windowId: 1,
    index: overrides.id,
    title: '',
    pinned: false,
    active: false,
    audible: false,
    muted: false,
    ...overrides,
  } as TabSnapshot;
}

function makeDeps(options: {
  tabs: TabSnapshot[];
  owner?: number | null;
  destinationWorkspaceId?: string | null;
  panelWorkspaceIds?: string[];
}): AdoptedTabDeps {
  return {
    tabs: {
      snapshot: vi.fn().mockReturnValue(options.tabs),
      clearWorkspace: vi.fn().mockResolvedValue(undefined),
      assignWorkspaceEagerly: vi.fn().mockResolvedValue(true),
    },
    workspaces: {
      findOwningWindow: vi.fn().mockReturnValue(options.owner ?? null),
      getActiveId: vi.fn().mockReturnValue(options.destinationWorkspaceId ?? null),
    },
    panels: {
      findWorkspacesContainingTab: vi.fn().mockReturnValue(options.panelWorkspaceIds ?? []),
      remove: vi.fn().mockReturnValue(true),
    },
    clearPanelMarker: vi.fn().mockResolvedValue(undefined),
    syncPanelMarkers: vi.fn(),
    emitPanelsSync: vi.fn(),
  };
}

describe('releaseAdoptedTab', () => {
  it('moves a tab torn out of another window into the destination workspace', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a', folderId: 'f' })],
      owner: 1,
      destinationWorkspaceId: 'ws-b',
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
    expect(deps.tabs.assignWorkspaceEagerly).toHaveBeenCalledWith(7, 'ws-b');
    expect(deps.panels.remove).not.toHaveBeenCalled();
  });

  it('drops a torn-out panel from its layout and refreshes the source workspace', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: 1,
      panelWorkspaceIds: ['ws-a'],
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.panels.remove).toHaveBeenCalledWith('ws-a', 7);
    expect(deps.clearPanelMarker).toHaveBeenCalledWith(7);
    expect(deps.syncPanelMarkers).toHaveBeenCalledWith('ws-a');
    expect(deps.emitPanelsSync).toHaveBeenCalledWith('ws-a');
    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
  });

  it('leaves the tab unassigned while the new window has no workspace yet', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: 1,
      destinationWorkspaceId: null,
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).toHaveBeenCalledWith(7);
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });

  it('keeps the workspace of a tab Bento moved to the window that shows it', async () => {
    const deps = makeDeps({
      tabs: [tab({ id: 7, windowId: 2, workspaceId: 'ws-a' })],
      owner: 2,
      panelWorkspaceIds: ['ws-a'],
    });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.panels.remove).not.toHaveBeenCalled();
  });

  it('ignores a tab that has no workspace', async () => {
    const deps = makeDeps({ tabs: [tab({ id: 7, windowId: 2 })], destinationWorkspaceId: 'ws-b' });

    await releaseAdoptedTab(deps, 7, 2);

    expect(deps.tabs.clearWorkspace).not.toHaveBeenCalled();
    expect(deps.tabs.assignWorkspaceEagerly).not.toHaveBeenCalled();
  });
});

describe('adoptableTabs', () => {
  const never = () => false;

  it('takes every tab of a window where no tab has a workspace', () => {
    const picked = adoptableTabs([tab({ id: 1 }), tab({ id: 2, active: true })], never, never);
    expect(picked.map((t) => t.id)).toEqual([1, 2]);
  });

  it('takes nothing once a tab in the window has a workspace', () => {
    expect(
      adoptableTabs([tab({ id: 1 }), tab({ id: 2, workspaceId: 'ws-a' })], never, never),
    ).toEqual([]);
  });

  it('skips closing and private tabs', () => {
    const picked = adoptableTabs(
      [tab({ id: 1, active: true }), tab({ id: 2 }), tab({ id: 3 })],
      (id) => id === 1,
      (id) => id === 2,
    );
    expect(picked.map((t) => t.id)).toEqual([3]);
  });
});
