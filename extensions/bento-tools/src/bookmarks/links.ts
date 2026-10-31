// URL rules for Bookmarks manager links. The scheme sets come from the backup
// validator (`ALLOWED_URL_SCHEMES`), so a stored link never carries a scheme the
// shell could not already ask to open.
import { ALLOWED_URL_SCHEMES, MAX_URL_LENGTH } from '@shared/export-schema';

const MAX_FAVICON_URL_LENGTH = 262_144;
const WEB_SCHEMES = new Set([...ALLOWED_URL_SCHEMES].filter((scheme) => scheme !== 'about:'));
const IMPORT_SCHEMES = new Set(['http:', 'https:']);

function hasScheme(value: unknown, schemes: ReadonlySet<string>): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    return schemes.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** A URL a bookmark link may hold and open: http(s), file, ftp and about. */
export const isLinkUrl = (value: unknown): value is string => hasScheme(value, ALLOWED_URL_SCHEMES);

/** A tab URL worth saving: a web or file page, not Firefox's own about: pages or any
 * privileged scheme (moz-extension, chrome, resource, view-source, data, blob). */
export const isSavableTabUrl = (value: unknown): value is string => hasScheme(value, WEB_SCHEMES);

/** A Firefox bookmark URL worth importing: http(s) only. */
export const isImportableUrl = (value: unknown): value is string =>
  hasScheme(value, IMPORT_SCHEMES);

/** An icon URL a shell document can render. `page-icon:` is chrome-privileged and does not load
 * from a moz-extension page, and an oversized data: URL would bloat every stored snapshot. */
export function cleanFavIconUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.length > MAX_FAVICON_URL_LENGTH || value.startsWith('page-icon:')) return undefined;
  return value;
}
