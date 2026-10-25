// Downstream mirror of bento-tools' SettingsStore (§4.2 mirror pattern).
// Settings are atomic (small object), so we replace the whole snapshot on
// every event rather than tracking deltas.

import { create } from 'zustand';
import type { BentoSettings } from '@shared/protocol';

interface SettingsState {
  /** Null until the first snapshot arrives from tools. Components should
   * render a loading state or fall back to safe defaults. */
  current: BentoSettings | null;
  /** When the event that brought `current` wants its colour mode shown (ColorStamp.flipAt, epoch
   * ms); undefined for an event without one. Set in the same `set()` as `current`, so a store
   * subscriber reads the time that belongs to the mode it sees. */
  colorFlipAt: number | undefined;
  apply: (next: BentoSettings, colorFlipAt?: number) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  current: null,
  colorFlipAt: undefined,
  apply: (next, colorFlipAt) => set({ current: next, colorFlipAt }),
}));
