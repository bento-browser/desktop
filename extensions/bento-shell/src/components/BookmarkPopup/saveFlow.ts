// The save the star and Cmd+D make when they open the edit popover, without React so the timing and
// the de-duplication are tested directly (EditPopover wraps it in a hook).
//
// A save reaches the snapshot a moment after it is sent, and the popup document can be asked again
// in between (Cmd+D twice, a star press while Cmd+D is still saving). Each ask is a new popover that
// starts from nothing, so the in-flight saves live in a ledger at module scope, keyed by page and by
// space, and a repeat reuses the client ids of the save already sent instead of sending another.

import type { BookmarksSnapshot } from '@shared/protocol';

import { UNSORTED_GROUP_NAME, defaultSaveTarget, newestLinkFor } from '../../bookmarks/links';
import { groupCreate, newId, tabsSave } from '../BookmarksView/actions';
import type { BookmarksAction } from '../BookmarksView/types';

/** How long a sent save may take to reach the snapshot before it counts as lost: the popover
 * closes and a later ask saves again. */
export const SAVE_ACK_MS = 3000;

/** What to do for one ask: the link the popover will edit, and the actions that make it. `actions`
 * is empty when the page is already saved or an earlier ask is still saving it. */
export interface SavePlan {
  itemId: string;
  actions: BookmarksAction[];
}

export interface SaveLedger {
  /** Plans the save of `key` (a `urlKey`) for the tab `tabId`. Null when there is nothing to save
   * into. */
  plan(snapshot: BookmarksSnapshot, key: string, tabId: number): SavePlan | null;
  /** The attempt that made `itemId` is over (acknowledged, lost or failed): the next ask for its
   * page starts afresh. */
  settle(itemId: string): void;
}

interface Pending {
  id: string;
  sentAt: number;
}

export function createSaveLedger(
  options: { ttlMs?: number; now?: () => number } = {},
): SaveLedger {
  const { ttlMs = SAVE_ACK_MS, now = () => Date.now() } = options;
  /** Saves sent and not yet in the snapshot, by page. */
  const saves = new Map<string, Pending>();
  /** "Unsorted" groups created and not yet in the snapshot, by space. */
  const groups = new Map<string, Pending>();

  const stale = (pending: Pending) => now() - pending.sentAt >= ttlMs;

  /** Forgets what the snapshot shows, or what has waited too long. */
  const prune = (snapshot: BookmarksSnapshot) => {
    const itemIds = new Set(snapshot.items.map((item) => item.id));
    const groupIds = new Set(snapshot.groups.map((group) => group.id));
    for (const [key, pending] of saves) {
      if (itemIds.has(pending.id) || stale(pending)) saves.delete(key);
    }
    for (const [spaceId, pending] of groups) {
      if (groupIds.has(pending.id) || stale(pending)) groups.delete(spaceId);
    }
  };

  return {
    plan(snapshot, key, tabId) {
      prune(snapshot);
      const existing = newestLinkFor(snapshot, key);
      if (existing) return { itemId: existing.id, actions: [] };
      const inFlight = saves.get(key);
      if (inFlight) return { itemId: inFlight.id, actions: [] };

      const target = defaultSaveTarget(snapshot);
      if (!target) return null;
      const actions: BookmarksAction[] = [];
      let groupId = target.groupId;
      if (groupId === null) {
        let created = groups.get(target.spaceId);
        if (!created) {
          created = { id: newId(), sentAt: now() };
          groups.set(target.spaceId, created);
          actions.push(groupCreate(target.spaceId, UNSORTED_GROUP_NAME, created.id));
        }
        groupId = created.id;
      }
      const itemId = newId();
      saves.set(key, { id: itemId, sentAt: now() });
      actions.push(tabsSave(target.spaceId, [tabId], { groupId, beforeId: null }, () => itemId));
      return { itemId, actions };
    },

    settle(itemId) {
      for (const [key, pending] of saves) {
        if (pending.id === itemId) saves.delete(key);
      }
    },
  };
}

/** The saves in flight in this document, shared by every popover it shows. */
export const saveLedger = createSaveLedger();

export interface SaveFlowOptions {
  /** `urlKey` of the page being saved. */
  key: string;
  tabId: number;
  ledger?: SaveLedger;
  send: (action: BookmarksAction) => void;
  /** Closes the popover; safe to call more than once. */
  close: () => void;
  /** The link the popover edits is known (found or being saved). It is not in the snapshot yet
   * when the save has just been sent. */
  onItem: (itemId: string) => void;
  waitMs?: number;
}

export interface SaveFlow {
  /** Feeds the latest snapshot, null until the first arrives. Call it on every change. */
  update(snapshot: BookmarksSnapshot | null): void;
  dispose(): void;
}

/**
 * One popover's save. It saves once, on the first ready snapshot, and then waits `waitMs` for the
 * snapshot to show the link: that wait starts when the save is sent, so loading the snapshot does
 * not use it up. A link that was shown and later disappears (deleted in the Bookmarks view) closes
 * the popover. Waiting for the first snapshot is bounded by the popup, which closes without one.
 */
export function createSaveFlow(options: SaveFlowOptions): SaveFlow {
  const { key, tabId, send, close, onItem, ledger = saveLedger, waitMs = SAVE_ACK_MS } = options;
  let itemId: string | null = null;
  let seen = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const stopWaiting = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  return {
    update(snapshot) {
      if (disposed || !snapshot) return;
      if (snapshot.status === 'loadFailed') {
        // The popover shows its own notice. What was sent is no longer being waited for, and a
        // Retry that loads again picks the wait up again.
        stopWaiting();
        if (itemId !== null) ledger.settle(itemId);
        return;
      }
      if (itemId === null) {
        const plan = ledger.plan(snapshot, key, tabId);
        if (!plan) {
          close();
          return;
        }
        for (const action of plan.actions) send(action);
        itemId = plan.itemId;
        onItem(itemId);
      }
      const present = snapshot.items.some((item) => item.id === itemId && item.kind === 'link');
      if (present) {
        seen = true;
        stopWaiting();
        ledger.settle(itemId);
        return;
      }
      if (seen) {
        stopWaiting();
        close();
        return;
      }
      const sent = itemId;
      timer ??= setTimeout(() => {
        ledger.settle(sent);
        close();
      }, waitMs);
    },

    dispose() {
      disposed = true;
      stopWaiting();
    },
  };
}
