/**
 * The sidebar search field's state, owned by TabList above the panes (a workspace
 * switch remounts the pane and keeps it).
 *
 * A query outlives the open field only while the sidebar is the rail: collapsing with
 * the field open closes it and parks a typed query, expanding reopens a parked one.
 * Esc, the clear button and picking a result clear everything (`INITIAL_SEARCH`).
 */
export interface SearchState {
  open: boolean;
  query: string;
  /**
   * The field closed because the sidebar collapsed. It tells the field to draw its fold
   * into the Search square for that phase, and is cleared by every other change.
   */
  folded: boolean;
}

export const INITIAL_SEARCH: SearchState = { open: false, query: '', folded: false };

export const hasSearchQuery = (query: string) => query.trim().length > 0;

/** A typed query kept while the field is closed: the rail's Search square marks it. */
export const isSearchParked = ({ open, query }: Pick<SearchState, 'open' | 'query'>) =>
  !open && hasSearchQuery(query);

/** The state after the sidebar collapses (`collapsed`) or expands. */
export function searchOnRailChange(state: SearchState, collapsed: boolean): SearchState {
  if (collapsed) {
    if (!state.open) return state;
    return { open: false, query: hasSearchQuery(state.query) ? state.query : '', folded: true };
  }
  return { open: state.open || isSearchParked(state), query: state.query, folded: false };
}

export const openSearch = (state: SearchState): SearchState => ({
  ...state,
  open: true,
  folded: false,
});
