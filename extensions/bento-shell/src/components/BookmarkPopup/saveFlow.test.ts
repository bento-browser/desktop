import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkItem, BookmarksSnapshot } from '@shared/protocol';

import {
  EMPTY_SPACE_SNAPSHOT,
  FIRST_RUN_SNAPSHOT,
  LOAD_FAILED_SNAPSHOT,
  SAMPLE_SNAPSHOT,
} from '../../state/__fixtures__/bookmarks';
import type { BookmarksAction } from '../BookmarksView/types';
import { SAVE_ACK_MS, createSaveFlow, createSaveLedger, type SaveLedger } from './saveFlow';

const PAGE = 'https://page.test/a';
const OTHER = 'https://page.test/b';

type Save = Extract<BookmarksAction, { type: 'bookmarks/tabs/save' }>;
type GroupCreate = Extract<BookmarksAction, { type: 'bookmarks/group/create' }>;

const saves = (actions: BookmarksAction[]) =>
  actions.filter((action): action is Save => action.type === 'bookmarks/tabs/save');
const creates = (actions: BookmarksAction[]) =>
  actions.filter((action): action is GroupCreate => action.type === 'bookmarks/group/create');

/** The snapshot after tools applied `actions` (just enough of the store: new groups and links). */
function applied(snapshot: BookmarksSnapshot, actions: BookmarksAction[]): BookmarksSnapshot {
  const groups = [...snapshot.groups];
  const items = [...snapshot.items];
  for (const action of actions) {
    if (action.type === 'bookmarks/group/create') {
      groups.push({
        id: action.id!,
        spaceId: action.spaceId,
        name: action.name,
        color: 'gray',
        order: groups.length,
      });
    }
    if (action.type === 'bookmarks/tabs/save') {
      action.ids?.forEach((id) =>
        items.push({
          id,
          groupId: action.groupId!,
          order: items.length,
          createdAt: Date.now(),
          kind: 'link',
          url: PAGE,
          title: 'Page',
        } satisfies BookmarkItem),
      );
    }
  }
  return { ...snapshot, groups, items };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('the save ledger', () => {
  it('sends one save for a page asked for twice before the first lands', () => {
    const ledger = createSaveLedger();
    const first = ledger.plan(SAMPLE_SNAPSHOT, PAGE, 4)!;
    const second = ledger.plan(SAMPLE_SNAPSHOT, PAGE, 4)!;

    expect(saves(first.actions)).toHaveLength(1);
    expect(saves(first.actions)[0]!.ids).toEqual([first.itemId]);
    expect(second.actions).toEqual([]);
    expect(second.itemId).toBe(first.itemId);
  });

  it('saves different pages separately', () => {
    const ledger = createSaveLedger();
    const first = ledger.plan(SAMPLE_SNAPSHOT, PAGE, 4)!;
    const second = ledger.plan(SAMPLE_SNAPSHOT, OTHER, 5)!;

    expect(second.itemId).not.toBe(first.itemId);
    expect(saves(second.actions)).toHaveLength(1);
  });

  it('creates one Unsorted group per space while it is not in the snapshot yet', () => {
    const ledger = createSaveLedger();
    const first = ledger.plan(FIRST_RUN_SNAPSHOT, PAGE, 4)!;
    const again = ledger.plan(FIRST_RUN_SNAPSHOT, PAGE, 4)!;
    const next = ledger.plan(FIRST_RUN_SNAPSHOT, OTHER, 5)!;

    const [group] = creates(first.actions);
    expect(group).toMatchObject({ spaceId: 'space-personal', name: 'Unsorted' });
    expect(again.actions).toEqual([]);
    // Another page saved meanwhile goes into the group already being created.
    expect(creates(next.actions)).toEqual([]);
    expect(saves(first.actions)[0]!.groupId).toBe(group!.id);
    expect(saves(next.actions)[0]!.groupId).toBe(group!.id);
  });

  it('uses the group once the snapshot has it, not a new one', () => {
    const ledger = createSaveLedger();
    const first = ledger.plan(FIRST_RUN_SNAPSHOT, PAGE, 4)!;
    const landed = applied(FIRST_RUN_SNAPSHOT, first.actions);
    const next = ledger.plan(landed, OTHER, 5)!;

    expect(creates(next.actions)).toEqual([]);
    expect(saves(next.actions)[0]!.groupId).toBe(creates(first.actions)[0]!.id);
  });

  it('edits the link in the snapshot instead of saving again once the save landed', () => {
    const ledger = createSaveLedger();
    const first = ledger.plan(SAMPLE_SNAPSHOT, PAGE, 4)!;
    const landed = applied(SAMPLE_SNAPSHOT, first.actions);
    const again = ledger.plan(landed, PAGE, 4)!;

    expect(again).toEqual({ itemId: first.itemId, actions: [] });
  });

  it('saves again when the save never landed and the wait is over', () => {
    let now = 1000;
    const ledger = createSaveLedger({ now: () => now });
    const first = ledger.plan(FIRST_RUN_SNAPSHOT, PAGE, 4)!;
    now += SAVE_ACK_MS - 1;
    expect(ledger.plan(FIRST_RUN_SNAPSHOT, PAGE, 4)!.actions).toEqual([]);
    now += 1;
    const retry = ledger.plan(FIRST_RUN_SNAPSHOT, PAGE, 4)!;

    expect(retry.itemId).not.toBe(first.itemId);
    expect(creates(retry.actions)).toHaveLength(1);
    expect(creates(retry.actions)[0]!.id).not.toBe(creates(first.actions)[0]!.id);
    expect(saves(retry.actions)).toHaveLength(1);
  });

  it('saves again after the attempt is settled, even if the link is gone from the snapshot', () => {
    const ledger = createSaveLedger();
    const first = ledger.plan(SAMPLE_SNAPSHOT, PAGE, 4)!;
    ledger.settle(first.itemId);
    const second = ledger.plan(SAMPLE_SNAPSHOT, PAGE, 4)!;

    expect(second.itemId).not.toBe(first.itemId);
    expect(saves(second.actions)).toHaveLength(1);
  });

  it('plans nothing when there is nowhere to save', () => {
    const ledger = createSaveLedger();
    expect(ledger.plan(LOAD_FAILED_SNAPSHOT, PAGE, 4)).toBeNull();
    expect(ledger.plan({ ...SAMPLE_SNAPSHOT, spaces: [], groups: [], items: [] }, PAGE, 4)).toBeNull();
  });
});

describe('a popover save', () => {
  function popover(ledger: SaveLedger, sent: BookmarksAction[]) {
    const close = vi.fn();
    const onItem = vi.fn();
    const flow = createSaveFlow({
      key: PAGE,
      tabId: 4,
      ledger,
      send: (action) => sent.push(action),
      close,
      onItem,
    });
    return { flow, close, onItem };
  }

  it('does not count the time spent loading the snapshot against the wait for the save', () => {
    const sent: BookmarksAction[] = [];
    const { flow, close } = popover(createSaveLedger(), sent);

    flow.update(null);
    vi.advanceTimersByTime(SAVE_ACK_MS * 2);
    expect(sent).toEqual([]);

    flow.update(SAMPLE_SNAPSHOT);
    expect(saves(sent)).toHaveLength(1);
    vi.advanceTimersByTime(SAVE_ACK_MS - 1);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('keeps the popover when the link arrives within the wait, and stops waiting', () => {
    const sent: BookmarksAction[] = [];
    const { flow, close, onItem } = popover(createSaveLedger(), sent);
    flow.update(SAMPLE_SNAPSHOT);
    vi.advanceTimersByTime(SAVE_ACK_MS - 100);
    flow.update(applied(SAMPLE_SNAPSHOT, sent));

    expect(onItem).toHaveBeenCalledWith(saves(sent)[0]!.ids![0]);
    vi.advanceTimersByTime(SAVE_ACK_MS * 3);
    expect(close).not.toHaveBeenCalled();
  });

  it('closes when the link it showed is deleted elsewhere', () => {
    const sent: BookmarksAction[] = [];
    const { flow, close } = popover(createSaveLedger(), sent);
    flow.update(SAMPLE_SNAPSHOT);
    flow.update(applied(SAMPLE_SNAPSHOT, sent));
    expect(close).not.toHaveBeenCalled();

    flow.update(SAMPLE_SNAPSHOT);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('saves a page once when a second popover replaces the first before the save lands', () => {
    const ledger = createSaveLedger();
    const sent: BookmarksAction[] = [];
    const first = popover(ledger, sent);
    first.flow.update(EMPTY_SPACE_SNAPSHOT);
    first.flow.dispose();
    const second = popover(ledger, sent);
    second.flow.update(EMPTY_SPACE_SNAPSHOT);

    expect(creates(sent)).toHaveLength(1);
    expect(saves(sent)).toHaveLength(1);
    expect(second.onItem).toHaveBeenCalledWith(first.onItem.mock.calls[0]![0]);

    const landed = applied(EMPTY_SPACE_SNAPSHOT, sent);
    second.flow.update(landed);
    vi.advanceTimersByTime(SAVE_ACK_MS * 2);
    expect(second.close).not.toHaveBeenCalled();
  });

  it('lets a later popover save again after a save was lost', () => {
    const ledger = createSaveLedger();
    const sent: BookmarksAction[] = [];
    const first = popover(ledger, sent);
    first.flow.update(SAMPLE_SNAPSHOT);
    vi.advanceTimersByTime(SAVE_ACK_MS);
    expect(first.close).toHaveBeenCalledTimes(1);

    const second = popover(ledger, sent);
    second.flow.update(SAMPLE_SNAPSHOT);
    expect(saves(sent)).toHaveLength(2);
    expect(second.onItem.mock.calls[0]![0]).not.toBe(first.onItem.mock.calls[0]![0]);
  });

  it('stops waiting while the stored bookmarks cannot be read, and resumes when a retry loads', () => {
    const sent: BookmarksAction[] = [];
    const { flow, close } = popover(createSaveLedger(), sent);
    flow.update(SAMPLE_SNAPSHOT);
    flow.update(LOAD_FAILED_SNAPSHOT);
    vi.advanceTimersByTime(SAVE_ACK_MS * 2);
    expect(close).not.toHaveBeenCalled();

    flow.update(SAMPLE_SNAPSHOT);
    vi.advanceTimersByTime(SAVE_ACK_MS - 1);
    expect(close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(saves(sent)).toHaveLength(1);
  });

  it('saves again when a page is removed and saved once more right after', () => {
    const ledger = createSaveLedger();
    const sent: BookmarksAction[] = [];
    const first = popover(ledger, sent);
    first.flow.update(SAMPLE_SNAPSHOT);
    first.flow.update(applied(SAMPLE_SNAPSHOT, sent));
    // Remove deletes the link; the snapshot is back to what it was.
    first.flow.dispose();

    const second = popover(ledger, sent);
    second.flow.update(SAMPLE_SNAPSHOT);
    expect(saves(sent)).toHaveLength(2);
  });

  it('closes at once when there is nowhere to save', () => {
    const { flow, close } = popover(createSaveLedger(), []);
    flow.update({ ...SAMPLE_SNAPSHOT, spaces: [], groups: [], items: [] });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does nothing after dispose', () => {
    const sent: BookmarksAction[] = [];
    const { flow, close } = popover(createSaveLedger(), sent);
    flow.update(SAMPLE_SNAPSHOT);
    flow.dispose();
    vi.advanceTimersByTime(SAVE_ACK_MS * 2);
    flow.update(SAMPLE_SNAPSHOT);
    expect(close).not.toHaveBeenCalled();
    expect(saves(sent)).toHaveLength(1);
  });
});
