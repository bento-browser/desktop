import type { TabSnapshot } from '@shared/protocol';

/** Sidebar tab states with their own icon. `tinted` states also paint a status background. */
export const TAB_STATES = {
  default: { label: 'Default', tinted: false },
  unavailable: { label: 'Unavailable', tinted: true },
  'certificate-warning': { label: 'Certificate warning', tinted: true },
  blocked: { label: 'Blocked', tinted: true },
  crashed: { label: 'Crashed', tinted: true },
  sleeping: { label: 'Sleeping', tinted: false },
  'internal-settings': { label: 'Internal settings', tinted: true },
} as const;

export type TabState = keyof typeof TAB_STATES;

const parseUrl = (url: string | undefined) => (url && URL.canParse(url) ? new URL(url) : null);

/** `about:config` and `about:preferences`, with any `#section` or query. */
const INTERNAL_SETTINGS_PAGES = new Set(['config', 'preferences']);

/**
 * The state a tab row presents, or null to show the website favicon (or the loading indicator).
 * `pageError` comes from the document the browser shows, read by bento-tools. Neither the favicon
 * nor the URL can stand in for it: a website can declare any `chrome://global/skin/` favicon, and
 * an error page keeps the failed address as its URL. A loading tab is null so the native loading
 * cue stays; a crash outranks it because the tab is no longer loading anything. A null `pageError`
 * (a cleared delta) counts as none.
 */
export function tabStateOf(
  tab: Pick<TabSnapshot, 'url' | 'loading' | 'discarded' | 'favIconUrl' | 'pageError'>,
): TabState | null {
  if (tab.pageError === 'crashed') return 'crashed';
  if (tab.loading) return null;
  if (tab.discarded) return 'sleeping';
  if (tab.pageError) return tab.pageError;
  const url = parseUrl(tab.url);
  if (url?.protocol === 'about:' && INTERNAL_SETTINGS_PAGES.has(url.pathname.toLowerCase())) {
    return 'internal-settings';
  }
  return tab.favIconUrl ? null : 'default';
}
