import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPanelsSyncScheduler, type PanelsSyncOptions } from './PanelsSyncScheduler';

/** Lets every microtask queued so far (and their continuations) run. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('panels/sync scheduler', () => {
  const emitted: Array<{ workspaceId: string; options: PanelsSyncOptions }> = [];
  const emit = vi.fn(async (workspaceId: string, options: PanelsSyncOptions) => {
    emitted.push({ workspaceId, options });
  });

  beforeEach(() => {
    emitted.length = 0;
    emit.mockClear();
  });

  it('turns a burst of requests for one workspace into one emit', async () => {
    const schedule = createPanelsSyncScheduler(emit);

    for (let i = 0; i < 50; i += 1) void schedule('ws-1');
    expect(emit).not.toHaveBeenCalled();
    await nextTask();

    expect(emitted).toEqual([{ workspaceId: 'ws-1', options: {} }]);
  });

  it('emits once per workspace', async () => {
    const schedule = createPanelsSyncScheduler(emit);

    void schedule('ws-1');
    void schedule('ws-2');
    void schedule('ws-1');
    await nextTask();

    expect(emitted.map((entry) => entry.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('keeps a one-shot scroll target when a later request has none, and lets a later target win', async () => {
    const schedule = createPanelsSyncScheduler(emit);

    void schedule('ws-1', { scrollToPanelTabId: 7, scrollToPanelReveal: 'right-edge' });
    void schedule('ws-1');
    await nextTask();
    void schedule('ws-1', { scrollToPanelTabId: 7, scrollToPanelReveal: 'right-edge' });
    void schedule('ws-1', { scrollToPanelTabId: 9 });
    await nextTask();

    expect(emitted.map((entry) => entry.options)).toEqual([
      { scrollToPanelTabId: 7, scrollToPanelReveal: 'right-edge' },
      { scrollToPanelTabId: 9 },
    ]);
  });

  it('does not merge requests aimed at different windows', async () => {
    const schedule = createPanelsSyncScheduler(emit);

    void schedule('ws-1', { windowId: 1 });
    void schedule('ws-1', { windowId: 2 });
    void schedule('ws-1', { windowId: 1 });
    await nextTask();

    expect(emitted.map((entry) => entry.options.windowId).sort()).toEqual([1, 2]);
  });

  it('resolves every caller after the shared emit finishes', async () => {
    let finishEmit = () => {};
    const slowEmit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishEmit = resolve;
        }),
    );
    const schedule = createPanelsSyncScheduler(slowEmit);
    let settled = 0;

    void schedule('ws-1').then(() => (settled += 1));
    void schedule('ws-1').then(() => (settled += 1));
    await nextTask();
    expect(settled).toBe(0);

    finishEmit();
    await nextTask();

    expect(settled).toBe(2);
    expect(slowEmit).toHaveBeenCalledTimes(1);
  });

  it('starts a new emit for a request that arrives while one is in flight', async () => {
    const slowEmit = vi.fn(() => new Promise<void>(() => {}));
    const schedule = createPanelsSyncScheduler(slowEmit);

    void schedule('ws-1');
    await nextTask();
    expect(slowEmit).toHaveBeenCalledTimes(1);

    // The in-flight emit may already have read older state.
    void schedule('ws-1');
    await nextTask();

    expect(slowEmit).toHaveBeenCalledTimes(2);
  });

  it('passes emit failures to every caller', async () => {
    const schedule = createPanelsSyncScheduler(async () => {
      throw new Error('boom');
    });

    const results = Promise.allSettled([schedule('ws-1'), schedule('ws-1')]);

    expect((await results).map((result) => result.status)).toEqual(['rejected', 'rejected']);
  });
});
