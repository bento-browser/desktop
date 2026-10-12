import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { checkLinks, extractLinks, headingAnchors, slugify } from './check-doc-links.mjs';

test('slugify follows the GitHub heading rules', () => {
  assert.equal(slugify('Shell to chrome bridge'), 'shell-to-chrome-bridge');
  assert.equal(slugify('Panel widgets, saved panels, and pinned panels'), 'panel-widgets-saved-panels-and-pinned-panels');
  assert.equal(slugify('Use `moveBefore` for [links](x.md)'), 'use-movebefore-for-links');
  assert.equal(slugify('snake_case and a/b'), 'snake_case-and-ab');
});

test('headingAnchors numbers repeated headings and skips fenced code', () => {
  const text = ['# Doc', '## Pitfalls', '## Pitfalls', '```', '## Not a heading', '```', '### Tail'].join('\n');
  assert.deepEqual([...headingAnchors(text)], ['doc', 'pitfalls', 'pitfalls-1', 'tail']);
});

test('extractLinks ignores code spans and fences and reads reference definitions', () => {
  const text = [
    'See [a](a.md#x) and `[b](b.md)` here.',
    '```',
    '[c](c.md)',
    '```',
    '[ref]: d.md#y',
  ].join('\n');
  assert.deepEqual(extractLinks(text), [
    { target: 'a.md#x', line: 1 },
    { target: 'd.md#y', line: 5 },
  ]);
});

test('checkLinks reports missing files and anchors, and accepts good links', () => {
  const root = mkdtempSync(join(tmpdir(), 'doc-links-'));
  try {
    mkdirSync(join(root, 'docs'));
    writeFileSync(join(root, 'docs', 'topic.md'), '# Topic\n\n## Real section\n');
    const index = join(root, 'docs', 'index.md');
    writeFileSync(
      index,
      [
        '[ok](topic.md#real-section) [file](topic.md) [self](#index) [web](https://example.com/#x)',
        '[no file](missing.md) [no anchor](topic.md#nope) [no self](#gone)',
        '# Index',
      ].join('\n'),
    );
    const errors = checkLinks([index], root);
    assert.equal(errors.length, 3);
    assert.match(errors[0], /docs\/index\.md:2: broken link, no such path: missing\.md/);
    assert.match(errors[1], /broken anchor #nope in docs\/topic\.md/);
    assert.match(errors[2], /broken anchor #gone in docs\/index\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
