// Cross-process bridge for the first-run welcome overlay.
//
// Same chrome-overlay pattern as palette / confirm / edit-workspace: the
// welcome card lives in its own chrome-mounted <browser> (welcome.html) so
// the modal scrim covers the entire browser window instead of being
// clipped to the sidebar.
//
// Trigger flow:
//   - App.tsx and welcome.html both watch the SettingsStore mirror. When
//     the first snapshot arrives and welcomeSeen=false, they call
//     requestWelcome() — sends BENTO_OPEN_WELCOME_<ts> through the shared
//     title writer, which chrome's pagetitlechanged listener picks up to
//     reveal the overlay frame. The duplicate signal covers cold-start
//     races and showWelcome() is idempotent.
//   - Welcome content dispatches settings/update {welcomeSeen: true} only
//     from final dismiss paths, then sends BENTO_CLOSE_WELCOME_<ts> for
//     chrome to hide. The Ready step's Open Settings button finishes the same way
//     but sends BENTO_OPEN_SETTINGS_<ts> instead, which chrome answers by hiding the
//     overlay and opening Settings (one title: title IPC is last-write-wins).
//   - The import action stores the next onboarding step in extension storage,
//     uses BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts>, and lets chrome show the
//     embedded Firefox migration host above the still-mounted onboarding flow.
//     It does not mark welcomeSeen=true. The dialog and the wizard card swap at one
//     rectangle (welcome/importHandoff.ts). A browser tile adds the browser's migrator
//     key to that title so the wizard opens with it selected.
//   - The Import step asks chrome for the browsers it can import from
//     (BENTO_IMPORT_SOURCES_REQUEST_<ts>; chrome also sends them once on its own), and
//     its Firefox or Zen tile asks chrome to restart into the startup import
//     (BENTO_IMPORT_FIREFOX_ZEN_<nextStep>_<ts>). welcome/importSources.ts.
//
// No BroadcastChannel needed — the welcome carries no payload, just a
// visibility signal.

import { sendChromeTitle } from './chromeTitle';

export const WELCOME_OPEN_PREFIX = 'BENTO_OPEN_WELCOME';
export const WELCOME_CLOSE_PREFIX = 'BENTO_CLOSE_WELCOME';
/** Open Settings on the Ready step: chrome hides the overlay and opens Settings (the mount
 * script's SETTINGS_OPEN_PREFIX, which the palette's Settings command also sends). */
export const WELCOME_OPEN_SETTINGS_PREFIX = 'BENTO_OPEN_SETTINGS';
export const WELCOME_IMPORT_BROWSER_DATA_PREFIX = 'BENTO_IMPORT_BROWSER_DATA';
/** The Import step asks chrome to send the import sources again: BENTO_IMPORT_SOURCES_REQUEST_<ts>. */
export const WELCOME_IMPORT_SOURCES_REQUEST_PREFIX = 'BENTO_IMPORT_SOURCES_REQUEST';
/** The Firefox or Zen tile: chrome restarts into the startup import, BENTO_IMPORT_FIREFOX_ZEN_<nextStep>_<ts>. */
export const WELCOME_IMPORT_FIREFOX_ZEN_PREFIX = 'BENTO_IMPORT_FIREFOX_ZEN';
/** Acknowledgements of the import handoff: BENTO_WELCOME_HANDOFF_<READY|HIDDEN|RESTORED>_<token>. */
export const WELCOME_HANDOFF_PREFIX = 'BENTO_WELCOME_HANDOFF';

/** Reveal the chrome welcome overlay. Idempotent at the chrome layer
 * (showWelcome no-ops if already visible). The timestamp suffix keeps repeat
 * calls from being dropped as an unchanged title. */
export function requestWelcome(): void {
  sendChromeTitle(`${WELCOME_OPEN_PREFIX}_${Date.now()}`);
}

const WELCOME_REQUEST_ATTEMPTS = 5;
const WELCOME_REQUEST_INTERVAL_MS = 200;

/** Requests the overlay now and repeats for about a second. The repeats
 * predate the shared title writer (a BENTO_PANELS write could displace the
 * first request) and are harmless because showWelcome() is idempotent.
 * Returns a function that stops them. */
export function startWelcomeRequests(): () => void {
  let attempts = 0;
  const fire = () => {
    requestWelcome();
    attempts += 1;
    if (attempts >= WELCOME_REQUEST_ATTEMPTS) clearInterval(handle);
  };
  fire();
  const handle = setInterval(fire, WELCOME_REQUEST_INTERVAL_MS);
  return () => clearInterval(handle);
}
