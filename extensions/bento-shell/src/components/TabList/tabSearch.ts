// Drops a leading `scheme:` and optional `//` (https://, about:, moz-extension://)
// from a tab URL. Without this, a query like "http" would match every tab.
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:(?:\/\/)?/i;
// The query form strips only `scheme://` or `about:`, so `localhost:3000` keeps its host.
const QUERY_SCHEME = /^(?:[a-z][a-z0-9+.-]*:\/\/|about:)/i;
const DATA_URL = /^data:/i;

/**
 * Sidebar search predicate. `query` must already be trimmed and lowercased.
 * Matches a substring of the display title as typed, or of the URL with its
 * scheme removed. The query loses its own `scheme://` or `about:` prefix for
 * the URL test, so a pasted `https://github.com/andrew` finds
 * `https://github.com/andrew/repo`, while `localhost:3000` is kept whole. A
 * query that is only a scheme (`https://`, `about:`) skips the URL test, as does
 * a `data:` URL.
 */
export function matchesTabSearch(query: string, title: string, url?: string): boolean {
  if (title.toLocaleLowerCase().includes(query)) return true;
  // A data: URL is the page itself and can be megabytes; scanning it on every keystroke is slow.
  if (url === undefined || DATA_URL.test(url)) return false;
  const urlQuery = query.replace(QUERY_SCHEME, '');
  return urlQuery.length > 0 && url.replace(URL_SCHEME, '').toLocaleLowerCase().includes(urlQuery);
}

/**
 * The site shown under a search result's title: the exact hostname for http(s)
 * URLs (`www.` kept), the URL itself for `about:` pages, and undefined for
 * everything else (extension, data, blob and file URLs, or an empty or
 * unparsable URL), so those rows stay single-line.
 */
export function searchResultDomain(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'about:') return url;
    if (protocol === 'http:' || protocol === 'https:') return hostname || undefined;
  } catch {
    // Unparsable URL: no domain.
  }
  return undefined;
}
