import { describe, expect, it } from 'vitest';
import { normalizeExternalUrl } from './urlNormalization';

describe('external merge URL normalization', () => {
  it('normalizes protocol, host, and default ports while preserving path query and hash', () => {
    expect(normalizeExternalUrl('HTTP://EXAMPLE.COM:80/Path?q=One#Hash')).toBe(
      'http://example.com/Path?q=One#Hash',
    );
    expect(normalizeExternalUrl('https://Example.com:443/a')).toBe('https://example.com/a');
    expect(normalizeExternalUrl('\u0000HTTPS://Example.com/a\u001f')).toBe('https://example.com/a');
  });

  it('maps source new-tab URLs and skips unsupported schemes', () => {
    expect(normalizeExternalUrl('chrome://newtab/', 'chrome')).toBe('about:newtab');
    expect(normalizeExternalUrl('edge://newtab/', 'edge')).toBe('about:newtab');
    expect(normalizeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeExternalUrl('data:text/plain,hi')).toBeNull();
    expect(normalizeExternalUrl('about:blank')).toBeNull();
  });
});
