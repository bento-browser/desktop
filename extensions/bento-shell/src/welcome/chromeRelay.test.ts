// Which `window` messages the welcome page takes for chrome's.

import { describe, expect, it } from 'vitest';

import { isChromeRelayMessage } from './chromeRelay';

const message = (origin: string) => new MessageEvent('message', { data: {}, origin });

describe('isChromeRelayMessage', () => {
  it('accepts the empty origin of a system-principal frame script', () => {
    expect(isChromeRelayMessage(message(''))).toBe(true);
  });

  it('rejects a message from a page, whatever its origin', () => {
    for (const origin of [
      'moz-extension://ae849d10-8901-40fc-ae2a-9ba2fb557b85',
      'null',
      'https://example.com',
    ]) {
      expect(isChromeRelayMessage(message(origin)), origin).toBe(false);
    }
  });
});
