// Selectors for the elements the view puts the focus on, and the neighbour slots the keyboard
// "Move up/down/left/right" menu items use. Pure strings and lists, tested without a DOM.

import type { EditTarget } from './types';

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

export const itemSelector = (id: string) => `[data-bm-item-id=${quote(id)}]`;
export const groupSelector = (id: string) => `[data-bm-group-id=${quote(id)}]`;

/** What scrolls into view for a new or restored id: a row or a column. */
export const revealSelector = (id: string) => `${itemSelector(id)}, ${groupSelector(id)}`;

/** The "Move" trigger of a row and the "..." trigger of a column header; the focus returns to them
 * after a keyboard move or rename. */
export const itemMenuSelector = (id: string) => `${itemSelector(id)} [data-bm-move-trigger]`;
export const groupMenuSelector = (id: string) =>
  `${groupSelector(id)} > header [data-bm-menu-trigger]`;

/** The "Link, note or to-do" button of a column. */
export const groupAddItemSelector = (id: string) => `${groupSelector(id)} [data-bm-add-item]`;

/** The first control of a row: the open button of a link or note, the checkbox of a to-do. */
export const itemMainSelector = (id: string) => `${itemSelector(id)} :is(button, input)`;

/** Where the focus goes when the editor `target` ends by keyboard: the row or the trigger that
 * opened it. */
export function editReturnSelector(target: EditTarget): string {
  switch (target.kind) {
    case 'item':
      return itemMainSelector(target.id);
    case 'group':
      return groupMenuSelector(target.id);
    case 'space':
      return `[data-bm-space-id=${quote(target.id)}] button`;
    case 'add-item':
      return groupAddItemSelector(target.groupId);
    case 'add-group':
      return '[data-bm-add-group]';
    case 'add-space':
      return '[data-bm-add-space]';
  }
}

/** The slots "Move up" and "Move down" (or left and right) put the entry at `index` of an ordered
 * list in, as the `beforeId` of the move: `earlier` is the neighbour before it, `later` the entry
 * after the next one (null: the end). Either is undefined when the entry cannot move that way. */
export function neighbourMoves(
  ids: readonly string[],
  index: number,
): { earlier: string | undefined; later: string | null | undefined } {
  return {
    earlier: index > 0 ? ids[index - 1] : undefined,
    later: index < ids.length - 1 ? (ids[index + 2] ?? null) : undefined,
  };
}
