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
//     requestWelcome() — sets document.title = BENTO_OPEN_WELCOME_<ts>,
//     which the chrome poll picks up and reveals the overlay frame. The
//     duplicate signal covers cold-start title races and showWelcome()
//     is idempotent.
//   - Welcome content dispatches settings/update {welcomeSeen: true} only
//     from final dismiss paths, then sets its own document.title =
//     BENTO_CLOSE_WELCOME_<ts> for chrome to hide.
//   - The import action stores the next onboarding step in the welcome page,
//     uses BENTO_IMPORT_BROWSER_DATA_<ts>, and lets chrome show the embedded
//     Firefox migration host above the still-mounted onboarding flow. It does
//     not mark welcomeSeen=true.
//
// No BroadcastChannel needed — the welcome carries no payload, just a
// visibility signal.

export const WELCOME_OPEN_PREFIX = 'BENTO_OPEN_WELCOME';
export const WELCOME_CLOSE_PREFIX = 'BENTO_CLOSE_WELCOME';
export const WELCOME_IMPORT_BROWSER_DATA_PREFIX = 'BENTO_IMPORT_BROWSER_DATA';

/** Reveal the chrome welcome overlay. Idempotent at the chrome layer
 * (showWelcome no-ops if already visible). Timestamp suffix forces a
 * DOMTitleChanged-equivalent poll detection even on repeat calls. */
export function requestWelcome(): void {
  document.title = `${WELCOME_OPEN_PREFIX}_${Date.now()}`;
}
