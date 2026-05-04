// Source-of-truth tab tracker for Bento. Listens to browser.tabs.* events,
// keeps an internal Map<id, TabSnapshot>, and emits batched delta arrays via
// requestAnimationFrame (§6.5) so opening 50 tabs at once becomes one
// broadcast instead of fifty round-trips.

import type { TabDelta, TabSnapshot } from '@shared/protocol';

type Listener = (deltas: TabDelta[]) => void;

function toSnapshot(t: browser.tabs.Tab): TabSnapshot {
  return {
    id: t.id ?? -1,
    windowId: t.windowId ?? -1,
    index: t.index,
    title: t.title ?? '',
    favIconUrl: t.favIconUrl,
    active: t.active,
    pinned: t.pinned,
    audible: t.audible ?? false,
  };
}

export class TabRegistry {
  #tabs = new Map<number, TabSnapshot>();
  #pending: TabDelta[] = [];
  #flushScheduled = false;
  #listeners = new Set<Listener>();

  async init(): Promise<void> {
    // Register listeners FIRST so we don't miss tabs created during the
    // initial query's await. Firefox can emit onCreated for startup tabs
    // in that window — without listeners up first those events are lost.
    browser.tabs.onCreated.addListener(this.#onCreated);
    browser.tabs.onUpdated.addListener(this.#onUpdated);
    browser.tabs.onRemoved.addListener(this.#onRemoved);
    browser.tabs.onActivated.addListener(this.#onActivated);
    browser.tabs.onMoved.addListener(this.#onMoved);

    const all = await browser.tabs.query({});
    for (const t of all) {
      const snap = toSnapshot(t);
      if (snap.id === -1) continue;
      // Set only if a concurrent onCreated didn't already insert it.
      if (!this.#tabs.has(snap.id)) this.#tabs.set(snap.id, snap);
    }
  }

  snapshot(): TabSnapshot[] {
    return Array.from(this.#tabs.values()).sort((a, b) => a.index - b.index);
  }

  onDeltas(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #onCreated = (tab: browser.tabs.Tab) => {
    const snap = toSnapshot(tab);
    if (snap.id === -1) return;
    this.#tabs.set(snap.id, snap);
    this.#enqueue({ kind: 'created', tab: snap });
  };

  #onUpdated = (
    id: number,
    changeInfo: browser.tabs._OnUpdatedChangeInfo,
    tab: browser.tabs.Tab,
  ) => {
    const existing = this.#tabs.get(id);
    if (!existing) {
      // Defensive: treat as create if we missed it
      const snap = toSnapshot(tab);
      this.#tabs.set(id, snap);
      this.#enqueue({ kind: 'created', tab: snap });
      return;
    }
    const changes: Partial<TabSnapshot> = {};
    if (changeInfo.title !== undefined) changes.title = changeInfo.title;
    if (changeInfo.favIconUrl !== undefined) changes.favIconUrl = changeInfo.favIconUrl;
    if (changeInfo.audible !== undefined) changes.audible = changeInfo.audible;
    if (changeInfo.pinned !== undefined) changes.pinned = changeInfo.pinned;
    if (Object.keys(changes).length === 0) return;
    Object.assign(existing, changes);
    this.#enqueue({ kind: 'updated', id, changes });
  };

  #onRemoved = (id: number) => {
    if (!this.#tabs.delete(id)) return;
    this.#enqueue({ kind: 'removed', id });
  };

  #onActivated = (info: browser.tabs._OnActivatedActiveInfo) => {
    for (const t of this.#tabs.values()) {
      if (t.windowId !== info.windowId) continue;
      const wasActive = t.active;
      t.active = t.id === info.tabId;
      if (t.active !== wasActive) {
        this.#enqueue({ kind: 'updated', id: t.id, changes: { active: t.active } });
      }
    }
    this.#enqueue({ kind: 'activated', id: info.tabId, windowId: info.windowId });
  };

  #onMoved = (id: number, info: browser.tabs._OnMovedMoveInfo) => {
    const t = this.#tabs.get(id);
    if (!t) return;
    t.index = info.toIndex;
    this.#enqueue({ kind: 'updated', id, changes: { index: info.toIndex } });
  };

  #enqueue(delta: TabDelta): void {
    this.#pending.push(delta);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    // requestAnimationFrame may not exist in some background contexts; fall
    // back to a 16ms timer that approximates a single frame.
    const flush = () => {
      this.#flushScheduled = false;
      const batch = this.#pending;
      this.#pending = [];
      if (batch.length === 0) return;
      for (const l of this.#listeners) l(batch);
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 16);
    }
  }
}
