import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { CLOSE_TITLE_PREFIX, OPEN_TITLE_PREFIX, titleFor } from './titles';

const mount = readFileSync(
  new URL('../../../../src/browser/base/content/bento-shell-mount.js', import.meta.url),
  'utf8',
);

function mountConstant(name: string): string | undefined {
  return new RegExp(`const ${name} = '([A-Z_]+)';`).exec(mount)?.[1];
}

describe('Bookmarks view title requests', () => {
  it('match the prefixes the chrome mount script listens for', () => {
    expect(mountConstant('BOOKMARKS_OPEN_PREFIX')).toBe(OPEN_TITLE_PREFIX);
    expect(mountConstant('BOOKMARKS_CLOSE_PREFIX')).toBe(CLOSE_TITLE_PREFIX);
  });

  it('puts a timestamp after the prefix so each request is a new title', () => {
    expect(titleFor(CLOSE_TITLE_PREFIX)).toMatch(new RegExp(`^${CLOSE_TITLE_PREFIX}_\\d+$`));
  });
});
