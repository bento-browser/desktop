import { describe, expect, it } from 'vitest';
import { DRAG_SLOP_PX, startDrag, type DragSample } from './dragTracker';

const sample = (type: DragSample['type'], pointerId: number, x: number, y = 0): DragSample => ({
  type,
  pointerId,
  x,
  y,
});

describe('startDrag', () => {
  it('is a click until the pointer travels past the slop', () => {
    const drag = startDrag({ pointerId: 1, x: 100, y: 0 });
    drag.observe(sample('pointermove', 1, 100 + DRAG_SLOP_PX));
    expect(drag.dragging).toBe(false);
    drag.observe(sample('pointermove', 1, 100 + DRAG_SLOP_PX + 1));
    expect(drag.dragging).toBe(true);
  });

  it('ends at its own pointer release, and stays ended', () => {
    const drag = startDrag({ pointerId: 1, x: 0, y: 0 });
    drag.observe(sample('pointermove', 1, 20));
    drag.observe(sample('pointerup', 1, 20));
    expect(drag.dragging).toBe(false);
    expect(drag.ended).toBe(true);
    drag.observe(sample('pointermove', 1, 50));
    expect(drag.dragging).toBe(false);
  });

  it('keeps dragging through another pointer’s release, cancel and movement', () => {
    const drag = startDrag({ pointerId: 1, x: 0, y: 0 });
    drag.observe(sample('pointermove', 1, 20));
    drag.observe(sample('pointerup', 2, 20));
    drag.observe(sample('pointercancel', 3, 20));
    expect(drag.dragging).toBe(true);
    expect(drag.ended).toBe(false);
    // The drag goes on: movement of its own pointer still counts, and another pointer's
    // movement near the press does not start a drag that was not one.
    drag.observe(sample('pointermove', 1, 60));
    expect(drag.dragging).toBe(true);
    const click = startDrag({ pointerId: 1, x: 0, y: 0 });
    click.observe(sample('pointermove', 2, 80));
    expect(click.dragging).toBe(false);
  });

  it('ends at its own cancel', () => {
    const drag = startDrag({ pointerId: 4, x: 0, y: 0 });
    drag.observe(sample('pointermove', 4, 30));
    drag.observe(sample('pointercancel', 4, 30));
    expect(drag.dragging).toBe(false);
    expect(drag.ended).toBe(true);
  });
});
