// The title IPC the Bookmarks view uses with chrome (`<prefix>_<timestamp>`, written with
// `sendChromeTitle`). The prefixes are the mount script's `BOOKMARKS_OPEN_PREFIX` and
// `BOOKMARKS_CLOSE_PREFIX`; `titles.test.ts` keeps them equal. The open comes from the sidebar and
// the command palette, the close from the Bookmarks document itself.

import { sendChromeTitle } from '../bridge/chromeTitle';

export const OPEN_TITLE_PREFIX = 'BENTO_OPEN_BOOKMARKS';
export const CLOSE_TITLE_PREFIX = 'BENTO_CLOSE_BOOKMARKS';

/** A title that is new every time, so successive requests are never taken for one. */
export function titleFor(prefix: string): string {
  return `${prefix}_${Date.now()}`;
}

/** Asks chrome to show the Bookmarks view (a private window refuses). */
export function openBookmarksView(): void {
  sendChromeTitle(titleFor(OPEN_TITLE_PREFIX));
}

/** Asks chrome to hide the Bookmarks view. */
export function closeBookmarksView(): void {
  sendChromeTitle(titleFor(CLOSE_TITLE_PREFIX));
}
