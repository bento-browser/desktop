// The colour mode flip fade: when the root attribute is on, and that it only leaves
// after the fade has ended.

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown) => void;

let attributes: Map<string, string>;
let listeners: Map<string, Set<Listener>>;
let reducedMotion: boolean;
let hidden: boolean;
let duration: string;
/** Attribute state seen by each `write`, to check the order of the steps. */
let seenByWrite: Array<string | null>;
/** Animation frame callbacks not yet run; `frame()` runs them like a rendering update. */
let frames: Map<number, (timestamp: number) => void>;
let nextFrameId: number;
let styleReads: number;
/** How far the wall clock (Date.now) has been stepped away from the monotonic clock. */
let clockStep: number;
/** Inline custom properties on the root, as `style.setProperty` leaves them. */
let styleProps: Map<string, string>;
/** The modes the announce callback was called with, in order. */
let announced: string[];

function frame() {
  const due = [...frames.values()];
  frames.clear();
  for (const callback of due) callback(performance.now());
}

/** Time passing at 240 Hz: every 4 ms a rendering update runs the queued frame callbacks. */
function pass(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 4) {
    vi.advanceTimersByTime(4);
    frame();
  }
}

const FADE = 'data-bento-mode-fade';

function loadHelper() {
  vi.resetModules();
  return import('./modeFade');
}

/** Steps the wall clock, as NTP or a manual change does; the monotonic clock does not move. */
function stepClock(ms: number) {
  clockStep += ms;
  vi.setSystemTime(Date.now() + ms);
}

type Mode = 'light' | 'dark';

function flip(
  apply: (
    resolve: () => Mode,
    write: (resolved: Mode) => void,
    flipAt?: number,
    announce?: (resolved: Mode) => void,
  ) => void,
  to: Mode | (() => Mode),
  flipAt?: number,
  label = '',
) {
  apply(
    typeof to === 'function' ? to : () => to,
    (resolved) => {
      seenByWrite.push(attributes.get(FADE) ?? null);
      attributes.set('data-color-mode', resolved);
    },
    flipAt,
    (resolved) => announced.push(label + resolved),
  );
}

beforeEach(() => {
  styleProps = new Map();
  announced = [];
  attributes = new Map([['data-color-mode', 'light']]);
  listeners = new Map();
  reducedMotion = false;
  hidden = false;
  duration = '0.12s';
  seenByWrite = [];
  frames = new Map();
  nextFrameId = 1;
  styleReads = 0;
  clockStep = 0;
  vi.useFakeTimers();
  vi.stubGlobal('performance', { now: () => Date.now() - clockStep });
  vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
    frames.set(nextFrameId, callback);
    return nextFrameId++;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const root = {
    isConnected: true,
    getAttribute: (name: string) => attributes.get(name) ?? null,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
    style: {
      setProperty: (name: string, value: string) => styleProps.set(name, value),
      removeProperty: (name: string) => styleProps.delete(name),
    },
    addEventListener: (type: string, listener: Listener) =>
      listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)),
    removeEventListener: (type: string, listener: Listener) =>
      listeners.get(type)?.delete(listener),
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => {
          styleReads += 1;
          return {
            transitionProperty: 'background-color',
            transitionDuration: duration,
            // What the catch-all computes from the root's inline delay (a <time>, in seconds).
            transitionDelay: `${parseFloat(styleProps.get('--bento-mode-fade-delay') ?? '0') / 1000}s`,
            animationName: 'none',
            animationDuration: '0s',
            animationDelay: '0s',
            animationIterationCount: '1',
          };
        },
      },
    },
  };
  vi.stubGlobal('document', {
    documentElement: root,
    get hidden() {
      return hidden;
    },
    addEventListener: root.addEventListener,
    removeEventListener: root.removeEventListener,
  });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') && reducedMotion,
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('applyModeWithFade', () => {
  it('skips the first application in a document, then fades a real change', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'dark');
    expect(seenByWrite).toEqual([null]);
    expect(attributes.has(FADE)).toBe(false);

    flip(applyModeWithFade, 'light');
    expect(seenByWrite).toEqual([null, '']);
    expect(attributes.has(FADE)).toBe(true);
  });

  it('sets the attribute before the mode and removes it only once the fade has ended', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    expect(seenByWrite[1]).toBe('');
    // The write is all the handler does: the style read waits for the frame.
    expect(styleReads).toBe(0);
    frame();
    expect(styleReads).toBeGreaterThan(0);

    // Still fading: dropping the rule now would cancel the running transitions.
    vi.advanceTimersByTime(100);
    expect(attributes.has(FADE)).toBe(true);

    // The end of the root's own colour transition ends the wait.
    for (const listener of listeners.get('transitionend') ?? []) {
      listener({
        type: 'transitionend',
        target: document.documentElement,
        propertyName: 'background-color',
      });
    }
    expect(attributes.has(FADE)).toBe(false);
    expect(listeners.get('transitionend')?.size).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0); // the fade is over: nothing is watched
  });

  it('falls back to a timer when no transition end arrives', async () => {
    const { applyModeWithFade, MODE_FADE_ATTRIBUTE } = await loadHelper();
    expect(MODE_FADE_ATTRIBUTE).toBe(FADE);
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    frame();
    vi.advanceTimersByTime(120 + 50 + 1);
    expect(attributes.has(FADE)).toBe(false);
  });

  it('does not fade an unchanged value', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'light');
    expect(seenByWrite).toEqual([null, null]);
    expect(attributes.has(FADE)).toBe(false);
  });

  it('does not fade with reduced motion or in a hidden document', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    reducedMotion = true;
    flip(applyModeWithFade, 'dark');
    reducedMotion = false;
    hidden = true;
    flip(applyModeWithFade, 'light');
    expect(seenByWrite).toEqual([null, null, null]);
    expect(attributes.has(FADE)).toBe(false);
  });

  it('removes the attribute at once when the motion token resolves to zero', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    duration = '0s';
    flip(applyModeWithFade, 'dark');
    expect(seenByWrite[1]).toBe('');
    frame();
    expect(attributes.has(FADE)).toBe(false);
  });

  it('restarts cleanly on a flip during a fade', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    frame();
    vi.advanceTimersByTime(100);

    // The attribute stays on across the second flip, so no transition is cancelled.
    flip(applyModeWithFade, 'light');
    frame();
    expect(seenByWrite[2]).toBe('');
    expect(attributes.has(FADE)).toBe(true);

    // The first flip's timer (due at 170 ms) no longer ends the fade.
    vi.advanceTimersByTime(100);
    expect(attributes.has(FADE)).toBe(true);
    vi.advanceTimersByTime(80);
    expect(attributes.has(FADE)).toBe(false);
  });
});

describe('a flip before the frame', () => {
  it('replaces the pending wait, so one wait ends the fade', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    flip(applyModeWithFade, 'light');
    expect(frames.size).toBe(1);
    expect(attributes.has(FADE)).toBe(true);

    frame();
    vi.advanceTimersByTime(120 + 50 + 1);
    expect(attributes.has(FADE)).toBe(false);
  });
});

describe('a change that does not fade, during a fade', () => {
  it.each([
    ['hidden', () => (hidden = true)],
    ['reduced motion', () => (reducedMotion = true)],
  ])('ends the fade and its pending wait when the document is %s', async (_name, enter) => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    // Hidden before the queued frame ran: no wait has started yet.
    expect(frames.size).toBe(1);
    expect(attributes.has(FADE)).toBe(true);

    enter();
    flip(applyModeWithFade, 'light');
    expect(attributes.has(FADE)).toBe(false);
    expect(seenByWrite[2]).toBeNull();
    expect(frames.size).toBe(0);
    expect(attributes.get('data-color-mode')).toBe('light');
  });

  it('also stops a wait that is already running', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    frame();
    vi.advanceTimersByTime(50);
    expect(listeners.get('transitionend')?.size).toBe(1);

    hidden = true;
    flip(applyModeWithFade, 'light');
    expect(attributes.has(FADE)).toBe(false);
    expect(listeners.get('transitionend')?.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the fade alone when the value is unchanged, whatever the document state', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    hidden = true;
    flip(applyModeWithFade, 'dark');
    expect(attributes.has(FADE)).toBe(true);
    expect(frames.size).toBe(1);

    hidden = false;
    frame();
    vi.advanceTimersByTime(120 + 50 + 1);
    expect(attributes.has(FADE)).toBe(false);
  });
});

describe('a scheduled flip (flipAt)', () => {
  const NOW = 1_000_000;
  const DELAY = '--bento-mode-fade-delay';
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it('prepares the flip in the first frame, with a delay that ends at flipAt, and announces it then', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'dark', NOW + 120);
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(4);
    // Mode and fade are on; the delay is measured from this frame, so the transitions start at
    // flipAt. The delay went on before the attribute, the attribute before the mode.
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(seenByWrite).toEqual([null, '']);
    expect(styleProps.get(DELAY)).toBe('116ms');
    expect(announced).toEqual(['light']);

    pass(112);
    expect(announced).toEqual(['light']);
    pass(8);
    expect(announced).toEqual(['light', 'dark']);
    // Not before the time, and not a frame after it that another document could have taken.
    expect(Date.now()).toBeLessThanOrEqual(NOW + 124);
    pass(300);
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
  });

  it('applies at once at or past flipAt, and without one, with no delay', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'dark', NOW);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(styleProps.get(DELAY)).toBe('0ms');
    flip(applyModeWithFade, 'light', NOW - 50);
    expect(attributes.get('data-color-mode')).toBe('light');
    flip(applyModeWithFade, 'dark');
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(seenByWrite).toEqual([null, '', '', '']);
    expect(announced).toEqual(['light', 'dark', 'light', 'dark']);
  });

  it('applies the first application at once, however far ahead flipAt is', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'dark', NOW + 120);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(seenByWrite).toEqual([null]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies a hidden document at once and an unchanged value as a no-op', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'light', NOW + 120);
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    hidden = true;
    flip(applyModeWithFade, 'dark', NOW + 120);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(attributes.has(FADE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still waits under reduced motion, then snaps without the fade', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    reducedMotion = true;

    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(100);
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(24);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(attributes.has(FADE)).toBe(false);
    expect(announced).toEqual(['light', 'dark']);
  });

  it('is replaced by a newer call, which includes flipping back before flipAt', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(48);
    expect(attributes.get('data-color-mode')).toBe('dark'); // prepared
    flip(applyModeWithFade, 'light', NOW + 170);
    pass(4);
    // Back to light before the first flip showed: the dark announcement never goes out.
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(300);
    expect(attributes.has(FADE)).toBe(false);
    expect(announced).toEqual(['light', 'light']);

    // A newer request for the other mode takes the place of one that has not been prepared yet,
    // with its own time: dark is asked for, then light (what is on screen) before any frame.
    flip(applyModeWithFade, 'dark', Date.now() + 100);
    flip(applyModeWithFade, 'light', Date.now() + 150);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    pass(300);
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(announced).toEqual(['light', 'light', 'light']);
  });

  it('joins a waiting flip that has not been prepared yet when a request names the same mode', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120, 'dark:');
    // No frame has run: this document is not prepared, as one whose renderer is busy is not.
    vi.advanceTimersByTime(40);
    flip(applyModeWithFade, 'dark', NOW + 160, 'auto:');
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(frames.size).toBe(1);
    frame();
    // Prepared for the first request's time, not the newer one's: a prepared document keeps
    // its time (its transitions cannot be re-timed), so no document takes the later one.
    expect(styleProps.get(DELAY)).toBe('80ms');
    pass(76);
    expect(announced).toEqual(['light']);
    pass(8);
    expect(announced).toEqual(['light', 'auto:dark']);
    pass(400);
    expect(announced).toEqual(['light', 'auto:dark']);
  });

  it('applies the newest request when a later one joins a flip that has not been prepared yet', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    const writes: string[] = [];
    applyModeWithFade(
      () => 'dark',
      (resolved) => {
        writes.push('first');
        attributes.set('data-color-mode', resolved);
      },
      NOW + 120,
    );
    vi.advanceTimersByTime(20);
    applyModeWithFade(
      () => 'dark',
      (resolved) => {
        writes.push('second');
        attributes.set('data-color-mode', resolved);
      },
      NOW + 160,
    );
    expect(writes).toEqual([]);
    frame();
    expect(writes).toEqual(['second']);
    expect(attributes.get('data-color-mode')).toBe('dark');
  });

  it('is finished once announced: a later request for that mode is not a join', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120, 'dark:');
    pass(400);
    expect(announced).toEqual(['light', 'dark:dark']);

    // Nothing waits any more: the same mode again applies and announces at once.
    flip(applyModeWithFade, 'dark', NOW + 1000, 'again:');
    expect(announced).toEqual(['light', 'dark:dark', 'again:dark']);
  });

  it('keeps the first request time for a duplicate, whatever the system clock did in between', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    // The wall clock steps forward before the first frame, then the same change arrives again
    // (another route): the wait must not be worked out a second time.
    stepClock(60_000);
    flip(applyModeWithFade, 'dark', NOW + 120);
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(4);
    expect(styleProps.get(DELAY)).toBe('116ms');
    pass(108);
    expect(announced).toEqual(['light']);
    pass(8);
    expect(announced).toEqual(['light', 'dark']);
  });

  it('applies at once, without a fade, when the document hides before the first frame', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(attributes.has(FADE)).toBe(false);
    expect(announced).toEqual(['light', 'dark']);
    // The wait is gone: no timer, no frame, no listener left to run it again.
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0);
  });

  it('announces a prepared flip at once when the document hides while it waits', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(20);
    expect(announced).toEqual(['light']);

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(announced).toEqual(['light', 'dark']);
    expect(listeners.get('visibilitychange')?.size).toBe(0);
    pass(300);
    expect(announced).toEqual(['light', 'dark']);
  });

  // flipAt is wall-clock time, frame times are monotonic. The step before the change arrives is
  // the bug that was found (tools stamps with the stepped clock, the document's own mapping of
  // frame times to wall time is not stepped); a step while it waits must not move it either.
  it.each([
    ['before', 60_000],
    ['before', -60_000],
    ['after', 60_000],
    ['after', -60_000],
  ] as const)(
    'is not thrown off by the system clock stepping %s the change arrives (%i ms)',
    async (when, step) => {
      const { applyModeWithFade } = await loadHelper();
      flip(applyModeWithFade, 'light');
      if (when === 'before') stepClock(step);
      flip(applyModeWithFade, 'dark', Date.now() + 120);
      pass(20);
      if (when === 'after') stepClock(step);

      // The deadline was fixed on the monotonic clock at receipt: 120 ms after it, not earlier and
      // not a step later.
      expect(attributes.get('data-color-mode')).toBe('dark');
      expect(styleProps.get(DELAY)).toBe('116ms');
      pass(96);
      expect(announced).toEqual(['light']);
      pass(8);
      expect(announced).toEqual(['light', 'dark']);
      expect(seenByWrite).toEqual([null, '']);
    },
  );

  it('resolves again when the flip is prepared, so an Auto choice shows the live value', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    let os: Mode = 'dark';

    flip(applyModeWithFade, () => os, NOW + 120);
    os = 'light'; // the OS changes before the first frame; nothing was listening
    pass(124);
    // Resolved light when prepared, which is what is on screen: nothing changes, nothing fades.
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(attributes.has(FADE)).toBe(false);
    expect(seenByWrite).toEqual([null, null]);
  });

  it('applies a change that is not scheduled (an OS flip) at once when it resolves to the other mode', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120, 'dark:');
    pass(8);
    expect(attributes.get('data-color-mode')).toBe('dark'); // prepared

    // The OS turns light during the wait: the stale mode is never announced.
    flip(applyModeWithFade, 'light', undefined, 'os:');
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(400);
    expect(attributes.has(FADE)).toBe(false);
    expect(announced).toEqual(['light', 'os:light']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins a waiting flip with a change that is not scheduled when both name the same mode', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120, 'dark:');
    pass(8);

    // An OS change that agrees with the prepared flip does not publish it ahead of its time.
    flip(applyModeWithFade, 'dark', undefined, 'os:');
    expect(announced).toEqual(['light']);
    pass(112);
    expect(announced).toEqual(['light', 'os:dark']);
    pass(300);
    expect(announced).toEqual(['light', 'os:dark']);
    expect(seenByWrite.filter((seen) => seen === '')).toHaveLength(2); // the flip, and the joined write
  });

  it('lets an Auto choice resolved to the waiting mode join, and a later OS change away from it replace it', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    let os: Mode = 'dark';
    flip(applyModeWithFade, () => os, NOW + 120, 'auto:');
    vi.advanceTimersByTime(20); // not prepared yet

    os = 'light'; // heard during the wait; the request that names it resolves to light
    flip(applyModeWithFade, () => os, undefined, 'os:');
    pass(400);
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(announced).toEqual(['light', 'os:light']);
    expect(attributes.has(FADE)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('timing of a scheduled flip', () => {
  const NOW = 1_000_000;
  const DELAY = '--bento-mode-fade-delay';
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it('holds the fade for the delay plus the duration, and announces only at flipAt', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);

    // Not at any frame of the lead window.
    for (let at = 4; at < 116; at += 4) {
      pass(4);
      expect(announced, `at ${at} ms`).toEqual(['light']);
    }
    pass(12);
    expect(announced).toEqual(['light', 'dark']);

    // The transitions start at flipAt (116 ms of delay from the first frame) and run 120 ms:
    // the fade, and the delay it was measured with, must outlive both.
    pass(100);
    expect(attributes.has(FADE)).toBe(true);
    pass(60);
    expect(attributes.has(FADE)).toBe(true);
    pass(110);
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
  });

  it('keeps the delay on the root until the fade ends', async () => {
    // Resetting it at flipAt would restyle every element in the frame the fade starts (the
    // sidebar's frame took 129 to 158 ms at 400 tabs instead of 33 to 67). The cost is that a
    // hover that starts during the fade waits as long as the flip did (see modeFade.ts).
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(60);
    expect(styleProps.get(DELAY)).toBe('116ms');
    pass(64);
    expect(styleProps.get(DELAY)).toBe('116ms');
    expect(attributes.has(FADE)).toBe(true);
    pass(300);
    expect(styleProps.has(DELAY)).toBe(false);
  });

  it.each([
    [0, '0ms'],
    [1, '-1ms'],
    [30, '-30ms'],
    [60, '-60ms'],
    [61, '0ms'],
  ])('a stamp that arrives %i ms after flipAt joins the fade with a delay of %s', async (late, delay) => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW - late);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(styleProps.get(DELAY)).toBe(delay);
    expect(announced).toEqual(['light', 'dark']);
    // The joined fade is shorter by what it is late: delay plus duration is what is waited for.
    pass(40);
    expect(attributes.has(FADE)).toBe(true);
    pass(200);
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
  });

  it('a stamp-less change fades from the start', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    expect(styleProps.get(DELAY)).toBe('0ms');
    expect(attributes.has(FADE)).toBe(true);
  });

  it.each([
    [145, '-25ms'],
    [180, '-60ms'],
    [181, '0ms'],
  ])('a first frame %i ms after receipt (120 ms lead) gets a delay of %s', async (frameAt, delay) => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    // The renderer stalls: no frame runs until frameAt.
    vi.advanceTimersByTime(frameAt);
    frame();
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(styleProps.get(DELAY)).toBe(delay);
    expect(announced).toEqual(['light', 'dark']);
  });

  it('drops the fade, the delay and the pending measurement when the document hides after preparation', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    // Prepared in the first frame; the measurement frame has not run yet.
    pass(4);
    expect(attributes.has(FADE)).toBe(true);
    expect(frames.size).toBe(1);

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    // No further frame is delivered to a hidden document.
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
    expect(announced).toEqual(['light', 'dark']);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0);

    // Shown again: nothing comes back, and the next flip fades normally.
    hidden = false;
    pass(300);
    expect(attributes.has(FADE)).toBe(false);
    expect(announced).toEqual(['light', 'dark']);
    flip(applyModeWithFade, 'light', Date.now() + 500);
    pass(8);
    expect(attributes.has(FADE)).toBe(true);
    expect(attributes.get('data-color-mode')).toBe('light');
  });

  it('also drops a fade whose measurement is already running when the document hides', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(24);
    expect(listeners.get('transitionend')?.size).toBe(1);

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
    expect(listeners.get('transitionend')?.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(announced).toEqual(['light', 'dark']);
  });

  it('drops the fade and its negative delay when the document hides after a late receipt', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    // The stamp arrives 30 ms after flipAt: the fade is joined part-way and announced at once.
    flip(applyModeWithFade, 'dark', NOW - 30);
    expect(styleProps.get(DELAY)).toBe('-30ms');
    expect(announced).toEqual(['light', 'dark']);
    expect(frames.size).toBe(1); // the measurement frame has not run

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0);

    // Shown again: no frame resumes the measurement, nothing comes back, nothing is announced twice.
    hidden = false;
    pass(400);
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
    expect(announced).toEqual(['light', 'dark']);
  });

  it('drops the fade and its negative delay when the document hides after a late preparation frame', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    // The renderer stalls: the first frame comes 57 ms after flipAt.
    vi.advanceTimersByTime(177);
    frame();
    expect(styleProps.get(DELAY)).toBe('-57ms');
    expect(announced).toEqual(['light', 'dark']);
    expect(frames.size).toBe(1);

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0);

    hidden = false;
    pass(400);
    expect(attributes.has(FADE)).toBe(false);
    expect(announced).toEqual(['light', 'dark']);
  });

  it('drops an immediate fade (no stamp) when the document hides before it is measured', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark');
    expect(attributes.has(FADE)).toBe(true);
    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins a prepared flip, keeping its time, when a newer request resolves to the same mode', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    // Dark chosen: prepared in the first frame, shown at flipAt.
    flip(applyModeWithFade, 'dark', NOW + 120, 'dark:');
    pass(40);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(announced).toEqual(['light']);

    // Auto chosen 40 ms later, resolving to dark as well: nothing is published yet, the show
    // time stays, and the newer request's announcement is the one that goes out.
    flip(applyModeWithFade, 'dark', NOW + 160, 'auto:');
    pass(60);
    expect(announced).toEqual(['light']);
    expect(attributes.has(FADE)).toBe(true);
    pass(24);
    expect(announced).toEqual(['light', 'auto:dark']);

    // Delivered once.
    pass(300);
    expect(announced).toEqual(['light', 'auto:dark']);
  });

  it('a newer request for the other mode still replaces the prepared one', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120, 'a:');
    pass(40);
    flip(applyModeWithFade, 'light', NOW + 160, 'b:');
    pass(300);
    expect(announced).toEqual(['light', 'b:light']);
    expect(attributes.get('data-color-mode')).toBe('light');
  });

  it('ends a fade that is still held when the change that follows does not fade', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(24);
    expect(styleProps.get(DELAY)).toBe('116ms');

    reducedMotion = true;
    flip(applyModeWithFade, 'light');
    expect(attributes.has(FADE)).toBe(false);
    expect(styleProps.has(DELAY)).toBe(false);
  });
});

describe('attribute name across runtimes', () => {
  // The shell, the chrome stylesheet and the mount script each spell the name themselves.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

  it('is the one the shell and chrome rules and the mount script use', async () => {
    const { MODE_FADE_ATTRIBUTE } = await loadHelper();
    expect(read('./document-base.css')).toContain(`:root[${MODE_FADE_ATTRIBUTE}] *::after`);
    const chrome = '../../../../src/browser/base/content/';
    expect(read(`${chrome}bento-chrome-theme.css`)).toContain(
      `:root[${MODE_FADE_ATTRIBUTE}] *::after`,
    );
    expect(read(`${chrome}bento-shell-mount.js`)).toContain(
      `BENTO_MODE_FADE_ATTR = '${MODE_FADE_ATTRIBUTE}'`,
    );
  });
});
