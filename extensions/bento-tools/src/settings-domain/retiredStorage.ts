/** Storage keys written by builds that shipped the native Settings page, now unused. */
const RETIRED_KEYS = ['bento.nativeSessions.v1'];

/** Drops the retired keys; a failure is only logged because nothing reads them any more. */
export async function removeRetiredSettingsStorage(): Promise<void> {
  try {
    await browser.storage.local.remove(RETIRED_KEYS);
  } catch (error) {
    console.warn('[bento-tools] could not remove retired Settings storage:', error);
  }
}
