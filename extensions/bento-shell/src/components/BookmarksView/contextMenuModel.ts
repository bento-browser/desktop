// The right-click menu of the Bookmarks view: which element a click or key press is about, whether
// the browser's own menu stays, and what the Bento menu offers. The page's native menu ("Bookmark
// Page", "Save Page As", "View Page Source") means nothing here, so the view replaces it.
//
//   - a text field (the search field, an inline editor): the native menu stays, for cut, copy,
//     paste and spelling;
//   - an element with actions (a row, a column, a space, an open tab, the board): the Bento menu;
//   - anything else: the native menu is suppressed and nothing opens.
//
// Pure: the DOM is read through the `Probe` shape and the entries come from menuEntries.ts, so it
// is tested on plain data.

import {
  boardEntries,
  groupEntries,
  itemEntries,
  spaceEntries,
  tabEntries,
  type BoardHandlers,
  type GroupHandlers,
  type ItemHandlers,
  type MenuEntry,
  type SaveTab,
  type SpaceHandlers,
} from './menuEntries';
import { itemLabel, type BoardModel } from './model';
import { neighbourMoves } from './focus';
import type { GroupChoice, OpenTab } from './types';

/** What a menu is about. */
export type ContextTarget =
  | { kind: 'item'; id: string }
  | { kind: 'group'; id: string }
  | { kind: 'space'; id: string }
  | { kind: 'tab'; id: number }
  | { kind: 'board' };

/** What the view does with a context-menu request. */
export type ContextRoute =
  { route: 'native' } | { route: 'suppress' } | { route: 'menu'; target: ContextTarget };

/** The part of a DOM element the routing reads, so a test can pass plain objects. */
export interface Probe {
  tagName: string;
  parentElement: Probe | null;
  getAttribute(name: string): string | null;
}

/** Inputs that take no typed text keep no native menu either. */
const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

function isTextField(element: Probe): boolean {
  const tag = element.tagName.toUpperCase();
  if (tag === 'TEXTAREA') return true;
  return (
    tag === 'INPUT' && !NON_TEXT_INPUTS.has((element.getAttribute('type') ?? '').toLowerCase())
  );
}

/** The nearest element that says what it is: a row, a tab, a column, a space or the board. */
function targetOf(element: Probe): ContextTarget | null {
  const itemId = element.getAttribute('data-bm-item-id');
  if (itemId !== null) return { kind: 'item', id: itemId };
  const tabId = element.getAttribute('data-bm-tab-id');
  if (tabId !== null && tabId !== '' && Number.isFinite(Number(tabId))) {
    return { kind: 'tab', id: Number(tabId) };
  }
  const groupId = element.getAttribute('data-bm-group-id');
  if (groupId !== null) return { kind: 'group', id: groupId };
  const spaceId = element.getAttribute('data-bm-space-id');
  if (spaceId !== null) return { kind: 'space', id: spaceId };
  if (element.getAttribute('data-bm-board') !== null) return { kind: 'board' };
  return null;
}

/** Decides what a right-click (or the context-menu key) on `element` does. */
export function routeContextMenu(element: Probe | null): ContextRoute {
  if (element && isTextField(element)) return { route: 'native' };
  for (let node = element; node; node = node.parentElement) {
    const target = targetOf(node);
    if (target) return { route: 'menu', target };
  }
  return { route: 'suppress' };
}

/** What a key press does: the Menu key and Shift+F10 open the menu of the focused element, as a
 * right-click on it would. Null for any other key, which the view leaves alone. */
export function routeContextKey(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
  focused: Probe | null,
): ContextRoute | null {
  const opens = event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
  return opens ? routeContextMenu(focused) : null;
}

// ---- What the menu offers -----------------------------------------------------------------

/** What the view hands over to build any of its context menus: the current screen and the same
 * handlers its rows, columns, spaces and tabs use. */
export interface ContextModel {
  board: BoardModel;
  openTabs: readonly OpenTab[];
  groups: readonly GroupChoice[];
  handlers: ItemHandlers & GroupHandlers & SpaceHandlers & BoardHandlers & { onSaveTab: SaveTab };
}

export interface ContextMenuContent {
  /** Names the menu for assistive technology. */
  label: string;
  entries: MenuEntry[];
}

/** The menu for `target`, or null when the element is gone (another window deleted it). */
export function contextMenuFor(
  target: ContextTarget,
  { board, openTabs, groups, handlers }: ContextModel,
): ContextMenuContent | null {
  switch (target.kind) {
    case 'item': {
      for (const column of board.groups) {
        const index = column.items.findIndex((entry) => entry.id === target.id);
        const item = column.items[index];
        if (!item) continue;
        const { earlier, later } = neighbourMoves(
          column.items.map((entry) => entry.id),
          index,
        );
        return {
          label: `Actions for ${itemLabel(item)}`,
          entries: itemEntries(
            item,
            { groups, moveUpBefore: earlier, moveDownBefore: later },
            handlers,
          ),
        };
      }
      return null;
    }
    case 'group': {
      const index = board.groups.findIndex((column) => column.group.id === target.id);
      const column = board.groups[index];
      if (!column) return null;
      const { earlier, later } = neighbourMoves(
        board.groups.map((entry) => entry.group.id),
        index,
      );
      return {
        label: `Actions for ${column.group.name}`,
        entries: groupEntries(
          column.group,
          column.items,
          { moveLeftBefore: earlier, moveRightBefore: later },
          handlers,
        ),
      };
    }
    case 'space': {
      const summary = board.spaces.find((entry) => entry.space.id === target.id);
      return summary
        ? { label: `Actions for ${summary.space.name}`, entries: spaceEntries(summary, handlers) }
        : null;
    }
    case 'tab': {
      const tab = openTabs.find((entry) => entry.id === target.id);
      return tab
        ? {
            label: `Save ${tab.title || tab.url}`,
            entries: tabEntries(tab, groups, handlers.onSaveTab),
          }
        : null;
    }
    case 'board':
      return board.current
        ? { label: 'Board actions', entries: boardEntries(openTabs.length, handlers) }
        : null;
  }
}
