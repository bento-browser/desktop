import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWorkspaceFirstTab } from './FirstTab';

/** Records each browser and registry step in order; `update` and `marker` can be made to fail. */
function setup(options: { markerWritten?: boolean; updateFails?: boolean } = {}) {
  const steps: string[] = [];
  let nextId = 10;
  vi.stubGlobal('browser', {
    tabs: {
      create: vi.fn(async (props: { active: boolean }) => {
        const id = nextId++;
        steps.push(`create ${id} active=${props.active}`);
        return { id, windowId: 1 };
      }),
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
      // The marker write resolves a turn later, as setTabValue does.
      await Promise.resolve();
      steps.push(`marker ${id} ${workspaceId}`);
      return options.markerWritten ?? true;
    }),
  };
  return { steps, tabs };
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
