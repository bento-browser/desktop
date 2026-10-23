import { SHUTDOWN_CLEAR_PREFS, type PrivacyPrefMap } from '@shared/privacy-levels';
import { snapshotAdvancedPrefs, writePrefsVerified } from './ProtectionLevels';

const REPAIRED_KEY = 'bento.shutdownClearingRepaired';
const MASTER_PREF = 'privacy.sanitize.sanitizeOnShutdown';
const MIGRATED_PREF = 'privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3';
const FORMDATA_PREF = 'privacy.clearOnShutdown_v2.formdata';
/** Firefox 158's defaults for the v2 item prefs the old switch left alone. */
const FIREFOX_ITEM_DEFAULTS: PrivacyPrefMap = {
  'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads': true,
  'privacy.clearOnShutdown_v2.cache': true,
  'privacy.clearOnShutdown_v2.cookiesAndStorage': true,
  'privacy.clearOnShutdown_v2.siteSettings': false,
};

/**
 * The state the old switch left: master pref on, every item pref at Firefox's default, and
 * `formdata` plus the migration flag either both untouched (false, false) or both set by
 * Firefox's own migration at the first quit (true, true: it copies form data from the legacy
 * default and sets the flag). Anything else is somebody's own choice.
 */
function isLegacySwitchState(prefs: PrivacyPrefMap): boolean {
  if (prefs[MASTER_PREF] !== true) return false;
  const itemsAtDefault = Object.entries(FIREFOX_ITEM_DEFAULTS).every(
    ([name, value]) => prefs[name] === value,
  );
  const migrated = prefs[MIGRATED_PREF];
  return itemsAtDefault && typeof migrated === 'boolean' && migrated === prefs[FORMDATA_PREF];
}

/**
 * One-time repair for profiles that turned "Clear cookies and cache on shutdown" on under a build
 * that wrote only the master pref: Firefox's item prefs then also select history, downloads and
 * form data. For exactly that state, write the whole bundle so the switch means what it says;
 * any other item prefs are left alone. The flag is set once the profile is settled (repaired,
 * or nothing to repair); if a write does not take (a locked pref), the prefs are put back and the
 * repair retries at the next launch.
 */
export async function repairLegacyShutdownClearing(): Promise<void> {
  const stored = await browser.storage.local.get(REPAIRED_KEY);
  if (stored[REPAIRED_KEY] === true) return;
  const prefs = await browser.bentoPrivacy.getPrefs([
    MASTER_PREF,
    MIGRATED_PREF,
    ...Object.keys(FIREFOX_ITEM_DEFAULTS),
    FORMDATA_PREF,
  ]);
  if (isLegacySwitchState(prefs)) {
    const restore = await snapshotAdvancedPrefs('sanitizeOnShutdown');
    try {
      await writePrefsVerified(SHUTDOWN_CLEAR_PREFS);
    } catch (err) {
      await restore?.().catch(() => undefined);
      console.warn('[bento-tools] shutdown clearing repair not applied; will retry:', err);
      return;
    }
  }
  await browser.storage.local.set({ [REPAIRED_KEY]: true });
}
