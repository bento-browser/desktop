import { beforeEach, describe, expect, it } from 'vitest';

import { SAMPLE_SNAPSHOT } from './__fixtures__/bookmarks';
import { useBookmarksStore } from './bookmarks';

describe('bookmarks mirror', () => {
  beforeEach(() => useBookmarksStore.setState({ snapshot: null }));

  it('holds nothing until tools sends a snapshot, then holds the latest one', () => {
    expect(useBookmarksStore.getState().snapshot).toBeNull();
    useBookmarksStore.getState().apply(SAMPLE_SNAPSHOT);
    expect(useBookmarksStore.getState().snapshot).toBe(SAMPLE_SNAPSHOT);
    const next = { ...SAMPLE_SNAPSHOT, lastSpaceId: 'space-work' };
    useBookmarksStore.getState().apply(next);
    expect(useBookmarksStore.getState().snapshot?.lastSpaceId).toBe('space-work');
  });
});
