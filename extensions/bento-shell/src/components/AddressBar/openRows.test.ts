import { describe, expect, it } from 'vitest';
import type { TabSnapshot } from '@shared/protocol';
import { buildOpenRows } from './openRows';

function tab(overrides: Partial<TabSnapshot> & { id: number; title: string }): TabSnapshot {
  return {
    windowId: 1,
    index: overrides.id,
    active: false,
    pinned: false,
    audible: false,
    muted: false,
    workspaceId: 'work',
    ...overrides,
  };
}

function byId(tabs: TabSnapshot[]): Record<number, TabSnapshot> {
  return Object.fromEntries(tabs.map((item) => [item.id, item]));
}

function rows(
  query: string,
  tabs: TabSnapshot[],
  options: {
    panelsByWorkspace?: Map<string, Set<number>>;
    activeWorkspaceId?: string | null;
    windowId?: number | null;
    limit?: number;
  } = {},
) {
  return buildOpenRows({
    query,
    tabsById: byId(tabs),
    orderedIds: tabs.map((item) => item.id),
    panelsByWorkspace: options.panelsByWorkspace ?? new Map(),
    activeWorkspaceId: options.activeWorkspaceId ?? 'work',
    windowId: options.windowId ?? 1,
    limit: options.limit ?? 8,
  });
}

describe('buildOpenRows', () => {
  it('returns no rows for an empty query', () => {
    expect(rows('', [tab({ id: 1, title: 'Bento Docs' })])).toEqual([]);
  });

  it('matches custom title before page title', () => {
    const result = rows('Renamed', [
      tab({ id: 1, title: 'Original title', customTitle: 'Renamed tab' }),
    ]);

    expect(result).toMatchObject([{ id: 'tab:1', title: 'Renamed tab', kind: 'tab' }]);
  });

  it('matches URL text', () => {
    const result = rows('docs.example', [
      tab({ id: 1, title: 'No title match', url: 'https://docs.example.com/guide' }),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.url).toBe('https://docs.example.com/guide');
  });

  it('normalizes protocol and leading www for URL matching', () => {
    const result = rows('example.com/path', [
      tab({ id: 1, title: 'No title match', url: 'https://www.example.com/path' }),
    ]);

    expect(result).toHaveLength(1);
  });

  it('restricts rows to the current window', () => {
    const result = rows('Bento', [
      tab({ id: 1, title: 'Bento current', windowId: 1 }),
      tab({ id: 2, title: 'Bento other', windowId: 2 }),
    ]);

    expect(result.map((row) => row.id)).toEqual(['tab:1']);
  });

  it('restricts rows to the active workspace', () => {
    const result = rows('Bento', [
      tab({ id: 1, title: 'Bento current', workspaceId: 'work' }),
      tab({ id: 2, title: 'Bento other', workspaceId: 'side' }),
    ]);

    expect(result.map((row) => row.id)).toEqual(['tab:1']);
  });

  it('uses panel ids only from the active workspace', () => {
    const result = rows(
      'Panel',
      [
        tab({ id: 1, title: 'Panel active', workspaceId: 'work' }),
        tab({ id: 2, title: 'Panel inactive', workspaceId: 'work' }),
      ],
      {
        panelsByWorkspace: new Map([
          ['work', new Set([1])],
          ['side', new Set([2])],
        ]),
      },
    );

    expect(result.map((row) => [row.id, row.kind])).toEqual([
      ['panel:work:1', 'panel'],
      ['tab:2', 'tab'],
    ]);
  });

  it('caps combined tab and panel results', () => {
    const tabs = Array.from({ length: 10 }, (_, index) =>
      tab({ id: index + 1, title: `Bento ${index + 1}` }),
    );

    expect(rows('Bento', tabs, { limit: 8 })).toHaveLength(8);
  });

  it('sorts prefix matches before substring matches while preserving stable order', () => {
    const result = rows('Bento', [
      tab({ id: 1, title: 'Alpha Bento' }),
      tab({ id: 2, title: 'Bento Beta' }),
      tab({ id: 3, title: 'Bento Gamma' }),
      tab({ id: 4, title: 'Delta Bento' }),
    ]);

    expect(result.map((row) => row.id)).toEqual(['tab:2', 'tab:3', 'tab:1', 'tab:4']);
  });
});
