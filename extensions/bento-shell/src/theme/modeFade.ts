// One shared colour fade for a light/dark flip. While the attribute below is on
// <html>, theme/document-base.css forces the `state` motion pair on every colour
// property of every element, overriding per-element timings, so all surfaces of the
// document change together. A flip that tools scheduled (ColorStamp.flipAt) is prepared in the
// first frame after it is heard and shown at that time: the mode and the attribute go on at once,
// so the expensive style work of a heavy document happens while the lead runs out, and
// --bento-mode-fade-delay holds every transition at its old colour until flipAt, so the
// documents, which receive the flip at different moments, start the fade at one instant.
// bento-shell-mount.js (setChromeColorMode) carries the same sequence for the chrome document;
// keep the two in step.

import { afterMotion } from '../motion/afterMotion';

/** Transient root attribute that switches the fade on. document-base.css names it too. */
export const MODE_FADE_ATTRIBUTE = 'data-bento-mode-fade';

type Mode = 'light' | 'dark';

const COLOR_MODE_ATTRIBUTE = 'data-color-mode';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
/** Registered `<time>` in theme/document-base.css: how long the fade's transitions wait. */
const FADE_DELAY_PROPERTY = '--bento-mode-fade-delay';

// Per document: each entry is its own page, so this module is evaluated once per document.
let applied = false;
let cancelFade: (() => void) | null = null;
let cancelFlip: (() => void) | null = null;

/** A flip that is waiting for its time, from receipt until it is announced. */
interface Flip {
  /** The mode it shows (asked again when the flip is prepared, for an Auto choice). */
  resolved: Mode;
  /** performance.now() of the moment it is shown, fixed on receipt of the request that scheduled
   * it: the system clock is read once, there, and never again. */
  deadline: number;
  resolve: () => Mode;
  write: (resolved: Mode) => void;
  announce: ((resolved: Mode) => void) | undefined;
  /** The mode and the fade are on, the transitions hold at the old colours until the deadline. */
  prepared: boolean;
}
/** The flip that waits. A later request for the same mode joins it (it keeps the deadline and
 * takes over `resolve`, `write` and the announcement); one for the other mode replaces it. */
let flip: Flip | null = null;

/** The document starts watching animation frames this long before `flipAt`, which covers several
 * frames even at 60 Hz. */
const FRAME_WATCH_LEAD_MS = 40;

/** A document that hears of a flip up to this long after its `flipAt` joins the fade part-way
 * (a negative delay), so it ends with the others; one that hears of it later fades from the
 * start, which shows more than a step. */
const CATCH_UP_MAX_MS = 60;

function removeFadeAttribute(root: HTMLElement): void {
  root.removeAttribute(MODE_FADE_ATTRIBUTE);
  root.style.removeProperty(FADE_DELAY_PROPERTY);
}

function cancelPending(): void {
  cancelFlip?.();
  cancelFlip = null;
  flip = null;
}

function endFade(root: HTMLElement): void {
  cancelFade?.();
  cancelFade = null;
  removeFadeAttribute(root);
}

/**
 * Applies a mode change that is due: runs `write`, which sets the mode attributes on <html> to
 * `resolved`, and fades the change. Order matters: the attribute goes on in the same task as
 * the mode, so one style recalculation starts every transition, and it comes off only after the
 * fade has ended, because dropping the rule mid-fade cancels the running transitions. A flip
 * during a fade keeps the attribute and waits again.
 *
 * No fade for the first application in a document (boot and settings hydration happen
 * under the startup veil), an unchanged value, reduced motion, or a hidden document:
 * those just write.
 */
function applyNow(resolved: Mode, write: (resolved: Mode) => void, delayMs = 0): void {
  const root = document.documentElement;
  const first = !applied;
  applied = true;
  const changed = root.getAttribute(COLOR_MODE_ATTRIBUTE) !== resolved;
  const fade = !first && changed && !document.hidden && !matchMedia(REDUCED_MOTION_QUERY).matches;
  if (!fade) {
    // A change that does not fade ends a fade that is running (its rule would keep every
    // transition forced on until the document resumes); an unchanged value, such as a copy
    // of the mode arriving by a second route, leaves it alone.
    if (changed) endFade(root);
    write(resolved);
    return;
  }

  cancelFade?.();
  root.style.setProperty(FADE_DELAY_PROPERTY, `${delayMs}ms`);
  root.setAttribute(MODE_FADE_ATTRIBUTE, '');
  write(resolved);
  // afterMotion reads the computed style, which flushes the document's styles. Done here it
  // would run inside the message handler, ahead of the next document's handler in the same
  // process; on the next frame it is part of the rendering update that every document of the
  // process takes together.
  let stopWait = () => {};
  const frame = requestAnimationFrame(() => {
    stopWait = afterMotion(root, {}, () => {
      document.removeEventListener('visibilitychange', onHide);
      cancelFade = null;
      removeFadeAttribute(root);
    });
  });
  // A hidden document gets no frames to measure or end the fade by, whatever way it joined it
  // (prepared early, or late), so one that hides during it drops the fade and its delay.
  const onHide = () => {
    if (document.hidden) endFade(root);
  };
  document.addEventListener('visibilitychange', onHide);
  cancelFade = () => {
    cancelAnimationFrame(frame);
    stopWait();
    document.removeEventListener('visibilitychange', onHide);
  };
}

/**
 * Runs `run` in the first animation frame at or after `deadline` (a performance.now() time). A
 * timer alone would not do: the documents of one process share a thread, and the first
 * document's rendering update, which has priority over timers, can run between two documents'
 * timers, so the second one would start its fade a frame or more late. The frames of one process
 * are driven by one vsync, and the frame time is the same for every document in a tick, so
 * documents that take the first frame at or after the deadline apply in the same tick and their
 * transitions start from the same time, even though each renders after the other. The timer only
 * wakes the document shortly before.
 *
 * `flipAt` is wall-clock time but frame times are on this document's monotonic clock, and the
 * system clock can be stepped (NTP, a manual change) after the document opened, so the two are
 * never compared: the request turns `flipAt` into `deadline` once, on receipt.
 */
function runAtFlip(deadline: number, run: () => void): void {
  let frame = 0;
  const onFrame = (timestamp: number) => {
    if (timestamp >= deadline) {
      cancelFlip?.();
      cancelFlip = null;
      run();
      return;
    }
    frame = requestAnimationFrame(onFrame);
  };
  const timer = setTimeout(
    () => {
      frame = requestAnimationFrame(onFrame);
    },
    deadline - performance.now() - FRAME_WATCH_LEAD_MS,
  );
  // A hidden document gets no frames, so one that hides while it waits applies when it hides
  // (without a fade), not at its next show.
  const onVisibility = () => {
    if (!document.hidden) return;
    cancelFlip?.();
    cancelFlip = null;
    run();
  };
  document.addEventListener('visibilitychange', onVisibility);
  cancelFlip = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Prepares a flip that is due at `current.deadline`. In the first frame after it is heard the
 * mode and the fade attribute go on, with a transition delay that ends at the deadline: the style
 * recalculation and the creation of every transition, which take 80 ms or more in a document
 * with a few hundred tab rows, happen while the lead runs out instead of after it, and the fade
 * is shown from the deadline. The delay is measured from this frame's time, which is also the
 * time the transitions start from; a frame that comes after the deadline (up to CATCH_UP_MAX_MS)
 * gives a negative delay, which joins the fade part-way. The announcement runs at the deadline.
 * A document that hides while the flip waits drops the fade (applyNow) and announces the mode at
 * once.
 *
 * The delay stays on the root until the fade ends. Resetting it at the deadline would keep a
 * hover or focus change that starts during the fade from waiting, but it is an inherited
 * property: every element is restyled in the frame the fade starts. Measured in the sidebar,
 * the sidebar's frame at flipAt took 129 to 158 ms at 400 tabs (7 of 8 flips; 29 to 92 ms
 * without) and 75 to 108 ms at 208 tabs (25 to 29 ms without).
 */
function prepareFlip(current: Flip): void {
  let frame = 0;
  const start = (timestamp: number | null) => {
    cancelFlip?.();
    cancelFlip = null;
    // A joined request may have replaced these since the flip was scheduled.
    const resolved = current.resolve();
    current.resolved = resolved;
    // A hidden document gets no frames and applies without a fade.
    const delay = timestamp === null ? 0 : current.deadline - timestamp;
    applyNow(resolved, current.write, delay < -CATCH_UP_MAX_MS ? 0 : Math.round(delay * 10) / 10);
    const remaining = current.deadline - performance.now();
    if (
      remaining > 0 &&
      timestamp !== null &&
      document.documentElement.hasAttribute(MODE_FADE_ATTRIBUTE)
    ) {
      current.prepared = true;
      runAtFlip(current.deadline, () => {
        flip = null;
        current.announce?.(current.resolved);
      });
    } else {
      flip = null;
      current.announce?.(resolved);
    }
  };
  frame = requestAnimationFrame(start);
  const onVisibility = () => {
    if (document.hidden) start(null);
  };
  document.addEventListener('visibilitychange', onVisibility);
  cancelFlip = () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * Shows the mode `resolve` returns (`write` sets the attributes; `announce` then tells whoever
 * follows this document, such as the window's overlays, and runs when the mode is on screen, at
 * `flipAt`). `resolve` is asked again when a flip is prepared, so an Auto choice shows the OS
 * appearance of that moment; `write` and `announce` get the mode that was applied. `flipAt` is
 * ColorStamp.flipAt: while it is in the future a visible document that has already applied a
 * mode prepares the flip at once (`prepareFlip`) and shows it at `flipAt`, so every document that
 * received the same change fades from the same moment however late it heard of it; at or past it,
 * or without one, the change is applied now. The first application, an unchanged value and a
 * hidden document apply at once; reduced motion waits for `flipAt` and then snaps, since a
 * synchronised snap beats a staggered one.
 *
 * Every call is a request that replaces the flip that waits, with one exception: a request for the
 * mode that flip already shows joins it, whether the flip is prepared or still waits for its
 * first frame. The flip keeps the deadline of the request that scheduled it, which was fixed on
 * receipt, and takes over the newer `resolve`, `write` and `announce`, so the announcement goes
 * out once, at that deadline. This is what lets a duplicate (a second route for the same change,
 * whose `flipAt` would be turned into a wait again after a clock step) and a newer request for
 * the same mode agree across documents: a prepared document cannot be re-timed without a full
 * restyle (its transitions were created with the old delay), so no document is. A request for the
 * other mode replaces the flip with its own time (a flip back before `flipAt` leaves the document
 * as it was), and so does an OS-driven change (no `flipAt`) that no longer resolves to the mode
 * the flip shows: the stale mode is never announced.
 */
export function applyModeWithFade(
  resolve: () => Mode,
  write: (resolved: Mode) => void,
  flipAt?: number,
  announce?: (resolved: Mode) => void,
): void {
  const resolved = resolve();
  const root = document.documentElement;
  if (flip?.resolved === resolved && !document.hidden) {
    flip.resolve = resolve;
    flip.write = write;
    flip.announce = announce;
    if (flip.prepared) write(resolved);
    return;
  }
  cancelPending();
  const wait = flipAt === undefined ? 0 : flipAt - Date.now();
  const changed = root.getAttribute(COLOR_MODE_ATTRIBUTE) !== resolved;
  if (wait > 0 && applied && changed && !document.hidden) {
    const scheduled: Flip = {
      resolved,
      deadline: performance.now() + wait,
      resolve,
      write,
      announce,
      prepared: false,
    };
    flip = scheduled;
    if (matchMedia(REDUCED_MOTION_QUERY).matches) {
      runAtFlip(scheduled.deadline, () => {
        flip = null;
        const due = scheduled.resolve();
        applyNow(due, scheduled.write);
        scheduled.announce?.(due);
      });
    } else {
      prepareFlip(scheduled);
    }
    return;
  }
  // Already due: a stamp that arrives up to CATCH_UP_MAX_MS late joins the fade part-way, as a
  // prepared flip whose frame is late does; anything later, or no stamp, fades from the start.
  const late = flipAt !== undefined && wait <= 0 && wait >= -CATCH_UP_MAX_MS;
  applyNow(resolved, write, late ? Math.round(wait * 10) / 10 : 0);
  announce?.(resolved);
}
