import { describe, expect, it } from 'vitest';

import { replaceSelectionWithSafePaste, stripUnsafeProtocolOnPaste } from './unsafeProtocol';

describe('stripUnsafeProtocolOnPaste', () => {
  it.each([
    ['javascript:alert(1)', 'alert(1)'],
    ['JaVaScRiPt:alert(1)', 'alert(1)'],
    ['\u0000\t javascript:alert(1)', 'alert(1)'],
    ['javascript:javascript:alert(1)', 'alert(1)'],
  ])('strips unsafe script schemes from %j', (input, expected) => {
    expect(stripUnsafeProtocolOnPaste(input)).toBe(expected);
  });

  it.each(['https://example.com/', 'data:text/plain,hello', 'example.com', 'search words'])(
    'preserves safe input %j',
    (input) => {
      expect(stripUnsafeProtocolOnPaste(input)).toBe(input);
    },
  );

  it('replaces only the selected input range', () => {
    expect(replaceSelectionWithSafePaste('before after', 7, 12, 'javascript:alert(1)')).toEqual({
      value: 'before alert(1)',
      cursor: 15,
      changed: true,
    });
  });
});
