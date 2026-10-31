import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFakeDocument,
  createFakeStorage,
  insertBootLink,
  type FakeHead,
  type FakeLink,
  type FakeRoot,
} from './fakeThemeDom';

describe('applyRootTheme', () => {
  let head: FakeHead;
  let root: FakeRoot;
  let storage: ReturnType<typeof createFakeStorage>;
  let apply: typeof import('./applyRootTheme').applyRootTheme;
  let sheets: typeof import('./themeSheets');

  const linkFor = (themeId: string): FakeLink =>
    [...head.links].find((link) => link.dataset.bentoThemeSheet === themeId)!;
  const hint = () => storage.values.get(sheets.THEME_HINT_KEY);
  const themeAttribute = () => root.attributes.get('data-bento-theme');

  beforeEach(async () => {
    const fake = createFakeDocument();
    head = fake.head;
    root = fake.documentElement;
    storage = createFakeStorage();
    vi.stubGlobal('document', fake.document);
    vi.stubGlobal('localStorage', storage);
    vi.resetModules();
    sheets = await import('./themeSheets');
    ({ applyRootTheme: apply } = await import('./applyRootTheme'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the boot sheet and the hint while the workspace is unknown', async () => {
    const boot = insertBootLink(head, 'standard-harbour', 'loaded');
    storage.values.set(sheets.THEME_HINT_KEY, 'standard-harbour');

    await apply(undefined, 'light', false);

    expect(themeAttribute()).toBe('default');
    expect(boot.removed).toBe(false);
    expect(hint()).toBe('standard-harbour');
  });

  it('shows the hinted theme from the adopted sheet and records it once the workspace is known', async () => {
    const boot = insertBootLink(head, 'standard-harbour', 'loaded');
    await apply(undefined, 'dark', false);

    await apply('standard-harbour', 'dark', true);

    expect(root.attributes.get('data-bento-theme')).toBe('standard-harbour');
    expect(root.attributes.get('data-muxui-theme')).toBe('standard-harbour');
    expect(root.attributes.get('data-muxui-color-scheme')).toBe('dark');
    expect([...head.links]).toEqual([boot]);
    expect(hint()).toBe('standard-harbour');
  });

  it('waits for the boot sheet that is still loading before it shows the theme', async () => {
    const boot = insertBootLink(head, 'standard-harbour', 'loading');
    await apply(undefined, 'light', false);

    const shown = apply('standard-harbour', 'light', true);
    await Promise.resolve();
    expect(themeAttribute()).toBe('default');

    boot.fire('load');
    await shown;
    expect(themeAttribute()).toBe('standard-harbour');
    expect(head.links.size).toBe(1);
  });

  it('a hosted sheet completion cannot restore a mode captured before the native grant', async () => {
    root.setAttribute('data-bento-mode-writer', '1');
    root.setAttribute('data-color-mode', 'light');
    const pending = apply('standard-harbour', 'light', true);
    root.setAttribute('data-color-mode', 'dark');
    root.setAttribute('data-muxui-color-scheme', 'dark');
    linkFor('standard-harbour').fire('load');
    await pending;
    expect(root.getAttribute('data-muxui-color-scheme')).toBe('dark');
  });

  it('prunes the boot sheet when the workspace has another theme, and records that theme after it loads', async () => {
    const boot = insertBootLink(head, 'standard-harbour', 'loaded');
    storage.values.set(sheets.THEME_HINT_KEY, 'standard-harbour');
    await apply(undefined, 'light', false);

    const shown = apply('standard-lagoon', 'light', true);
    expect(boot.removed).toBe(true);
    expect(hint()).toBe('standard-harbour');

    linkFor('standard-lagoon').fire('load');
    await shown;
    expect(themeAttribute()).toBe('standard-lagoon');
    expect(hint()).toBe('standard-lagoon');
    expect(head.hrefs).toEqual(['./themes/standard-lagoon.css']);
  });

  it('clears the hint when the known workspace uses Default', async () => {
    insertBootLink(head, 'standard-harbour', 'loaded');
    storage.values.set(sheets.THEME_HINT_KEY, 'standard-harbour');

    await apply(undefined, 'light', true);

    expect(themeAttribute()).toBe('default');
    expect(hint()).toBe('default');
    expect(head.links.size).toBe(0);
  });

  it('records the resolved id for a legacy alias', async () => {
    const shown = apply('teal', 'light', true);
    linkFor('monochrome-teal').fire('load');
    await shown;
    expect(themeAttribute()).toBe('monochrome-teal');
    expect(hint()).toBe('monochrome-teal');
  });

  it('falls back to Default and records it when the sheet fails', async () => {
    const shown = apply('standard-harbour', 'light', true);
    linkFor('standard-harbour').fire('error');
    await shown;
    expect(themeAttribute()).toBe('default');
    expect(hint()).toBe('default');
  });

  it('leaves the scope and the hint to the newer request when one replaces it', async () => {
    const first = apply('standard-harbour', 'light', true);
    const harbour = linkFor('standard-harbour');
    const second = apply('standard-lagoon', 'light', true);
    harbour.fire('load');
    await first;
    expect(themeAttribute()).toBeUndefined();
    expect(hint()).toBeUndefined();

    linkFor('standard-lagoon').fire('load');
    await second;
    expect(themeAttribute()).toBe('standard-lagoon');
    expect(hint()).toBe('standard-lagoon');
  });
});
