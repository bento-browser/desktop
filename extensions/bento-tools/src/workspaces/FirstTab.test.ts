import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TabSnapshot } from '@shared/protocol';
import { openWorkspaceFirstTab, openWorkspaceFirstTabOnce } from './FirstTab';

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

    expect(tab).toEqual({ status: 'selected', tab: { id: 10, windowId: 1 } });
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

    expect(tab).toEqual({ status: 'superseded', tab: { id: 10, windowId: 1 } });
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

    expect(tab).toEqual({ status: 'displaced', tab: { id: 10, windowId: 1 } });
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

    expect(tab.status).toBe('superseded');
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

    expect(tab).toEqual({ status: 'selected', tab: { id: 11, windowId: 1 } });
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

describe('openWorkspaceFirstTabOnce', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Runs `during` for the given tabs inside their marker write. */
  function duringMarker(
    tabs: ReturnType<typeof setup>['tabs'],
    ids: number[],
    during: (id: number) => void,
  ) {
    const write = tabs.assignWorkspaceEagerly.getMockImplementation()!;
    tabs.assignWorkspaceEagerly.mockImplementation(async (id, workspaceId) => {
      if (ids.includes(id)) during(id);
      return write(id, workspaceId);
    });
  }

  it('opens and selects one more tab when the first moved to another window during its marker write', async () => {
    const { steps, tabs, windowOf } = setup();
    duringMarker(tabs, [10], (id) => windowOf.set(id, 2));

    const outcome = await openWorkspaceFirstTabOnce({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(outcome).toEqual({ status: 'selected', tab: { id: 11, windowId: 1 } });
    expect(steps).toEqual([
      'create 10 active=false',
      'marker 10 ws-b',
      'create 11 active=false',
      'marker 11 ws-b',
      'select 11',
    ]);
  });

  it('opens one more tab when the first closed during its marker write', async () => {
    const { tabs } = setup();
    const read = vi.mocked(browser.tabs.get).getMockImplementation()!;
    vi.mocked(browser.tabs.get).mockImplementation(async (id) => {
      if (id === 10) throw new Error('no tab');
      return read(id);
    });

    const outcome = await openWorkspaceFirstTabOnce({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(outcome.status).toBe('selected');
    expect(browser.tabs.update).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).toHaveBeenCalledWith(11, { active: true });
  });

  it('opens no other tab when the window moved on as the first one left', async () => {
    const { tabs, windowOf } = setup();
    let current = true;
    duringMarker(tabs, [10], (id) => {
      windowOf.set(id, 2);
      current = false;
    });

    const outcome = await openWorkspaceFirstTabOnce({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => current,
    });

    expect(outcome.status).toBe('superseded');
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it('tries only once more and selects nothing when the second tab moves away too', async () => {
    const { tabs, windowOf } = setup();
    duringMarker(tabs, [10, 11], (id) => windowOf.set(id, 2));

    const outcome = await openWorkspaceFirstTabOnce({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(outcome.status).toBe('displaced');
    expect(browser.tabs.create).toHaveBeenCalledTimes(2);
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it('does not try again when the tab and its selected fallback both failed', async () => {
    const { tabs } = setup({ updateFails: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const create = vi.mocked(browser.tabs.create).getMockImplementation()!;
    vi.mocked(browser.tabs.create).mockImplementation(async (props) => {
      if (props.active) throw new Error('no window');
      return create(props);
    });

    const outcome = await openWorkspaceFirstTabOnce({
      workspaceId: 'ws-b',
      windowId: 1,
      tabs,
      stillCurrent: () => true,
    });

    expect(outcome.status).toBe('unselected');
    expect(browser.tabs.create).toHaveBeenCalledTimes(2);
  });
});
