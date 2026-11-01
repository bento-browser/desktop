import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDismissTimer } from './dismissTimer';

describe('dismiss timer of an undo toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('expires after its time when nothing holds it', () => {
    const onExpire = vi.fn();
    createDismissTimer(6000, onExpire);
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('stays while the pointer is on it, and counts the full time again after', () => {
    const onExpire = vi.fn();
    const timer = createDismissTimer(6000, onExpire);
    vi.advanceTimersByTime(5000);
    timer.hold('pointer');
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.release('pointer');
    vi.advanceTimersByTime(5999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting for a focused button after the pointer leaves', () => {
    const onExpire = vi.fn();
    const timer = createDismissTimer(6000, onExpire);
    timer.hold('focus');
    timer.hold('pointer');
    timer.release('pointer');
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.release('focus');
    vi.advanceTimersByTime(6000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('keeps waiting for the pointer after the focus leaves, and a repeated hold is one hold', () => {
    const onExpire = vi.fn();
    const timer = createDismissTimer(6000, onExpire);
    timer.hold('pointer');
    timer.hold('focus');
    timer.hold('focus');
    timer.release('focus');
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
    timer.release('pointer');
    vi.advanceTimersByTime(6000);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('does nothing once cancelled, even if released afterwards', () => {
    const onExpire = vi.fn();
    const timer = createDismissTimer(6000, onExpire);
    timer.hold('focus');
    timer.cancel();
    timer.release('focus');
    vi.advanceTimersByTime(60_000);
    expect(onExpire).not.toHaveBeenCalled();
  });
});
