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
  apply: (resolve: () => Mode, write: (resolved: Mode) => void, flipAt?: number) => void,
  to: Mode | (() => Mode),
  flipAt?: number,
) {
  apply(
    typeof to === 'function' ? to : () => to,
    (resolved) => {
      seenByWrite.push(attributes.get(FADE) ?? null);
      attributes.set('data-color-mode', resolved);
    },
    flipAt,
  );
}

beforeEach(() => {
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
    setAttribute: (name: string, value: string) => attributes.set(name, value),
    removeAttribute: (name: string) => attributes.delete(name),
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
            transitionDelay: '0s',
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
  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it('waits for flipAt, then applies in the first frame at or after it, mode and fade together', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(116);
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(attributes.has(FADE)).toBe(false);

    pass(8);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(seenByWrite).toEqual([null, '']);
    // Not before the time, and not a frame after it that another document could have taken.
    expect(Date.now()).toBeLessThanOrEqual(NOW + 124);
  });

  it('applies at once at or past flipAt, and without one', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'dark', NOW);
    expect(attributes.get('data-color-mode')).toBe('dark');
    flip(applyModeWithFade, 'light', NOW - 50);
    expect(attributes.get('data-color-mode')).toBe('light');
    flip(applyModeWithFade, 'dark');
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(seenByWrite).toEqual([null, '', '', '']);
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
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(124);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(attributes.has(FADE)).toBe(false);
  });

  it('is replaced by a newer call, which includes flipping back before flipAt', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');

    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(48);
    flip(applyModeWithFade, 'light', NOW + 170);
    // The mode never left light, so there is nothing to fade and the first change is gone.
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    pass(300);
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(attributes.has(FADE)).toBe(false);

    // A newer scheduled change takes the place of an older one still waiting.
    flip(applyModeWithFade, 'dark', Date.now() + 100);
    flip(applyModeWithFade, 'dark', Date.now() + 150);
    pass(100);
    expect(attributes.get('data-color-mode')).toBe('light');
    pass(56);
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(seenByWrite.filter((seen) => seen === '')).toHaveLength(1);
  });

  it('applies at once, without a fade, when the document hides while it waits', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);
    pass(20);
    expect(attributes.get('data-color-mode')).toBe('light');

    hidden = true;
    for (const listener of listeners.get('visibilitychange') ?? []) listener({});
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(attributes.has(FADE)).toBe(false);
    // The wait is gone: no timer, no frame, no listener left to run it again.
    expect(vi.getTimerCount()).toBe(0);
    expect(frames.size).toBe(0);
    expect(listeners.get('visibilitychange')?.size).toBe(0);
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
      pass(96);
      expect(attributes.get('data-color-mode')).toBe('light');
      pass(8);
      expect(attributes.get('data-color-mode')).toBe('dark');
      expect(seenByWrite).toEqual([null, '']);
    },
  );

  it('resolves again when the change fires, so an Auto choice shows the live value', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    let os: Mode = 'dark';

    flip(applyModeWithFade, () => os, NOW + 120);
    os = 'light'; // the OS changes during the wait; nothing was listening
    pass(124);
    // Resolved light at the flip, which is what is on screen: nothing changes, nothing fades.
    expect(attributes.get('data-color-mode')).toBe('light');
    expect(attributes.has(FADE)).toBe(false);
    expect(seenByWrite).toEqual([null, null]);
  });

  it('applies a change that is not scheduled (an OS flip) at once and drops the waiting one', async () => {
    const { applyModeWithFade } = await loadHelper();
    flip(applyModeWithFade, 'light');
    flip(applyModeWithFade, 'dark', NOW + 120);

    flip(applyModeWithFade, 'dark');
    expect(attributes.get('data-color-mode')).toBe('dark');
    expect(vi.getTimerCount()).toBe(0); // the waiting change is gone; the fade's wait starts on the frame
    frame();
    vi.advanceTimersByTime(200);
    expect(attributes.has(FADE)).toBe(false);
    expect(seenByWrite).toEqual([null, '']);
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
