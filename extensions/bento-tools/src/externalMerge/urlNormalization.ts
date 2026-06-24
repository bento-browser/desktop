import type { ExternalMergeSourceKind } from '@shared/protocol';

const NEW_TAB_URLS = new Set([
  'about:home',
  'about:newtab',
  'chrome://newtab/',
  'chrome-native://newtab/',
  'edge://newtab/',
  'brave://newtab/',
  'vivaldi://startpage/',
  'opera://startpage/',
]);

const CHROMIUM_NEW_TAB_PREFIXES = [
  'chrome-search://local-ntp/',
  'chrome://new-tab-page/',
  'edge://new-tab-page/',
];

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'ftp:']);

function isControlCharacter(char: string): boolean {
  const code = char.charCodeAt(0);
  return code <= 0x1f || code === 0x7f;
}

function stripControlCharacters(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw.charAt(i);
    if (!isControlCharacter(char)) out += char;
  }
  return out;
}

function trimUrl(raw: string): string {
  return stripControlCharacters(raw).trim();
}

export function isSourceNewTabUrl(raw: string, kind?: ExternalMergeSourceKind): boolean;
export function isSourceNewTabUrl(raw: string): boolean {
  const value = trimUrl(raw).toLowerCase();
  if (NEW_TAB_URLS.has(value)) return true;
  return CHROMIUM_NEW_TAB_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function normalizeExternalUrl(raw: string, kind?: ExternalMergeSourceKind): string | null;
export function normalizeExternalUrl(raw: string): string | null {
  const value = trimUrl(raw);
  if (!value) return null;
  if (isSourceNewTabUrl(value)) return 'about:newtab';

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  const protocol = url.protocol.toLowerCase();
  if (!SUPPORTED_PROTOCOLS.has(protocol)) return null;
  url.protocol = protocol;
  url.hostname = url.hostname.toLowerCase();

  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443') ||
    (url.protocol === 'ftp:' && url.port === '21')
  ) {
    url.port = '';
  }

  return url.toString();
}
