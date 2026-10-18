// Pinned tabs restored on demand (browser.sessionstore.restore_pinned_tabs_on_demand,
// set in prefs/bento.js) stay unloaded until selected, but Firefox gives them a
// real, pending browser instead of the lazy one other restored tabs get
// (Tabbrowser: createLazyBrowser = restoreTabsLazily && !select && !tabData.pinned).
// The WebExtension tabs.Tab.discarded getter is `!linkedPanel`, so they report
// discarded: false and the sidebar draws them as loaded. Discarding them once at
// startup swaps the pending browser for a lazy one; selecting one restores it
// from the session as before.

import type { TabSnapshot } from '@shared/protocol';

/**
 * Ids of pinned tabs to discard: not the selected tab of their window, not
 * already discarded, and not a panel shown in an active workspace layout (the
 * mount script renders those straight away, so a discard would only reload them).
 */
export function pinnedTabsToDiscard(
  tabs: readonly TabSnapshot[],
  shownPanelTabIds: ReadonlySet<number>,
): number[] {
  return tabs
    .filter((t) => t.pinned && !t.active && !t.discarded && !shownPanelTabIds.has(t.id))
    .map((t) => t.id);
}

/**
 * Discards the tabs `pinnedTabsToDiscard` picks, one at a time. Each tab is read
 * live first: the registry snapshot can be a moment old, and a tab the user has
 * since opened must stay loaded. Failures are logged, never thrown, so a tab that
 * closed mid-sweep cannot break startup.
 */
export async function discardRestoredPinnedTabs(
  tabs: readonly TabSnapshot[],
  shownPanelTabIds: ReadonlySet<number>,
): Promise<void> {
  for (const id of pinnedTabsToDiscard(tabs, shownPanelTabIds)) {
    try {
      const live = await browser.tabs.get(id);
      if (!live.pinned || live.active || live.discarded) continue;
      await browser.tabs.discard(id);
    } catch (err) {
      console.warn('[bento-tools] pinned tab discard failed for tab', id, err);
    }
  }
}
