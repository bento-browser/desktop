// The Import step's sources: what chrome reports about this Mac, and the step's view of it.
//
// Chrome (bento-shell-mount.js, "Import sources") asks Firefox's migrators which of the browsers
// below have data to import, reads each one's logo, and sends the result once when onboarding opens
// (and again whenever this page asks, e.g. after a reload). This module is the pure part: it parses
// that message and derives the tiles, the copy and the action for each state the step can be in, so
// the states are testable and storied. docs/technical/first-run-import.md describes the protocol.

import {
  WELCOME_IMPORT_FIREFOX_ZEN_PREFIX,
  WELCOME_IMPORT_SOURCES_REQUEST_PREFIX,
} from '../bridge/useWelcome';

/**
 * Browsers the Import step offers as tiles, in tile order. `key` is the key of Firefox's migrator
 * for that browser: the import wizard preselects it, and chrome reports availability under it.
 */
export const IMPORT_BROWSERS = [
  { key: 'chrome', name: 'Chrome' },
  { key: 'safari', name: 'Safari' },
  { key: 'chromium-edge', name: 'Edge' },
  { key: 'brave', name: 'Brave' },
  { key: 'vivaldi', name: 'Vivaldi' },
  { key: 'opera', name: 'Opera' },
] as const;

export type ImportBrowserKey = (typeof IMPORT_BROWSERS)[number]['key'];

/** A browser chrome can import from. `logo` is a PNG data URL, or null when chrome could not read it. */
export interface ImportBrowser {
  key: ImportBrowserKey;
  name: string;
  logo: string | null;
}

/** Chrome's answer: the detection failed or ran out of time, or the result. */
export type ImportSourcesReport =
  { status: 'failed' } | { status: 'ready'; browsers: ImportBrowser[]; firefoxZen: boolean };

// Chrome sends a logo only as a PNG it encoded itself; anything else is dropped before it can
// become an <img> source.
const LOGO_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The report in a message chrome's frame script posted, or null for anything else on `window`.
 * Browsers come back in tile order whatever order chrome listed them in; an unknown key is dropped.
 */
export function parseImportSourcesMessage(data: unknown): ImportSourcesReport | null {
  if (!isRecord(data) || data.kind !== 'bento-import-sources') return null;
  if (data.status === 'failed') return { status: 'failed' };
  if (data.status !== 'ready' || !Array.isArray(data.browsers)) return null;

  const reported: unknown[] = data.browsers;
  const browsers = IMPORT_BROWSERS.flatMap(({ key, name }): ImportBrowser[] => {
    const entry = reported.find((item) => isRecord(item) && item.key === key);
    if (!isRecord(entry)) return [];
    const logo =
      typeof entry.logo === 'string' && LOGO_DATA_URL.test(entry.logo) ? entry.logo : null;
    return [{ key, name, logo }];
  });
  return { status: 'ready', browsers, firefoxZen: data.firefoxZen === true };
}

/** `BENTO_IMPORT_SOURCES_REQUEST_<ts>`: the page has no report and asks chrome to send it. */
export function importSourcesRequestTitle(token: string): string {
  return `${WELCOME_IMPORT_SOURCES_REQUEST_PREFIX}_${token}`;
}

/** `BENTO_IMPORT_FIREFOX_ZEN_<nextStep>_<ts>`: restart Bento into the Firefox or Zen startup import. */
export function firefoxZenTitle(nextStep: number, token: string): string {
  return `${WELCOME_IMPORT_FIREFOX_ZEN_PREFIX}_${nextStep}_${token}`;
}

/** What the page waits for a report before it gives up and shows the plain Import action. */
export const IMPORT_SOURCES_CEILING_MS = 4000;

/** The Import step in each state it can be in. */
export type ImportView =
  /** No report yet: static placeholder tiles. */
  | { kind: 'detecting' }
  /** Detection failed or timed out: no tiles, the single Import browser data action. */
  | { kind: 'fallback' }
  /** Nothing to import from: only the file imports of Other sources remain. */
  | { kind: 'none' }
  | { kind: 'tiles'; browsers: ImportBrowser[]; firefoxZen: boolean };

export function importView(report: ImportSourcesReport | null, timedOut: boolean): ImportView {
  if (report === null) return timedOut ? { kind: 'fallback' } : { kind: 'detecting' };
  if (report.status === 'failed') return { kind: 'fallback' };
  if (report.browsers.length === 0 && !report.firefoxZen) return { kind: 'none' };
  return { kind: 'tiles', browsers: report.browsers, firefoxZen: report.firefoxZen };
}

export interface ImportCopy {
  description: string;
  /** The footer action that opens the wizard with no browser selected. */
  action: { label: string; primary: boolean };
}

export const IMPORT_DESCRIPTION =
  'Pick a browser to copy bookmarks, history, passwords and open tabs. Nothing leaves this device.';

export const IMPORT_NONE_NOTE = 'No other browsers found on this Mac.';

export function importCopy(view: ImportView): ImportCopy {
  switch (view.kind) {
    case 'none':
      return {
        description:
          'Import bookmarks or passwords from an exported file. Nothing leaves this device.',
        action: { label: 'Other sources', primary: true },
      };
    case 'fallback':
      return {
        description: 'Bookmarks, history, passwords and open tabs. Nothing leaves this device.',
        action: { label: 'Import browser data', primary: true },
      };
    default:
      return {
        description: IMPORT_DESCRIPTION,
        action: { label: 'Other sources', primary: false },
      };
  }
}

/** Columns of the tile grid: welcome.css shows 4, and 2 in the compact layout. */
export const IMPORT_GRID_COLUMNS = { wide: 4, compact: 2 } as const;

/**
 * Columns the Firefox or Zen tile takes in a grid of `columns` columns after `browserCount` tiles:
 * those left in its row, or 2 on a new row when the row is full. Alone it takes the whole row.
 */
export function firefoxZenSpan(browserCount: number, columns: number): number {
  const left = columns - (browserCount % columns);
  return left === columns && browserCount > 0 ? Math.min(2, columns) : left;
}
