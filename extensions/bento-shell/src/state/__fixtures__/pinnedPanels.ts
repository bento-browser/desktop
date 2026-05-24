// Fake pinned-panel data for Ladle stories — seeds usePinnedPanelsStore
// so the PinnedPanels component can be exercised in isolation without
// needing bento-tools or storage.local. The component renders favicon +
// title from useTab(id), so seed tabs first (via tabs.ts) when stories
// want real labels.

import type { PinnedPanelEntry } from '@shared/protocol';
import { usePinnedPanelsStore } from '../pinnedPanels';

export function makePinnedEntry(
  overrides: Partial<PinnedPanelEntry> & { workspaceId: string; tabId: number },
): PinnedPanelEntry {
  const { workspaceId, tabId, ...rest } = overrides;
  return {
    workspaceId,
    tabId,
    order: tabId,
    ...rest,
  };
}

export function seedPinnedPanels(entries: PinnedPanelEntry[]): void {
  usePinnedPanelsStore.getState().applySnapshot(entries);
}

export function seedEmptyPinnedPanels(): void {
  usePinnedPanelsStore.getState().applySnapshot([]);
}
