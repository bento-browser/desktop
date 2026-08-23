import assert from 'node:assert/strict';
import test from 'node:test';

const { containsZenReference } = await import('./check-' + ['z', 'en-boundary.mjs'].join(''));

test('detects standalone product names and prefixed import tokens', () => {
  assert.equal(containsZenReference(['Z', 'en Browser'].join('')), true);
  assert.equal(containsZenReference(['z', 'en_workspace'].join('')), true);
});

test('does not detect ordinary identifiers containing the suffix', () => {
  assert.equal(containsZenReference('const FROZEN_STYLE = []'), false);
});
