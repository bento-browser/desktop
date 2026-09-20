import assert from 'node:assert/strict';
import test from 'node:test';

import { rewriteThemeSelectors } from './theme-selector.mjs';

test('rewrites light and dark page-root selectors with matching legacy siblings', () => {
  const css = `
:where(html:not([data-color-mode="dark"])) .palette-root, .light .palette-root {
  --color-50-fg: var(--color-5);
}

html[data-color-mode='dark'] .theme-root, .dark .theme-root {
  --color-50-fg: var(--color-100);
}
`;

  assert.equal(
    rewriteThemeSelectors(css, 'violet'),
    `
html[data-bento-theme="violet"]:not([data-color-mode="dark"]) {
  --color-50-fg: var(--color-5);
}

html[data-bento-theme='violet'][data-color-mode='dark'] {
  --color-50-fg: var(--color-100);
}
`,
  );
});

test('rewrites media not-light selectors and top-level roots', () => {
  const css = `
:root {
  --brand-60: #123456;
}

@media (prefers-color-scheme: dark) {
  :where(html:not([data-color-mode='light'])) .palette-root-extra {
    --color-50-fg: var(--color-100);
  }
}
`;

  assert.equal(
    rewriteThemeSelectors(css, 'violet', { attributeQuote: "'" }),
    `
[data-bento-theme='violet'] {
  --brand-60: #123456;
}

@media (prefers-color-scheme: dark) {
  html[data-bento-theme='violet']:not([data-color-mode='light']) {
    --color-50-fg: var(--color-100);
  }
}
`,
  );
});

test('leaves mismatched siblings, extended classes, and unrelated selectors untouched', () => {
  const css = `
:where(html:not([data-color-mode="dark"])) .palette-root, .unrelated {
  --should-stay: true;
}

.unrelated, html[data-color-mode="dark"] .palette-root {
  --should-stay: true;
}

:where(html:not([data-color-mode="dark"])) .palette-root, .light .other-ui {
  --should-stay: true;
}

:where(html:not([data-color-mode="dark"])) .palette-root .child {
  --should-stay: true;
}

section :where(html:not([data-color-mode="dark"])) .palette-root {
  --should-stay: true;
}

.light .palette-root {
  --should-stay: true;
}
`;

  assert.equal(rewriteThemeSelectors(css, 'violet'), css);
});

test('requires exact page-root boundaries and validates arguments', () => {
  assert.throws(() => rewriteThemeSelectors('', 42), TypeError);
  assert.throws(() => rewriteThemeSelectors('', 'violet', { attributeQuote: '`' }), TypeError);

  const css = `
:where(html:not([data-color-mode="dark"])) .palette-root .child {
  --should-stay: true;
}
`;
  assert.equal(rewriteThemeSelectors(css, 'violet'), css);
});
