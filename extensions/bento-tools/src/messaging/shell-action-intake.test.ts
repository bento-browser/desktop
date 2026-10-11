import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@shared/protocol';
import { createShellActionIntake, createWindowRegistry } from './shell-action-intake';

/** Lets queued window checks and deliveries settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(existingWindows: number[] = [7]) {
  const removedListeners: Array<(windowId: number) => void> = [];
  const get = vi.fn(async (windowId: number) => {
    if (!existingWindows.includes(windowId)) throw new Error(`Invalid window ID: ${windowId}`);
    return { id: windowId };
  });
  const windows = createWindowRegistry({
    get,
    onRemoved: { addListener: (listener) => void removedListeners.push(listener) },
  });
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

  it('checks a claimed window once, then delivers synchronously', async () => {
    const { intake, delivered, get } = setup();
    intake({ type: 'shell/hello', windowId: 7, __windowId: 7 });
    expect(delivered).toHaveLength(0);
    await settle();
    expect(delivered).toEqual([{ action: { type: 'shell/hello', windowId: 7 }, windowId: 7 }]);
    intake({ type: 'tab/close', id: 3, __windowId: 7 });
    expect(delivered).toHaveLength(2);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('drops actions that claim a window that does not exist', async () => {
    const { intake, run, get } = setup([7]);
    intake({ type: 'workspace/activate', id: 'ws-1', __windowId: 99 });
    intake({ type: 'workspace/activate', id: 'ws-1', __windowId: 99 });
    await settle();
    expect(run).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(99);
  });

  it('treats the shell/hello payload window as a claim', async () => {
    const { intake, delivered, get } = setup([7]);
    intake({ type: 'shell/hello', windowId: 99 });
    intake({ type: 'shell/hello', windowId: 7, __windowId: 8 });
    intake({ type: 'shell/hello', windowId: 7 });
    await settle();
    expect(get).toHaveBeenCalledWith(99);
    expect(delivered).toEqual([{ action: { type: 'shell/hello', windowId: 7 }, windowId: null }]);
  });

  it('forgets a window when it closes', async () => {
    const { intake, run, get, removeWindow } = setup([7]);
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
    const { intake, delivered, get, removeWindow } = setup([7]);
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
    const { intake, delivered } = setup([7]);
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
    const { intake, delivered } = setup([7]);
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
    const { intake, run } = setup([7]);
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
