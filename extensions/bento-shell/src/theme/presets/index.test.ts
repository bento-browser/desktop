import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { BENTO_THEMES, DEFAULT_THEME_ID, getThemeMeta, resolveThemeId } from './index';
import { getThemeScopeAttributes } from '../themeScope';

const generatedThemeCss = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

describe('workspace theme presets', () => {
  it('includes the complete canonical Mux standard and monochromatic collections', () => {
    expect(BENTO_THEMES.filter((theme) => theme.collection === 'standard')).toHaveLength(8);
    expect(BENTO_THEMES.filter((theme) => theme.collection === 'monochrome')).toHaveLength(7);
  });

  it('keeps standard and monochromatic Terracotta distinct', () => {
    expect(getThemeMeta('standard-terracotta').brand60).toBe('#9b3f35');
    expect(getThemeMeta('monochrome-terracotta').brand60).toBe('#a64300');
  });

  it('resolves legacy workspace theme ids to the monochromatic collection', () => {
    expect(getThemeMeta('antique').id).toBe('monochrome-antique');
    expect(getThemeMeta('terracotta').id).toBe('monochrome-terracotta');
  });

  it('keeps Bento Default as the measured baseline presentation', () => {
    expect(resolveThemeId(undefined)).toBe(DEFAULT_THEME_ID);
    expect(resolveThemeId('default')).toBe(DEFAULT_THEME_ID);
    expect(getThemeMeta(DEFAULT_THEME_ID).id).not.toBe('standard-harbour');
    expect(getThemeMeta(DEFAULT_THEME_ID).neutral20).toBe('#e5e1dd');
    expect(getThemeMeta('standard-harbour').id).toBe('standard-harbour');
  });

  it('fails closed to Default for deleted or unknown presentation ids', () => {
    expect(resolveThemeId('deleted-theme')).toBe(DEFAULT_THEME_ID);
    expect(resolveThemeId('')).toBe(DEFAULT_THEME_ID);
    expect(getThemeMeta('deleted-theme').id).toBe(DEFAULT_THEME_ID);
  });

  it('keeps legacy storage aliases separate from canonical presentation ids', () => {
    expect(resolveThemeId('teal')).toBe('monochrome-teal');
    expect(getThemeMeta('teal').id).toBe('monochrome-teal');
    expect('teal').not.toBe(resolveThemeId('teal'));
  });

  it('applies a complete scoped attribute closure to nested themed elements', () => {
    expect(getThemeScopeAttributes('teal', 'dark')).toEqual({
      'data-bento-theme': 'monochrome-teal',
      'data-muxui-theme': 'monochrome-teal',
      'data-muxui-color-scheme': 'dark',
      'data-muxui-contrast': 'standard',
    });
    expect(getThemeScopeAttributes('unknown', 'light')['data-muxui-theme']).toBe(DEFAULT_THEME_ID);
  });

  it('projects the public Mux root, modes, contrast closure, and effects for custom-compatible CSS', () => {
    expect(generatedThemeCss).toContain("[data-muxui-theme='default'] {");
    expect(generatedThemeCss).toContain(
      "[data-muxui-theme='default'][data-muxui-color-scheme='light'] {",
    );
    expect(generatedThemeCss).toContain(
      "[data-muxui-theme='default'][data-muxui-color-scheme='dark'] {",
    );
    expect(generatedThemeCss).toContain(
      "[data-muxui-theme='default'][data-muxui-contrast='standard'] {",
    );
    expect(generatedThemeCss).toContain(
      "[data-muxui-theme='default'][data-muxui-contrast='more'] {",
    );
    expect(generatedThemeCss).toContain('--muxui-reference-effect-shadow-s:');
    expect(generatedThemeCss).toContain('color-mix(in srgb');
    expect(generatedThemeCss).toContain('--muxui-reference-color-brand-60: var(--brand-60);');
    expect(generatedThemeCss).toContain(
      '--muxui-reference-color-neutral-20: var(--neutral-default-20);',
    );
    expect(generatedThemeCss).toContain('--brand-60: #025768;');
    expect(generatedThemeCss).toContain('--neutral-default-20: #e5e1dd;');
    expect(generatedThemeCss).toContain(
      '--muxui-semantic-color-color-50-fg: var(--muxui-semantic-color-color-5);',
    );
    expect(generatedThemeCss).toContain(
      '--muxui-semantic-color-color-50-fg: var(--muxui-semantic-color-color-100);',
    );
    expect(generatedThemeCss).toContain('--muxui-popup-bg: var(--muxui-semantic-surface-raised);');
    expect(generatedThemeCss).not.toContain(
      '--muxui-semantic-color-neutral-20: var(--neutral-default-20);',
    );
  });

  it('keeps nested Default and unknown scopes independent from canonical parent scopes', () => {
    const parent = getThemeScopeAttributes('standard-harbour', 'dark');
    const childDefault = getThemeScopeAttributes(undefined, 'dark');
    const childUnknown = getThemeScopeAttributes('deleted-theme', 'dark');

    expect(parent['data-muxui-theme']).toBe('standard-harbour');
    expect(childDefault['data-muxui-theme']).toBe(DEFAULT_THEME_ID);
    expect(childUnknown['data-muxui-theme']).toBe(DEFAULT_THEME_ID);
    expect(childDefault['data-bento-theme']).not.toBe(parent['data-bento-theme']);
    expect(childUnknown['data-bento-theme']).not.toBe(parent['data-bento-theme']);
    expect(generatedThemeCss.indexOf('--brand-60: #025768;')).toBeGreaterThan(-1);
    expect(generatedThemeCss.indexOf('--neutral-default-20: #e5e1dd;')).toBeGreaterThan(-1);
  });
});
