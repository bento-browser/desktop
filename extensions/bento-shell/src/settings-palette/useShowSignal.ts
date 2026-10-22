// Tells the palette when chrome shows and hides it. The overlay document stays loaded while chrome
// hides it, so every show starts fresh: back at the root (or the setting a link names) with the
// latest snapshot. Chrome sends the show once the document has announced readiness, as a
// 'bento-settings-show' CustomEvent whose detail is a JSON string, and a 'bento-settings-hide'
// when it hides the overlay, however that happened (a frame script dispatches both, so they also
// reach a private window's document). A hide ends an unfinished edit: without it the live preview
// and its timer would outlive the visible palette.

import { useEffect, useState } from 'react';
import {
  ROOT_TARGET,
  resolveSettingsTarget,
  type SettingsTarget,
} from '../components/SettingsPalette/targets';

export const SETTINGS_SHOW_EVENT = 'bento-settings-show';
export const SETTINGS_HIDE_EVENT = 'bento-settings-hide';

export interface ShowState extends SettingsTarget {
  /** Changes on every show. */
  openToken: number;
  /** Changes on every hide. */
  hideToken: number;
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

/** Calls `onShow` with the target a show names and `onHide` for a hide; returns the unsubscribe. */
export function listenForVisibility(
  source: EventTarget,
  handlers: { onShow(target: SettingsTarget): void; onHide(): void },
): () => void {
  const show = (event: Event) => handlers.onShow(targetForShow((event as CustomEvent).detail));
  const hide = () => handlers.onHide();
  source.addEventListener(SETTINGS_SHOW_EVENT, show);
  source.addEventListener(SETTINGS_HIDE_EVENT, hide);
  return () => {
    source.removeEventListener(SETTINGS_SHOW_EVENT, show);
    source.removeEventListener(SETTINGS_HIDE_EVENT, hide);
  };
}

/** `refresh` runs on mount and on each show. */
export function useShowSignal(refresh: () => void): ShowState {
  const [state, setState] = useState<ShowState>({ openToken: 0, hideToken: 0, ...ROOT_TARGET });

  useEffect(() => {
    refresh();
    return listenForVisibility(window, {
      onShow: (target) => {
        setState((current) => ({ ...current, openToken: current.openToken + 1, ...target }));
        refresh();
      },
      onHide: () => setState((current) => ({ ...current, hideToken: current.hideToken + 1 })),
    });
  }, [refresh]);

  return state;
}
