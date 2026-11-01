// One group of the board: a header with the colour dot, name, count and menu, the rows, and the
// "+" entry for a link, note or to-do (shown while the column is hovered or holds the focus). The header is the handle for ordering columns (the menu has
// Move left and Move right for the keyboard); a double click renames. `AddGroupColumn` is the
// trailing "+ Group" column.

import { memo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button, Text } from '@muxui/react';
import Plus from 'lucide-react/dist/esm/icons/plus';
import {
  BOOKMARK_LIMITS,
  type BookmarkGroup,
  type BookmarkItem,
  type BookmarkItemInput,
} from '@shared/protocol';

import { BentoIcon } from '../primitives';
import { AddGroup } from './AddGroup';
import { EntityMenu } from './EntityMenu';
import { neighbourMoves } from './focus';
import { InlineEditor } from './InlineEditor';
import { ItemRow } from './ItemRow';
import { groupEntries, type GroupHandlers, type ItemHandlers } from './menuEntries';
import { parseAddInput } from './model';
import { isEditing, type EditHandler, type EditTarget, type GroupChoice } from './types';
import type { DragSource } from './useBoardDrag';

/** The column's menu handlers (`GroupHandlers`) and the ones it hands to its rows (`ItemHandlers`). */
export interface BoardColumnProps extends GroupHandlers, ItemHandlers {
  group: BookmarkGroup;
  items: BookmarkItem[];
  editing: EditTarget | null;
  /** The item being dragged, if any, so its row can dim. */
  draggingItemId: string | null;
  /** This whole column is being dragged. */
  dragging: boolean;
  /** The groups of the current space, for "Move to group". */
  groups: readonly GroupChoice[];
  /** The `beforeId` of "Move left" (the column before), undefined for the first column. */
  moveLeftBefore: string | undefined;
  /** The `beforeId` of "Move right" (null: the end), undefined for the last column. */
  moveRightBefore: string | null | undefined;
  onCreateItem: (groupId: string, item: BookmarkItemInput) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: DragSource) => void;
  isSuppressed: () => boolean;
}

function BoardColumnImpl({
  group,
  items,
  editing,
  draggingItemId,
  dragging,
  groups,
  moveLeftBefore,
  moveRightBefore,
  send,
  onEdit,
  onCreateItem,
  onMove,
  onMoveGroup,
  onOpen,
  onCopy,
  onDelete,
  onOpenAll,
  onDeleteGroup,
  onPointerDown,
  isSuppressed,
}: BoardColumnProps) {
  // Remounts the entry after an Enter so the next one can be typed straight away.
  const [entryKey, setEntryKey] = useState(0);
  const renaming = isEditing(editing, { kind: 'group', id: group.id });
  const adding = isEditing(editing, { kind: 'add-item', groupId: group.id });
  const itemIds = items.map((item) => item.id);

  return (
    <section
      className="bento-bookmarks__column"
      aria-label={group.name}
      data-bm-group-id={group.id}
      data-bm-flip={`group:${group.id}`}
      data-dragging={dragging ? 'true' : undefined}
    >
      <header
        className="bento-bookmarks__column-head"
        data-bm-group-header
        onPointerDownCapture={(event) => onPointerDown(event, { kind: 'group', id: group.id })}
        onDoubleClick={() => onEdit({ kind: 'group', id: group.id })}
      >
        <span className="bento-bookmarks__dot" data-bm-color={group.color} />
        {renaming ? (
          <InlineEditor
            label="Group name"
            initial={group.name}
            selectAll
            maxLength={BOOKMARK_LIMITS.name}
            className="bento-bookmarks__rename"
            onCommit={(text, reason) => {
              const name = text.trim();
              if (name && name !== group.name) {
                send({ type: 'bookmarks/group/update', id: group.id, name });
              }
              onEdit(null, reason === 'enter');
            }}
            onCancel={() => onEdit(null, true)}
          />
        ) : (
          <Text variant="label" size="sm" truncate className="bento-bookmarks__column-name">
            {group.name}
          </Text>
        )}
        <Text variant="body" size="sm" color="muted" className="bento-bookmarks__count">
          {items.length}
        </Text>
        <EntityMenu
          label={`Actions for ${group.name}`}
          entries={groupEntries(
            group,
            items,
            { moveLeftBefore, moveRightBefore },
            { send, onEdit, onMoveGroup, onOpenAll, onDeleteGroup },
          )}
        />
      </header>
      <div className="bento-bookmarks__list" role="list" data-bm-list>
        {items.map((item, index) => {
          const { earlier, later } = neighbourMoves(itemIds, index);
          return (
            <ItemRow
              key={item.id}
              item={item}
              editing={isEditing(editing, { kind: 'item', id: item.id })}
              dragging={draggingItemId === item.id}
              groups={groups}
              moveUpBefore={earlier}
              moveDownBefore={later}
              send={send}
              onEdit={onEdit}
              onOpen={onOpen}
              onCopy={onCopy}
              onDelete={onDelete}
              onMove={onMove}
              onPointerDown={onPointerDown}
              isSuppressed={isSuppressed}
            />
          );
        })}
      </div>
      <footer className="bento-bookmarks__column-foot">
        {adding ? (
          <InlineEditor
            key={entryKey}
            label="New link, note or to-do"
            placeholder="Paste a link, write a note, or start with []"
            multiline
            maxLength={BOOKMARK_LIMITS.text}
            hint={
              <>
                <span>Enter to save</span>
                <span>Esc to cancel</span>
                <span>[] for a to-do</span>
              </>
            }
            onCommit={(text, reason) => {
              const item = parseAddInput(text);
              if (item) onCreateItem(group.id, item);
              if (item && reason === 'enter') setEntryKey((key) => key + 1);
              else onEdit(null, reason === 'enter');
            }}
            onCancel={() => onEdit(null, true)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="bento-bookmarks__add-item"
            aria-label="Add link, note or to-do"
            data-bm-add-item
            onActivate={() => onEdit({ kind: 'add-item', groupId: group.id })}
          >
            <BentoIcon icon={Plus} size="sm" />
          </Button>
        )}
      </footer>
    </section>
  );
}

/** Columns compare their items by value: every snapshot is a new set of objects. */
export const BoardColumn = memo(BoardColumnImpl, (prev, next) => {
  const { group: ga, items: ia, ...restA } = prev;
  const { group: gb, items: ib, ...restB } = next;
  const same = <T extends object>(a: T, b: T) =>
    Object.keys(a).length === Object.keys(b).length &&
    (Object.keys(a) as Array<keyof T>).every((key) => Object.is(a[key], b[key]));
  return (
    same(ga, gb) &&
    ia.length === ib.length &&
    ia.every((item, index) => same(item, ib[index]!)) &&
    (Object.keys(restA) as Array<keyof typeof restA>).every((key) =>
      Object.is(restA[key], restB[key]),
    )
  );
});

/** The trailing "+ Group" column: a button that becomes a name field. */
export function AddGroupColumn({
  editing,
  onEdit,
  onCreate,
}: {
  editing: EditTarget | null;
  onEdit: EditHandler;
  onCreate: (name: string, viaKeyboard: boolean) => void;
}) {
  return (
    <section
      className="bento-bookmarks__column bento-bookmarks__column--add"
      aria-label="New group"
    >
      <header className="bento-bookmarks__column-head">
        <AddGroup
          editing={editing}
          onEdit={onEdit}
          onCreate={onCreate}
          buttonVariant="ghost"
          buttonClassName="bento-bookmarks__add"
        />
      </header>
    </section>
  );
}
