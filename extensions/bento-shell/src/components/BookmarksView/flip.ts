// FLIP settle for reordered rows and columns. Before a change the view records where every
// `[data-bm-flip]` element is; once the new snapshot has rendered, `playFlip` puts each element
// that moved back at its old place and lets the stylesheet's `[data-bm-flipping]` transition
// (the reveal role) carry it to the new one. CSS owns the time: the attribute is dropped by
// `afterMotion` when the transition ends.

import { afterMotion } from '../../motion/afterMotion';

export const FLIP_ATTRIBUTE = 'data-bm-flip';
const FLIPPING_ATTRIBUTE = 'data-bm-flipping';

/** How long recorded positions stay good for a snapshot that has not arrived yet. */
export const FLIP_TTL_MS = 1500;

export interface FlipRecord {
  rects: Map<string, DOMRect>;
  at: number;
}

const cancelByElement = new WeakMap<Element, () => void>();

function endFlip(element: HTMLElement): void {
  cancelByElement.get(element)?.();
  cancelByElement.delete(element);
  element.removeAttribute(FLIPPING_ATTRIBUTE);
  element.style.removeProperty('transform');
}

/** The current box of every element that takes part, by its flip key. */
export function recordFlip(root: ParentNode): FlipRecord {
  const rects = new Map<string, DOMRect>();
  for (const element of root.querySelectorAll<HTMLElement>(`[${FLIP_ATTRIBUTE}]`)) {
    const key = element.getAttribute(FLIP_ATTRIBUTE);
    if (key) rects.set(key, element.getBoundingClientRect());
  }
  return { rects, at: performance.now() };
}

/** Animates every element whose box moved since `record` from its old place to its new one. */
export function playFlip(root: ParentNode, record: FlipRecord): void {
  if (performance.now() - record.at > FLIP_TTL_MS) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const elements = Array.from(root.querySelectorAll<HTMLElement>(`[${FLIP_ATTRIBUTE}]`));
  // A settle still running reports its in-flight box; end it before measuring.
  for (const element of elements) endFlip(element);
  const moved: HTMLElement[] = [];
  for (const element of elements) {
    const before = record.rects.get(element.getAttribute(FLIP_ATTRIBUTE) ?? '');
    if (!before) continue;
    const after = element.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    element.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(element);
  }
  if (moved.length === 0) return;
  // Reading a box commits the inverted places before the transition is switched on.
  moved[0]!.getBoundingClientRect();
  for (const element of moved) {
    element.setAttribute(FLIPPING_ATTRIBUTE, '');
    element.style.removeProperty('transform');
    cancelByElement.set(
      element,
      afterMotion(element, { properties: ['transform'] }, () => endFlip(element)),
    );
  }
}
