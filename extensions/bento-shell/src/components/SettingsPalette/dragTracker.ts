// Tells a drag of the slider's handle from a click on its track, free of the DOM so it is tested
// directly. A press is a drag once the pointer that made it has travelled past the slop, and it
// ends at that pointer's release or cancel. Other pointers (a second touch, a pen) neither join
// nor end it.

/** How far a pressed pointer must travel before the press is a drag and not a click. */
export const DRAG_SLOP_PX = 3;

export interface DragSample {
  type: 'pointermove' | 'pointerup' | 'pointercancel';
  pointerId: number;
  x: number;
  y: number;
}

export interface DragTracker {
  readonly pointerId: number;
  readonly dragging: boolean;
  readonly ended: boolean;
  observe(sample: DragSample): void;
}

export function startDrag(press: { pointerId: number; x: number; y: number }): DragTracker {
  let dragging = false;
  let ended = false;
  return {
    pointerId: press.pointerId,
    get dragging() {
      return dragging;
    },
    get ended() {
      return ended;
    },
    observe(sample) {
      if (ended || sample.pointerId !== press.pointerId) return;
      if (sample.type !== 'pointermove') {
        ended = true;
        dragging = false;
      } else if (Math.hypot(sample.x - press.x, sample.y - press.y) > DRAG_SLOP_PX) {
        dragging = true;
      }
    },
  };
}
