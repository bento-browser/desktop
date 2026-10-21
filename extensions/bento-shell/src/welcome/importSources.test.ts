// The Import step's sources: chrome's report, and the tiles, copy and action derived from it.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  firefoxZenSpan,
  firefoxZenTitle,
  IMPORT_BROWSERS,
  IMPORT_DESCRIPTION,
  importCopy,
  importSourcesRequestTitle,
  importView,
  parseImportSourcesMessage,
  type ImportBrowser,
  type ImportSourcesReport,
  type ImportView,
} from './importSources';

const LOGO = 'data:image/png;base64,iVBORw0KGgo=';

const ready = (browsers: { key: string; logo?: unknown }[], firefoxZen = false) => ({
  kind: 'bento-import-sources',
  status: 'ready',
  browsers,
  firefoxZen,
});

const browser = (key: ImportBrowser['key'], logo: string | null = LOGO): ImportBrowser => ({
  key,
  name: IMPORT_BROWSERS.find((entry) => entry.key === key)!.name,
  logo,
});

describe('parseImportSourcesMessage', () => {
  it('lists the browsers chrome found in tile order, with their names', () => {
    expect(
      parseImportSourcesMessage(
        ready(
          [
            { key: 'opera', logo: LOGO },
            { key: 'chromium-edge', logo: LOGO },
            { key: 'chrome', logo: LOGO },
          ],
          true,
        ),
      ),
    ).toEqual({
      status: 'ready',
      browsers: [browser('chrome'), browser('chromium-edge'), browser('opera')],
      firefoxZen: true,
    });
  });

  it('drops a browser it does not list, and a duplicate', () => {
    expect(
      parseImportSourcesMessage(
        ready([
          { key: 'firefox', logo: LOGO },
          { key: 'arc', logo: LOGO },
          { key: 'brave', logo: LOGO },
          { key: 'brave', logo: LOGO },
        ]),
      ),
    ).toEqual({ status: 'ready', browsers: [browser('brave')], firefoxZen: false });
  });

  it('keeps a logo only when it is a PNG data URL', () => {
    const logos = [
      'https://example.com/chrome.png',
      'chrome://browser/content/migration/brands/chrome.png',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:image/png;base64,AAAA" onerror="alert(1)',
      '',
      7,
      null,
      undefined,
    ];
    for (const logo of logos) {
      const report = parseImportSourcesMessage(ready([{ key: 'chrome', logo }]));
      expect(report).toEqual({
        status: 'ready',
        browsers: [browser('chrome', null)],
        firefoxZen: false,
      });
    }
  });

  it('reads a failed report', () => {
    expect(parseImportSourcesMessage({ kind: 'bento-import-sources', status: 'failed' })).toEqual({
      status: 'failed',
    });
  });

  it('takes Firefox or Zen as found only when chrome says true', () => {
    for (const firefoxZen of ['true', 1, null, undefined]) {
      expect(parseImportSourcesMessage({ ...ready([]), firefoxZen })).toMatchObject({
        firefoxZen: false,
      });
    }
  });

  it('ignores any other message on window', () => {
    for (const data of [
      null,
      'ready',
      42,
      { kind: 'bento-welcome-handoff', phase: 'hide', token: '17' },
      { kind: 'bento-import-sources' },
      { kind: 'bento-import-sources', status: 'ready' },
      { kind: 'bento-import-sources', status: 'ready', browsers: 'chrome' },
      { kind: 'bento-import-sources', status: 'loading' },
      { status: 'ready', browsers: [] },
    ]) {
      expect(parseImportSourcesMessage(data)).toBeNull();
    }
  });
});

describe('titles', () => {
  it('name the request and the Firefox or Zen restart by their prefixes', () => {
    expect(importSourcesRequestTitle('1700000000000')).toBe(
      'BENTO_IMPORT_SOURCES_REQUEST_1700000000000',
    );
    expect(firefoxZenTitle(4, '1700000000000')).toBe('BENTO_IMPORT_FIREFOX_ZEN_4_1700000000000');
  });
});

describe('importView', () => {
  const found: ImportSourcesReport = {
    status: 'ready',
    browsers: [browser('chrome')],
    firefoxZen: false,
  };

  it('waits with placeholders until a report arrives or the page gives up', () => {
    expect(importView(null, false)).toEqual({ kind: 'detecting' });
    expect(importView(null, true)).toEqual({ kind: 'fallback' });
  });

  it('shows the tiles whenever anything was found', () => {
    expect(importView(found, false)).toEqual({
      kind: 'tiles',
      browsers: [browser('chrome')],
      firefoxZen: false,
    });
    expect(importView({ status: 'ready', browsers: [], firefoxZen: true }, false)).toEqual({
      kind: 'tiles',
      browsers: [],
      firefoxZen: true,
    });
  });

  it('shows no tiles when nothing was found', () => {
    expect(importView({ status: 'ready', browsers: [], firefoxZen: false }, false)).toEqual({
      kind: 'none',
    });
  });

  it('falls back on a failed report, and a late report beats a timeout', () => {
    expect(importView({ status: 'failed' }, false)).toEqual({ kind: 'fallback' });
    expect(importView(found, true).kind).toBe('tiles');
  });
});

describe('importCopy', () => {
  it('describes the choice while there is one to make, with Other sources as the secondary action', () => {
    const views: ImportView[] = [
      { kind: 'detecting' },
      { kind: 'tiles', browsers: [browser('chrome')], firefoxZen: true },
    ];
    for (const view of views) {
      expect(importCopy(view)).toEqual({
        description: IMPORT_DESCRIPTION,
        action: { label: 'Other sources', primary: false },
      });
    }
  });

  it('turns to file imports, with Other sources primary, when nothing was found', () => {
    expect(importCopy({ kind: 'none' })).toEqual({
      description:
        'Import bookmarks or passwords from an exported file. Nothing leaves this device.',
      action: { label: 'Other sources', primary: true },
    });
  });

  it('falls back to the single Import browser data action', () => {
    expect(importCopy({ kind: 'fallback' })).toEqual({
      description: 'Bookmarks, history, passwords and open tabs. Nothing leaves this device.',
      action: { label: 'Import browser data', primary: true },
    });
  });
});

describe('firefoxZenSpan', () => {
  it('takes the columns left in its row at four columns', () => {
    expect([1, 2, 3, 5, 6].map((count) => firefoxZenSpan(count, 4))).toEqual([3, 2, 1, 3, 2]);
  });

  it('takes two columns of a new row when the row is full, and the whole row when alone', () => {
    expect(firefoxZenSpan(4, 4)).toBe(2);
    expect(firefoxZenSpan(0, 4)).toBe(4);
  });

  it('follows the compact two-column grid', () => {
    expect([0, 1, 2, 3, 6].map((count) => firefoxZenSpan(count, 2))).toEqual([2, 1, 2, 1, 2]);
  });
});

describe('the grid and the tiles', () => {
  it('keeps the column counts the stylesheet lays out', () => {
    const css = readFileSync(new URL('./welcome.css', import.meta.url), 'utf8');
    const grid = /\.bento-welcome__sources \{[^}]*grid-template-columns: repeat\((\d+),/.exec(css);
    expect(Number(grid?.[1])).toBe(4);
    const compact = /\.bento-welcome__sources \{\s*grid-template-columns: repeat\((\d+),/.exec(
      css.slice(css.indexOf('@media (max-width: 48rem)')),
    );
    expect(Number(compact?.[1])).toBe(2);
  });

  it('lists the six browsers the import wizard can preselect', () => {
    expect(IMPORT_BROWSERS.map(({ key }) => key)).toEqual([
      'chrome',
      'safari',
      'chromium-edge',
      'brave',
      'vivaldi',
      'opera',
    ]);
  });
});
