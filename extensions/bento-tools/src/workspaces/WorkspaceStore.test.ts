import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from './WorkspaceStore';

describe('WorkspaceStore active workspace persistence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('browser', {
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => undefined),
        },
      },
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

  it('updates the persisted fallback when the only window changes workspace', async () => {
    const store = new WorkspaceStore();
    await store.init();

    const workspace = store.create({ name: 'Workspace 2' }, 1);

    expect(store.snapshot().activeId).toBe(workspace.id);
    expect(store.snapshot().activeIdByWindow).toEqual({ 1: workspace.id });
    expect(browser.sessions.setWindowValue).toHaveBeenCalledWith(
      1,
      'bento.activeWorkspaceId',
      workspace.id,
    );
  });

  it('keeps multi-window per-window activations out of the global fallback', async () => {
    const store = new WorkspaceStore();
    await store.init();
    const workspace2 = store.create({ name: 'Workspace 2' }, 1);
    const workspace3 = store.create({ name: 'Workspace 3' }, null, { activate: false });

    expect(store.activate(workspace3.id, 2)).toBe('activated');

    expect(store.snapshot().activeId).toBe(workspace2.id);
    expect(store.snapshot().activeIdByWindow).toEqual({
      1: workspace2.id,
      2: workspace3.id,
    });
  });
});
