// Focus for an inline editor that a menu opens. The menu's popup, while it closes, still makes the
// rest of the page inert, and `focus()` on an inert field does nothing (React's `autoFocus` calls
// it once). So the editor waits for the page to stop being inert, then takes the focus a frame
// later, after the menu has handed the focus back to its trigger.

import { useLayoutEffect, type RefObject } from 'react';

/** About two seconds of frames: longer than any menu exit, short enough to end if the page stays inert. */
const MAX_FRAMES = 120;

/** Focuses `field` at once, or when the page stops being inert (and one frame later, so the menu's
 * own focus return to its trigger, a frame after its popup unmounts, does not win). Returns the cancel. */
export function focusWhenReady(field: Pick<HTMLElement, 'closest' | 'focus'>): () => void {
  let frame = 0;
  let frames = 0;
  let settled = false;
  const attempt = () => {
    if (field.closest('[inert]') && frames < MAX_FRAMES) {
      frames += 1;
      frame = requestAnimationFrame(attempt);
      return;
    }
    if (frames > 0 && !settled) {
      settled = true;
      frame = requestAnimationFrame(attempt);
      return;
    }
    field.focus();
  };
  attempt();
  return () => cancelAnimationFrame(frame);
}

/** `autoFocus` that survives the menu that opened the editor: focuses the field when it mounts. */
export function useFocusWhenReady(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const field = ref.current;
    return field ? focusWhenReady(field) : undefined;
  }, [ref]);
}
