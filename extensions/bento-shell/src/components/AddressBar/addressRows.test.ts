import { describe, expect, it } from 'vitest';
import type { AddrResult, SavedPanelEntry } from '@shared/protocol';
import {
  buildClipboardRow,
  buildSavedPanelRows,
  buildSyntheticRow,
  chooseSearchEngineForAddressRow,
  isUrlLike,
  resultToRow,
  resultAge,
} from './addressRows';

describe('address row helpers', () => {
  it('detects explicit schemes and host-like input as URL-like', () => {
    expect(isUrlLike('https://example.com')).toBe(true);
    expect(isUrlLike('about:config')).toBe(true);
    expect(isUrlLike('example.com/path')).toBe(true);
    expect(isUrlLike('search terms')).toBe(false);
  });

  it('maps tools results into display rows', () => {
    const result: AddrResult = {
      kind: 'bookmark',
      url: 'https://example.com/docs',
      title: 'Docs',
      score: 10,
    };

    expect(resultToRow(result)).toMatchObject({
      id: 'bookmark:https://example.com/docs',
      kind: 'bookmark',
      title: 'Docs',
      subtitle: 'Bookmark · https://example.com/docs',
      group: 'History & Bookmarks',
      url: 'https://example.com/docs',
    });
  });

  it('builds synthetic open and search rows', () => {
    expect(buildSyntheticRow({ mode: 'current', query: 'example.com' })).toMatchObject({
      kind: 'synthetic',
      title: 'Open example.com',
      subtitle: 'Open in current tab',
    });
    expect(buildSyntheticRow({ mode: 'newTab', query: 'bento browser' })).toMatchObject({
      kind: 'synthetic',
      title: 'Search for bento browser',
      subtitle: 'Open in new tab',
    });
  });

  it('only shows clipboard and saved-panel defaults in empty new-tab mode', () => {
    const savedPanels: SavedPanelEntry[] = [
      { id: '1', title: '', url: 'https://panel.example', favIconUrl: 'icon.png' },
    ];

    expect(
      buildClipboardRow({ mode: 'newTab', query: '', clipboardUrl: 'https://clip.example' }),
    ).toMatchObject({ kind: 'clipboard', url: 'https://clip.example' });
    expect(
      buildClipboardRow({ mode: 'current', query: '', clipboardUrl: 'https://clip.example' }),
    ).toBeNull();
    expect(buildSavedPanelRows({ mode: 'newTab', query: '', savedPanels })).toMatchObject([
      { kind: 'savedPanel', title: 'https://panel.example', favIconUrl: 'icon.png' },
    ]);
    expect(buildSavedPanelRows({ mode: 'newTab', query: 'typed', savedPanels })).toEqual([]);
  });

  it('uses one-shot engines only for dirty non-default synthetic searches', () => {
    const searchRow = buildSyntheticRow({ mode: 'current', query: 'bento browser' });
    const urlRow = buildSyntheticRow({ mode: 'current', query: 'example.com' });
    if (!searchRow || !urlRow) throw new Error('expected rows');

    expect(
      chooseSearchEngineForAddressRow({
        row: searchRow,
        engineSelectionDirty: true,
        selectedSearchEngineId: 'google',
        defaultSearchEngine: 'ddg',
      }),
    ).toBe('google');
    expect(
      chooseSearchEngineForAddressRow({
        row: searchRow,
        engineSelectionDirty: true,
        selectedSearchEngineId: 'ddg',
        defaultSearchEngine: 'ddg',
      }),
    ).toBeUndefined();
    expect(
      chooseSearchEngineForAddressRow({
        row: urlRow,
        engineSelectionDirty: true,
        selectedSearchEngineId: 'google',
        defaultSearchEngine: 'ddg',
      }),
    ).toBeUndefined();
  });
});

describe('recent row presentation', () => {
  it('keeps session identity distinct at the same URL and exposes domain/timestamps', () => {
    const closed = {
      kind: 'recentlyClosed' as const,
      sessionId: 'one',
      url: 'https://www.example.test/path',
      title: 'Page',
      score: 0,
      closedAt: 123,
    };
    expect(resultToRow(closed)).toMatchObject({
      id: 'recentlyClosed:one',
      sessionId: 'one',
      subtitle: 'example.test',
      timestamp: 123,
      group: 'Recently Closed',
    });
    expect(resultToRow({ ...closed, sessionId: 'two' }).id).not.toBe(resultToRow(closed).id);
    expect(
      resultToRow({
        kind: 'recentHistory',
        url: closed.url,
        title: 'Page',
        score: 0,
        lastVisitTime: 234,
      }),
    ).toMatchObject({ group: 'Recent History', timestamp: 234 });
  });
});

it('formats recent timestamps without negative ages or invalid metadata', () => {
  const now = 100_000_000;
  expect(
    [undefined, NaN, now + 60_000, now - 120_000, now - 7_200_000, now - 172_800_000].map((t) =>
      resultAge(t, now),
    ),
  ).toEqual(['', '', 'now', '2m', '2h', '2d']);
});
