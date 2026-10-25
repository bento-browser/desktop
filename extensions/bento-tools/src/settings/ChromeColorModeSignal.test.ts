import { describe, expect, it, vi } from 'vitest';
import { createChromeColorModeSignal } from './ChromeColorModeSignal';

const stamp = (seq: number) => ({ run: 'run-a', seq, flipAt: 1_000 + seq });

describe('createChromeColorModeSignal', () => {
  it('sends the pref once per colour change and nothing for an unchanged mode', () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const signal = createChromeColorModeSignal(send, 'light');

    // Other settings changing re-run the handler with the same mode.
    signal('light', stamp(1));
    signal('light', stamp(1));
    expect(send).not.toHaveBeenCalled();

    signal('dark', stamp(2));
    signal('dark', stamp(2));
    expect(send).toHaveBeenCalledTimes(1);
    // The order stamp rides along for chrome to compare.
    expect(send).toHaveBeenLastCalledWith('dark', stamp(2));

    // The pref is sent as chosen: chrome resolves Auto itself.
    signal('system', stamp(3));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith('system', stamp(3));

    signal('light', stamp(4));
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('keeps the change recorded when a send fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error('no window'));
    const signal = createChromeColorModeSignal(send, 'light');

    signal('dark', stamp(1));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));

    // A throw instead of a rejection (the experiment is missing) is contained the same way.
    const missing = createChromeColorModeSignal(() => {
      throw new TypeError('notifyUiColorMode is not a function');
    }, 'light');
    expect(() => missing('dark', stamp(1))).not.toThrow();

    // The same mode is not retried, and the next real change still goes out.
    send.mockClear();
    signal('dark', stamp(1));
    expect(send).not.toHaveBeenCalled();
    send.mockResolvedValue(undefined);
    signal('light', stamp(2));
    expect(send).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('retries once without flipAt when the send with it fails, and logs only if that fails too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // An older cached schema rejects the unexpected `flipAt` property.
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Unexpected property "flipAt"'))
      .mockResolvedValue(undefined);
    const signal = createChromeColorModeSignal(send, 'light');

    signal('dark', stamp(1));
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send).toHaveBeenNthCalledWith(1, 'dark', stamp(1));
    expect(send).toHaveBeenNthCalledWith(2, 'dark', { run: 'run-a', seq: 1 });
    await Promise.resolve();
    expect(warn).not.toHaveBeenCalled();

    // Both fail: one retry, no loop, both errors logged together.
    const failing = vi.fn().mockRejectedValue(new Error('no window'));
    const failed = createChromeColorModeSignal(failing, 'light');
    failed('dark', stamp(1));
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(failing).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]).toHaveLength(3);

    // A stamp without a time has nothing to leave out, so it is not retried.
    const untimed = vi.fn().mockRejectedValue(new Error('no window'));
    createChromeColorModeSignal(untimed, 'light')('dark', { run: 'run-a', seq: 1 });
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    expect(untimed).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
