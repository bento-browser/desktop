import { vi } from 'vitest';
import type { PrivacyPrefMap, PrivacyPrefValue } from '@shared/privacy-levels';

/** Firefox 158's defaults for the shutdown-clearing prefs on a fresh profile. */
export const FIREFOX_SHUTDOWN_DEFAULTS: PrivacyPrefMap = {
  'privacy.sanitize.sanitizeOnShutdown': false,
  'privacy.sanitize.clearOnShutdown.hasMigratedToNewPrefs3': false,
  'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads': true,
  'privacy.clearOnShutdown_v2.cache': true,
  'privacy.clearOnShutdown_v2.cookiesAndStorage': true,
  'privacy.clearOnShutdown_v2.formdata': false,
  'privacy.clearOnShutdown_v2.siteSettings': false,
};

/**
 * An in-memory `browser.bentoPrivacy` pref API. Like Firefox, a write to a locked pref is dropped
 * without an error.
 */
export function createFakePrefs(initial: PrivacyPrefMap, locked: readonly string[] = []) {
  const store = new Map<string, PrivacyPrefValue>(Object.entries(initial));
  const lockedNames = new Set(locked);
  const api = {
    getPrefs: vi.fn(async (names: string[]) =>
      Object.fromEntries(names.map((name) => [name, store.get(name) ?? ''])),
    ),
    setPrefs: vi.fn(async (values: Record<string, PrivacyPrefValue>) => {
      for (const [name, value] of Object.entries(values)) {
        if (!lockedNames.has(name)) store.set(name, value);
      }
    }),
  };
  return { store, api };
}
