import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@shared/protocol';
import { createShellActionIntake, createWindowRegistry } from './shell-action-intake';

/** Lets queued window checks, their grace timers and deliveries settle. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * `existingWindows` are the ids `windows.get` accepts; `listedWindows` are the ones the
 * startup listing returns (a window can exist yet be missing from it while it is starting).
 */
function setup({
  existingWindows = [7],
  listedWindows = existingWindows,
  graceMs = 0,
  defaultTimeout = false,
}: {
  existingWindows?: number[];
  listedWindows?: number[];
  graceMs?: number;
  /** Use the registry's own announcement timeout instead of `graceMs`. */
  defaultTimeout?: boolean;
} = {}) {
  const createdListeners: Array<(window: { id?: number }) => void> = [];
  const removedListeners: Array<(windowId: number) => void> = [];
  const get = vi.fn(async (windowId: number) => {
    if (!existingWindows.includes(windowId)) throw new Error(`Invalid window ID: ${windowId}`);
    return { id: windowId };
  });
  const getAll = vi.fn(async () => listedWindows.map((id) => ({ id })));
  const windows = createWindowRegistry(
    {
      get,
      getAll,
      onCreated: { addListener: (listener) => void createdListeners.push(listener) },
      onRemoved: { addListener: (listener) => void removedListeners.push(listener) },
    },
    defaultTimeout ? undefined : graceMs,
  );
  const delivered: Array<{ action: Action; windowId: number | null }> = [];
  const run = vi.fn((action: Action, windowId: number | null) => {
    delivered.push({ action, windowId });
  });
  const intake = createShellActionIntake({ windows, run });
  return {
    intake,
    run,
    get,
    delivered,
    windows,
    createWindow: (windowId: number) =>
      createdListeners.forEach((listener) => listener({ id: windowId })),
    removeWindow: (windowId: number) => removedListeners.forEach((listener) => listener(windowId)),
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('shell action intake', () => {
  it('drops malformed messages without running them or throwing', async () => {
    const { intake, run, get } = setup();
    for (const message of [
      null,
      42,
      'ping',
      [],
      {},
      { type: 'tab/explode' },
      { type: 'tab/close', id: -1, __windowId: 7 },
      { type: 'tab/close', id: 3, __windowId: -1 },
      { type: 'tab/openUrl', url: 'javascript:alert(1)' },
      { type: 'tab/close', id: 3, extra: true },
    ]) {
      expect(() => intake(message)).not.toThrow();
    }
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('delivers valid actions without a window claim synchronously', () => {
    const { intake, delivered } = setup();
    intake({ type: 'tab/close', id: 3 });
    expect(delivered).toEqual([{ action: { type: 'tab/close', id: 3 }, windowId: null }]);
  });

  it('confirms a claimed window once, then delivers synchronously', async () => {
    const { intake, delivered, get } = setup();
    intake({ type: 'shell/hello', windowId: 7, __windowId: 7 });
    expect(delivered).toHaveLength(0);
    await settle();
    expect(delivered).toEqual([{ action: { type: 'shell/hello', windowId: 7 }, windowId: 7 }]);
    intake({ type: 'tab/close', id: 3, __windowId: 7 });
    expect(delivered).toHaveLength(2);
    expect(get).not.toHaveBeenCalled();
  });

  it('waits for a starting window to be announced instead of asking windows.get', async () => {
    // The first shell message of a new window can arrive before Firefox has built the
    // window's tab browser; windows.get then throws inside Firefox and the hello is lost.
    const { intake, delivered, get, createWindow } = setup({
      existingWindows: [],
      listedWindows: [],
      graceMs: 60_000,
    });
    intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
    intake({ type: 'tab/close', id: 3, __windowId: 9 });
    await settle();
    expect(delivered).toEqual([]);
    expect(get).not.toHaveBeenCalled();
    createWindow(9);
    await settle();
    expect(delivered.map((entry) => entry.action.type)).toEqual(['shell/hello', 'tab/close']);
    expect(get).not.toHaveBeenCalled();
  });

  it('keeps the first message of a window that takes seconds to start', async () => {
    // A window announces itself only once it has a tab browser. The shell sends its
    // hello once, so a message dropped while the window starts leaves it without a workspace.
    vi.useFakeTimers();
    try {
      const { intake, delivered, get, createWindow } = setup({
        existingWindows: [],
        listedWindows: [],
        defaultTimeout: true,
      });
      intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
      intake({ type: 'tab/close', id: 3, __windowId: 9 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(delivered).toEqual([]);
      expect(get).not.toHaveBeenCalled();
      createWindow(9);
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered.map((entry) => entry.action.type)).toEqual(['shell/hello', 'tab/close']);
      expect(get).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes an unannounced window once and drops its messages when the probe fails', async () => {
    vi.useFakeTimers();
    try {
      const { intake, delivered, get } = setup({
        existingWindows: [],
        listedWindows: [],
        defaultTimeout: true,
      });
      intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(get).toHaveBeenCalledTimes(1);
      expect(delivered).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps no waiter behind once a window was announced, removed or timed out', async () => {
    const { intake, windows, createWindow, removeWindow } = setup({
      existingWindows: [],
      listedWindows: [],
      graceMs: 60_000,
    });
    intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
    await settle();
    expect(windows.waitingWindows()).toBe(1);
    createWindow(9);
    await settle();
    expect(windows.waitingWindows()).toBe(0);

    intake({ type: 'shell/hello', windowId: 10, __windowId: 10 });
    await settle();
    removeWindow(10);
    await settle();
    expect(windows.waitingWindows()).toBe(0);

    const timedOut = setup({ existingWindows: [], listedWindows: [], graceMs: 1 });
    timedOut.intake({ type: 'shell/hello', windowId: 11, __windowId: 11 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(timedOut.windows.waitingWindows()).toBe(0);
  });

  it('delivers at once for a window that was announced before its first message', async () => {
    const { intake, delivered, get, createWindow } = setup({
      existingWindows: [],
      listedWindows: [],
    });
    createWindow(9);
    intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
    await settle();
    expect(delivered).toHaveLength(1);
    expect(get).not.toHaveBeenCalled();
  });

  it('asks windows.get once an unannounced window outlasts the grace period', async () => {
    const { intake, delivered, get } = setup({ existingWindows: [9], listedWindows: [] });
    intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
    await settle();
    expect(get).toHaveBeenCalledWith(9);
    expect(delivered).toHaveLength(1);
  });

  it('drops the queued messages of a window that closes before it was announced', async () => {
    const { intake, delivered, get, removeWindow } = setup({
      existingWindows: [],
      listedWindows: [],
      graceMs: 60_000,
    });
    intake({ type: 'shell/hello', windowId: 9, __windowId: 9 });
    await settle();
    removeWindow(9);
    await settle();
    expect(delivered).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it('drops actions that claim a window that does not exist', async () => {
    const { intake, run, get } = setup();
    intake({ type: 'workspace/activate', id: 'ws-1', __windowId: 99 });
    intake({ type: 'workspace/activate', id: 'ws-1', __windowId: 99 });
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(99);
  });

  it('treats the shell/hello payload window as a claim', async () => {
    const { intake, delivered, get } = setup();
    intake({ type: 'shell/hello', windowId: 99 });
    intake({ type: 'shell/hello', windowId: 7, __windowId: 8 });
    intake({ type: 'shell/hello', windowId: 7 });
    await settle();
    expect(get).toHaveBeenCalledWith(99);
    expect(delivered).toEqual([{ action: { type: 'shell/hello', windowId: 7 }, windowId: null }]);
  });

  it('forgets a window when it closes', async () => {
    const { intake, run, get, removeWindow } = setup();
    intake({ type: 'tab/close', id: 1, __windowId: 7 });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
    removeWindow(7);
    get.mockRejectedValue(new Error('Invalid window ID: 7'));
    intake({ type: 'tab/close', id: 2, __windowId: 7 });
    await settle();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not revive a window that closed while its lookup was pending', async () => {
    const { intake, delivered, get, removeWindow } = setup({
      existingWindows: [7],
      listedWindows: [],
    });
    let finishLookup: () => void = () => undefined;
    get.mockImplementationOnce(
      (windowId: number) =>
        new Promise((resolve) => {
          finishLookup = () => resolve({ id: windowId });
        }),
    );
    intake({ type: 'shell/hello', windowId: 7, __windowId: 7 });
    intake({ type: 'tab/close', id: 3, __windowId: 7 });
    await settle();
    expect(get).toHaveBeenCalledTimes(1);
    removeWindow(7);
    finishLookup();
    await settle();
    expect(delivered).toEqual([]);
    // The queued follow-up and any later message are dropped without a second lookup.
    intake({ type: 'tab/close', id: 4, __windowId: 7 });
    await settle();
    expect(delivered).toEqual([]);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps arrival order while a window check is pending', async () => {
    const { intake, delivered } = setup();
    intake({ type: 'shell/hello', windowId: 7, __windowId: 7 });
    intake({ type: 'tabs/requestSnapshot' });
    intake({ type: 'tab/close', id: 3, __windowId: 7 });
    await settle();
    expect(delivered.map((entry) => entry.action.type)).toEqual([
      'shell/hello',
      'tabs/requestSnapshot',
      'tab/close',
    ]);
  });

  it('keeps delivering after a dropped message in the queue', async () => {
    const { intake, delivered } = setup();
    intake({ type: 'tab/close', id: 1, __windowId: 99 });
    intake({ type: 'tab/close', id: 2, __windowId: 7 });
    intake({ type: 'tab/close', id: 3 });
    await settle();
    expect(delivered.map((entry) => entry.action)).toEqual([
      { type: 'tab/close', id: 2 },
      { type: 'tab/close', id: 3 },
    ]);
  });

  it('contains handler failures, sync and queued', async () => {
    const { intake, run } = setup();
    run.mockImplementation(() => {
      throw new Error('handler bug');
    });
    expect(() => intake({ type: 'tab/close', id: 1 })).not.toThrow();
    expect(() => intake({ type: 'tab/close', id: 2, __windowId: 7 })).not.toThrow();
    intake({ type: 'tab/close', id: 3, __windowId: 7 });
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
