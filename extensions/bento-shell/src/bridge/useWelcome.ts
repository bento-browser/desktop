// Cross-process bridge for the first-run welcome overlay.
//
// Same chrome-overlay pattern as palette / confirm / edit-workspace: the
// welcome card lives in its own chrome-mounted <browser> (welcome.html) so
// the modal scrim covers the entire browser window instead of being
// clipped to the sidebar.
//
// Trigger flow:
//   - App.tsx watches the SettingsStore mirror. When the first snapshot
//     arrives and welcomeSeen=false, it calls requestWelcome() exactly
//     once per session — sets document.title = BENTO_OPEN_WELCOME_<ts>,
//     which the chrome poll picks up and reveals the overlay frame.
//   - Welcome content dispatches settings/update {welcomeSeen: true} on
//     dismiss so the overlay never reopens, then sets its own
//     document.title = BENTO_CLOSE_WELCOME_<ts> for chrome to hide.
//
// No BroadcastChannel needed — the welcome carries no payload, just a
// visibility signal.

export const WELCOME_OPEN_PREFIX = 'BENTO_OPEN_WELCOME';
export const WELCOME_CLOSE_PREFIX = 'BENTO_CLOSE_WELCOME';

/** Reveal the chrome welcome overlay. Idempotent at the chrome layer
 * (showWelcome no-ops if already visible). Timestamp suffix forces a
 * DOMTitleChanged-equivalent poll detection even on repeat calls. */
export function requestWelcome(): void {
  document.title = `${WELCOME_OPEN_PREFIX}_${Date.now()}`;
}
