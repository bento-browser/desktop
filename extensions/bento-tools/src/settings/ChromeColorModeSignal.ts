// Tells chrome the new UI colour mode the moment settings change, ahead of the
// panels/sync payload (which carries the same value and stays the backstop).
//
// The payload is built after browser.tabs.get for every visible panel and then relayed through
// the shell's document.title, so chrome used to start its colour fade 60 to 100 ms after the
// sidebar and the overlays did. This is the direct leg: one call to the bentoPrivacy experiment,
// which fires a window event the mount script turns into applyChromeColorMode. A private window
// ignores it (it keeps its own mode); the mount script applies the rule.

import type { BentoSettings, ColorStamp } from '@shared/protocol';

type UiColorMode = BentoSettings['uiColorMode'];

/**
 * Returns a function to call with every settings change. It sends the pref, with the store's
 * `colorStamp` (which chrome uses to drop a copy older than the one it applied), when
 * `uiColorMode` differs from the last one it saw, once per change, and nothing for any other
 * setting. A send that carries `flipAt` and fails is retried once without it: an older cached
 * schema of the experiment rejects the unexpected property, and the change should still reach
 * chrome now (without a time it applies at once). A send that still fails is only logged: the
 * panels payload still carries the value.
 */
export function createChromeColorModeSignal(
  send: (mode: UiColorMode, stamp: ColorStamp) => Promise<unknown>,
  initial: UiColorMode,
): (mode: UiColorMode, stamp: ColorStamp) => void {
  let last = initial;
  return (mode, stamp) => {
    if (mode === last) return;
    last = mode;
    // The call itself starts now; an async wrapper turns a throw (the experiment missing) into
    // a logged failure instead of breaking the settings handler that called this.
    void (async () => {
      try {
        await send(mode, stamp);
      } catch (err) {
        if (stamp.flipAt === undefined) {
          console.warn('[bento-tools] chrome colour mode signal failed', err);
          return;
        }
        try {
          await send(mode, { run: stamp.run, seq: stamp.seq });
        } catch (retryErr) {
          console.warn('[bento-tools] chrome colour mode signal failed', err, retryErr);
        }
      }
    })();
  };
}
