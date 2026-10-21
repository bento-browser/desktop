// The step index is a persisted contract: 'bento-welcome-step', the
// #bentoWelcomeStep hash chrome stamps after a profile migration, and the next
// step in BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts> all carry it.

import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  LAST_STEP,
  parseStoredStep,
  pendingThemeView,
  searchEngineName,
  searchEngineOptions,
  startImport,
  stepAfter,
  stepIndexOf,
  THEME_GROUPS,
  themeGroupOf,
  themeOptions,
  WELCOME_STEPS,
} from './WelcomeSurfaces';

describe('welcome steps', () => {
  it('keeps the persisted step order', () => {
    expect(WELCOME_STEPS.map((step) => step.id)).toEqual([
      'welcome',
      'appearance',
      'theme',
      'import',
      'privacy',
      'search',
      'tour',
      'ready',
    ]);
    expect(LAST_STEP).toBe(7);
  });

  it('stores Privacy as the resume step, then signals chrome, after an import', async () => {
    const log: string[] = [];
    const next = stepAfter(stepIndexOf('import'));
    await startImport(
      next,
      async (step) => {
        log.push(`store ${step}`);
      },
      (title) => log.push(title),
    );
    expect(next).toBe(stepIndexOf('privacy'));
    expect(log).toEqual(['store 4', expect.stringMatching(/^BENTO_IMPORT_BROWSER_DATA_4_\d+$/)]);
  });

  it('matches the fallback resume step in the chrome mount script to Privacy', () => {
    const mount = readFileSync(
      new URL('../../../../src/browser/base/content/bento-shell-mount.js', import.meta.url),
      'utf8',
    );
    const fallback = /const BENTO_WELCOME_POST_IMPORT_STEP = '(\d+)';/.exec(mount)?.[1];
    expect(fallback).toBe(String(stepIndexOf('privacy')));
  });

  it('never resumes past the last step', () => {
    expect(stepAfter(LAST_STEP)).toBe(LAST_STEP);
  });

  it('parses stored steps from storage, localStorage and the hash', () => {
    expect(parseStoredStep(0)).toBe(0);
    expect(parseStoredStep(7)).toBe(7);
    expect(parseStoredStep('3')).toBe(3);
  });

  it('rejects values outside the step table', () => {
    for (const value of [-1, 8, 2.5, Number.NaN, '', 'x', null, undefined, {}]) {
      expect(parseStoredStep(value)).toBeNull();
    }
  });
});

describe('theme step options', () => {
  const themesOf = (id: 'colourful' | 'monochrome') =>
    THEME_GROUPS.find((group) => group.id === id)?.themes ?? [];

  it('offers Default then the standard themes, Harbour included, as Colourful', () => {
    const [first, ...rest] = themesOf('colourful');
    expect(first?.id).toBe('default');
    expect(rest).toHaveLength(8);
    expect(rest.every((theme) => theme.collection === 'standard')).toBe(true);
    expect(rest.map((theme) => theme.id)).toContain('standard-harbour');
  });

  it('offers the seven monochrome themes as Monochrome', () => {
    const themes = themesOf('monochrome');
    expect(themes).toHaveLength(7);
    expect(themes.every((theme) => theme.collection === 'monochrome')).toBe(true);
  });

  it('opens on the collection holding the selected theme, resolving aliases', () => {
    expect(themeGroupOf(undefined)).toBe('colourful');
    expect(themeGroupOf('standard-harbour')).toBe('colourful');
    expect(themeGroupOf('monochrome-teal')).toBe('monochrome');
    // A legacy id resolves to its monochrome theme; an unknown one to Default.
    expect(themeGroupOf('teal')).toBe('monochrome');
    expect(themeGroupOf('deleted-theme')).toBe('colourful');
  });

  it('previews each card in its own theme scope and the dialog scheme', () => {
    const [first, second] = themeOptions(THEME_GROUPS[0].themes.slice(0, 2), 'dark');
    expect([first?.id, second?.id]).toEqual(['default', 'standard-harbour']);
    const markup = renderToStaticMarkup(second?.preview);
    expect(markup).toContain('data-muxui-theme="standard-harbour"');
    expect(markup).toContain('data-muxui-color-scheme="dark"');
    expect(markup).toContain('aria-hidden="true"');
  });
});

describe('a theme pick in flight', () => {
  const pick = (workspaceId: string, themeId: string) => ({ workspaceId, themeId });

  it('shows only for the workspace it was written to', () => {
    const pending = pick('a', 'standard-blueprint');
    expect(pendingThemeView({ pending, activeWorkspaceId: 'a', storedThemeId: undefined })).toEqual(
      { themeId: 'standard-blueprint', settled: false },
    );
    // B is Default too; A's pick must not show there, and is done with.
    expect(pendingThemeView({ pending, activeWorkspaceId: 'b', storedThemeId: undefined })).toEqual(
      { themeId: 'default', settled: true },
    );
  });

  it('survives the acknowledgement of an older pick', () => {
    const pending = pick('a', 'standard-wildflower');
    expect(
      pendingThemeView({ pending, activeWorkspaceId: 'a', storedThemeId: 'standard-blueprint' }),
    ).toEqual({ themeId: 'standard-wildflower', settled: false });
  });

  it('is settled by the acknowledgement of the latest pick', () => {
    expect(
      pendingThemeView({
        pending: pick('a', 'standard-wildflower'),
        activeWorkspaceId: 'a',
        storedThemeId: 'standard-wildflower',
      }),
    ).toEqual({ themeId: 'standard-wildflower', settled: true });
  });

  it('settles on the resolved stored id: unset or unknown is Default, a legacy id its theme', () => {
    const view = (themeId: string, storedThemeId: string | undefined) =>
      pendingThemeView({ pending: pick('a', themeId), activeWorkspaceId: 'a', storedThemeId });
    expect(view('default', undefined)).toEqual({ themeId: 'default', settled: true });
    expect(view('default', 'deleted-theme')).toEqual({ themeId: 'default', settled: true });
    expect(view('monochrome-teal', 'teal')).toEqual({ themeId: 'monochrome-teal', settled: true });
  });
});

describe('searchEngineName', () => {
  const loaded = [{ id: 'ddg', name: 'DuckDuckGo (Private)', isDefault: true }];

  it('prefers the loaded engine list', () => {
    expect(searchEngineName(loaded, 'ddg')).toBe('DuckDuckGo (Private)');
  });

  it('names a default engine before the list loads, and falls back to the id', () => {
    expect(searchEngineName([], 'ddg')).toBe('DuckDuckGo');
    expect(searchEngineName([], 'custom-engine')).toBe('custom-engine');
    expect(searchEngineName([], 'constructor')).toBe('constructor');
  });
});

describe('searchEngineOptions', () => {
  const engines = [
    { id: 'ddg', name: 'DuckDuckGo', isDefault: true, iconUrl: 'data:image/png;base64,ddg' },
    { id: 'kagi', name: 'Kagi', isDefault: false },
  ];

  it('keeps each engine in order, tagging privacy-oriented ones', () => {
    expect(searchEngineOptions(engines).map(({ id, label, tag }) => ({ id, label, tag }))).toEqual([
      { id: 'ddg', label: 'DuckDuckGo', tag: 'Private' },
      { id: 'kagi', label: 'Kagi', tag: undefined },
    ]);
  });

  it('shows the engine icon as a decorative image, else a search glyph', () => {
    const [withIcon, withoutIcon] = searchEngineOptions(engines).map((option) =>
      renderToStaticMarkup(option.icon),
    );
    expect(withIcon).toMatch(/<img[^>]* src="data:image\/png;base64,ddg"/);
    expect(withIcon).toContain('alt=""');
    expect(withoutIcon).not.toContain('<img');
    expect(withoutIcon).toContain('lucide-search');
    expect(withoutIcon).toContain('aria-hidden="true"');
  });
});
