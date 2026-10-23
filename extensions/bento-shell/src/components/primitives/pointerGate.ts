// Tells a pointer that moved from one that only has a new list under it. A browser reports the
// element under a stationary pointer after a layout change (a `pointerover` with the old
// coordinates), and React Aria turns that into a hover that moves the list's focus. Stage changes
// in the Settings palette would then lose the row they meant to focus (the current choice, or
// the row Back returns to) to whatever row lands under the pointer. A list keeps hover out
// until the pointer has really moved since the list appeared. Kept free of the DOM so it is
// tested directly.

export interface PointerSample {
  type: string;
  x: number;
  y: number;
  /** False for events a script made (the highlight hook's own synthetic `pointermove`). */
  trusted: boolean;
}

/** One list's gate: closed when the list appears, open from the first real pointer movement. */
export interface HoverGate {
  readonly open: boolean;
}

export interface PointerTracker {
  observe(sample: PointerSample): void;
  /** A new gate for a list that has just appeared. */
  gate(): HoverGate;
}

export function createPointerTracker(): PointerTracker {
  let last: { x: number; y: number } | null = null;
  const closed = new Set<{ open: boolean }>();

  const open = () => {
    for (const gate of closed) gate.open = true;
    closed.clear();
  };

  return {
    observe(sample) {
      if (!sample.trusted) return;
      const moved = last === null || last.x !== sample.x || last.y !== sample.y;
      // A press is the user acting on the list. A move opens it; a `pointerover` or `pointerout`
      // only counts when there is a position to compare with (the first one after a load cannot
      // tell a move from a layout report, so it waits for a `pointermove`).
      if (sample.type === 'pointerdown') open();
      else if (sample.type === 'pointermove' && moved) open();
      else if ((sample.type === 'pointerover' || sample.type === 'pointerout') && moved && last) {
        open();
      }
      last = { x: sample.x, y: sample.y };
    },

    gate() {
      const gate = { open: false };
      closed.add(gate);
      return gate;
    },
  };
}
