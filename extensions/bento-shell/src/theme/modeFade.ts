// One shared colour fade for a light/dark flip. While the attribute below is on
// <html>, theme/document-base.css forces the `state` motion pair on every colour
// property of every element, overriding per-element timings, so all surfaces of the
// document change together. A flip that tools scheduled (ColorStamp.flipAt) is applied at that
// time, so the documents, which receive it at different moments, start the fade at one instant.
// bento-shell-mount.js (setChromeColorMode) and bento-migration-host.js carry the same
// sequence for the chrome documents; keep the three in step.

import { afterMotion } from '../motion/afterMotion';

/** Transient root attribute that switches the fade on. document-base.css names it too. */
export const MODE_FADE_ATTRIBUTE = 'data-bento-mode-fade';

type Mode = 'light' | 'dark';

const COLOR_MODE_ATTRIBUTE = 'data-color-mode';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

// Per document: each entry is its own page, so this module is evaluated once per document.
let applied = false;
let cancelFade: (() => void) | null = null;
let cancelFlip: (() => void) | null = null;

/** The document starts watching animation frames this long before `flipAt`, which covers several
 * frames even at 60 Hz. */
const FRAME_WATCH_LEAD_MS = 40;

function endFade(root: HTMLElement): void {
  cancelFade?.();
  cancelFade = null;
  root.removeAttribute(MODE_FADE_ATTRIBUTE);
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
function applyNow(resolved: Mode, write: (resolved: Mode) => void): void {
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
  root.setAttribute(MODE_FADE_ATTRIBUTE, '');
  write(resolved);
  // afterMotion reads the computed style, which flushes the document's styles. Done here it
  // would run inside the message handler, ahead of the next document's handler in the same
  // process; on the next frame it is part of the rendering update that every document of the
  // process takes together.
  let stopWait = () => {};
  const frame = requestAnimationFrame(() => {
    stopWait = afterMotion(root, {}, () => {
      cancelFade = null;
      root.removeAttribute(MODE_FADE_ATTRIBUTE);
    });
  });
  cancelFade = () => {
    cancelAnimationFrame(frame);
    stopWait();
  };
}

/**
 * Runs `run` in the first animation frame `wait` ms from now. A timer alone would not do: the
 * documents of one process share a thread, and the first document's rendering update, which has
 * priority over timers, can run between two documents' timers, so the second one would start its
 * fade a frame or more late. The frames of one process are driven by one vsync, and the frame
 * time is the same for every document in a tick, so documents that take the first frame at or
 * after the deadline apply in the same tick and their transitions start from the same time, even
 * though each renders after the other. The timer only wakes the document shortly before.
 *
 * `flipAt` is wall-clock time but frame times are on this document's monotonic clock, and the
 * system clock can be stepped (NTP, a manual change) after the document opened, so the two are
 * never compared: the caller turns `flipAt` into `wait` once, on receipt, and the deadline is
 * that far ahead on the monotonic clock.
 */
function runAtFlip(wait: number, run: () => void): void {
  const deadline = performance.now() + wait;
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
  const timer = setTimeout(() => {
    frame = requestAnimationFrame(onFrame);
  }, wait - FRAME_WATCH_LEAD_MS);
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
 * Shows the mode `resolve` returns (`write` sets the attributes). `resolve` is asked again when a
 * waiting change fires, so an Auto choice shows the OS appearance of that moment, not the one
 * from when it was requested (an OS change in between may not have been heard); `write` gets the
 * mode that was applied. `flipAt` is ColorStamp.flipAt: while it is in the future the change
 * waits for it, so every document that received the same change applies it
 * at the same moment however late it heard of it; at or past it, or without one, the change is
 * applied now. A real change waits only in a visible document that has already applied a mode
 * (the first application, an unchanged value and a hidden document apply at once, since a
 * hidden document gets no animation frames); reduced motion still waits, since a synchronised
 * snap beats a staggered one.
 *
 * Any call replaces a change that is still waiting: the newest call is the newest state, so a
 * flip back before `flipAt` leaves the document as it was, and an OS-driven change (no
 * `flipAt`) applies at once.
 */
export function applyModeWithFade(
  resolve: () => Mode,
  write: (resolved: Mode) => void,
  flipAt?: number,
): void {
  cancelFlip?.();
  cancelFlip = null;
  const wait = flipAt === undefined ? 0 : flipAt - Date.now();
  const resolved = resolve();
  const changed = document.documentElement.getAttribute(COLOR_MODE_ATTRIBUTE) !== resolved;
  if (wait > 0 && applied && changed && !document.hidden) {
    runAtFlip(wait, () => applyNow(resolve(), write));
    return;
  }
  applyNow(resolved, write);
}
