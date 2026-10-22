import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { BACK_TO_PALETTE_TITLE_PREFIX, CLOSE_TITLE_PREFIX, titleFor } from './titles';

const mount = readFileSync(
  new URL('../../../../src/browser/base/content/bento-shell-mount.js', import.meta.url),
  'utf8',
);

function mountConstant(name: string): string | undefined {
  return new RegExp(`const ${name} = '([A-Z_]+)';`).exec(mount)?.[1];
}

describe('Settings palette title requests', () => {
  it('match the prefixes the chrome mount script listens for', () => {
    expect(mountConstant('SETTINGS_PALETTE_CLOSE_PREFIX')).toBe(CLOSE_TITLE_PREFIX);
    expect(mountConstant('SETTINGS_BACK_TO_PALETTE_PREFIX')).toBe(BACK_TO_PALETTE_TITLE_PREFIX);
  });

  it('puts a timestamp after the prefix so each request is a new title', () => {
    expect(titleFor(BACK_TO_PALETTE_TITLE_PREFIX)).toMatch(
      new RegExp(`^${BACK_TO_PALETTE_TITLE_PREFIX}_\\d+$`),
    );
  });
});
