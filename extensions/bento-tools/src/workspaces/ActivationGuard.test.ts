import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from './WorkspaceStore';
import { hasSelectedWorkspaceTab, isActivationCurrent } from './ActivationGuard';

describe('isActivationCurrent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
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
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stops an activation held during boot once its window has switched to another workspace', async () => {
    // Activation A is held, the window switches to B, then both resume.
    const store = new WorkspaceStore();
    await store.init();
    const a = store.snapshot().workspaces[0]!;
    const b = store.create({ name: 'B' }, null, { activate: false });
    store.activate(a.id, 1);
    store.activate(b.id, 1);
    const activeId = (windowId: number | null) => store.getActiveId(windowId);

    expect(isActivationCurrent(a.id, 1, activeId)).toBe(false);
    expect(isActivationCurrent(b.id, 1, activeId)).toBe(true);
  });

  it('judges another window by its own workspace', async () => {
    const store = new WorkspaceStore();
    await store.init();
    const a = store.snapshot().workspaces[0]!;
    const b = store.create({ name: 'B' }, null, { activate: false });
    store.activate(a.id, 1);
    store.activate(b.id, 2);
    const activeId = (windowId: number | null) => store.getActiveId(windowId);

    expect(isActivationCurrent(a.id, 1, activeId)).toBe(true);
    expect(isActivationCurrent(a.id, 2, activeId)).toBe(false);
  });

  it('follows the global workspace for an activation without a window', async () => {
    const store = new WorkspaceStore();
    await store.init();
    const a = store.snapshot().workspaces[0]!;
    const b = store.create({ name: 'B' }, null, { activate: false });
    store.activate(b.id);
    const activeId = (windowId: number | null) => store.getActiveId(windowId);

    expect(isActivationCurrent(a.id, null, activeId)).toBe(false);
    expect(isActivationCurrent(b.id, null, activeId)).toBe(true);
  });
});

describe('hasSelectedWorkspaceTab', () => {
  const tab = (workspaceId: string, windowId: number, active: boolean) => ({
    workspaceId,
    windowId,
    active,
  });

  it('counts a selected panel of the workspace, so neither startup path overrides it', () => {
    // The selected tab is a panel: it belongs to the workspace but is not a sidebar tab.
    const tabs = [tab('ws', 1, true), tab('ws', 1, false)];

    expect(hasSelectedWorkspaceTab(tabs, 'ws', 1)).toBe(true);
    expect(hasSelectedWorkspaceTab(tabs, 'ws', null)).toBe(true);
  });

  it('is false when the window selects a tab of another workspace', () => {
    const tabs = [tab('other', 1, true), tab('ws', 1, false)];

    expect(hasSelectedWorkspaceTab(tabs, 'ws', 1)).toBe(false);
    expect(hasSelectedWorkspaceTab(tabs, 'ws', null)).toBe(false);
  });

  it('looks only at the window it is asked about', () => {
    const tabs = [tab('ws', 2, true), tab('ws', 1, false)];

    expect(hasSelectedWorkspaceTab(tabs, 'ws', 1)).toBe(false);
    expect(hasSelectedWorkspaceTab(tabs, 'ws', null)).toBe(true);
  });
});
