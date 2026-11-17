import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabSnapshot } from '@shared/protocol';
import { openWorkspaceFirstTab } from './FirstTab';

/** Records each browser and registry step in order; `update` and `marker` can be made to fail.
 * `windowOf` is each tab's current window as Firefox reports it (moves edit it). */
function setup(options: { markerWritten?: boolean; updateFails?: boolean } = {}) {
  const steps: string[] = [];
  const windowOf = new Map<number, number>();
  const workspaceOf = new Map<number, string>();
  let nextId = 10;
  vi.stubGlobal('browser', {
    tabs: {
      create: vi.fn(async (props: { active: boolean }) => {
        const id = nextId++;
        windowOf.set(id, 1);
        steps.push(`create ${id} active=${props.active}`);
        return { id, windowId: 1 };
      }),
      get: vi.fn(async (id: number) => ({ id, windowId: windowOf.get(id) })),
      update: vi.fn(async (id: number) => {
        steps.push(`select ${id}`);
        if (options.updateFails) throw new Error('no tab');
        return { id };
      }),
      remove: vi.fn(async () => undefined),
    },
  });
  const tabs = {
    assignWorkspaceEagerly: vi.fn(async (id: number, workspaceId: string) => {
      // Memory first, then the marker write a turn later, as setTabValue does.
      workspaceOf.set(id, workspaceId);
      await Promise.resolve();
      steps.push(`marker ${id} ${workspaceId}`);
      return options.markerWritten ?? true;
    }),
    isClosing: () => false,
    snapshot: () =>
      [...windowOf].map(
        ([id, windowId]) => ({ id, windowId, workspaceId: workspaceOf.get(id) }) as TabSnapshot,
      ),
  };
  return { steps, tabs, windowOf };
}

describe('openWorkspaceFirstTab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the tab unselected, writes its marker, then selects it', async () => {
    const { steps, tabs } = setup();

    const tab = await openWorkspaceFirstTab({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(tab?.id).toBe(10);
    expect(browser.tabs.create).toHaveBeenCalledWith({ windowId: 1, active: false });
    expect(steps).toEqual(['create 10 active=false', 'marker 10 ws-b', 'select 10']);
  });

  it('keeps the tab for the workspace, unselected, when the window moved on meanwhile', async () => {
    const { steps, tabs } = setup();
    let current = true;
    tabs.assignWorkspaceEagerly.mockImplementation(async (id, workspaceId) => {
      steps.push(`marker ${id} ${workspaceId}`);
      current = false;
      return true;
    });

    const tab = await openWorkspaceFirstTab({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => current,
    });

    expect(tab?.id).toBe(10);
    expect(steps).toEqual(['create 10 active=false', 'marker 10 ws-b']);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.remove).not.toHaveBeenCalled();
  });

  it('leaves the tab unselected when it moved to another window during the marker write', async () => {
    const { steps, tabs, windowOf } = setup();
    const write = tabs.assignWorkspaceEagerly.getMockImplementation()!;
    tabs.assignWorkspaceEagerly.mockImplementation(async (id, workspaceId) => {
      windowOf.set(id, 2);
      return write(id, workspaceId);
    });

    const tab = await openWorkspaceFirstTab({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(tab?.id).toBe(10);
    expect(steps).toEqual(['create 10 active=false', 'marker 10 ws-b']);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('leaves the tab unselected when the window moved on while it was read again', async () => {
    const { tabs } = setup();
    let current = true;
    const read = vi.mocked(browser.tabs.get).getMockImplementation()!;
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => {
      current = false;
      return read(id);
    });

    const tab = await openWorkspaceFirstTab({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => current,
    });

    expect(tab?.id).toBe(10);
    expect(browser.tabs.update).not.toHaveBeenCalled();
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('still selects the tab when its marker could not be written', async () => {
    const { steps, tabs } = setup({ markerWritten: false });

    await openWorkspaceFirstTab({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(steps).toEqual(['create 10 active=false', 'marker 10 ws-b', 'select 10']);
  });

  it('opens a selected tab the old way when selecting the new one fails', async () => {
    const { steps, tabs } = setup({ updateFails: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tab = await openWorkspaceFirstTab({
      workspaceId: 'ws-b',
      windowId: 1,
      url: 'https://one/',
      tabs,
      stillCurrent: () => true,
    });

    expect(tab?.id).toBe(11);
    expect(browser.tabs.create).toHaveBeenLastCalledWith({
      url: 'https://one/',
      windowId: 1,
      active: true,
    });
    expect(steps.slice(0, 4)).toEqual([
      'create 10 active=false',
      'marker 10 ws-b',
      'select 10',
      'create 11 active=true',
    ]);
    expect(tabs.assignWorkspaceEagerly).toHaveBeenLastCalledWith(11, 'ws-b');
  });
});
