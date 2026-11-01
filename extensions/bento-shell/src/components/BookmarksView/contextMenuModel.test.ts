import { describe, expect, it, vi } from 'vitest';

import { SAMPLE_SNAPSHOT, SAMPLE_TABS } from '../../state/__fixtures__/bookmarks';
import {
  contextMenuFor,
  routeContextKey,
  routeContextMenu,
  type ContextModel,
  type Probe,
} from './contextMenuModel';
import type { MenuEntry } from './menuEntries';
import { buildBoard, groupChoices } from './model';

/** A plain stand-in for a DOM element: a tag, attributes and a parent. */
function el(
  tagName: string,
  attrs: Record<string, string> = {},
  parent: Probe | null = null,
): Probe {
  return { tagName, parentElement: parent, getAttribute: (name) => attrs[name] ?? null };
}

/** The shape of the view: boards > column > row > button, drawer > tab row, spaces > space. */
const board = el('DIV', { 'data-bm-board': '' });
const column = el('SECTION', { 'data-bm-group-id': 'g1' }, board);
const row = el('DIV', { 'data-bm-item-id': 'i1' }, column);
const rowButton = el('BUTTON', {}, row);
const header = el('HEADER', {}, column);
const tabRow = el('LI', { 'data-bm-tab-id': '12' }, el('ASIDE'));
const space = el('LI', { 'data-bm-space-id': 's1' }, el('UL', {}, el('NAV')));

describe('routing a right-click', () => {
  it('opens the menu of the row, column, space, open tab or board under the pointer', () => {
    expect(routeContextMenu(rowButton)).toEqual({
      route: 'menu',
      target: { kind: 'item', id: 'i1' },
    });
    expect(routeContextMenu(el('SPAN', {}, el('SPAN', {}, rowButton)))).toEqual({
      route: 'menu',
      target: { kind: 'item', id: 'i1' },
    });
    expect(routeContextMenu(header)).toEqual({
      route: 'menu',
      target: { kind: 'group', id: 'g1' },
    });
    expect(routeContextMenu(el('SPAN', {}, tabRow))).toEqual({
      route: 'menu',
      target: { kind: 'tab', id: 12 },
    });
    expect(routeContextMenu(el('SPAN', {}, space))).toEqual({
      route: 'menu',
      target: { kind: 'space', id: 's1' },
    });
    expect(routeContextMenu(board)).toEqual({ route: 'menu', target: { kind: 'board' } });
  });

  it('takes the nearest one: a row inside a column inside the board is the row', () => {
    expect(routeContextMenu(row)).toEqual({ route: 'menu', target: { kind: 'item', id: 'i1' } });
    expect(routeContextMenu(column)).toEqual({
      route: 'menu',
      target: { kind: 'group', id: 'g1' },
    });
  });

  it('keeps the native menu for text fields, so cut, copy, paste and spelling work', () => {
    const inRow = (tag: string, attrs: Record<string, string> = {}) => el(tag, attrs, row);
    expect(routeContextMenu(inRow('INPUT'))).toEqual({ route: 'native' });
    expect(routeContextMenu(inRow('INPUT', { type: 'search' }))).toEqual({ route: 'native' });
    expect(routeContextMenu(inRow('INPUT', { type: 'TEXT' }))).toEqual({ route: 'native' });
    expect(routeContextMenu(inRow('TEXTAREA'))).toEqual({ route: 'native' });
    expect(routeContextMenu(el('input', { type: 'text' }))).toEqual({ route: 'native' });
  });

  it('does not treat a checkbox or a button input as a text field', () => {
    expect(routeContextMenu(el('INPUT', { type: 'checkbox' }, row))).toEqual({
      route: 'menu',
      target: { kind: 'item', id: 'i1' },
    });
    expect(routeContextMenu(el('INPUT', { type: 'button' }, row)).route).toBe('menu');
  });

  it('suppresses the native menu and opens nothing anywhere else', () => {
    expect(routeContextMenu(el('H1', {}, el('HEADER', {}, el('SECTION'))))).toEqual({
      route: 'suppress',
    });
    expect(routeContextMenu(el('BODY'))).toEqual({ route: 'suppress' });
    expect(routeContextMenu(null)).toEqual({ route: 'suppress' });
  });

  it('ignores an open-tab id that is not a number', () => {
    expect(routeContextMenu(el('LI', { 'data-bm-tab-id': 'x' }))).toEqual({ route: 'suppress' });
    expect(routeContextMenu(el('LI', { 'data-bm-tab-id': '' }))).toEqual({ route: 'suppress' });
  });
});

describe('opening from the keyboard', () => {
  const key = (name: string, shiftKey = false) => ({ key: name, shiftKey });

  it('opens the menu of the focused element on the Menu key and on Shift+F10', () => {
    const route = { route: 'menu', target: { kind: 'item', id: 'i1' } };
    expect(routeContextKey(key('ContextMenu'), rowButton)).toEqual(route);
    expect(routeContextKey(key('F10', true), rowButton)).toEqual(route);
    expect(routeContextKey(key('ContextMenu'), header)).toEqual({
      route: 'menu',
      target: { kind: 'group', id: 'g1' },
    });
  });

  it('leaves every other key alone, including F10 without Shift', () => {
    expect(routeContextKey(key('F10'), rowButton)).toBeNull();
    expect(routeContextKey(key('Enter'), rowButton)).toBeNull();
    expect(routeContextKey(key('F10', true), null)).toEqual({ route: 'suppress' });
  });

  it('keeps the native menu in a text field and suppresses it where nothing is offered', () => {
    expect(routeContextKey(key('ContextMenu'), el('INPUT', { type: 'search' }))).toEqual({
      route: 'native',
    });
    expect(routeContextKey(key('ContextMenu'), el('BODY'))).toEqual({ route: 'suppress' });
  });
});

describe('what the menu offers', () => {
  const snapshotBoard = buildBoard(SAMPLE_SNAPSHOT);
  const model = (overrides: Partial<ContextModel> = {}): ContextModel => ({
    board: snapshotBoard,
    openTabs: SAMPLE_TABS,
    groups: groupChoices(snapshotBoard.groups),
    handlers: {
      send: vi.fn(),
      onEdit: vi.fn(),
      onOpen: vi.fn(),
      onCopy: vi.fn(),
      onDelete: vi.fn(),
      onMove: vi.fn(),
      onMoveGroup: vi.fn(),
      onOpenAll: vi.fn(),
      onDeleteGroup: vi.fn(),
      onDeleteSpace: vi.fn(),
      onSaveAllTabs: vi.fn(),
      onSaveTab: vi.fn(),
    },
    ...overrides,
  });
  const ids = (entries: readonly MenuEntry[]) => entries.map((entry) => entry.id);
  const find = (entries: readonly MenuEntry[], id: string) =>
    entries.find((entry) => entry.id === id);

  const gyms = snapshotBoard.groups.find((entry) => entry.group.id === 'group-gyms')!;

  it('gives a row the neighbour slots of its place in its column', () => {
    const first = gyms.items[0]!;
    const last = gyms.items.at(-1)!;
    const menuOf = (id: string) => {
      const content = contextMenuFor({ kind: 'item', id }, model());
      const move = find(content!.entries, 'move');
      return move?.type === 'submenu' ? move.entries : [];
    };
    expect(find(menuOf(first.id), 'move-up')).toMatchObject({ disabled: true });
    expect(find(menuOf(first.id), 'move-down')).toMatchObject({ disabled: false });
    expect(find(menuOf(last.id), 'move-up')).toMatchObject({ disabled: false });
    expect(find(menuOf(last.id), 'move-down')).toMatchObject({ disabled: true });
  });

  it('names a row by its title and lists the link actions', () => {
    const content = contextMenuFor({ kind: 'item', id: gyms.items[1]!.id }, model())!;
    expect(content.label).toBe('Actions for Northside Boulders');
    expect(ids(content.entries)).toEqual([
      'open-panel',
      'open-tab',
      'copy-link',
      'edit',
      'move',
      'separator',
      'delete',
    ]);
  });

  it('gives a column Move left and Move right by its place among the columns', () => {
    const entriesOf = (id: string) => contextMenuFor({ kind: 'group', id }, model())!.entries;
    const first = snapshotBoard.groups[0]!.group.id;
    const last = snapshotBoard.groups.at(-1)!.group.id;
    expect(find(entriesOf(first), 'move-left')).toMatchObject({ disabled: true });
    expect(find(entriesOf(first), 'move-right')).toMatchObject({ disabled: false });
    expect(find(entriesOf(last), 'move-right')).toMatchObject({ disabled: true });
    expect(ids(entriesOf('group-gyms'))).toEqual([
      'open-all',
      'rename',
      'colour',
      'move-left',
      'move-right',
      'separator',
      'delete',
    ]);
  });

  it('gives a space Rename, Colour and Delete space', () => {
    const content = contextMenuFor({ kind: 'space', id: 'space-trip' }, model())!;
    expect(content.label).toBe('Actions for Trip planning');
    expect(ids(content.entries)).toEqual(['rename', 'colour', 'separator', 'delete']);
  });

  it('gives an open tab Save to group', () => {
    const tab = SAMPLE_TABS[0]!;
    const content = contextMenuFor({ kind: 'tab', id: tab.id }, model())!;
    expect(ids(content.entries)).toEqual(['save-to-group']);
  });

  it('gives the board New group, and Save all open tabs while tabs are open', () => {
    expect(ids(contextMenuFor({ kind: 'board' }, model())!.entries)).toEqual([
      'new-group',
      'save-all-tabs',
    ]);
    expect(ids(contextMenuFor({ kind: 'board' }, model({ openTabs: [] }))!.entries)).toEqual([
      'new-group',
    ]);
  });

  it('gives nothing for an element that is gone', () => {
    expect(contextMenuFor({ kind: 'item', id: 'gone' }, model())).toBeNull();
    expect(contextMenuFor({ kind: 'group', id: 'gone' }, model())).toBeNull();
    expect(contextMenuFor({ kind: 'space', id: 'gone' }, model())).toBeNull();
    expect(contextMenuFor({ kind: 'tab', id: -1 }, model())).toBeNull();
    expect(
      contextMenuFor({ kind: 'board' }, model({ board: { ...snapshotBoard, current: null } })),
    ).toBeNull();
  });
});
