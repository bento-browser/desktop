import type { AddrResult } from '@shared/protocol';
import { eligibleClosedTabs, type ClosedSessionContext } from './ClosedSessions';

const DEFAULT_LIMIT = 8;
const HISTORY_CAP = 16;
const BOOKMARK_CAP = 12;

function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    const keys: string[] = [];
    url.searchParams.forEach((_value, key) => keys.push(key));
    for (const key of keys) {
      const lower = key.toLowerCase();
      if (lower === 'utm' || lower.startsWith('utm_')) url.searchParams.delete(key);
    }
    let out = url.toString();
    if (url.pathname === '/' && !url.search && out.endsWith('/')) out = out.slice(0, -1);
    return out;
  } catch {
    return rawUrl.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

function hostPrefixScore(query: string, rawUrl: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  try {
    const host = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    if (host === q) return 5000;
    if (host.startsWith(q)) return 3500;
    if (host.includes(q)) return 1800;
  } catch {
    // Ignore non-URL values; history/bookmark URLs should normally parse.
  }
  return 0;
}

function historyScore(query: string, item: browser.history.HistoryItem): number {
  const visitCount = typeof item.visitCount === 'number' ? item.visitCount : 0;
  const typedCount = typeof item.typedCount === 'number' ? item.typedCount : 0;
  const lastVisitTime = typeof item.lastVisitTime === 'number' ? item.lastVisitTime : 0;
  const ageDays = Math.max(0, (Date.now() - lastVisitTime) / 86_400_000);
  const recency = Math.max(0, 1200 - ageDays * 20);
  return hostPrefixScore(query, item.url ?? '') + recency + visitCount * 8 + typedCount * 24;
}

function bookmarkScore(query: string, node: browser.bookmarks.BookmarkTreeNode): number {
  const dateAdded = typeof node.dateAdded === 'number' ? node.dateAdded : 0;
  const ageDays = Math.max(0, (Date.now() - dateAdded) / 86_400_000);
  const recency = Math.max(0, 500 - ageDays * 2);
  return hostPrefixScore(query, node.url ?? '') + recency + 650;
}

function titleForUrl(title: string | undefined, url: string): string {
  const trimmed = title?.trim();
  if (trimmed) return trimmed;
  return url;
}

async function getEmptyQueryResults(context?: ClosedSessionContext): Promise<AddrResult[]> {
  // Each source fails independently; native history/top-site order is intentional.
  const [closed, history, topSites] = await Promise.all([
    eligibleClosedTabs(context).catch(() => []),
    Promise.resolve()
      .then(() =>
        browser.history.search({
          text: '',
          startTime: 0,
          maxResults: 2,
        }),
      )
      .catch(() => []),
    Promise.resolve()
      .then(() =>
        browser.topSites.get({
          newtab: true,
          limit: 2,
          includeFavicon: true,
        }),
      )
      .catch(() => []),
  ]);
  return [
    ...closed.slice(0, 2).map((session): AddrResult => ({
      kind: 'recentlyClosed',
      sessionId: session.tab.sessionId,
      url: session.tab.url,
      title: titleForUrl(session.tab.title, session.tab.url),
      favIconUrl: session.tab.favIconUrl,
      closedAt: session.lastModified,
      score: 0,
    })),
    ...history
      .filter((item) => !!item.url)
      .slice(0, 2)
      .map((item): AddrResult => ({
        kind: 'recentHistory',
        url: item.url!,
        title: titleForUrl(item.title, item.url!),
        lastVisitTime: item.lastVisitTime,
        score: 0,
      })),
    ...topSites
      .filter((site) => !!site.url)
      .slice(0, 2)
      .map((site, index): AddrResult => ({
        kind: 'topSite',
        url: site.url,
        title: titleForUrl(site.title, site.url),
        favIconUrl: site.favicon,
        score: 2 - index,
      })),
  ];
}

function mergeResult(byUrl: Map<string, AddrResult>, key: string, result: AddrResult): void {
  const existing = byUrl.get(key);
  if (!existing) {
    byUrl.set(key, result);
    return;
  }
  byUrl.set(key, {
    ...existing,
    kind: existing.kind === 'bookmark' || result.kind === 'bookmark' ? 'bookmark' : 'history',
    title: result.kind === 'bookmark' ? result.title : existing.title,
    score: Math.max(existing.score, result.score),
  });
}

export async function searchAddressResults(
  query: string,
  limit = DEFAULT_LIMIT,
  context?: ClosedSessionContext,
): Promise<AddrResult[]> {
  const trimmed = query.trim();
  const maxResults = Math.max(1, Math.min(limit, 20));
  const byUrl = new Map<string, AddrResult>();

  if (!trimmed) {
    return getEmptyQueryResults(context);
  }

  const [historyItems, bookmarkNodes] = await Promise.all([
    browser.history.search({
      text: trimmed,
      startTime: 0,
      maxResults: Math.max(HISTORY_CAP, maxResults),
    }),
    browser.bookmarks.search(trimmed),
  ]);

  for (const item of historyItems.slice(0, HISTORY_CAP)) {
    if (!item.url) continue;
    const key = normalizeUrl(item.url);
    mergeResult(byUrl, key, {
      kind: 'history',
      url: item.url,
      title: titleForUrl(item.title, item.url),
      score: historyScore(trimmed, item),
    });
  }

  let bookmarkCount = 0;
  for (const node of bookmarkNodes) {
    if (!node.url) continue;
    const key = normalizeUrl(node.url);
    mergeResult(byUrl, key, {
      kind: 'bookmark',
      url: node.url,
      title: titleForUrl(node.title, node.url),
      score: bookmarkScore(trimmed, node),
    });
    bookmarkCount += 1;
    if (bookmarkCount >= BOOKMARK_CAP) break;
  }

  return Array.from(byUrl.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}
