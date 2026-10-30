import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAddressResults } from './AddressSearch';
import { eligibleClosedTabs } from './ClosedSessions';

const context = { windowId: 7, incognito: false };
const closed = (sessionId: string, changes = {}) => ({
  lastModified: 1_790_000_000_000,
  tab: {
    sessionId,
    url: 'https://same.example/',
    title: sessionId,
    windowId: 7,
    incognito: false,
    ...changes,
  },
});

describe('address providers', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      sessions: { getRecentlyClosed: vi.fn(async () => [closed('a'), closed('b'), closed('c')]) },
      history: {
        search: vi.fn(async () => [
          {
            url: 'https://recent.example/',
            title: 'Recent',
            lastVisitTime: Date.now(),
            visitCount: 1,
          },
          { url: 'https://popular.example/', lastVisitTime: Date.now() - 60_000, visitCount: 1000 },
        ]),
      },
      bookmarks: { search: vi.fn(async () => []) },
      topSites: {
        get: vi.fn(async () => [
          { url: 'https://top.example/', title: 'Top', favicon: 'icon' },
          { url: 'https://second.example/' },
        ]),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns two rows per group in native order, preserving duplicate session URLs', async () => {
    const results = await searchAddressResults('', 8, context);
    expect(results.map((r) => r.kind)).toEqual([
      'recentlyClosed',
      'recentlyClosed',
      'recentHistory',
      'recentHistory',
      'topSite',
      'topSite',
    ]);
    expect(results.slice(0, 2)).toMatchObject([
      { sessionId: 'a', closedAt: 1_790_000_000_000 },
      { sessionId: 'b' },
    ]);
    expect(results[2]).toMatchObject({
      url: 'https://recent.example/',
      lastVisitTime: expect.any(Number),
    });
    expect(results[3]).toMatchObject({
      url: 'https://popular.example/',
      title: 'https://popular.example/',
    });
    expect(browser.sessions.getRecentlyClosed).toHaveBeenCalledWith({ maxResults: 25 });
    expect(browser.history.search).toHaveBeenCalledWith({ text: '', startTime: 0, maxResults: 2 });
    expect(browser.topSites.get).toHaveBeenCalledWith({
      newtab: true,
      limit: 2,
      includeFavicon: true,
    });
    expect(browser.bookmarks.search).not.toHaveBeenCalled();
  });

  it.each(['history', 'topSites', 'sessions'] as const)('isolates a %s failure', async (source) => {
    const fn =
      source === 'history'
        ? browser.history.search
        : source === 'topSites'
          ? browser.topSites.get
          : browser.sessions.getRecentlyClosed;
    vi.mocked(fn).mockRejectedValueOnce(new Error('unavailable'));
    const results = await searchAddressResults('', 8, context);
    const missing =
      source === 'history' ? 'recentHistory' : source === 'topSites' ? 'topSite' : 'recentlyClosed';
    expect(results).toHaveLength(4);
    expect(results.some((r) => r.kind === missing)).toBe(false);
  });

  it('keeps typed ranking, deduplication and bookmark precedence', async () => {
    vi.mocked(browser.bookmarks.search).mockResolvedValueOnce([
      { id: 'bookmark', url: 'https://popular.example/#anchor', title: 'Saved popular' },
    ]);
    const results = await searchAddressResults('popular', 8, context);
    expect(results[0]).toMatchObject({ kind: 'bookmark', title: 'Saved popular' });
    expect(results).toHaveLength(2);
    expect(browser.sessions.getRecentlyClosed).not.toHaveBeenCalled();
    expect(browser.topSites.get).not.toHaveBeenCalled();
  });

  it('filters windows, private status, missing eligibility and window sessions before capping', async () => {
    vi.mocked(browser.sessions.getRecentlyClosed).mockResolvedValueOnce([
      closed('other-window', { windowId: 8 }),
      closed('private', { incognito: true }),
      closed('unknown-private', { incognito: undefined }),
      { lastModified: 1, window: { sessionId: 'window' } },
      closed('eligible'),
    ] as browser.sessions.Session[]);
    expect((await eligibleClosedTabs(context)).map((s) => s.tab?.sessionId)).toEqual(['eligible']);
    expect(await eligibleClosedTabs({ windowId: null, incognito: false })).toEqual([]);
    expect(await eligibleClosedTabs({ windowId: 7, incognito: undefined })).toEqual([]);
    expect(browser.sessions.getRecentlyClosed).toHaveBeenCalledTimes(1);
  });
});
