// The dialog's side of the handoff to the import wizard: the title it sends (read by the mount
// script), its acknowledgements, chrome's messages, and the dialog states they move it through.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { firefoxZenTitle, importSourcesRequestTitle } from './importSources';
import {
  ackTitle,
  importTitle,
  nextHandoff,
  parseHandoffMessage,
  type DialogGeometry,
  type DialogHandoff,
  type HandoffPhase,
} from './importHandoff';

const geometry: DialogGeometry = {
  x: 280,
  y: 238,
  width: 720,
  height: 528,
  radius: 16,
  viewportWidth: 1280,
  viewportHeight: 1004,
};

const MOUNT = readFileSync(
  new URL('../../../../src/browser/base/content/bento-shell-mount.js', import.meta.url),
  'utf8',
);

/** A top-level (2-space indented) function of the mount script, built with the constants it reads. */
function mountFunction<T>(name: string, constants: Record<string, string>): T {
  const start = MOUNT.indexOf(`\n  function ${name}(`);
  expect(start, `${name} is missing from the mount script`).not.toBe(-1);
  const source = MOUNT.slice(start, MOUNT.indexOf('\n  }\n', start) + 5);
  return new Function(...Object.keys(constants), `${source}\nreturn ${name};`)(
    ...Object.values(constants),
  ) as T;
}

type ParsedImport = {
  token: string;
  rect: { x: number; y: number; w: number; h: number; r: number } | null;
  viewport: { w: number; h: number } | null;
  source: string | null;
} | null;

const parseImport = mountFunction<(title: string) => ParsedImport>('parseWelcomeImportHandoff', {
  WELCOME_IMPORT_BROWSER_DATA_PREFIX: 'BENTO_IMPORT_BROWSER_DATA',
});
const parseResumeStep = mountFunction<(title: string, prefix?: string) => string>(
  'parseWelcomeImportResumeStep',
  {
    WELCOME_IMPORT_BROWSER_DATA_PREFIX: 'BENTO_IMPORT_BROWSER_DATA',
    BENTO_WELCOME_POST_IMPORT_STEP: '2',
  },
);

describe('importTitle', () => {
  it('keeps the title chrome has always read when the dialog cannot morph', () => {
    expect(importTitle(3, '1700000000000')).toBe('BENTO_IMPORT_BROWSER_DATA_3_1700000000000');
  });

  it('appends the dialog rectangle, radius and viewport, rounded to two decimals', () => {
    expect(importTitle(3, '1700000000000', { ...geometry, x: 280.004, radius: 15.9963 })).toBe(
      'BENTO_IMPORT_BROWSER_DATA_3_1700000000000_280_238_720_528_16_1280_1004',
    );
    expect(importTitle(3, '1', { ...geometry, x: 280.126 })).toContain('_280.13_');
  });

  it('is read back by the mount script, and leaves the resume step where it was', () => {
    const title = importTitle(3, '1700000000000', geometry);
    expect(parseImport(title)).toEqual({
      token: '1700000000000',
      rect: { x: 280, y: 238, w: 720, h: 528, r: 16 },
      viewport: { w: 1280, h: 1004 },
      source: null,
    });
    expect(parseResumeStep(title)).toBe('3');
    expect(parseResumeStep(importTitle(3, '1700000000000'))).toBe('3');
  });

  it('is read without a rectangle when it carries none or a malformed one', () => {
    const bare = { token: '1700000000000', rect: null, viewport: null, source: null };
    expect(parseImport(importTitle(3, '1700000000000'))).toEqual(bare);
    for (const suffix of [
      '_1_2_3',
      '_a_238_720_528_16_1280_1004',
      '_280_238_0_528_16_1280_1004',
      '_280_238_720_528_16_1280_',
    ]) {
      expect(parseImport(`BENTO_IMPORT_BROWSER_DATA_3_1700000000000${suffix}`)).toEqual(bare);
    }
    expect(parseImport('BENTO_IMPORT_BROWSER_DATA_3_x')).toBeNull();
  });
});

describe('importTitle with a browser tile', () => {
  it('appends the migrator key last, with or without the geometry', () => {
    expect(importTitle(3, '1700000000000', undefined, 'chromium-edge')).toBe(
      'BENTO_IMPORT_BROWSER_DATA_3_1700000000000_s-chromium-edge',
    );
    expect(importTitle(3, '1700000000000', geometry, 'chrome')).toBe(
      'BENTO_IMPORT_BROWSER_DATA_3_1700000000000_280_238_720_528_16_1280_1004_s-chrome',
    );
  });

  it('is read back by the mount script with the key, whatever else the title carries', () => {
    const rect = { x: 280, y: 238, w: 720, h: 528, r: 16 };
    const viewport = { w: 1280, h: 1004 };
    expect(parseImport(importTitle(3, '1700000000000', geometry, 'safari'))).toEqual({
      token: '1700000000000',
      rect,
      viewport,
      source: 'safari',
    });
    expect(parseImport(importTitle(3, '1700000000000', undefined, 'vivaldi'))).toEqual({
      token: '1700000000000',
      rect: null,
      viewport: null,
      source: 'vivaldi',
    });
    expect(parseResumeStep(importTitle(3, '1700000000000', geometry, 'brave'))).toBe('3');
  });

  it('drops a key that is not a plain lowercase word, and keeps the rest of the title', () => {
    for (const key of ['Chrome', 'chrome!', 'a'.repeat(33), '']) {
      const parsed = parseImport(`BENTO_IMPORT_BROWSER_DATA_3_1700000000000_s-${key}`);
      expect(parsed).toEqual({ token: '1700000000000', rect: null, viewport: null, source: null });
    }
    expect(
      parseImport('BENTO_IMPORT_BROWSER_DATA_3_1700000000000_280_238_720_528_16_1280_1004_s-Zed')
        ?.rect,
    ).toEqual({ x: 280, y: 238, w: 720, h: 528, r: 16 });
  });
});

describe('the Firefox or Zen sentinel', () => {
  it('carries the resume step the way the import title does', () => {
    const title = firefoxZenTitle(3, '1700000000000');
    expect(title).toBe('BENTO_IMPORT_FIREFOX_ZEN_3_1700000000000');
    expect(parseResumeStep(title, 'BENTO_IMPORT_FIREFOX_ZEN')).toBe('3');
    expect(parseResumeStep('BENTO_IMPORT_FIREFOX_ZEN_x', 'BENTO_IMPORT_FIREFOX_ZEN')).toBe('2');
  });

  it('is not mistaken for another sentinel by the mount script prefix tests', () => {
    const titles = [
      importTitle(3, '17'),
      firefoxZenTitle(3, '17'),
      importSourcesRequestTitle('17'),
      ackTitle('READY', '17'),
    ];
    const prefixes = [
      'BENTO_IMPORT_BROWSER_DATA',
      'BENTO_IMPORT_FIREFOX_ZEN',
      'BENTO_IMPORT_SOURCES_REQUEST',
      'BENTO_WELCOME_HANDOFF',
    ];
    titles.forEach((title, index) => {
      expect(prefixes.filter((prefix) => title.startsWith(prefix))).toEqual([prefixes[index]]);
    });
  });
});

describe('acknowledgements', () => {
  it('name the handoff by its token', () => {
    expect(ackTitle('READY', '17')).toBe('BENTO_WELCOME_HANDOFF_READY_17');
    expect(ackTitle('HIDDEN', '17')).toBe('BENTO_WELCOME_HANDOFF_HIDDEN_17');
    expect(ackTitle('RESTORED', '17')).toBe('BENTO_WELCOME_HANDOFF_RESTORED_17');
  });
});

describe('parseHandoffMessage', () => {
  it('accepts the message chrome posts', () => {
    expect(
      parseHandoffMessage({ kind: 'bento-welcome-handoff', phase: 'hide', token: '17' }),
    ).toEqual({ phase: 'hide', token: '17' });
  });

  it('ignores any other message on window', () => {
    for (const data of [
      null,
      'hide',
      { kind: 'bento-panel-navigator-tooltip', phase: 'hide', token: '17' },
      { kind: 'bento-welcome-handoff', phase: 'explode', token: '17' },
      { kind: 'bento-welcome-handoff', phase: 'hide' },
      { kind: 'bento-welcome-handoff', phase: 'hide', token: 17 },
    ]) {
      expect(parseHandoffMessage(data)).toBeNull();
    }
  });
});

describe('nextHandoff', () => {
  const run = (from: DialogHandoff, ...phases: HandoffPhase[]) => phases.reduce(nextHandoff, from);

  it('follows the morph out and back', () => {
    expect(run('out', 'hide')).toBe('hidden');
    expect(run('hidden', 'restore')).toBe('restoring');
    expect(run('restoring', 'reveal')).toBe('idle');
    expect(run('out', 'hide', 'restore', 'reveal')).toBe('idle');
  });

  it('crossfades out and back, starting the fade in from opacity 0', () => {
    expect(run('idle', 'fade-out')).toBe('faded');
    expect(run('faded', 'fade-in')).toBe('idle');
    // After a morph out the dialog is `hidden`: it goes `faded` first, then `idle`.
    expect(run('hidden', 'fade-in')).toBe('faded');
    expect(run('hidden', 'fade-in', 'fade-in')).toBe('idle');
  });

  it('abandons from any state', () => {
    for (const state of ['idle', 'out', 'hidden', 'restoring', 'faded'] as const) {
      expect(run(state, 'reset')).toBe('idle');
    }
  });

  it('leaves the state alone for a phase that does not apply (a late or repeated message)', () => {
    expect(run('idle', 'reveal')).toBe('idle');
    expect(run('idle', 'restore')).toBe('idle');
    expect(run('hidden', 'hide')).toBe('hidden');
    expect(run('restoring', 'restore')).toBe('restoring');
    expect(run('restoring', 'fade-out')).toBe('restoring');
    expect(run('out', 'reveal')).toBe('out');
  });
});
