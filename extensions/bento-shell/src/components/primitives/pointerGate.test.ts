import { describe, expect, it } from 'vitest';
import { createPointerTracker, type PointerSample } from './pointerGate';

const sample = (type: string, x: number, y: number, trusted = true): PointerSample => ({
  type,
  x,
  y,
  trusted,
});

describe('createPointerTracker', () => {
  it('keeps hover out while a new list appears under a stationary pointer', () => {
    const tracker = createPointerTracker();
    tracker.observe(sample('pointermove', 300, 200));
    tracker.observe(sample('pointerdown', 300, 200));
    // A click opens the next stage, whose rows land under the pointer: the browser reports the
    // element under it with the same coordinates, and the hook's own synthetic move is untrusted.
    const next = tracker.gate();
    tracker.observe(sample('pointerover', 300, 200));
    tracker.observe(sample('pointermove', 0, 0, false));
    expect(next.open).toBe(false);
  });

  it('opens at the first real movement, whether it arrives as a move or an over', () => {
    const tracker = createPointerTracker();
    tracker.observe(sample('pointermove', 300, 200));
    const byMove = tracker.gate();
    tracker.observe(sample('pointermove', 301, 200));
    expect(byMove.open).toBe(true);

    const byOver = tracker.gate();
    tracker.observe(sample('pointerover', 301, 200));
    expect(byOver.open).toBe(false);
    tracker.observe(sample('pointerover', 301, 240));
    expect(byOver.open).toBe(true);
  });

  it('holds each list to its own gate, so going back closes hover again', () => {
    const tracker = createPointerTracker();
    tracker.observe(sample('pointermove', 10, 10));
    const forward = tracker.gate();
    tracker.observe(sample('pointermove', 20, 10));
    expect(forward.open).toBe(true);
    // Back: a new list under the pointer where it stopped.
    const back = tracker.gate();
    tracker.observe(sample('pointerover', 20, 10));
    expect(back.open).toBe(false);
  });

  it('counts a pointerout that moved, which React uses to make the enter of the row it names', () => {
    const tracker = createPointerTracker();
    tracker.observe(sample('pointermove', 300, 200));
    const gate = tracker.gate();
    tracker.observe(sample('pointerout', 300, 200));
    expect(gate.open).toBe(false);
    tracker.observe(sample('pointerout', 300, 230));
    expect(gate.open).toBe(true);
  });

  it('cannot tell the first pointerover after a load from a layout report, and waits for a move', () => {
    const tracker = createPointerTracker();
    const first = tracker.gate();
    tracker.observe(sample('pointerover', 50, 60));
    expect(first.open).toBe(false);
    // The pointermove that follows in the same spot is the first real movement: the over must not
    // have used up the position.
    tracker.observe(sample('pointermove', 50, 60));
    expect(first.open).toBe(true);
  });

  it('opens on a press and ignores events a script made', () => {
    const tracker = createPointerTracker();
    tracker.observe(sample('pointermove', 5, 5));
    const gate = tracker.gate();
    tracker.observe(sample('pointermove', 99, 99, false));
    expect(gate.open).toBe(false);
    tracker.observe(sample('pointerdown', 5, 5));
    expect(gate.open).toBe(true);
  });
});
