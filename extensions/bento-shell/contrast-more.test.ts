import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import {
  dropContrastMoreSelectors,
  selectorRequiresContrastMore,
  stripContrastMore,
} from './contrast-more.mjs';

describe('selectorRequiresContrastMore', () => {
  it.each([
    "[data-muxui-contrast='more']",
    '[data-muxui-contrast=more]',
    '[ data-muxui-contrast = "more" i ]',
    "[data-muxui-theme='x']:not([data-muxui-color-scheme='dark'])[data-muxui-contrast='more']",
    ".a [data-muxui-contrast='more'] .b",
  ])('matches %s', (selector) => {
    expect(selectorRequiresContrastMore(selector)).toBe(true);
  });

  it.each([
    "[data-muxui-contrast='standard']",
    '[data-muxui-contrast]',
    "[data-muxui-theme='x']:not([data-muxui-contrast='more'])",
    ":is([data-muxui-contrast='more'], .x)",
    "[data-other='[data-muxui-contrast=more]']",
  ])('keeps %s', (selector) => {
    expect(selectorRequiresContrastMore(selector)).toBe(false);
  });
});

describe('dropContrastMoreSelectors', () => {
  it('filters only the contrast alternatives of a list', () => {
    expect(dropContrastMoreSelectors(".a, [data-muxui-contrast='more'] .b, :is(.c, .d)")).toBe(
      '.a, :is(.c, .d)',
    );
    expect(dropContrastMoreSelectors("[data-muxui-contrast='more']")).toBe('');
    expect(dropContrastMoreSelectors('.a, .b')).toBe('.a, .b');
  });
});

const strip = async (css: string) =>
  (await postcss([stripContrastMore]).process(css, { from: undefined })).css;

/** Layer names in first-appearance order, which is the cascade order between layers. */
const layerOrder = (css: string) => [
  ...new Set([...css.matchAll(/@layer\s+([\w.-]+)/g)].map((match) => match[1])),
];

describe('stripContrastMore plugin', () => {
  it('keeps layer registration when a layer block empties', async () => {
    // Without the first @layer block, 'second' registers first and '.x' turns blue.
    const input = `@layer first { [data-muxui-contrast='more'] { color: red; } }
      @layer second { .x { color: red; } }
      @layer first { .x { color: blue; } }`;
    const css = await strip(input);
    expect(layerOrder(css)).toEqual(['first', 'second']);
    expect(css).toMatch(/@layer first;\s*@layer second \{/);
    expect(css).not.toContain('contrast');
  });

  it('removes unreachable rules and the at-rules they leave empty', async () => {
    const input = `
      @layer muxui {
        [data-muxui-contrast='standard'] { --x: 1; }
        [data-muxui-contrast='more'] { --x: 2; }
        .a, [data-muxui-contrast='more'] .a { color: red; }
      }
      @media (min-width: 1px) { [data-muxui-contrast='more'] .b { color: blue; } }
      @layer bento.fonts {}
      [data-muxui-theme='t']:not([data-muxui-contrast='more']) { --y: 1; }
    `;
    const { css } = await postcss([stripContrastMore]).process(input, { from: undefined });
    expect(css).not.toMatch(/--x: 2|color: blue|@media/);
    expect(css).toContain("[data-muxui-contrast='standard'] { --x: 1; }");
    expect(css).toMatch(/\.a\s*\{\s*color: red;/);
    expect(css).toContain('@layer bento.fonts {}');
    expect(css).toContain(":not([data-muxui-contrast='more'])");
  });
});
