// Readiness announcement of an overlay document.
//
// Chrome creates most overlay documents on demand or at idle, not at window
// startup (docs/technical/overlay-documents.md). What
// chrome sends an overlay (a frame-script relay onto a BroadcastChannel) does
// not queue: sent before the React tree subscribed, it is lost. So an overlay
// announces once that its subscriptions exist, and chrome reveals an open, and
// sends the messages that belong to it, only on that announcement.

import { useEffect } from 'react';
import { sendChromeTitle } from './chromeTitle';
import { nativeModeHosted, whenModePresentationReady } from '../theme/modePresentation';

export const OVERLAY_READY_PREFIX = 'BENTO_OVERLAY_READY';

/** Names match the chrome frame ids: `bento-<name>-frame`. */
export type OverlayName =
  | 'palette'
  | 'workspace-palette'
  | 'merge-palette'
  | 'settings-palette'
  | 'addrbar'
  | 'confirm'
  | 'edit-workspace'
  | 'welcome'
  | 'workspace-switcher'
  | 'menu'
  | 'panel-navigator-tooltip';

/** Announces that this overlay document is subscribed and can receive an open. */
export function signalOverlayReady(overlay: OverlayName): void {
  // The timestamp keeps successive titles distinct; chrome drops a repeated one.
  const announce = () => sendChromeTitle(`${OVERLAY_READY_PREFIX}:${overlay}_${Date.now()}`);
  if (nativeModeHosted) void whenModePresentationReady().then(announce);
  else announce();
}

/** Call from the overlay's top-level component, after the effects that subscribe. */
export function useOverlayReadySignal(overlay: OverlayName): void {
  useEffect(() => {
    signalOverlayReady(overlay);
  }, [overlay]);
}
