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

test('heading slugs keep the text inside inline code and other formatting', () => {
  assert.deepEqual([...headingAnchors('## Use `moveBefore` for links\n')], ['use-movebefore-for-links']);
  assert.deepEqual([...headingAnchors('### **Bold** and `code_x` plus [a link](a.md)\n')], [
    'bold-and-code_x-plus-a-link',
  ]);

  const root = mkdtempSync(join(tmpdir(), 'doc-links-'));
  try {
    const file = join(root, 'doc.md');
    writeFileSync(file, '## Use `moveBefore` for links\n\n[ok](#use-movebefore-for-links)\n');
    assert.deepEqual(checkLinks([file], root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('duplicate heading slugs never reuse a slug that was already handed out', () => {
  assert.deepEqual([...headingAnchors('# Foo\n# Foo-1\n# Foo\n# Foo\n')], ['foo', 'foo-1', 'foo-2', 'foo-3']);
  assert.deepEqual([...headingAnchors('# Foo\n# Foo\n# Foo-1\n')], ['foo', 'foo-1', 'foo-1-1']);
});

test('code blocks follow the GFM rules: fences, blockquotes, indentation, lists', () => {
  const targets = (lines) => extractLinks(lines.join('\n')).map((link) => `${link.line}:${link.target}`);

  // Fences inside blockquotes and indented up to 3 columns hide their content.
  assert.deepEqual(targets(['> ```', '> [x](a.md)', '> ```', '[y](b.md)', '   ```', '   [z](c.md)', '   ```', '[w](d.md)']), [
    '4:b.md',
    '8:d.md',
  ]);

  // Four spaces make a line indented code, not a fence, so later links still count.
  assert.deepEqual(targets(['para', '', '    ```', '    [x](a.md)', '', '[y](b.md)']), ['6:b.md']);

  // A closing fence must use the same character and be at least as long.
  assert.deepEqual(targets(['````', '```', '[x](a.md)', '~~~~', '````', '[y](b.md)']), ['6:b.md']);
  assert.deepEqual(targets(['~~~', '```', '[x](a.md)', '```', '~~~', '[y](b.md)']), ['6:b.md']);

  // A backtick fence cannot have backticks in its info string, so this is inline code.
  assert.deepEqual(targets(['```js`x', '[x](a.md)']), ['2:a.md']);

  // Indented code blocks are skipped, including tab-indented ones.
  assert.deepEqual(targets(['text', '', '    [x](a.md)', '', '\t[y](b.md)', '', '[z](c.md)']), ['7:c.md']);

  // An indented line directly after a paragraph is a continuation, so its link counts.
  assert.deepEqual(targets(['text', '    [x](a.md)']), ['2:a.md']);

  // List item content is not code unless indented 4 more columns than the item text.
  assert.deepEqual(targets(['- item', '', '    [x](a.md)', '', '        [y](b.md)', '', '1. one', '', '    [z](c.md)']), [
    '3:a.md',
    '9:c.md',
  ]);

  // A fence indented to its list item closes with the same indentation.
  assert.deepEqual(targets(['- item', '', '  ```', '  [x](a.md)', '  ```', '', '  [y](b.md)', '[z](c.md)']), [
    '7:b.md',
    '8:c.md',
  ]);

  // A fence inside a blockquote ends when the quote does.
  assert.deepEqual(targets(['> ```', '> [x](a.md)', '', '[y](b.md)']), ['4:b.md']);
});
