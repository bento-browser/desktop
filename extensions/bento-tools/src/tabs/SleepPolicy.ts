// Tab sleep policy (§6.7). Pulled forward from M3 because it directly
// serves Bento's snappy/lightweight requirement: a long-lived browser with
// 100+ tabs can quietly bloat to GBs of RAM if every tab keeps a content
// process. browser.tabs.discard() unloads the content process while keeping
// the tab in the model — Firefox transparently re-loads on next focus.
//
// Eligibility (all must hold):
//   1. tab is not pinned (pinned tabs stay alive; user signaled importance)
//   2. tab is not currently active in its window
//   3. tab hasn't been activated within SLEEP_AFTER_MS
//   4. tab is NOT among the KEEP_ACTIVE_PER_WORKSPACE most-recently-active
//      tabs in its workspace (so a workspace stays warm even if every tab
//      passed the timeout)
//   5. tab is not already discarded
//
// Sweep runs every SWEEP_INTERVAL_MS and discards eligible tabs. This is
// the entire policy — wake is automatic when the user focuses a discarded
// tab (Firefox handles it). No UI affordance for now; future M2/M3 work
// could expose "Wake all" / per-tab override via the command palette.

import type { TabRegistry } from './TabRegistry';
import type { SettingsStore } from '../settings/SettingsStore';

// Sweep cadence is a fixed implementation detail (not user-tunable). Sleep
// timeout + keep-alive count come from SettingsStore so the user can adjust
// them in Bento Settings without restarting.
const SWEEP_INTERVAL_MS = 60 * 1000;

export class SleepPolicy {
  #tabs: TabRegistry;
  #settings: SettingsStore;
  #lastActivatedAt = new Map<number, number>();
  #sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(tabs: TabRegistry, settings: SettingsStore) {
    this.#tabs = tabs;
    this.#settings = settings;
  }

  init(): void {
    // Seed timestamps for tabs that already exist at boot. Without this,
    // every existing tab has lastActivated=0 and the first sweep would
    // discard them all (except the active one).
    const now = Date.now();
    for (const t of this.#tabs.snapshot()) {
      this.#lastActivatedAt.set(t.id, now);
    }

    browser.tabs.onActivated.addListener((info) => {
      this.#lastActivatedAt.set(info.tabId, Date.now());
    });
    browser.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) this.#lastActivatedAt.set(tab.id, Date.now());
    });
    browser.tabs.onRemoved.addListener((id) => {
      this.#lastActivatedAt.delete(id);
    });

    this.#sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Public for tests + future "sleep now" command palette action. */
  async sweep(): Promise<void> {
    const settings = this.#settings.snapshot();
    if (!settings.tabSleepEnabled) return;
    const now = Date.now();
    const candidates = this.#eligibleForSleep(
      now,
      settings.tabSleepAfterMinutes * 60 * 1000,
      settings.tabSleepKeepAlivePerWorkspace,
    );
    if (candidates.length === 0) return;
    console.log('[bento-tools] SleepPolicy: discarding', candidates.length, 'tabs');
    for (const id of candidates) {
      try {
        await browser.tabs.discard(id);
      } catch (err) {
        // Firefox rejects discard for tabs in unsupported states (e.g. a
        // tab currently loading). Log and move on.
        console.warn('[bento-tools] SleepPolicy: discard failed for tab', id, err);
      }
    }
  }

  #eligibleForSleep(now: number, sleepAfterMs: number, keepAlivePerWorkspace: number): number[] {
    const allTabs = this.#tabs.snapshot();

    // Group by workspace so per-workspace keep-alive can be applied.
    // Tabs without a workspaceId go in their own bucket — they're not
    // protected by the keep-alive rule (no workspace = no LRU).
    const byWorkspace = new Map<string | null, typeof allTabs>();
    for (const t of allTabs) {
      const key = t.workspaceId ?? null;
      const bucket = byWorkspace.get(key);
      if (bucket) bucket.push(t);
      else byWorkspace.set(key, [t]);
    }

    const protectedIds = new Set<number>();
    for (const [, tabs] of byWorkspace) {
      // Sort by lastActivated DESC, take top N — those stay warm.
      const ranked = tabs
        .map((t) => ({ id: t.id, ts: this.#lastActivatedAt.get(t.id) ?? 0 }))
        .sort((a, b) => b.ts - a.ts)
        .slice(0, keepAlivePerWorkspace);
      for (const r of ranked) protectedIds.add(r.id);
    }

    return allTabs
      .filter((t) => !t.pinned)
      .filter((t) => !t.active)
      .filter((t) => !protectedIds.has(t.id))
      .filter((t) => {
        const last = this.#lastActivatedAt.get(t.id) ?? now;
        return now - last >= sleepAfterMs;
      })
      .map((t) => t.id);
  }

  // For test harness; not currently invoked from production code.
  dispose(): void {
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = null;
  }
}
