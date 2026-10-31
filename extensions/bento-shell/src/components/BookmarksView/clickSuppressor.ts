// Keeps a press that was a drag from also activating what it began on. A Mux Button does not
// activate on the pointer release: React Aria waits for the click that follows it, and when that
// click never reaches its listener it clicks the button itself 80 ms later. So the click must not
// be swallowed (that makes the late one), and the controls ask `isActive()` when they activate
// instead. When the drag ends before the release (Esc, the window losing focus) the gesture is
// still going: the suppression has to outlive the keypress, through the release of the button and
// the click, or letting go over the source would open it.

export interface ClickSuppressor {
  /** True from the start of a drag until its release has passed: an activation is to be ignored. */
  isActive(): boolean;
  /** A drag of `pointerId` has started or ended. `released` says its button is already up. */
  begin(pointerId: number, released: boolean): void;
  /** The gesture is over whatever happens next (the view hides). */
  end(): void;
}

type Listeners = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/** How long the suppression outlasts a release: the click follows it at once, and React Aria's own
 * fallback click comes 80 ms after, if the first never reached it. */
export const RELEASE_GRACE_MS = 120;

export function createClickSuppressor(
  /** The window, read when a drag begins so the suppressor can be made while rendering. */
  getTarget: () => Listeners,
  /** Runs `done` once the click and the late fallback click that follow a release are past. A
   * `done` that arrives after another gesture began does nothing. */
  afterRelease: (done: () => void) => void = (done) => void setTimeout(done, RELEASE_GRACE_MS),
): ClickSuppressor {
  let active = false;
  let stop: (() => void) | null = null;
  // Counts gestures. A release timer of an earlier gesture can fire during the next one (a drag
  // started within the grace of the last drop), and must not end that one.
  let gesture = 0;

  const end = () => {
    gesture += 1;
    stop?.();
    stop = null;
    active = false;
  };

  return {
    isActive: () => active,
    end,
    begin(pointerId, released) {
      end();
      active = true;
      const mine = gesture;
      const endMine = () => {
        if (gesture === mine) end();
      };
      const target = getTarget();
      const onRelease = (event: Event) => {
        if ((event as PointerEvent).pointerId === pointerId) afterRelease(endMine);
      };
      // A new press, or the window losing focus, means the old gesture is over.
      target.addEventListener('pointerdown', end, { capture: true });
      target.addEventListener('blur', end);
      if (!released) {
        target.addEventListener('pointerup', onRelease, { capture: true });
        target.addEventListener('pointercancel', onRelease, { capture: true });
      }
      stop = () => {
        target.removeEventListener('pointerdown', end, { capture: true });
        target.removeEventListener('blur', end);
        target.removeEventListener('pointerup', onRelease, { capture: true });
        target.removeEventListener('pointercancel', onRelease, { capture: true });
      };
      if (released) afterRelease(endMine);
    },
  };
}
