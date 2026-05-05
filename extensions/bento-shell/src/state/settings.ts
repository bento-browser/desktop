// Downstream mirror of bento-tools' SettingsStore (§4.2 mirror pattern).
// Settings are atomic (small object), so we replace the whole snapshot on
// every event rather than tracking deltas.

import { create } from 'zustand';
import type { BentoSettings } from '@shared/protocol';

interface SettingsState {
  /** Null until the first snapshot arrives from tools. Components should
   * render a loading state or fall back to safe defaults. */
  current: BentoSettings | null;
  apply: (next: BentoSettings) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  current: null,
  apply: (next) => set({ current: next }),
}));
