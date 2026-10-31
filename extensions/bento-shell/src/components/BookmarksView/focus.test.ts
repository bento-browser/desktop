import { describe, expect, it } from 'vitest';

import {
  editReturnSelector,
  groupAddItemSelector,
  groupMenuSelector,
  itemMainSelector,
  itemMenuSelector,
  neighbourMoves,
  revealSelector,
} from './focus';

describe('selectors', () => {
  it('quote the id, so a quote or backslash in it cannot end the attribute value', () => {
    expect(itemMainSelector('a"b\\c')).toBe('[data-bm-item-id="a\\"b\\\\c"] :is(button, input)');
  });

  it('name the row, the column and the triggers inside them', () => {
    expect(revealSelector('x')).toBe('[data-bm-item-id="x"], [data-bm-group-id="x"]');
    expect(itemMenuSelector('i')).toBe('[data-bm-item-id="i"] [data-bm-item-menu]');
    // The header's trigger, not the menu trigger of a row inside the column.
    expect(groupMenuSelector('g')).toBe('[data-bm-group-id="g"] > header [data-bm-menu-trigger]');
    expect(groupAddItemSelector('g')).toBe('[data-bm-group-id="g"] [data-bm-add-item]');
  });
});

describe('editReturnSelector', () => {
  it('sends the focus back to the row or trigger the editor began on', () => {
    expect(editReturnSelector({ kind: 'item', id: 'i' })).toBe(itemMainSelector('i'));
    expect(editReturnSelector({ kind: 'group', id: 'g' })).toBe(groupMenuSelector('g'));
    expect(editReturnSelector({ kind: 'space', id: 's' })).toBe('[data-bm-space-id="s"] button');
    expect(editReturnSelector({ kind: 'add-item', groupId: 'g' })).toBe(groupAddItemSelector('g'));
    expect(editReturnSelector({ kind: 'add-group' })).toBe('[data-bm-add-group]');
    expect(editReturnSelector({ kind: 'add-space' })).toBe('[data-bm-add-space]');
  });
});

describe('neighbourMoves', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('moves up before the neighbour above, down before the entry after the next one', () => {
    expect(neighbourMoves(ids, 1)).toEqual({ earlier: 'a', later: 'd' });
    expect(neighbourMoves(ids, 0)).toEqual({ earlier: undefined, later: 'c' });
  });

  it('moves down to the end from the second to last, and not at all from the last', () => {
    expect(neighbourMoves(ids, 2)).toEqual({ earlier: 'b', later: null });
    expect(neighbourMoves(ids, 3)).toEqual({ earlier: 'c', later: undefined });
  });

  it('has nowhere to go with one entry', () => {
    expect(neighbourMoves(['only'], 0)).toEqual({ earlier: undefined, later: undefined });
  });
});
