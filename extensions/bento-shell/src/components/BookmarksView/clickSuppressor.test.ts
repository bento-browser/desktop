import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RELEASE_GRACE_MS, createClickSuppressor } from './clickSuppressor';

const pointer = (type: string, pointerId: number) =>
  Object.assign(new Event(type, { cancelable: true }), { pointerId });

describe('click suppressor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('after Esc cancels a drag, stays on until the button is released and the click has passed', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    // The drag started with the button down; Esc ended the drag, which changes nothing here.
    suppressor.begin(7, false);
    vi.advanceTimersByTime(60_000);
    expect(suppressor.isActive()).toBe(true);

    // The release, the click React Aria acts on, and its own fallback click 80 ms later.
    win.dispatchEvent(pointer('pointerup', 7));
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(suppressor.isActive()).toBe(true);

    vi.advanceTimersByTime(1);
    expect(suppressor.isActive()).toBe(false);
  });

  it('does not swallow the click: React Aria needs it to fire the press, or it clicks again itself', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    suppressor.begin(7, true);
    const click = new Event('click', { cancelable: true });
    const stop = vi.spyOn(click, 'stopPropagation');
    win.dispatchEvent(click);
    expect(stop).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it('ignores the release of another pointer', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    suppressor.begin(7, false);
    win.dispatchEvent(pointer('pointerup', 8));
    vi.advanceTimersByTime(RELEASE_GRACE_MS * 2);
    expect(suppressor.isActive()).toBe(true);
    win.dispatchEvent(pointer('pointercancel', 7));
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(suppressor.isActive()).toBe(false);
  });

  it('after a drop, whose release has already happened, ends once the grace has passed', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    suppressor.begin(7, true);
    expect(suppressor.isActive()).toBe(true);
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(suppressor.isActive()).toBe(false);
  });

  it('ends at once on a new press or when the window loses focus', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    suppressor.begin(1, false);
    win.dispatchEvent(pointer('pointerdown', 2));
    expect(suppressor.isActive()).toBe(false);

    suppressor.begin(3, false);
    win.dispatchEvent(new Event('blur'));
    expect(suppressor.isActive()).toBe(false);
  });

  it('keeps a drag going when the release timer of the drop before it fires', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    // A drop, whose release timer is out for RELEASE_GRACE_MS.
    suppressor.begin(1, true);
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);

    // A new drag starts inside that grace and is still held when the old timer fires.
    suppressor.begin(2, false);
    vi.advanceTimersByTime(RELEASE_GRACE_MS / 2);
    expect(suppressor.isActive()).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(suppressor.isActive()).toBe(true);

    // Its own release still ends it, a full grace later.
    win.dispatchEvent(pointer('pointerup', 2));
    vi.advanceTimersByTime(RELEASE_GRACE_MS - 1);
    expect(suppressor.isActive()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(suppressor.isActive()).toBe(false);
  });

  it('ignores a release callback of a gesture that is over, whoever runs it and when', () => {
    const win = new EventTarget();
    const pending: Array<() => void> = [];
    const suppressor = createClickSuppressor(
      () => win,
      (done) => void pending.push(done),
    );
    suppressor.begin(1, true);
    suppressor.begin(2, true);
    const [first, second] = pending;

    // The first drop's callback arrives after the second drop began.
    first?.();
    expect(suppressor.isActive()).toBe(true);
    second?.();
    expect(suppressor.isActive()).toBe(false);

    // A callback after the gesture was ended by hand cannot end the next one either.
    suppressor.begin(3, true);
    suppressor.end();
    suppressor.begin(4, false);
    pending[2]?.();
    expect(suppressor.isActive()).toBe(true);
  });

  it('ends when told to, and a second drag replaces the first without leaving a listener', () => {
    const win = new EventTarget();
    const suppressor = createClickSuppressor(() => win);
    suppressor.begin(1, false);
    suppressor.end();
    expect(suppressor.isActive()).toBe(false);

    suppressor.begin(1, false);
    suppressor.begin(2, false);
    win.dispatchEvent(pointer('pointerup', 1));
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(suppressor.isActive()).toBe(true);
    win.dispatchEvent(pointer('pointerup', 2));
    vi.advanceTimersByTime(RELEASE_GRACE_MS);
    expect(suppressor.isActive()).toBe(false);
  });
});
