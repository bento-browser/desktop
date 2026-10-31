// Runs the onboarding dialog's side of the handoff to the import wizard (importHandoff.ts holds
// the pure parts and describes the whole exchange). The dialog is in one of the DialogHandoff
// states; chrome's messages move it, and its own acknowledgements are sent once the change is
// painted. No wait here is unbounded: a message chrome never sends frees the dialog after
// HANDOFF_STALL_MS, so a stuck handoff cannot leave the dialog invisible.

import { useCallback, useEffect, useRef, useState } from 'react';

import { sendChromeTitle } from '../bridge/chromeTitle';
import { afterMotion } from '../motion/afterMotion';
import { isChromeRelayMessage } from './chromeRelay';
import {
  ackTitle,
  measureDialog,
  nextHandoff,
  parseHandoffMessage,
  type DialogGeometry,
  type DialogHandoff,
} from './importHandoff';

/** Longer than chrome's own ceiling on each of its waits, which it resolves first. */
const HANDOFF_STALL_MS = 3000;

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useImportHandoff({
  release,
  focusHeading,
}: {
  /** Shows the step the import resumes on, if it is still pending. Idempotent. */
  release: () => void;
  focusHeading: () => void;
}) {
  const [state, setState] = useState<DialogHandoff>('idle');
  const stateRef = useRef<DialogHandoff>('idle');
  const tokenRef = useRef<string | null>(null);
  const progress = useRef({ sent: false, faded: false, reported: false });
  const latest = useRef({ release, focusHeading });
  useEffect(() => {
    latest.current = { release, focusHeading };
  });

  const change = useCallback((next: DialogHandoff) => {
    stateRef.current = next;
    setState(next);
  }, []);

  // The heading takes focus once the dialog is showing again and this page has focus. focus() fails
  // while the dialog is `visibility: hidden` (cut out, or faded out), which flips on the second
  // frame of the dialog's own transition, so it waits two frames after the commit that shows the
  // dialog. A page that is not focused yet (the wizard's host still has focus during a crossfade)
  // ignores focus(), so it takes it when chrome gives the page focus.
  const refocus = useRef(false);
  useEffect(() => {
    if (state !== 'idle' || !refocus.current) return;
    refocus.current = false;
    const focus = () => latest.current.focusHeading();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (document.hasFocus()) focus();
        else window.addEventListener('focus', focus, { once: true });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('focus', focus);
    };
  }, [state]);

  // A wait chrome never ended: show the dialog as it was.
  const recover = useCallback(() => {
    latest.current.release();
    refocus.current = stateRef.current !== 'idle';
    change('idle');
  }, [change]);

  // Chrome may take over once the import title is out and the content has faded.
  const reportWhenReady = useCallback(() => {
    const { sent, faded, reported } = progress.current;
    if (!sent || !faded || reported || tokenRef.current === null) return;
    progress.current.reported = true;
    sendChromeTitle(ackTitle('READY', tokenRef.current));
  }, []);

  // Starts a handoff from the Import button. `send` posts the import title (with the geometry
  // when the dialog can morph). Returns that geometry, or null when the dialog does not move:
  // reduced motion or an unmeasurable dialog, where chrome shows the wizard on the plain fade.
  const begin = useCallback(
    (send: (token: string, geometry: DialogGeometry | null) => Promise<void>) => {
      const token = String(Date.now());
      tokenRef.current = token;
      progress.current = { sent: false, faded: false, reported: false };
      const geometry = reducedMotion() ? null : measureDialog();
      const sent = send(token, geometry);
      if (!geometry) return null;
      void sent.then(() => {
        progress.current.sent = true;
        reportWhenReady();
      });
      change('out');
      return geometry;
    },
    [change, reportWhenReady],
  );

  // Out: the content fade ends, then READY; a handoff chrome never takes over is released.
  useEffect(() => {
    if (state !== 'out') return;
    const content = document.querySelector('.bento-welcome > .muxui-dialog__content');
    const stopWaiting = content
      ? afterMotion(content, { properties: ['opacity'] }, () => {
          progress.current.faded = true;
          reportWhenReady();
        })
      : undefined;
    if (!content) {
      progress.current.faded = true;
      reportWhenReady();
    }
    const stall = setTimeout(recover, HANDOFF_STALL_MS);
    return () => {
      stopWaiting?.();
      clearTimeout(stall);
    };
  }, [state, recover, reportWhenReady]);

  // Cut out or back in: acknowledge once painted. A restore waits for chrome's reveal.
  useEffect(() => {
    if (state !== 'hidden' && state !== 'restoring') return;
    const token = tokenRef.current;
    if (token === null) return;
    const ack = state === 'hidden' ? 'HIDDEN' : 'RESTORED';
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => sendChromeTitle(ackTitle(ack, token)));
    });
    const stall = state === 'restoring' ? setTimeout(recover, HANDOFF_STALL_MS) : undefined;
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(stall);
    };
  }, [state, recover]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isChromeRelayMessage(event)) return;
      const message = parseHandoffMessage(event.data);
      if (!message || message.token !== tokenRef.current) return;
      const before = stateRef.current;
      const next = nextHandoff(before, message.phase);
      refocus.current = next === 'idle' && before !== 'idle';
      change(next);
      latest.current.release();
      if (message.phase === 'fade-in' && before === 'hidden') {
        // Fade in from opacity 0: the dialog is `faded` for a frame, then `idle`.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            refocus.current = true;
            change(nextHandoff(stateRef.current, 'fade-in'));
          }),
        );
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [change]);

  return { state, begin, isIdle: () => stateRef.current === 'idle' };
}
