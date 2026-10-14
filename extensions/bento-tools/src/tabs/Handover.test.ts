import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HANDOVER_TTL_MS, wasHandedOver } from './Handover';

function stubSessions(value: unknown) {
  const getTabValue = vi.fn().mockResolvedValue(value);
  const removeTabValue = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('browser', { sessions: { getTabValue, removeTabValue } });
  return { getTabValue, removeTabValue };
}

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
    const { getTabValue } = stubSessions({ from: 2, to: 1, at: Date.now() });

    await expect(wasHandedOver(7, { from: 2 })).resolves.toBe(true);

    expect(getTabValue).toHaveBeenCalledWith(7, 'bento.handover');
  });

  it('recognises the move into the window the tab arrived in (onAttached)', async () => {
    stubSessions({ from: 2, to: 1, at: Date.now() });

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(true);
  });

  it('does not count a tab that went to or came from another window', async () => {
    stubSessions({ from: 2, to: 1, at: Date.now() });

    // The user dragged the handed-over tab on to a third window.
    await expect(wasHandedOver(7, { from: 1 })).resolves.toBe(false);
    await expect(wasHandedOver(7, { to: 3 })).resolves.toBe(false);
  });

  it('reads the marker again for the second event instead of consuming it', async () => {
    stubSessions({ from: 2, to: 1, at: Date.now() });

    await expect(wasHandedOver(7, { from: 2 })).resolves.toBe(true);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(true);
  });

  it('lets a marker that outlived its TTL (a restored session) pass as a user move', async () => {
    stubSessions({ from: 2, to: 1, at: Date.now() - HANDOVER_TTL_MS - 1 });

    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('ignores a tab with no marker or a malformed one, and an unreadable tab', async () => {
    stubSessions(undefined);
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);

    stubSessions({ from: '2', to: 1, at: Date.now() });
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);

    const { getTabValue } = stubSessions(undefined);
    getTabValue.mockRejectedValue(new Error('Invalid tab ID: 7'));
    await expect(wasHandedOver(7, { to: 1 })).resolves.toBe(false);
  });

  it('removes the value once it has expired, not before', async () => {
    const { removeTabValue } = stubSessions({ from: 2, to: 1, at: Date.now() });

    await wasHandedOver(7, { to: 1 });
    await vi.advanceTimersByTimeAsync(HANDOVER_TTL_MS - 1);
    expect(removeTabValue).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(removeTabValue).toHaveBeenCalledWith(7, 'bento.handover');
  });
});
