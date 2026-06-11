import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAddressResults } from './AddressSearch';

describe('searchAddressResults', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      history: {
        search: vi.fn(async () => [
          {
            url: 'https://example.com/recent',
            title: 'Recent page',
            lastVisitTime: Date.now(),
            visitCount: 2,
            typedCount: 1,
          },
          {
            url: 'https://example.com/untitled',
            lastVisitTime: Date.now() - 60_000,
            visitCount: 1,
            typedCount: 0,
          },
        ]),
      },
      bookmarks: {
        search: vi.fn(async () => []),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns recent history for an empty query', async () => {
    const results = await searchAddressResults('', 8);

    expect(browser.history.search).toHaveBeenCalledWith({
      text: '',
      startTime: 0,
      maxResults: 8,
    });
    expect(browser.bookmarks.search).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        kind: 'history',
        url: 'https://example.com/recent',
        title: 'Recent page',
      }),
      expect.objectContaining({
        kind: 'history',
        url: 'https://example.com/untitled',
        title: 'https://example.com/untitled',
      }),
    ]);
  });
});
