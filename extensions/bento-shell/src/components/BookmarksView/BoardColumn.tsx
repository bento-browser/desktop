// One group of the board: a header with the colour dot, name, count and menu, the rows, and the
// "+ Link, note or to-do" entry. The header is the handle for ordering columns; a double click
// renames. `AddGroupColumn` is the trailing "+ Group" column.

import { memo, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Button, Text } from '@muxui/react';
import Plus from 'lucide-react/dist/esm/icons/plus';
import type { BookmarkGroup, BookmarkItem } from '@shared/protocol';

import { BentoIcon } from '../primitives';
import { EntityMenu } from './EntityMenu';
import { InlineEditor } from './InlineEditor';
import { ItemRow } from './ItemRow';
import { parseAddInput } from './model';
import { isEditing, type BookmarksAction, type EditTarget } from './types';
import type { DragSource } from './useBoardDrag';

export interface BoardColumnProps {
  group: BookmarkGroup;
  items: BookmarkItem[];
  editing: EditTarget | null;
  /** The item being dragged, if any, so its row can dim. */
  draggingItemId: string | null;
  /** This whole column is being dragged. */
  dragging: boolean;
  send: (action: BookmarksAction) => void;
  onEdit: (target: EditTarget | null) => void;
  onOpen: (id: string, where: 'panel' | 'tab') => void;
  onDeleteItem: (item: BookmarkItem) => void;
  onOpenAll: (items: BookmarkItem[]) => void;
  onDeleteGroup: (group: BookmarkGroup, itemCount: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: DragSource) => void;
  isSuppressed: () => boolean;
}

function BoardColumnImpl({
  group,
  items,
  editing,
  draggingItemId,
  dragging,
  send,
  onEdit,
  onOpen,
  onDeleteItem,
  onOpenAll,
  onDeleteGroup,
  onPointerDown,
  isSuppressed,
}: BoardColumnProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  // Remounts the entry after an Enter so the next one can be typed straight away.
  const [entryKey, setEntryKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const renaming = isEditing(editing, { kind: 'group', id: group.id });
  const adding = isEditing(editing, { kind: 'add-item', groupId: group.id });
  const links = items.filter((item) => item.kind === 'link');

  // A new row is added at the end: keep it in view.
  const count = items.length;
  const previousCount = useRef(count);
  useEffect(() => {
    if (adding && count > previousCount.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
    previousCount.current = count;
  }, [adding, count]);

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
            className="bento-bookmarks__rename"
            onCommit={(text) => {
              const name = text.trim();
              if (name && name !== group.name) {
                send({ type: 'bookmarks/group/update', id: group.id, name });
              }
              onEdit(null);
            }}
            onCancel={() => onEdit(null)}
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
          deleteLabel="Delete group"
          color={group.color}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          openAll={{ count: links.length, onOpenAll: () => onOpenAll(links) }}
          onRename={() => onEdit({ kind: 'group', id: group.id })}
          onColor={(color) => send({ type: 'bookmarks/group/update', id: group.id, color })}
          onDelete={() => onDeleteGroup(group, items.length)}
        />
      </header>
      <div ref={listRef} className="bento-bookmarks__list" role="list" data-bm-list>
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            editing={isEditing(editing, { kind: 'item', id: item.id })}
            dragging={draggingItemId === item.id}
            send={send}
            onEdit={onEdit}
            onOpen={onOpen}
            onDelete={onDeleteItem}
            onPointerDown={onPointerDown}
            isSuppressed={isSuppressed}
          />
        ))}
      </div>
      <footer className="bento-bookmarks__column-foot">
        {adding ? (
          <InlineEditor
            key={entryKey}
            label="New link, note or to-do"
            placeholder="Paste a link, write a note, or start with []"
            multiline
            hint={
              <>
                <span>Enter to save</span>
                <span>Esc to cancel</span>
                <span>[] for a to-do</span>
              </>
            }
            onCommit={(text, reason) => {
              const item = parseAddInput(text);
              if (item)
                send({ type: 'bookmarks/item/create', groupId: group.id, beforeId: null, item });
              if (item && reason === 'enter') setEntryKey((key) => key + 1);
              else onEdit(null);
            }}
            onCancel={() => onEdit(null)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="bento-bookmarks__add"
            aria-label="Add link, note or to-do"
            onActivate={() => onEdit({ kind: 'add-item', groupId: group.id })}
          >
            <BentoIcon icon={Plus} size="sm" />
            Link, note or to-do
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
  spaceId,
  editing,
  send,
  onEdit,
}: {
  spaceId: string;
  editing: EditTarget | null;
  send: (action: BookmarksAction) => void;
  onEdit: (target: EditTarget | null) => void;
}) {
  const adding = isEditing(editing, { kind: 'add-group' });
  return (
    <section
      className="bento-bookmarks__column bento-bookmarks__column--add"
      aria-label="New group"
    >
      <header className="bento-bookmarks__column-head">
        {adding ? (
          <InlineEditor
            label="Group name"
            placeholder="Group name"
            onCommit={(text) => {
              const name = text.trim();
              if (name) send({ type: 'bookmarks/group/create', spaceId, name });
              onEdit(null);
            }}
            onCancel={() => onEdit(null)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="bento-bookmarks__add"
            aria-label="Add group"
            onActivate={() => onEdit({ kind: 'add-group' })}
          >
            <BentoIcon icon={Plus} size="sm" />
            Group
          </Button>
        )}
      </header>
    </section>
  );
}
