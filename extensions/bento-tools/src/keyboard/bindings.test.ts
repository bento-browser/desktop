import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../workspaces/WorkspaceStore';
import { handleCommand } from './bindings';

const tabIn = (windowId: number) => ({ windowId }) as browser.tabs.Tab;

describe('workspace-N commands', () => {
  let store: WorkspaceStore;
  // Workspace ids in switcher order (creation time), created out of order on purpose.
  let first: string;
  let second: string;
  let third: string;

  const run = (command: string, tab?: browser.tabs.Tab) =>
    handleCommand(command, { workspaces: store, broadcastEvent: vi.fn() }, tab);

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) } },
      windows: {
        getAll: vi.fn(async () => []),
        get: vi.fn(async (id: number) => ({ id, type: 'normal', incognito: false })),
        getLastFocused: vi.fn(async () => ({ id: 1, type: 'normal', incognito: false })),
        update: vi.fn(async () => ({})),
      },
      sessions: {
        getWindowValue: vi.fn(async () => undefined),
        setWindowValue: vi.fn(async () => undefined),
        removeWindowValue: vi.fn(async () => undefined),
      },
    });
    store = new WorkspaceStore();
    await store.init();
    first = store.snapshot().workspaces[0]!.id;
    const base = Date.now();
    third = store.create({ name: 'Third' }, null, { activate: false, createdAt: base + 2 }).id;
    second = store.create({ name: 'Second' }, null, { activate: false, createdAt: base + 1 }).id;
    store.activate(first, 1);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('switches the command window to the workspace at that position', async () => {
    await run('workspace-3', tabIn(1));

    expect(store.snapshot().activeIdByWindow).toEqual({ 1: third });
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it('uses the last focused window when Firefox passes no tab', async () => {
    vi.mocked(browser.windows.getLastFocused).mockResolvedValue({
      id: 2,
      type: 'normal',
    } as browser.windows.Window);

    await run('workspace-2');

    expect(store.snapshot().activeIdByWindow).toEqual({ 1: first, 2: second });
  });

  it('focuses the window that already shows the workspace and leaves the current one', async () => {
    store.activate(second, 2);

    await run('workspace-2', tabIn(1));

    expect(store.snapshot().activeIdByWindow).toEqual({ 1: first, 2: second });
    expect(browser.windows.update).toHaveBeenCalledWith(2, { focused: true });
  });

  it('does nothing in a private window', async () => {
    store.ensurePrivate(9);
    vi.mocked(browser.windows.get).mockResolvedValue({
      id: 9,
      type: 'normal',
      incognito: true,
    } as browser.windows.Window);

    await run('workspace-2', tabIn(9));

    expect(store.snapshot().activeIdByWindow).toEqual({ 1: first });
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it('does nothing in a popup window', async () => {
    vi.mocked(browser.windows.get).mockResolvedValue({
      id: 5,
      type: 'popup',
      incognito: false,
    } as browser.windows.Window);

    await run('workspace-2', tabIn(5));

    expect(store.snapshot().activeIdByWindow).toEqual({ 1: first });
    expect(browser.windows.update).not.toHaveBeenCalled();
  });

  it('does nothing for a position past the last workspace', async () => {
    await run('workspace-4', tabIn(1));

    expect(store.snapshot().activeIdByWindow).toEqual({ 1: first });
    expect(browser.windows.update).not.toHaveBeenCalled();
  });
});
