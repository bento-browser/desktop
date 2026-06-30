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
      topSites: {
        get: vi.fn(async () => [
          {
            url: 'https://example.com/top',
            title: 'Top site',
            favicon: 'data:image/png;base64,abc',
          },
          {
            url: 'https://example.com/untitled-top',
          },
        ]),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns new-tab top sites for an empty query', async () => {
    const results = await searchAddressResults('', 8);

    expect(browser.topSites.get).toHaveBeenCalledWith({
      newtab: true,
      limit: 8,
      includeFavicon: true,
    });
    expect(browser.history.search).not.toHaveBeenCalled();
    expect(browser.bookmarks.search).not.toHaveBeenCalled();
    expect(results).toEqual([
      expect.objectContaining({
        kind: 'topSite',
        url: 'https://example.com/top',
        title: 'Top site',
        favIconUrl: 'data:image/png;base64,abc',
      }),
      expect.objectContaining({
        kind: 'topSite',
        url: 'https://example.com/untitled-top',
        title: 'https://example.com/untitled-top',
      }),
    ]);
  });

  it('falls back to recent history when top sites are unavailable', async () => {
    vi.mocked(browser.topSites.get).mockRejectedValueOnce(new Error('unavailable'));

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
