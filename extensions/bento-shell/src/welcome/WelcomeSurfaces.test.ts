// The step index is a persisted contract: 'bento-welcome-step', the
// #bentoWelcomeStep hash chrome stamps after a profile migration, and the next
// step in BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts> all carry it.

import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { WELCOME_CLOSE_PREFIX, WELCOME_OPEN_SETTINGS_PREFIX } from '../bridge/useWelcome';
import {
  finishOnboarding,
  restartsOnboarding,
  LAST_STEP,
  parseStoredStep,
  pendingThemeView,
  searchEngineOptions,
  startImport,
  stepAfter,
  stepIndexOf,
  ThemeChooser,
  THEME_GROUPS,
  WELCOME_STEPS,
} from './WelcomeSurfaces';
import { nextPreview, requestedTheme, swatchThemeId } from './themeChooser';

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

describe('theme step swatch rows', () => {
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

  it('selects the theme in the row that holds it and previews it in its own scope', () => {
    // The two rows are separate groups: only one of them gets the selected id.
    const markup = renderToStaticMarkup(
      createElement(ThemeChooser, { value: 'standard-harbour', onChange() {} }),
    );
    const checked = [
      ...markup.matchAll(/<button[^>]*aria-label="([^"]+)"[^>]*aria-checked="true"/g),
    ];
    expect(checked.map((match) => match[1])).toEqual(['Harbour']);
    // Every swatch (and nothing else) carries data-theme-swatch, which the hover lookup reads.
    expect([...markup.matchAll(/data-theme-swatch="/g)]).toHaveLength(16);
    expect(markup).toContain('aria-label="Colourful themes"');
    expect(markup).toContain('aria-label="Monochrome themes"');
    expect(markup).toMatch(/aria-hidden="true"[^>]*data-muxui-theme="standard-harbour"/);
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

describe('theme chooser pointer, focus and selection rules', () => {
  // A tiny element tree whose closest() matches a bare [attribute] selector, like the DOM's.
  interface FakeNode {
    closest(selector: string): FakeNode | null;
    getAttribute(name: string): string | null;
  }
  const node = (attributes: Record<string, string>, parent?: FakeNode): FakeNode => {
    const self: FakeNode = {
      getAttribute: (name) => attributes[name] ?? null,
      closest(selector) {
        const name = /^\[([^\]=]+)\]$/.exec(selector)?.[1] ?? '';
        return name in attributes ? self : (parent?.closest(selector) ?? null);
      },
    };
    return self;
  };
  const html = node({ 'data-theme': 'light' });
  const row = node({}, node({}, html));

  it('reads a swatch, or a shape inside it, but not whitespace under the html data-theme', () => {
    const swatch = node({ 'data-theme-swatch': 'standard-fern' }, row);
    expect(swatchThemeId(swatch)).toBe('standard-fern');
    expect(swatchThemeId(node({}, swatch))).toBe('standard-fern');
    expect(swatchThemeId(row)).toBeNull();
  });

  it('ends the override when the pointer moves from a swatch to whitespace', () => {
    let preview = nextPreview('monochrome-teal', { type: 'point', swatch: 'standard-fern' });
    expect(preview).toBe('standard-fern');
    preview = nextPreview(preview, { type: 'point', swatch: null });
    expect(preview).toBeNull();
  });

  it('shows the selected theme after a swatch is activated, not the last hovered one', () => {
    expect(nextPreview('standard-fern', { type: 'select' })).toBeNull();
  });

  it('writes a theme only when the event names a different one', () => {
    expect(requestedTheme('standard-harbour', 'default')).toBe('standard-harbour');
    expect(requestedTheme('standard-harbour', 'standard-harbour')).toBeNull();
    expect(requestedTheme(undefined, 'default')).toBeNull();
  });
});

describe('restarting onboarding', () => {
  it('restarts only when welcomeSeen goes from true back to false', () => {
    expect(restartsOnboarding(true, false)).toBe(true);
    expect(restartsOnboarding(undefined, false)).toBe(false);
    expect(restartsOnboarding(false, false)).toBe(false);
    expect(restartsOnboarding(false, true)).toBe(false);
    expect(restartsOnboarding(true, true)).toBe(false);
    expect(restartsOnboarding(true, undefined)).toBe(false);
  });
});

describe('finishing onboarding', () => {
  const finish = (prefix: string) => {
    const log: string[] = [];
    finishOnboarding(prefix, {
      clearStep: () => log.push('clear step'),
      markSeen: () => log.push('welcomeSeen'),
      send: (title) => log.push(title),
    });
    return log;
  };

  it('persists the dismissal, then sends the close title only, for Start browsing', () => {
    expect(finish(WELCOME_CLOSE_PREFIX)).toEqual([
      'clear step',
      'welcomeSeen',
      expect.stringMatching(/^BENTO_CLOSE_WELCOME_\d+$/),
    ]);
  });

  it('persists the dismissal, then sends the open-Settings title only, for Open Settings', () => {
    expect(finish(WELCOME_OPEN_SETTINGS_PREFIX)).toEqual([
      'clear step',
      'welcomeSeen',
      expect.stringMatching(/^BENTO_OPEN_SETTINGS_\d+$/),
    ]);
  });

  it('is answered by the mount script: its welcome frame hides the overlay and opens Settings', () => {
    const mount = readFileSync(
      new URL('../../../../src/browser/base/content/bento-shell-mount.js', import.meta.url),
      'utf8',
    );
    expect(mount).toContain(`const SETTINGS_OPEN_PREFIX = '${WELCOME_OPEN_SETTINGS_PREFIX}_';`);
    const start = mount.search(/'bento-welcome-frame',\s*\(title\) => \{/);
    expect(start).toBeGreaterThan(-1);
    // Line comments are dropped first, so the pattern below needs no nested repetition.
    const handler = mount
      .slice(start, mount.indexOf("'bento-embedded-import-frame',", start))
      .replace(/\/\/[^\n]*/g, '');
    // Only a showing dialog opens Settings, so a double click during the fade adds no second tab.
    expect(handler).toMatch(
      /startsWith\(SETTINGS_OPEN_PREFIX\)\) \{\s*const host = document\.getElementById\('bento-welcome-host'\);\s*if \(host && isWelcomeShowing\(host\)\) \{\s*hideWelcome\(\);\s*void openBentoSettings\(false\);/,
    );
    expect(mount).toMatch(
      /function isWelcomeShowing\(host\) \{\s*return isWelcomeVisible\(host\) && host\.style\.opacity !== '0';/,
    );
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
