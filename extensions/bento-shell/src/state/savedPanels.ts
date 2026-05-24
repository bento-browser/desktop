// Downstream mirror of bento-tools' SavedPanelsStore (§4.2 mirror pattern).
// Saved panels are GLOBAL across workspaces — the bookmark folder under
// "Other Bookmarks" is per-profile, not per-workspace — so the store keeps
// a single list rather than the per-workspace map used by `state/panels.ts`.
//
// Tools is the only writer. Saves originate as `savedPanels/save` actions
// dispatched from the panel kebab menu; tools writes the bookmark, the
// browser.bookmarks listener fires, SavedPanelsStore re-reads, and a fresh
// savedPanels/snapshot lands here. Direct mutations from React would
// bypass the bookmark-API round-trip and desync the mirror — don't add a
// setter.

import { create } from 'zustand';
import type { SavedPanelEntry } from '@shared/protocol';

interface SavedPanelsState {
  items: SavedPanelEntry[];
  apply: (items: SavedPanelEntry[]) => void;
}

export const useSavedPanelsStore = create<SavedPanelsState>((set) => ({
  items: [],
  apply: (items) => set({ items }),
}));
