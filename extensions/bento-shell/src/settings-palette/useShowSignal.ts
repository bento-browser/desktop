// Tells the palette when chrome shows it. The overlay document stays loaded while chrome hides
// it, so every show starts fresh: back at the root (or the setting a link names) with the latest
// snapshot. Chrome sends the show once the document has announced readiness, as a
// 'bento-settings-show' CustomEvent whose detail is a JSON string (a frame script dispatches it,
// so it also reaches a private window's document).

import { useEffect, useState } from 'react';
import {
  ROOT_TARGET,
  resolveSettingsTarget,
  type SettingsTarget,
} from '../components/SettingsPalette/targets';

export const SETTINGS_SHOW_EVENT = 'bento-settings-show';

export interface ShowState extends SettingsTarget {
  /** Changes on every show. */
  openToken: number;
}

/** The target a show asks for: the first list unless its detail names a row this build knows. */
export function targetForShow(detail: unknown): SettingsTarget {
  try {
    const { target } = JSON.parse(String(detail)) as { target?: unknown };
    return (typeof target === 'string' && resolveSettingsTarget(target)) || ROOT_TARGET;
  } catch {
    return ROOT_TARGET;
  }
}

/** `refresh` runs on mount and on each show. */
export function useShowSignal(refresh: () => void): ShowState {
  const [state, setState] = useState<ShowState>({ openToken: 0, ...ROOT_TARGET });

  useEffect(() => {
    refresh();
    const onShow = (event: Event) => {
      const target = targetForShow((event as CustomEvent).detail);
      setState((current) => ({ openToken: current.openToken + 1, ...target }));
      refresh();
    };
    window.addEventListener(SETTINGS_SHOW_EVENT, onShow);
    return () => window.removeEventListener(SETTINGS_SHOW_EVENT, onShow);
  }, [refresh]);

  return state;
}
