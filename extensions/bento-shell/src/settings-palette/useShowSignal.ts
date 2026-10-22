// Tells the palette when chrome shows it. The overlay document stays loaded while chrome hides
// it, so every show starts fresh: back at the root (or the stage a deep link names) with the
// latest snapshot. Chrome sends the show once the document has announced readiness, as a
// 'bento-settings-show' CustomEvent whose detail is a JSON string (a frame script dispatches it,
// so it also reaches a private window's document).

import { useEffect, useState } from 'react';
import { initialStack, type Stage } from '../components/SettingsPalette/stageStack';

export const SETTINGS_SHOW_EVENT = 'bento-settings-show';

/** The stages a deep link may open on. */
const DEEP_LINK_STAGES: Record<string, Stage> = {
  protection: { kind: 'protection' },
};

export interface ShowState {
  /** Changes on every show. */
  openToken: number;
  /** The stages to start on, root first. */
  initialStages: readonly Stage[];
}

/** The stages a show asks for: the root alone unless its detail names a known deep link. */
export function stagesForShow(detail: unknown): readonly Stage[] {
  try {
    const { stage } = JSON.parse(String(detail)) as { stage?: unknown };
    const known = typeof stage === 'string' ? DEEP_LINK_STAGES[stage] : undefined;
    return initialStack(known);
  } catch {
    return initialStack();
  }
}

/** `refresh` runs on mount and on each show. */
export function useShowSignal(refresh: () => void): ShowState {
  const [state, setState] = useState<ShowState>(() => ({
    openToken: 0,
    initialStages: initialStack(),
  }));

  useEffect(() => {
    refresh();
    const onShow = (event: Event) => {
      const initialStages = stagesForShow((event as CustomEvent).detail);
      setState((current) => ({ openToken: current.openToken + 1, initialStages }));
      refresh();
    };
    window.addEventListener(SETTINGS_SHOW_EVENT, onShow);
    return () => window.removeEventListener(SETTINGS_SHOW_EVENT, onShow);
  }, [refresh]);

  return state;
}
