// Pinned tabs restored on demand (browser.sessionstore.restore_pinned_tabs_on_demand,
// set in prefs/bento.js) stay unloaded until selected, but Firefox gives them a
// real, pending browser instead of the lazy one other restored tabs get
// (Tabbrowser: createLazyBrowser = restoreTabsLazily && !select && !tabData.pinned).
// The WebExtension tabs.Tab.discarded getter is `!linkedPanel`, so they report
// discarded: false and the sidebar draws them as loaded. Discarding them once at
// startup swaps the pending browser for a lazy one; selecting one restores it
// from the session as before.
//
// Boot runs this pass before it sends the shell its first tab snapshot (the
// message that opens the sidebar's readiness gate), and records each discard in
// the registry itself, so the first rows the shell draws are already dimmed.

import type { TabSnapshot } from '@shared/protocol';
import type { TabRegistry } from './TabRegistry';

/**
 * The longest boot waits for the discards before it opens the sidebar anyway.
 * The discards run in parallel, so a normal pass is expected to cost about one
 * discard: a state flush and a couple of parent-process round trips, tens of
 * milliseconds (not measured). One second is well above that and still short
 * enough that a stuck discard only delays the sidebar once per launch. A discard
 * that finishes later still lands in the registry and reaches the shell as an
 * ordinary tab update.
 */
export const PINNED_DISCARD_WAIT_MS = 1000;

type RestoredTabs = Pick<TabRegistry, 'snapshot' | 'isClosing' | 'isPrivate' | 'markDiscarded'>;

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

async function discardPinnedTab(id: number, tabs: RestoredTabs): Promise<void> {
  try {
    await browser.tabs.discard(id);
    // tabs.discard resolves even when Firefox declines (it never unloads a
    // selected tab), so the registry only records what a live read confirms.
    if ((await browser.tabs.get(id)).discarded) tabs.markDiscarded(id);
  } catch (err) {
    console.warn('[bento-tools] pinned tab discard failed for tab', id, err);
  }
}

/**
 * Discards the tabs `pinnedTabsToDiscard` picks from the registry, all at once,
 * and marks each one discarded in the registry as soon as Firefox confirms it,
 * so a snapshot taken after this resolves already shows it. Resolves when every
 * discard has settled or after `waitMs`, whichever comes first. Failures are
 * logged, never thrown, so a tab that closed mid-pass cannot break startup.
 */
export async function discardRestoredPinnedTabs(
  tabs: RestoredTabs,
  shownPanelTabIds: ReadonlySet<number>,
  waitMs: number = PINNED_DISCARD_WAIT_MS,
): Promise<void> {
  const ids = pinnedTabsToDiscard(
    tabs.snapshot().filter((tab) => !tabs.isClosing(tab.id) && !tabs.isPrivate(tab.id)),
    shownPanelTabIds,
  );
  if (ids.length === 0) return;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[bento-tools] pinned tab discard still running after ${waitMs} ms`);
      resolve();
    }, waitMs);
  });
  try {
    await Promise.race([Promise.allSettled(ids.map((id) => discardPinnedTab(id, tabs))), capped]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The discard pass boot runs, gated on the browser having just started.
 * `noteStartup` is the `runtime.onStartup` listener: Firefox fires that event
 * only for the APP_STARTUP startup reason, shortly after the background page
 * loads. A dev reload, install or update never fires it, and on those the pinned
 * tabs may be loaded and in use. `run` must be called late in boot, after the
 * settle wait and the active workspace's panel restore (hundreds of milliseconds
 * after the first script run), so the event has long arrived on a real startup;
 * if it has not, `run` does nothing and the tabs stay as Firefox restored them.
 * It never rejects.
 */
export function createStartupPinnedTabDiscard(
  tabs: RestoredTabs,
  getShownPanelTabIds: () => Iterable<number>,
  waitMs?: number,
): { noteStartup: () => void; run: () => Promise<void> } {
  let browserStarted = false;
  return {
    noteStartup: () => {
      browserStarted = true;
    },
    run: async () => {
      if (!browserStarted) return;
      try {
        await discardRestoredPinnedTabs(tabs, new Set(getShownPanelTabIds()), waitMs);
      } catch (err) {
        console.warn('[bento-tools] startup pinned tab discard failed:', err);
      }
    },
  };
}
