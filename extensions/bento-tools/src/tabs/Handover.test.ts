import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A tab value rides the session file; the module also remembers which hops it matched.
// Each test loads a fresh copy, after the clock is set, so "this run" starts at that time.
async function load() {
  vi.resetModules();
  return import('./Handover');
}

function stubSessions(value: unknown) {
  const getTabValue = vi.fn().mockResolvedValue(value);
  const removeTabValue = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('browser', { sessions: { getTabValue, removeTabValue } });
  return { getTabValue, removeTabValue };
}

const hop = (from: number, to: number, at = Date.now()) => ({ from, to, at });

describe('wasHandedOver', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('recognises the move out of the window the tab left (onDetached)', async () => {
    const { wasHandedOver } = await load();
    const { getTabValue } = stubSessions([hop(2, 1)]);

    await expect(wasHandedOver(7, { from: 2 })).resolves.toBe(true);

    expect(getTabValue).toHaveBeenCalledWith(7, 'bento.handover');
  });

  it('recognises the move into the window the tab arrived in (onAttached)', async () => {
    const { wasHandedOver } = await load();
    stubSessions([hop(2, 1)]);

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(true);
  });

  it('matches the detach and the attach of one hop, in either order', async () => {
    const { wasHandedOver } = await load();
    stubSessions([hop(2, 1)]);

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(true);
    await expect(wasHandedOver(7, { from: 2 })).resolves.toBe(true);
  });

  it('does not count a tab that went to or came from another window', async () => {
    const { wasHandedOver } = await load();
    stubSessions([hop(2, 1)]);

    // The user dragged the handed-over tab on to a third window.
    await expect(wasHandedOver(7, { from: 1 })).resolves.toBe(false);
    await expect(wasHandedOver(7, { to: 3 })).resolves.toBe(false);
  });

  it('matches each side of a hop once, so a drag back into the window is a drag', async () => {
    const { wasHandedOver } = await load();
    stubSessions([hop(2, 1)]);
    await expect(wasHandedOver(7, { from: 2 })).resolves.toBe(true);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(true);

    // Moments later the user drags the tab to window 3 and back to window 1.
    vi.advanceTimersByTime(2_000);
    await expect(wasHandedOver(7, { from: 1 })).resolves.toBe(false);
    await expect(wasHandedOver(7, { to: 3 })).resolves.toBe(false);
    await expect(wasHandedOver(7, { from: 3 })).resolves.toBe(false);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('matches every hop of a tab handed on before tools saw the first', async () => {
    const { wasHandedOver } = await load();
    // Window 2 closed into window 1, and window 1 into window 3, in one task.
    stubSessions([hop(2, 1), hop(1, 3)]);

    for (const windows of [{ from: 2 }, { to: 1 }, { from: 1 }, { to: 3 }]) {
      await expect(wasHandedOver(7, windows)).resolves.toBe(true);
    }
    // Each hop is spent once matched.
    await expect(wasHandedOver(7, { to: 3 })).resolves.toBe(false);
  });

  it('lets a hop that outlived its TTL pass as a user move', async () => {
    const { wasHandedOver, HANDOVER_TTL_MS } = await load();
    stubSessions([hop(2, 1, Date.now() - HANDOVER_TTL_MS - 1)]);

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('ignores a hop written before this tools instance started (a restored session)', async () => {
    const { wasHandedOver } = await load();
    // Window ids repeat across runs, so a value from the last run can name today's windows.
    stubSessions([hop(2, 1, Date.now() - 1_000)]);

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('ignores a tab with no value or a malformed one, and an unreadable tab', async () => {
    const { wasHandedOver } = await load();
    stubSessions(undefined);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);

    stubSessions([{ from: '2', to: 1, at: Date.now() }]);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);

    stubSessions(hop(2, 1));
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);

    const { getTabValue } = stubSessions(undefined);
    getTabValue.mockRejectedValue(new Error('Invalid tab ID: 7'));
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('only reads: it never removes or rewrites the value, however long it waits', async () => {
    // A cleanup that read the value and removed it later could delete a hop that chrome
    // appended in between (a tab handed on again), so tools leaves expiry to the hop's time
    // and to chrome, which prunes while it appends.
    const { wasHandedOver, HANDOVER_TTL_MS } = await load();
    const { getTabValue, removeTabValue } = stubSessions([hop(2, 1)]);
    const setTabValue = vi.fn();
    vi.stubGlobal('browser', { sessions: { getTabValue, removeTabValue, setTabValue } });

    await wasHandedOver(7, { from: 2 });
    await wasHandedOver(7, { to: 1 });
    // The next handover is appended while tools would have been cleaning up.
    getTabValue.mockResolvedValue([hop(2, 1), hop(1, 3, Date.now() + 10_000)]);
    await vi.advanceTimersByTimeAsync(HANDOVER_TTL_MS * 2);

    expect(removeTabValue).not.toHaveBeenCalled();
    expect(setTabValue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not match a hop timed in the future', async () => {
    const { wasHandedOver } = await load();
    stubSessions([hop(2, 1, Date.now() + 60_000)]);

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('matches a hop appended after an earlier one was spent', async () => {
    const { wasHandedOver } = await load();
    const { getTabValue } = stubSessions([hop(2, 1)]);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(true);

    vi.advanceTimersByTime(1_000);
    getTabValue.mockResolvedValue([hop(2, 1, 1_000_000), hop(1, 3)]);

    await expect(wasHandedOver(7, { from: 1 })).resolves.toBe(true);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
    await expect(wasHandedOver(7, { to: 3 })).resolves.toBe(true);
  });
});
