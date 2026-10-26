import { describe, expect, it } from 'vitest';
import {
  INITIAL_SEARCH,
  isSearchParked,
  openSearch,
  searchOnRailChange,
  type SearchState,
} from './searchState';

const open = (query = ''): SearchState => ({ open: true, query, folded: false });

describe('searchOnRailChange', () => {
  it('collapsing an open empty field closes it with nothing parked', () => {
    const next = searchOnRailChange(open('  '), true);
    expect(next).toEqual({ open: false, query: '', folded: true });
    expect(isSearchParked(next)).toBe(false);
  });

  it('collapsing with a query closes the field and parks the query', () => {
    const next = searchOnRailChange(open('bento'), true);
    expect(next).toEqual({ open: false, query: 'bento', folded: true });
    expect(isSearchParked(next)).toBe(true);
  });

  it('collapsing a closed field changes nothing', () => {
    expect(searchOnRailChange(INITIAL_SEARCH, true)).toBe(INITIAL_SEARCH);
  });

  it('expanding reopens a parked query', () => {
    const parked = searchOnRailChange(open('bento'), true);
    expect(searchOnRailChange(parked, false)).toEqual({
      open: true,
      query: 'bento',
      folded: false,
    });
  });

  it('expanding with nothing parked leaves the field closed, or open if it was opened in the rail', () => {
    expect(searchOnRailChange(INITIAL_SEARCH, false)).toEqual(INITIAL_SEARCH);
    expect(searchOnRailChange(openSearch(INITIAL_SEARCH), false)).toEqual(open());
  });
});
