// The onboarding dialog's side of the handoff to the browser-data import wizard.
//
// "Import browser data" opens Firefox's wizard in a chrome page that shares no DOM and no process
// with this document, and the two read as one card: the dialog fades its content out, chrome puts
// the import card over the dialog (same rectangle, same surface) and cuts the dialog out, the card
// reshapes into the wizard, and on the way back chrome cuts the dialog in under the card and the
// content fades in. This module is the pure part: the title this page sends, the acknowledgements
// it sends back, the messages chrome posts, and the dialog's state. bento-shell-mount.js owns the
// protocol and docs/technical/first-run-import.md describes it.

import { WELCOME_HANDOFF_PREFIX, WELCOME_IMPORT_BROWSER_DATA_PREFIX } from '../bridge/useWelcome';
import type { ImportBrowserKey } from './importSources';

/** The dialog's rectangle and corner radius in page px, and the viewport it was measured in. */
export interface DialogGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  viewportWidth: number;
  viewportHeight: number;
}

// Two decimals keep the number free of exponents and float noise in a title.
const px = (value: number) => String(Math.round(value * 100) / 100);

/**
 * `BENTO_IMPORT_BROWSER_DATA_<nextStep>_<token>`, plus `_<x>_<y>_<w>_<h>_<r>_<vw>_<vh>` when the
 * page can morph, plus `_s-<key>` when a browser tile asked for that browser to be selected in the
 * wizard. Without the geometry chrome shows the wizard on the plain fade; without the key the
 * wizard selects its first entry. The token (a timestamp) names this handoff in every later message.
 */
export function importTitle(
  nextStep: number,
  token: string,
  geometry?: DialogGeometry,
  source?: ImportBrowserKey,
): string {
  const parts = [`${WELCOME_IMPORT_BROWSER_DATA_PREFIX}_${nextStep}_${token}`];
  if (geometry) {
    const { x, y, width, height, radius, viewportWidth, viewportHeight } = geometry;
    parts.push(...[x, y, width, height, radius, viewportWidth, viewportHeight].map(px));
  }
  if (source) parts.push(`s-${source}`);
  return parts.join('_');
}

/** What the page reports to chrome: its content has faded out, and chrome's `hide` and `restore` landed. */
export type HandoffAck = 'READY' | 'HIDDEN' | 'RESTORED';

export function ackTitle(ack: HandoffAck, token: string): string {
  return `${WELCOME_HANDOFF_PREFIX}_${ack}_${token}`;
}

/**
 * What chrome tells the page. `hide` and `restore` cut the dialog out and in; `reveal` fades its
 * content in; `fade-out` and `fade-in` are the crossfade (reduced motion, or a window resized
 * meanwhile); `reset` abandons the handoff and shows the dialog as it was.
 */
export type HandoffPhase = 'hide' | 'restore' | 'reveal' | 'fade-out' | 'fade-in' | 'reset';

export interface HandoffMessage {
  phase: HandoffPhase;
  token: string;
}

const PHASES: readonly string[] = [
  'hide',
  'restore',
  'reveal',
  'fade-out',
  'fade-in',
  'reset',
] satisfies HandoffPhase[];

/** The message chrome's frame script posts, or null for anything else on `window`. */
export function parseHandoffMessage(data: unknown): HandoffMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { kind, phase, token } = data as Record<string, unknown>;
  if (kind !== 'bento-welcome-handoff') return null;
  if (typeof phase !== 'string' || !PHASES.includes(phase) || typeof token !== 'string')
    return null;
  return { phase: phase as HandoffPhase, token };
}

/**
 * The dialog's state during a handoff, as a class on it (`bento-welcome--<state>`):
 * - `idle`: showing.
 * - `out`: content faded out, waiting for chrome to put the card over the dialog.
 * - `hidden`: cut out (instant) while the wizard is up.
 * - `restoring`: cut back in, content still hidden, waiting for chrome to remove the card.
 * - `faded`: the whole dialog at opacity 0 (crossfade); it fades back in on the way to `idle`.
 */
export type DialogHandoff = 'idle' | 'out' | 'hidden' | 'restoring' | 'faded';

/** The dialog's class for a state. */
export function dialogClass(state: DialogHandoff): string {
  return state === 'idle' ? 'bento-welcome' : `bento-welcome bento-welcome--${state}`;
}

/**
 * The state after chrome's message. A phase that does not apply to the state leaves it alone, so a
 * late or repeated message is harmless. `fade-in` from `hidden` (a morph out, a crossfade back)
 * takes two steps: `faded` first, then `idle` on the next `fade-in` the caller issues a frame later,
 * so the dialog starts the fade from opacity 0.
 */
export function nextHandoff(state: DialogHandoff, phase: HandoffPhase): DialogHandoff {
  switch (phase) {
    case 'hide':
      return state === 'out' || state === 'idle' ? 'hidden' : state;
    case 'restore':
      return state === 'hidden' ? 'restoring' : state;
    case 'reveal':
      return state === 'restoring' ? 'idle' : state;
    case 'fade-out':
      return state === 'idle' || state === 'out' ? 'faded' : state;
    case 'fade-in':
      return state === 'hidden' ? 'faded' : state === 'faded' ? 'idle' : state;
    case 'reset':
      return 'idle';
  }
}

/** The dialog's rectangle and radius now, or null when it cannot be measured (it then does not morph). */
export function measureDialog(): DialogGeometry | null {
  const dialog = document.querySelector<HTMLElement>('.muxui-dialog.bento-welcome');
  if (!dialog) return null;
  const rect = dialog.getBoundingClientRect();
  const radius = Number.parseFloat(getComputedStyle(dialog).borderTopLeftRadius);
  if (!(rect.width > 0 && rect.height > 0 && Number.isFinite(radius))) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    radius,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}
