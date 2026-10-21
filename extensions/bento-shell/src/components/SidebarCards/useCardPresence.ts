import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { afterMotion } from '../../motion/afterMotion';
import type { MotionFilter } from '../../motion/afterMotion';

// The card's exit is a dismiss-role fade and slide (SidebarCards.css).
const EXIT_MOTION: MotionFilter = { properties: ['opacity', 'transform'] };

/**
 * Keeps a card mounted while it plays its exit. `value` is what the card shows, or null
 * when it should be gone: while null follows a value, the card still renders the last
 * value with `exiting` true, and unmounts once its CSS motion has finished (at once
 * when there is none, as in reduced motion). Attach `ref` to the card element.
 */
export function useCardPresence<T>(value: T | null): {
  shown: T | null;
  exiting: boolean;
  ref: RefObject<HTMLDivElement | null>;
} {
  const ref = useRef<HTMLDivElement>(null);
  const lastValue = useRef(value);
  if (value !== null) lastValue.current = value;
  // Mounted from the first value until the exit has played.
  const [present, setPresent] = useState(value !== null);
  if (value !== null && !present) setPresent(true);
  const exiting = value === null && present;

  useLayoutEffect(() => {
    if (!exiting) return;
    const card = ref.current;
    if (!card) {
      setPresent(false);
      return;
    }
    return afterMotion(card, EXIT_MOTION, () => setPresent(false));
  }, [exiting]);

  return { shown: value ?? (present ? lastValue.current : null), exiting, ref };
}
