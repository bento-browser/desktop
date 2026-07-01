import { describe, expect, it } from 'vitest';
import type { AddrResult, SavedPanelEntry } from '@shared/protocol';
import {
  buildClipboardRow,
  buildSavedPanelRows,
  buildSyntheticRow,
  chooseSearchEngineForAddressRow,
  isUrlLike,
  resultToRow,
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
