// The title IPC requests the Settings document makes of chrome (`<prefix>_<timestamp>`, written
// with `sendChromeTitle`). The prefixes are the mount script's `SETTINGS_PALETTE_CLOSE_PREFIX`
// and `SETTINGS_BACK_TO_PALETTE_PREFIX`; `titles.test.ts` keeps them equal.

/** Hide the Settings palette. */
export const CLOSE_TITLE_PREFIX = 'BENTO_CLOSE_SETTINGS_PALETTE';

/** Hide the Settings palette and show the command palette again, with the query it had. */
export const BACK_TO_PALETTE_TITLE_PREFIX = 'BENTO_SETTINGS_BACK_TO_PALETTE';

/** A title that is new every time, so successive requests are never taken for one. */
export function titleFor(prefix: string): string {
  return `${prefix}_${Date.now()}`;
}
