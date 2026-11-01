import { describe, expect, it } from 'vitest';
import type { BookmarkItem, BookmarksSnapshot } from '@shared/protocol';

import {
  bookmarkedTabIds,
  defaultSaveTarget,
  isSavableUrl,
  linkKeys,
  newestLinkFor,
  urlKey,
} from './links';

function link(id: string, groupId: string, url: string, createdAt: number): BookmarkItem {
  return { id, groupId, order: 0, createdAt, kind: 'link', url, title: id };
}

function snapshot(partial: Partial<BookmarksSnapshot> = {}): BookmarksSnapshot {
  return {
    status: 'ready',
    spaces: [
      { id: 's1', name: 'Personal', color: 'blue', order: 0 },
      { id: 's2', name: 'Work', color: 'green', order: 1 },
    ],
    groups: [
      { id: 'g1', spaceId: 's1', name: 'Reading', color: 'blue', order: 0 },
      { id: 'g2', spaceId: 's2', name: 'Docs', color: 'green', order: 0 },
      { id: 'g3', spaceId: 's2', name: 'Dev', color: 'gray', order: 1 },
    ],
    items: [],
    lastSpaceId: 's1',
    firefoxImportOffered: true,
    ...partial,
  };
}

describe('urlKey', () => {
  it('is the canonical href, so equivalent spellings match', () => {
    expect(urlKey('https://EXAMPLE.com')).toBe('https://example.com/');
    expect(urlKey('https://example.com/')).toBe(urlKey('https://example.com'));
    expect(urlKey('https://example.com/a#x')).not.toBe(urlKey('https://example.com/a'));
  });

  it('is null for text that is not a URL', () => {
    expect(urlKey('not a url')).toBeNull();
    expect(urlKey('')).toBeNull();
    expect(urlKey(undefined)).toBeNull();
  });
});

describe('isSavableUrl', () => {
  it('accepts web and file pages and refuses Firefox and extension pages', () => {
    for (const url of [
      'https://a.test/',
      'http://a.test/',
      'file:///tmp/a.html',
      'ftp://a.test/',
    ]) {
      expect(isSavableUrl(url), url).toBe(true);
    }
    for (const url of [
      'about:blank',
      'about:preferences',
      'moz-extension://x/index.html',
      'chrome://browser/content/browser.xhtml',
      'view-source:https://a.test/',
      'data:text/html,hi',
      'nonsense',
      undefined,
    ]) {
      expect(isSavableUrl(url), String(url)).toBe(false);
    }
  });
});

describe('newestLinkFor', () => {
  it('picks the most recent of several saves of one page', () => {
    const state = snapshot({
      items: [
        link('old', 'g1', 'https://a.test/', 1),
        link('new', 'g2', 'https://a.test', 5),
        link('other', 'g1', 'https://b.test/', 9),
      ],
    });
    expect(newestLinkFor(state, urlKey('https://a.test/')!)?.id).toBe('new');
    expect(newestLinkFor(state, urlKey('https://c.test/')!)).toBeNull();
  });

  it('ignores notes and to-dos', () => {
    const state = snapshot({
      items: [
        { id: 'n', groupId: 'g1', order: 0, createdAt: 1, kind: 'note', text: 'https://a.test/' },
      ],
    });
    expect(newestLinkFor(state, urlKey('https://a.test/')!)).toBeNull();
  });
});

describe('linkKeys', () => {
  it('holds the key of every link and nothing while the snapshot is missing or failed', () => {
    const items = [link('a', 'g1', 'https://a.test', 1), link('b', 'g1', 'https://b.test/x', 2)];
    expect([...linkKeys(snapshot({ items }))].sort()).toEqual([
      'https://a.test/',
      'https://b.test/x',
    ]);
    expect(linkKeys(null).size).toBe(0);
    expect(linkKeys(snapshot({ status: 'loadFailed', items })).size).toBe(0);
  });
});

describe('defaultSaveTarget', () => {
  it('is the group of the newest link in the current space', () => {
    const items = [
      link('a', 'g2', 'https://a.test/', 1),
      link('b', 'g3', 'https://b.test/', 7),
      link('c', 'g1', 'https://c.test/', 9),
    ];
    expect(defaultSaveTarget(snapshot({ items, lastSpaceId: 's2' }))).toEqual({
      spaceId: 's2',
      groupId: 'g3',
    });
    expect(defaultSaveTarget(snapshot({ items }))).toEqual({ spaceId: 's1', groupId: 'g1' });
  });

  it('is the first group of the current space when nothing is saved yet', () => {
    expect(defaultSaveTarget(snapshot())).toEqual({ spaceId: 's1', groupId: 'g1' });
    expect(defaultSaveTarget(snapshot({ lastSpaceId: 's2' }))).toEqual({
      spaceId: 's2',
      groupId: 'g2',
    });
  });

  it('asks for "Unsorted" when the current space has no group', () => {
    const state = snapshot({ groups: [], lastSpaceId: 's2' });
    expect(defaultSaveTarget(state)).toEqual({ spaceId: 's2', groupId: null });
  });

  it('falls back to the first space when the remembered one is gone', () => {
    expect(defaultSaveTarget(snapshot({ lastSpaceId: 'missing' }))).toEqual({
      spaceId: 's1',
      groupId: 'g1',
    });
  });

  it('is null while there is nothing to save into', () => {
    expect(defaultSaveTarget(null)).toBeNull();
    expect(defaultSaveTarget(snapshot({ status: 'loadFailed' }))).toBeNull();
    expect(defaultSaveTarget(snapshot({ spaces: [], groups: [], lastSpaceId: null }))).toBeNull();
  });
});

describe('bookmarkedTabIds', () => {
  const tabs = [
    { id: 9, windowId: 1, url: 'https://a.test/' },
    { id: 3, windowId: 1, url: 'https://b.test/' },
    { id: 5, windowId: 2, url: 'https://a.test' },
    { id: 7, windowId: 1 },
  ];
  const keys = new Set(['https://a.test/']);

  it('lists this window’s saved tabs in ascending order', () => {
    expect(bookmarkedTabIds(tabs, keys, 1)).toEqual([9]);
    expect(bookmarkedTabIds(tabs, keys, 2)).toEqual([5]);
  });

  it('covers every window when the window is unknown', () => {
    expect(bookmarkedTabIds(tabs, keys, null)).toEqual([5, 9]);
  });
});
