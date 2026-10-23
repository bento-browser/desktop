import { SHUTDOWN_CLEAR_PREFS } from '@shared/privacy-levels';

const REPAIRED_KEY = 'bento.shutdownClearingRepaired';
const MASTER_PREF = 'privacy.sanitize.sanitizeOnShutdown';

/**
 * One-time repair for profiles that turned "Clear cookies and cache on shutdown" on under a build
 * that wrote only the master pref: Firefox's own item prefs then also select history, downloads and
 * form data. If the master pref is on, write the whole bundle so the switch means what it says.
 * Runs once per profile (the flag is set even when nothing needed fixing), after the stored
 * protection level is applied so a level that turns clearing off is not undone.
 */
export async function repairLegacyShutdownClearing(): Promise<void> {
  const stored = await browser.storage.local.get(REPAIRED_KEY);
  if (stored[REPAIRED_KEY] === true) return;
  const prefs = await browser.bentoPrivacy.getPrefs([MASTER_PREF]);
  if (prefs[MASTER_PREF] === true) await browser.bentoPrivacy.setPrefs(SHUTDOWN_CLEAR_PREFS);
  await browser.storage.local.set({ [REPAIRED_KEY]: true });
}
