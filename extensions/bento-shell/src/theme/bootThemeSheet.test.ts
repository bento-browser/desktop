import { readdirSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BENTO_THEMES, DEFAULT_THEME_ID } from './presets';
import { THEME_HINT_KEY } from './themeSheets';
import {
  createFakeDocument,
  createFakeStorage,
  type FakeHead,
  type FakeLink,
} from './fakeThemeDom';

const bootSource = readFileSync(new URL('../../public/boot.js', import.meta.url), 'utf8');
const sheetIds = readdirSync(new URL('../../public/themes/', import.meta.url))
  .filter((file) => file.endsWith('.css'))
  .map((file) => file.slice(0, -'.css'.length));

/** Run public/boot.js against a fake document whose localStorage holds `hint`. */
function runBoot(hint: string | null, options: { optOut?: boolean } = {}) {
  const fake = createFakeDocument({ hasAttribute: () => options.optOut === true });
  const storage = createFakeStorage(hint === null ? {} : { [THEME_HINT_KEY]: hint });
  runInNewContext(bootSource, {
    document: fake.document,
    localStorage: storage,
    matchMedia: () => ({ matches: false }),
  });
  return { head: fake.head, root: fake.documentElement };
}

/** The one link boot.js inserted; throws when it inserted none or several. */
function onlyLink(head: FakeHead): FakeLink {
  const links = [...head.links];
  const [link] = links;
  if (links.length !== 1 || !link) throw new Error(`expected one link, found ${links.length}`);
  return link;
}

describe('boot.js theme sheet request', () => {
  it('lists a sheet for every registered theme but Default', () => {
    expect(sheetIds.sort()).toEqual(
      BENTO_THEMES.map((theme) => theme.id)
        .filter((id) => id !== DEFAULT_THEME_ID)
        .sort(),
    );
  });

  it.each(sheetIds)('requests the sheet for %s before React mounts', (id) => {
    const link = onlyLink(runBoot(id).head);
    expect(link.rel).toBe('stylesheet');
    expect(link.href).toBe(`./themes/${id}.css`);
    expect(link.dataset.bentoThemeSheet).toBe(id);
    expect(link.dataset.bentoBootSheet).toBe('loading');
  });

  it('keeps the root scope on Default until the sheet has loaded', () => {
    const { root } = runBoot('standard-harbour');
    expect(root.attributes.get('data-bento-theme')).toBe('default');
    expect(root.attributes.get('data-muxui-theme')).toBe('default');
  });

  it('marks the link when its load or error fires, before anything adopts it', () => {
    const loaded = onlyLink(runBoot('standard-harbour').head);
    loaded.fire('load');
    expect(loaded.dataset.bentoBootSheet).toBe('loaded');

    const failed = onlyLink(runBoot('not-a-sheet').head);
    failed.fire('error');
    expect(failed.dataset.bentoBootSheet).toBe('failed');
  });

  it.each([
    ['a missing hint', null],
    ['an empty hint', ''],
    ['Default', 'default'],
    ['a parent path', '../standard-harbour'],
    ['an encoded parent path', '..%2fstandard-harbour'],
    ['a nested path', 'themes/standard-harbour'],
    ['a file extension', 'standard-harbour.css'],
    ['a protocol-relative URL', '//example.com/x'],
    ['upper case', 'Standard-Harbour'],
    ['surrounding whitespace', ' standard-harbour'],
    ['a trailing newline', 'standard-harbour\n'],
    ['a leading hyphen', '-standard-harbour'],
    ['a trailing hyphen', 'standard-harbour-'],
    ['a doubled hyphen', 'standard--harbour'],
    ['more than 64 characters', 'a'.repeat(65)],
  ])('requests nothing for %s', (_, hint) => {
    expect(runBoot(hint).head.links.size).toBe(0);
  });

  it('requests nothing for a page that opts out', () => {
    expect(runBoot('standard-harbour', { optOut: true }).head.links.size).toBe(0);
  });
});
