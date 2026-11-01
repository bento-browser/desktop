import { describe, expect, it, vi } from 'vitest';
import type { BookmarkGroup, BookmarkItem } from '@shared/protocol';

import {
  boardEntries,
  groupEntries,
  itemEntries,
  spaceEntries,
  tabEntries,
  type GroupHandlers,
  type ItemHandlers,
  type MenuEntry,
  type SpaceHandlers,
} from './menuEntries';
import type { GroupChoice, OpenTab } from './types';

const ids = (entries: readonly MenuEntry[]) => entries.map((entry) => entry.id);
const find = (entries: readonly MenuEntry[], id: string) =>
  entries.find((entry) => entry.id === id);
const submenu = (entries: readonly MenuEntry[], id: string) => {
  const entry = find(entries, id);
  if (entry?.type !== 'submenu') throw new Error(`${id} is not a submenu`);
  return entry.entries;
};
const run = (entries: readonly MenuEntry[], id: string) => {
  const entry = find(entries, id);
  if (entry?.type !== 'action') throw new Error(`${id} is not an action`);
  entry.onAction?.();
};

const link: BookmarkItem = {
  id: 'i-link',
  groupId: 'g1',
  order: 0,
  createdAt: 0,
  kind: 'link',
  url: 'https://example.com/a',
  title: 'Example',
};
const note: BookmarkItem = {
  id: 'i-note',
  groupId: 'g1',
  order: 1,
  createdAt: 0,
  kind: 'note',
  text: 'hi',
};
const todo: BookmarkItem = {
  id: 'i-todo',
  groupId: 'g1',
  order: 2,
  createdAt: 0,
  kind: 'todo',
  text: 'Call',
  done: false,
};
const groups: GroupChoice[] = [
  { id: 'g1', name: 'One', color: 'red' },
  { id: 'g2', name: 'Two', color: 'blue' },
];
const slots = { groups, moveUpBefore: 'i-before', moveDownBefore: null } as const;

function handlers() {
  return {
    send: vi.fn(),
    onEdit: vi.fn(),
    onOpen: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
  } satisfies ItemHandlers;
}

describe('an item row menu', () => {
  it('offers a link Open in panel, Open in new tab, Copy link, Edit, Move and Delete', () => {
    expect(ids(itemEntries(link, slots, handlers()))).toEqual([
      'open-panel',
      'open-tab',
      'copy-link',
      'edit',
      'move',
      'separator',
      'delete',
    ]);
  });

  it('offers a note only Edit, Move and Delete', () => {
    expect(ids(itemEntries(note, slots, handlers()))).toEqual([
      'edit',
      'move',
      'separator',
      'delete',
    ]);
  });

  it('offers a to-do Mark done, or Mark not done once it is ticked', () => {
    const open = itemEntries(todo, slots, handlers());
    expect(ids(open)).toEqual(['edit', 'done', 'move', 'separator', 'delete']);
    expect(find(open, 'done')).toMatchObject({ label: 'Mark done' });
    const ticked = itemEntries({ ...todo, done: true }, slots, handlers());
    expect(find(ticked, 'done')).toMatchObject({ label: 'Mark not done' });
  });

  it('sends each choice to its handler', () => {
    const on = handlers();
    const entries = itemEntries(link, slots, on);
    run(entries, 'open-panel');
    run(entries, 'open-tab');
    run(entries, 'copy-link');
    run(entries, 'edit');
    run(entries, 'delete');
    expect(on.onOpen.mock.calls).toEqual([
      ['i-link', 'panel'],
      ['i-link', 'tab'],
    ]);
    expect(on.onCopy).toHaveBeenCalledWith('https://example.com/a');
    expect(on.onEdit).toHaveBeenCalledWith({ kind: 'item', id: 'i-link' });
    expect(on.onDelete).toHaveBeenCalledWith(link);

    const todoOn = handlers();
    run(itemEntries(todo, slots, todoOn), 'done');
    expect(todoOn.send).toHaveBeenCalledWith({
      type: 'bookmarks/item/update',
      id: 'i-todo',
      done: true,
    });
  });

  it('puts Move to group (the other groups), Move up and Move down in the Move submenu', () => {
    const on = handlers();
    const move = submenu(itemEntries(link, slots, on), 'move');
    expect(ids(move)).toEqual(['move-group', 'move-up', 'move-down']);
    expect(ids(submenu(move, 'move-group'))).toEqual(['group:g2']);
    run(submenu(move, 'move-group'), 'group:g2');
    run(move, 'move-up');
    run(move, 'move-down');
    expect(on.onMove.mock.calls).toEqual([
      ['i-link', 'g2', null],
      ['i-link', 'g1', 'i-before'],
      ['i-link', 'g1', null],
    ]);
  });

  it('disables a move that is not possible, and Move to group with no other group', () => {
    const edge = itemEntries(
      link,
      { groups: [groups[0]!], moveUpBefore: undefined, moveDownBefore: undefined },
      handlers(),
    );
    const move = submenu(edge, 'move');
    expect(find(move, 'move-group')).toMatchObject({ type: 'action', disabled: true });
    expect(find(move, 'move-up')).toMatchObject({ disabled: true, onAction: undefined });
    expect(find(move, 'move-down')).toMatchObject({ disabled: true, onAction: undefined });
  });
});

describe('a group menu', () => {
  const group: BookmarkGroup = { id: 'g1', spaceId: 's', order: 0, name: 'One', color: 'green' };
  const on = (): GroupHandlers => ({
    send: vi.fn(),
    onEdit: vi.fn(),
    onMoveGroup: vi.fn(),
    onOpenAll: vi.fn(),
    onDeleteGroup: vi.fn(),
  });

  it('offers Open all (counting the links), Rename, Colour, Move left, Move right and Delete group', () => {
    const entries = groupEntries(
      group,
      [link, note, todo],
      { moveLeftBefore: 'a', moveRightBefore: null },
      on(),
    );
    expect(ids(entries)).toEqual([
      'open-all',
      'rename',
      'colour',
      'move-left',
      'move-right',
      'separator',
      'delete',
    ]);
    expect(find(entries, 'open-all')).toMatchObject({ label: 'Open all 1 in panels' });
    expect(find(entries, 'delete')).toMatchObject({ label: 'Delete group' });
  });

  it('leaves out Open all when the group has no links', () => {
    const entries = groupEntries(
      group,
      [note],
      { moveLeftBefore: undefined, moveRightBefore: undefined },
      on(),
    );
    expect(ids(entries)).not.toContain('open-all');
    expect(find(entries, 'move-left')).toMatchObject({ disabled: true });
    expect(find(entries, 'move-right')).toMatchObject({ disabled: true });
  });

  it('sends each choice to its handler', () => {
    const handlersOf = on();
    const entries = groupEntries(
      group,
      [link, note],
      { moveLeftBefore: 'a', moveRightBefore: null },
      handlersOf,
    );
    run(entries, 'open-all');
    run(entries, 'rename');
    run(entries, 'move-left');
    run(entries, 'move-right');
    run(entries, 'delete');
    run(submenu(entries, 'colour'), 'colour:purple');
    expect(handlersOf.onOpenAll).toHaveBeenCalledWith([link]);
    expect(handlersOf.onEdit).toHaveBeenCalledWith({ kind: 'group', id: 'g1' });
    expect(vi.mocked(handlersOf.onMoveGroup).mock.calls).toEqual([
      ['g1', 'a'],
      ['g1', null],
    ]);
    expect(handlersOf.onDeleteGroup).toHaveBeenCalledWith(group, 2);
    expect(handlersOf.send).toHaveBeenCalledWith({
      type: 'bookmarks/group/update',
      id: 'g1',
      color: 'purple',
    });
  });

  it('ticks the current colour in the Colour submenu', () => {
    const colours = submenu(
      groupEntries(group, [], { moveLeftBefore: undefined, moveRightBefore: undefined }, on()),
      'colour',
    );
    expect(colours).toHaveLength(7);
    expect(
      colours.filter((entry) => entry.type === 'action' && entry.checked).map((entry) => entry.id),
    ).toEqual(['colour:green']);
  });
});

describe('a space menu', () => {
  const summary = {
    space: { id: 's1', name: 'Trip', color: 'red' as const, order: 0 },
    groupCount: 0,
    linkCount: 0,
  };
  const on = (): SpaceHandlers => ({ send: vi.fn(), onEdit: vi.fn(), onDeleteSpace: vi.fn() });

  it('offers Rename, Colour and Delete space, and no column or link actions', () => {
    const handlersOf = on();
    const entries = spaceEntries(summary, handlersOf);
    expect(ids(entries)).toEqual(['rename', 'colour', 'separator', 'delete']);
    expect(find(entries, 'delete')).toMatchObject({ label: 'Delete space' });
    run(entries, 'rename');
    run(entries, 'delete');
    run(submenu(entries, 'colour'), 'colour:blue');
    expect(handlersOf.onEdit).toHaveBeenCalledWith({ kind: 'space', id: 's1' });
    expect(handlersOf.onDeleteSpace).toHaveBeenCalledWith(summary);
    expect(handlersOf.send).toHaveBeenCalledWith({
      type: 'bookmarks/space/update',
      id: 's1',
      color: 'blue',
    });
  });
});

describe('an open tab menu', () => {
  const tab: OpenTab = { id: 7, title: 'Moon', url: 'https://moon.example/' };

  it('offers Save to group with every group, then New group', () => {
    const save = vi.fn();
    const entries = tabEntries(tab, groups, save);
    expect(ids(entries)).toEqual(['save-to-group']);
    const picker = submenu(entries, 'save-to-group');
    expect(ids(picker)).toEqual(['group:g1', 'group:g2', 'group:separator', 'group:new']);
    run(picker, 'group:g2');
    run(picker, 'group:new');
    expect(save.mock.calls).toEqual([
      [tab, 'g2'],
      [tab, null],
    ]);
  });

  it('still offers New group in a space with no group', () => {
    const picker = submenu(tabEntries(tab, [], vi.fn()), 'save-to-group');
    expect(ids(picker)).toEqual(['group:new']);
  });
});

describe('the board menu', () => {
  it('offers New group, and Save all open tabs only while tabs are open', () => {
    const on = { onEdit: vi.fn(), onSaveAllTabs: vi.fn() };
    const withTabs = boardEntries(3, on);
    expect(ids(withTabs)).toEqual(['new-group', 'save-all-tabs']);
    run(withTabs, 'new-group');
    run(withTabs, 'save-all-tabs');
    expect(on.onEdit).toHaveBeenCalledWith({ kind: 'add-group' });
    expect(on.onSaveAllTabs).toHaveBeenCalledTimes(1);
    expect(ids(boardEntries(0, on))).toEqual(['new-group']);
  });
});
