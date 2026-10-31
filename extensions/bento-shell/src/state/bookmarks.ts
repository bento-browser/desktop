// Downstream mirror of bento-tools' BookmarksStore (§4.2 mirror pattern). Tools is the only
// writer: the Bookmarks view dispatches `bookmarks/*` actions, tools applies them and broadcasts the
// whole state as `bookmarks/snapshot`, and the bridge hands that to `apply`. There is no other
// setter on purpose. A direct edit here would put the view ahead of what tools stores.
//
// The snapshot is null until the first one arrives. Tools sends it to the documents of regular
// windows only, so a private window's mirror stays null.

import { create } from 'zustand';
import type { BookmarksSnapshot } from '@shared/protocol';

interface BookmarksState {
  snapshot: BookmarksSnapshot | null;
  apply: (snapshot: BookmarksSnapshot) => void;
}

export const useBookmarksStore = create<BookmarksState>((set) => ({
  snapshot: null,
  apply: (snapshot) => set({ snapshot }),
}));
