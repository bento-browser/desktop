// Tells the palette when chrome shows and hides it. The overlay document stays loaded while chrome
// hides it, so every show starts fresh: back at the root (or the setting a link names) with the
// latest snapshot. Chrome sends the show once the document has announced readiness, as a
// 'bento-settings-show' CustomEvent whose detail is a JSON string (the target, and `origin`
// 'palette' when the command palette opened Settings), and a 'bento-settings-hide'
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

/** Who opened Settings: the command palette (a result or its Open Settings command), or any
 * other opener (the sidebar menu, the app menu, onboarding), which is null. */
export type ShowOrigin = 'palette' | null;

export interface ShowState extends SettingsTarget {
  /** Who opened Settings this time. */
  origin: ShowOrigin;
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

/** Who a show says opened Settings; anything but 'palette' is no origin. */
export function originForShow(detail: unknown): ShowOrigin {
  try {
    const { origin } = JSON.parse(String(detail)) as { origin?: unknown };
    return origin === 'palette' ? 'palette' : null;
  } catch {
    return null;
  }
}

/** Calls `onShow` with the target a show names and who opened it, and `onHide` for a hide;
 * returns the unsubscribe. */
export function listenForVisibility(
  source: EventTarget,
  handlers: { onShow(target: SettingsTarget, origin: ShowOrigin): void; onHide(): void },
): () => void {
  const show = (event: Event) => {
    const { detail } = event as CustomEvent;
    handlers.onShow(targetForShow(detail), originForShow(detail));
  };
  const hide = () => handlers.onHide();
  source.addEventListener(SETTINGS_SHOW_EVENT, show);
  source.addEventListener(SETTINGS_HIDE_EVENT, hide);
  return () => {
    source.removeEventListener(SETTINGS_SHOW_EVENT, show);
    source.removeEventListener(SETTINGS_HIDE_EVENT, hide);
  };
}

/** `refresh` runs on mount and on each show. `setVisible` hears of each show and hide first, ahead
 * of React and of the snapshot a show asks for. */
export function useShowSignal(
  refresh: () => void,
  setVisible: (visible: boolean) => void,
): ShowState {
  const [state, setState] = useState<ShowState>({
    openToken: 0,
    hideToken: 0,
    origin: null,
    ...ROOT_TARGET,
  });

  useEffect(() => {
    refresh();
    return listenForVisibility(window, {
      onShow: (target, origin) => {
        setVisible(true);
        setState((current) => ({
          ...current,
          openToken: current.openToken + 1,
          origin,
          ...target,
        }));
        refresh();
      },
      onHide: () => {
        setVisible(false);
        setState((current) => ({ ...current, hideToken: current.hideToken + 1 }));
      },
    });
  }, [refresh, setVisible]);

  return state;
}
