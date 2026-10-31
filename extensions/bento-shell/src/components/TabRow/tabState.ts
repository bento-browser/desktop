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

/** The stand-in icons Firefox sets on its net error, certificate error, HTTPS-Only error and
 * blocked-site pages (`nsIFaviconService.idl` FAVICON_ERRORPAGE_URL and
 * FAVICON_CERTERRORPAGE_URL, `blockedSite.xhtml`). Other internal pages that use the same files
 * (`about:sessionrestore`, `about:restartrequired`, `about:restricted`) are told apart by URL. */
const ERROR_PAGE_ICONS: ReadonlyMap<string, TabState> = new Map([
  ['chrome://global/skin/icons/info.svg', 'unavailable'],
  ['chrome://global/skin/icons/warning.svg', 'certificate-warning'],
  ['chrome://global/skin/icons/blocked.svg', 'blocked'],
]);

const parseUrl = (url: string | undefined) => (url && URL.canParse(url) ? new URL(url) : null);

/** Firefox keeps the failed address as the tab URL on an error page, so only a tab that still
 * shows a website address can be one. `about:`, `chrome:`, `moz-extension:` and similar internal
 * pages never are, even when they borrow an error icon. */
const WEBSITE_PROTOCOLS = new Set(['http:', 'https:', 'file:']);

/** `about:config` and `about:preferences`, with any `#section` or query. */
const INTERNAL_SETTINGS_PAGES = new Set(['config', 'preferences']);

/**
 * The state a tab row presents, or null to show the website favicon (or the loading indicator).
 * A loading tab is null so the native loading cue stays; a crash outranks it because the tab is
 * no longer loading anything.
 */
export function tabStateOf(
  tab: Pick<TabSnapshot, 'url' | 'loading' | 'discarded' | 'favIconUrl' | 'crashed'>,
): TabState | null {
  if (tab.crashed === true) return 'crashed';
  if (tab.loading) return null;
  if (tab.discarded) return 'sleeping';
  const url = parseUrl(tab.url);
  const errorState = tab.favIconUrl ? ERROR_PAGE_ICONS.get(tab.favIconUrl) : undefined;
  if (errorState && url && WEBSITE_PROTOCOLS.has(url.protocol)) return errorState;
  if (url?.protocol === 'about:' && INTERNAL_SETTINGS_PAGES.has(url.pathname.toLowerCase())) {
    return 'internal-settings';
  }
  return tab.favIconUrl ? null : 'default';
}
