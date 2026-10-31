import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MUX_UNUSED_COMPONENT_CLASSES,
  pruneCssFamilies,
  pruneMuxCssInBundle,
} from './mux-css-prune';

const prune = (css: string, ...families: string[]) => pruneCssFamilies(css, families);

describe('pruneCssFamilies', () => {
  it('removes rules that need a pruned class, in compound and descendant selectors', () => {
    const css =
      '.muxui-switch{a:1}.muxui-switch[data-selected]{a:2}.x .muxui-switch-field__label{a:3}.keep{a:4}';
    expect(prune(css, 'muxui-switch')).toBe('.keep{a:4}');
  });

  it('covers parts and modifiers of a family but not a longer name', () => {
    const css =
      '.muxui-radio-group{a:1}.muxui-radio--lg{a:2}.muxui-radio_x{a:3}.muxui-radiology{a:4}';
    expect(prune(css, 'muxui-radio')).toBe('.muxui-radiology{a:4}');
  });

  it('narrows a selector list to its remaining alternatives', () => {
    expect(prune('.muxui-tree,.keep .muxui-button{a:1}', 'muxui-tree')).toBe(
      '.keep .muxui-button{a:1}',
    );
  });

  it('keeps rules where the class is optional or negated', () => {
    const css =
      ':is(.muxui-tree,.keep) .x{a:1}:not(.muxui-tree){a:2}:where(.muxui-tree,.k){a:3}[data-x=".muxui-tree"]{a:4}';
    expect(prune(css, 'muxui-tree')).toBe(css);
  });

  it('recurses into grouping at-rules and drops the ones it empties', () => {
    const css =
      '@layer muxui,bento;@layer muxui{.muxui-tree{a:1}.keep{a:2}}@media (x){.muxui-tree{a:1}}' +
      '@scope ([data-a]) to ([data-b]){.muxui-tree{a:1}}@supports (y){.k{a:1}}';
    expect(prune(css, 'muxui-tree')).toBe(
      '@layer muxui,bento;@layer muxui{.keep{a:2}}@supports (y){.k{a:1}}',
    );
  });

  it('keeps the layer name of a layer block it empties', () => {
    expect(prune('@layer a,b;@layer b{.muxui-tree{a:1}}.k{a:2}', 'muxui-tree')).toBe(
      '@layer a,b;@layer b;.k{a:2}',
    );
  });

  it('leaves other at-rules and rules with nested rules alone', () => {
    const css =
      '@font-face{font-family:x;src:url(./a.woff2)}@keyframes k{from{a:1}to{a:2}}.muxui-tree{.x{a:1}}';
    expect(prune(css, 'muxui-tree')).toBe(css);
  });

  it('does nothing without families', () => {
    expect(pruneCssFamilies('.muxui-tree{a:1}', [])).toBe('.muxui-tree{a:1}');
  });
});

describe('pruneMuxCssInBundle', () => {
  const bundleWith = (js: string, css: string, html = '') => ({
    'assets/shell.js': { type: 'chunk', fileName: 'assets/shell.js', code: js },
    'assets/style.css': { type: 'asset', fileName: 'assets/style.css', source: css },
    'index.html': { type: 'asset', fileName: 'index.html', source: html },
  });
  const css = '.muxui-tree{a:1}.muxui-switch{a:2}.muxui-button{a:3}';
  const sourceOf = (bundle: ReturnType<typeof bundleWith>) => bundle['assets/style.css'].source;

  it('prunes families the bundle never names', () => {
    const bundle = bundleWith('cx("muxui-button")', css);
    const removed = pruneMuxCssInBundle(bundle, ['muxui-tree', 'muxui-switch']);
    expect(removed).toEqual(['muxui-tree', 'muxui-switch']);
    expect(sourceOf(bundle)).toBe('.muxui-button{a:3}');
  });

  it('keeps a family a script names, including a built-name prefix', () => {
    const bundle = bundleWith('cx("muxui-tree", `muxui-switch--${size}`)', css);
    expect(pruneMuxCssInBundle(bundle, ['muxui-tree', 'muxui-switch'])).toEqual([]);
    expect(sourceOf(bundle)).toBe(css);
  });

  it('counts a class in an HTML page as use', () => {
    const bundle = bundleWith('', css, '<div class="muxui-tree"></div>');
    expect(pruneMuxCssInBundle(bundle, ['muxui-tree', 'muxui-switch'])).toEqual(['muxui-switch']);
    expect(sourceOf(bundle)).toBe('.muxui-tree{a:1}.muxui-button{a:3}');
  });

  it('fails when a class a script builds at runtime would lose its rules', () => {
    // The script names only the prefix 'muxui-tree-', which may build 'muxui-tree-item'.
    const bundle = bundleWith('cx(`muxui-tree-${kind}`)', '.muxui-tree-item{a:1}.k{a:2}');
    expect(() => pruneMuxCssInBundle(bundle, ['muxui-tree-item'])).toThrow(
      /uses 'muxui-tree-'.*Remove its family/,
    );
    expect(sourceOf(bundle)).toBe('.muxui-tree-item{a:1}.k{a:2}');
  });
});

describe('MUX_UNUSED_COMPONENT_CLASSES', () => {
  const stylesheet = readFileSync(
    createRequire(import.meta.url).resolve('@muxui/react/styles.css'),
    'utf8',
  );
  const classes = new Set([...stylesheet.matchAll(/\.(muxui-[\w-]+)/g)].map((match) => match[1]!));

  it('names families the public stylesheet defines', () => {
    for (const family of MUX_UNUSED_COMPONENT_CLASSES) {
      expect([...classes].some((name) => name === family || name.startsWith(`${family}-`) || name.startsWith(`${family}_`)), family).toBe(
        true,
      );
    }
  });

  it('removes a large share of the package stylesheet without unbalancing it', () => {
    const pruned = pruneCssFamilies(stylesheet, MUX_UNUSED_COMPONENT_CLASSES);
    expect(pruned.length).toBeLessThan(stylesheet.length * 0.85);
    expect(pruned.split('{').length).toBe(pruned.split('}').length);
    expect(pruned).toContain('.muxui-button');
    expect(stylesheet).toMatch(/^\.muxui-multi-select\s*\{/m);
    expect(pruned).not.toMatch(/^\.muxui-multi-select\s*\{/m);
  });
});
