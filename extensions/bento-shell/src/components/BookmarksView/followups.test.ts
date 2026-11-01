import { describe, expect, it, vi } from 'vitest';
import type { BookmarksSnapshot } from '@shared/protocol';

import { exists, groupPlacedAt, itemPlacedAt, settleFollowups } from './followups';

const snapshot: BookmarksSnapshot = {
  status: 'ready',
  spaces: [{ id: 's1', name: 'S', color: 'gray', order: 0 }],
  groups: [
    { id: 'g1', spaceId: 's1', name: 'One', color: 'gray', order: 0 },
    { id: 'g2', spaceId: 's1', name: 'Two', color: 'gray', order: 1 },
  ],
  items: [
    { id: 'a', groupId: 'g1', order: 0, createdAt: 0, kind: 'note', text: 'a' },
    { id: 'b', groupId: 'g1', order: 1, createdAt: 0, kind: 'note', text: 'b' },
    { id: 'c', groupId: 'g2', order: 0, createdAt: 0, kind: 'note', text: 'c' },
  ],
  lastSpaceId: 's1',
  firefoxImportOffered: true,
};

describe('exists', () => {
  it('is true once any of the ids is a space, group or item', () => {
    expect(exists(['nope'])(snapshot)).toBe(false);
    expect(exists(['nope', 'b'])(snapshot)).toBe(true);
    expect(exists(['g2'])(snapshot)).toBe(true);
    expect(exists(['s1'])(snapshot)).toBe(true);
    expect(exists([])(snapshot)).toBe(false);
  });
});

describe('placement', () => {
  it('knows when an item sits before another, last, or in another group', () => {
    expect(itemPlacedAt('a', 'g1', 'b')(snapshot)).toBe(true);
    expect(itemPlacedAt('b', 'g1', null)(snapshot)).toBe(true);
    expect(itemPlacedAt('a', 'g1', null)(snapshot)).toBe(false);
    expect(itemPlacedAt('a', 'g2', null)(snapshot)).toBe(false);
    expect(itemPlacedAt('missing', 'g1', null)(snapshot)).toBe(false);
  });

  it('does the same for a group among its space', () => {
    expect(groupPlacedAt('g1', 's1', 'g2')(snapshot)).toBe(true);
    expect(groupPlacedAt('g2', 's1', null)(snapshot)).toBe(true);
    expect(groupPlacedAt('g2', 's1', 'g1')(snapshot)).toBe(false);
  });
});

describe('settleFollowups', () => {
  it('runs what the snapshot made ready, once, and keeps the rest waiting', () => {
    const ready = vi.fn();
    const waiting = vi.fn();
    const pending = [
      { ready: exists(['a']), run: ready },
      { ready: exists(['later']), run: waiting },
    ];
    const rest = settleFollowups(pending, snapshot);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(waiting).not.toHaveBeenCalled();
    expect(rest).toEqual([pending[1]]);
    // A snapshot that holds the other id finishes it; the first one is not run again.
    const withLater = {
      ...snapshot,
      items: [...snapshot.items, { ...snapshot.items[0]!, id: 'later' }],
    };
    expect(settleFollowups(rest, withLater)).toEqual([]);
    expect(waiting).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('is not triggered by items that are not the ones it waits for', () => {
    const run = vi.fn();
    const rest = settleFollowups([{ ready: exists(['mine']), run }], {
      ...snapshot,
      items: [...snapshot.items, { ...snapshot.items[0]!, id: 'someone-elses' }],
    });
    expect(run).not.toHaveBeenCalled();
    expect(rest).toHaveLength(1);
  });
});
