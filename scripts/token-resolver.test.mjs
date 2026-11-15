import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectRules,
  createShellPxResolver,
  createTokenResolver,
  rootSpecificity,
} from './token-resolver.mjs';

const ROOT = { 'data-bento-theme': 'fern', 'data-color-mode': 'dark' };

test('selectors match a root by its attributes, with their specificity', () => {
  assert.deepEqual(rootSpecificity(':root', ROOT), [0, 1, 0]);
  assert.deepEqual(rootSpecificity('html', ROOT), [0, 0, 1]);
  assert.deepEqual(
    rootSpecificity("[data-bento-theme='fern'][data-color-mode='dark']", ROOT),
    [0, 2, 0],
  );
  assert.equal(rootSpecificity("[data-bento-theme='lagoon']", ROOT), null);
  assert.equal(rootSpecificity('[data-bento-contrast]', ROOT), null);
  // :not() counts its argument whether or not it matches; :where() counts nothing.
  assert.deepEqual(rootSpecificity(":not([data-color-mode='light'])", ROOT), [0, 1, 0]);
  assert.equal(rootSpecificity(":not([data-color-mode='dark'])", ROOT), null);
  assert.deepEqual(rootSpecificity(':is([data-x], [data-bento-theme])', ROOT), [0, 1, 0]);
  assert.deepEqual(rootSpecificity(':where([data-bento-theme])', ROOT), [0, 0, 0]);
  // The best-matching selector of a list; a root never matches a combinator or a class.
  assert.deepEqual(rootSpecificity(".x, :root, [data-bento-theme='fern']:root", ROOT), [0, 2, 0]);
  assert.equal(rootSpecificity(':root .x', ROOT), null);
  assert.equal(rootSpecificity('::selection', ROOT), null);
});

test('collectRules reads custom properties, importance and @layer blocks', () => {
  const rules = collectRules(`
    /* comment { } */
    @layer a, b;
    :root { --a: 1px; color: red; --b: var(--a)  !important; }
    @layer bento.tokens { :root { --c: calc( 1px +
      2px ); } }
    @media (x) { :root { --skipped: 1; } }
  `);
  assert.deepEqual(
    rules.map(({ selector, layered, declarations }) => [selector, layered, declarations]),
    [
      [
        ':root',
        false,
        [
          { name: '--a', value: '1px', important: false },
          { name: '--b', value: 'var(--a)', important: true },
        ],
      ],
      [':root', true, [{ name: '--c', value: 'calc(1px + 2px)', important: false }]],
    ],
  );
});

test('the cascade picks importance, then unlayered, then specificity, then order', () => {
  const css = `
    @layer l { [data-bento-theme='fern'][data-color-mode='dark'] { --a: layered; --d: layered; } }
    [data-color-mode='dark'] { --a: mode; --b: mode; --d: unlayered; }
    [data-bento-theme='fern'][data-color-mode='dark'] { --b: theme-mode; }
    :root { --b: root; --c: first; }
    :root { --c: second; }
    [data-color-mode='light'] { --c: light; }
    :root { --e: important !important; }
    [data-bento-theme='fern'][data-color-mode='dark'] { --e: specific; }
  `;
  const { resolve } = createTokenResolver(css, { attributes: ROOT });
  assert.equal(resolve('--a'), 'mode');
  assert.equal(resolve('--b'), 'theme-mode');
  assert.equal(resolve('--c'), 'second');
  assert.equal(resolve('--d'), 'unlayered');
  assert.equal(resolve('--e'), 'important');
});

test('var() is followed per root, with fallbacks, and failures name the token', () => {
  const css = `
    :root { --ref-5: #fff; --surface: var(--ref-5); --mix: color-mix(in srgb, var(--surface) 50%, var(--missing, var(--ref-5))); }
    [data-color-mode='dark'] { --ref-5: #000; }
    :root { --loop-a: var(--loop-b); --loop-b: var(--loop-a); --broken: var(--nowhere); }
  `;
  const dark = createTokenResolver(css, { attributes: ROOT });
  const light = createTokenResolver(css, { attributes: { 'data-color-mode': 'light' } });
  assert.equal(dark.resolve('--surface'), '#000');
  assert.equal(light.resolve('--surface'), '#fff');
  assert.equal(dark.resolve('--mix'), 'color-mix(in srgb, #000 50%, #000)');
  assert.throws(() => dark.resolve('--loop-a'), /refers to itself/);
  assert.throws(() => dark.resolve('--broken'), /--nowhere is not declared/);
  assert.throws(() => dark.resolve('--absent'), /--absent is not declared/);
});

test('the shell px resolver keeps its rules: one value, no fallback, rem in px', () => {
  const css = `
    :root { --font-size-root: 16px; --gap: 0.5rem; --width: calc(var(--gap) * 2); }
    [data-color-mode='dark'] { --gap: 0.5rem; }
    :root { --two: 1px; } [data-x] { --two: 2px; }
    :root { --fallback: var(--gap, 1px); }
  `;
  const { rootPx, resolve } = createShellPxResolver(css);
  assert.equal(rootPx, 16);
  assert.equal(resolve('--width'), 'calc(8px * 2)');
  assert.throws(() => resolve('--two'), /declared with different values/);
  assert.throws(() => resolve('--fallback'), /has a var\(\) fallback/);
  assert.throws(() => resolve('--absent'), /not declared/);
});
