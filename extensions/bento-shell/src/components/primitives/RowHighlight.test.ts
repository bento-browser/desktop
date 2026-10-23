import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('RowHighlight.css', () => {
  it('anchors the slab at the physical left edge, where the hook measures from', () => {
    // useRowHighlight writes physical offsets (offsetLeft), so a logical inline-start anchor
    // would put the slab at the right edge in RTL, shifted by the row's offset.
    const css = readFileSync(new URL('./RowHighlight.css', import.meta.url), 'utf8');
    const slab = /\.bento-row-highlight::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(slab).toMatch(/\bleft:\s*0\b/);
    expect(slab).not.toMatch(/inset-inline-start/);
    expect(slab).toMatch(/translate\(var\(--bento-row-highlight-x/);
  });
});
