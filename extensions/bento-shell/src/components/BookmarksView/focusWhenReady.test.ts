import { afterEach, describe, expect, it, vi } from 'vitest';

import { focusWhenReady } from './focusWhenReady';

/** A field that is inert for the first `inertFrames` frames, then focusable. */
function fakeField(inertFrames: number) {
  let frames = 0;
  const focus = vi.fn();
  return {
    focus,
    closest: () => (frames < inertFrames ? ({} as Element) : null),
    tick: () => (frames += 1),
  };
}

/** requestAnimationFrame that runs its callbacks when the test says a frame has passed. */
function stubFrames() {
  let queue: Array<{ id: number; run: () => void }> = [];
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (run: () => void) => {
    queue.push({ id: next, run });
    return next++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => {
    queue = queue.filter((entry) => entry.id !== id);
  });
  return (onFrame: () => void) => {
    const due = queue;
    queue = [];
    onFrame();
    for (const entry of due) entry.run();
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('focusWhenReady', () => {
  it('focuses at once when the page is not inert', () => {
    stubFrames();
    const field = fakeField(0);
    focusWhenReady(field);
    expect(field.focus).toHaveBeenCalledTimes(1);
  });

  it('waits out an inert page, then focuses once, a frame after it stops being inert', () => {
    const frame = stubFrames();
    const field = fakeField(2);
    focusWhenReady(field);
    expect(field.focus).not.toHaveBeenCalled();
    frame(field.tick);
    expect(field.focus).not.toHaveBeenCalled();
    frame(field.tick); // no longer inert: waits one more frame for the menu's focus return
    expect(field.focus).not.toHaveBeenCalled();
    frame(field.tick);
    expect(field.focus).toHaveBeenCalledTimes(1);
    frame(field.tick);
    expect(field.focus).toHaveBeenCalledTimes(1);
  });

  it('stops waiting when cancelled, and gives up on a page that stays inert', () => {
    const frame = stubFrames();
    const cancelled = fakeField(Infinity);
    focusWhenReady(cancelled)();
    frame(cancelled.tick);
    expect(cancelled.focus).not.toHaveBeenCalled();

    const stuck = fakeField(Infinity);
    focusWhenReady(stuck);
    for (let i = 0; i < 200; i += 1) frame(stuck.tick);
    expect(stuck.focus).toHaveBeenCalledTimes(1);
  });
});
