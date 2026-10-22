import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabSnapshot } from '@shared/protocol';
import { WorkspaceStore } from './WorkspaceStore';
import { adoptPrivateTabs, joinPrivateWorkspace } from './privateTabs';

describe('private tab membership', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      windows: { getAll: vi.fn(async () => []) },
      sessions: {
        getWindowValue: vi.fn(async () => undefined),
        setWindowValue: vi.fn(async () => undefined),
        removeWindowValue: vi.fn(async () => undefined),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeTabs(tabs: Array<Partial<TabSnapshot> & { id: number }>) {
    return {
      snapshotPrivate: vi.fn(() => tabs as TabSnapshot[]),
      setWorkspaceInMemory: vi.fn(),
    };
  }

  it('adopts every private tab of the window, and only those not already in the workspace', async () => {
    const workspaces = new WorkspaceStore();
    await workspaces.init();
    const privateWorkspace = workspaces.ensurePrivate(9);
    const tabs = fakeTabs([
      { id: 1, windowId: 9 },
      { id: 2, windowId: 9, workspaceId: privateWorkspace.id },
      { id: 3, windowId: 9, workspaceId: 'ws-stale' },
    ]);

    adoptPrivateTabs(workspaces, tabs, 9);

    expect(tabs.snapshotPrivate).toHaveBeenCalledWith(9);
    expect(tabs.setWorkspaceInMemory.mock.calls).toEqual([
      [1, privateWorkspace.id],
      [3, privateWorkspace.id],
    ]);
  });

  it('assigns a created or moved private tab to the Private workspace of its window', async () => {
    const workspaces = new WorkspaceStore();
    await workspaces.init();
    const first = workspaces.ensurePrivate(9);
    const second = workspaces.ensurePrivate(10);
    const tabs = fakeTabs([]);

    joinPrivateWorkspace(workspaces, tabs, 900, 9);
    joinPrivateWorkspace(workspaces, tabs, 900, 10);

    expect(tabs.setWorkspaceInMemory.mock.calls).toEqual([
      [900, first.id],
      [900, second.id],
    ]);
  });

  it('leaves a tab of a window without a Private workspace alone, and never uses a regular one', async () => {
    const workspaces = new WorkspaceStore();
    await workspaces.init();
    const tabs = fakeTabs([{ id: 1, windowId: 5 }]);

    joinPrivateWorkspace(workspaces, tabs, 1, 5);
    adoptPrivateTabs(workspaces, tabs, 5);

    expect(tabs.setWorkspaceInMemory).not.toHaveBeenCalled();
  });
});
