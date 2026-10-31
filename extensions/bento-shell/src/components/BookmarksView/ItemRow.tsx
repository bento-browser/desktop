// One row of a column: a link, a note or a to-do, with its hover actions and its inline editor.
// The row starts a drag (useBoardDrag) from anywhere but its own controls; a press that ended a
// drag must not also open the link, so the open checks `isSuppressed` first.

import { memo, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Button, Checkbox, IconButton, Input, Text } from '@muxui/react';
import AppWindow from 'lucide-react/dist/esm/icons/app-window';
import Globe from 'lucide-react/dist/esm/icons/globe';
import PanelRightOpen from 'lucide-react/dist/esm/icons/panel-right-open';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import type { BookmarkItem } from '@shared/protocol';

import { BentoIcon } from '../primitives';
import { InlineEditor } from './InlineEditor';
import { hostnameOf, normalizeUrl } from './model';
import type { BookmarksAction, EditTarget } from './types';
import type { DragSource } from './useBoardDrag';

export interface ItemRowProps {
  item: BookmarkItem;
  editing: boolean;
  /** This row is the source of the drag in progress. */
  dragging: boolean;
  send: (action: BookmarksAction) => void;
  onEdit: (target: EditTarget | null) => void;
  /** Opens the link and leaves the view. */
  onOpen: (id: string, where: 'panel' | 'tab') => void;
  /** Deletes the item and offers the undo. */
  onDelete: (item: BookmarkItem) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, source: DragSource) => void;
  /** True for the press that just ended a drag. */
  isSuppressed: () => boolean;
}

/** A link's icon, or a globe when it has none or it does not load. */
export function Favicon({ src, className }: { src?: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span
        className={`bento-bookmarks__favicon bento-bookmarks__favicon--fallback ${className ?? ''}`}
      >
        <BentoIcon icon={Globe} size="sm" />
      </span>
    );
  }
  return (
    <img
      className={`bento-bookmarks__favicon ${className ?? ''}`}
      src={src}
      alt=""
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Title and address of a link in two fields. Enter saves, Esc cancels, and leaving the pair saves. */
function LinkEditor({
  item,
  send,
  onEdit,
}: {
  item: Extract<BookmarkItem, { kind: 'link' }>;
  send: (action: BookmarksAction) => void;
  onEdit: (target: EditTarget | null) => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [url, setUrl] = useState(item.url);
  const [done, setDone] = useState(false);

  const commit = () => {
    if (done) return;
    setDone(true);
    const nextUrl = normalizeUrl(url);
    send({
      type: 'bookmarks/item/update',
      id: item.id,
      ...(title !== item.title ? { title } : {}),
      ...(nextUrl && nextUrl !== item.url ? { url: nextUrl } : {}),
    });
    onEdit(null);
  };
  const cancel = () => {
    if (done) return;
    setDone(true);
    onEdit(null);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  return (
    <div
      className="bento-bookmarks__editor bento-bookmarks__link-editor"
      data-bm-no-drag
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) commit();
      }}
    >
      <Input.Input
        className="bento-bookmarks__field"
        aria-label="Title"
        value={title}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <Input.Input
        className="bento-bookmarks__field"
        aria-label="Address"
        value={url}
        aria-invalid={normalizeUrl(url) === null ? true : undefined}
        onChange={(event) => setUrl(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <div className="bento-bookmarks__editor-hint">
        <span>Enter to save</span>
        <span>Esc to cancel</span>
      </div>
    </div>
  );
}

function RowActions({
  item,
  onOpen,
  onEdit,
  onDelete,
}: Pick<ItemRowProps, 'item' | 'onOpen' | 'onEdit' | 'onDelete'>) {
  return (
    <div className="bento-bookmarks__row-actions" data-bm-no-drag>
      {item.kind === 'link' ? (
        <>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Open in panel"
            title="Open in panel"
            onActivate={() => onOpen(item.id, 'panel')}
          >
            <BentoIcon icon={PanelRightOpen} size="sm" />
          </IconButton>
          <IconButton
            variant="ghost"
            size="sm"
            aria-label="Open in tab"
            title="Open in tab"
            onActivate={() => onOpen(item.id, 'tab')}
          >
            <BentoIcon icon={AppWindow} size="sm" />
          </IconButton>
        </>
      ) : null}
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Edit"
        title="Edit"
        onActivate={() => onEdit({ kind: 'item', id: item.id })}
      >
        <BentoIcon icon={Pencil} size="sm" />
      </IconButton>
      <IconButton
        variant="ghost"
        size="sm"
        aria-label="Delete"
        title="Delete"
        onActivate={() => onDelete(item)}
      >
        <BentoIcon icon={Trash2} size="sm" />
      </IconButton>
    </div>
  );
}

function ItemRowImpl(props: ItemRowProps) {
  const { item, editing, dragging, send, onEdit, onOpen, onPointerDown, isSuppressed } = props;
  const source: DragSource = { kind: 'item', id: item.id };
  const rowProps = {
    role: 'listitem',
    className: 'bento-bookmarks__row',
    'data-kind': item.kind,
    'data-bm-item-id': item.id,
    'data-bm-flip': `item:${item.id}`,
    'data-dragging': dragging ? 'true' : undefined,
    // Capture phase: a Mux Button stops the press events it handles from reaching its ancestors.
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => onPointerDown(event, source),
  };

  if (editing) {
    if (item.kind === 'link') {
      return (
        <div {...rowProps} data-editing="true">
          <LinkEditor item={item} send={send} onEdit={onEdit} />
        </div>
      );
    }
    return (
      <div {...rowProps} data-editing="true">
        <InlineEditor
          label={item.kind === 'note' ? 'Note' : 'To-do'}
          initial={item.text}
          multiline={item.kind === 'note'}
          hint={
            <>
              <span>Enter to save</span>
              <span>Esc to cancel</span>
            </>
          }
          onCommit={(text) => {
            const next = text.trim();
            if (next && next !== item.text) {
              send({ type: 'bookmarks/item/update', id: item.id, text: next });
            }
            onEdit(null);
          }}
          onCancel={() => onEdit(null)}
        />
      </div>
    );
  }

  if (item.kind === 'link') {
    return (
      <div {...rowProps}>
        <Button
          variant="ghost"
          size="sm"
          className="bento-bookmarks__row-main"
          title={item.url}
          onActivate={() => {
            if (!isSuppressed()) onOpen(item.id, 'panel');
          }}
        >
          <Favicon src={item.favIconUrl} />
          <span className="bento-bookmarks__row-text">
            <Text variant="body" size="sm" truncate>
              {item.title || hostnameOf(item.url)}
            </Text>
            <Text variant="body" size="xs" color="muted" truncate>
              {hostnameOf(item.url)}
            </Text>
          </span>
        </Button>
        <RowActions {...props} />
      </div>
    );
  }

  if (item.kind === 'note') {
    return (
      <div {...rowProps}>
        <Button
          variant="ghost"
          size="sm"
          className="bento-bookmarks__row-main"
          aria-label={`Edit note: ${item.text}`}
          onActivate={() => {
            if (!isSuppressed()) onEdit({ kind: 'item', id: item.id });
          }}
        >
          <Text variant="body" size="sm" className="bento-bookmarks__note-text">
            {item.text}
          </Text>
        </Button>
        <RowActions {...props} />
      </div>
    );
  }

  return (
    <div {...rowProps} data-done={item.done ? 'true' : undefined}>
      <span className="bento-bookmarks__todo-box" data-bm-no-drag>
        <Checkbox
          size="sm"
          checked={item.done}
          aria-label={item.text}
          onChange={(done) => send({ type: 'bookmarks/item/update', id: item.id, done })}
        />
      </span>
      <Text
        variant="body"
        size="sm"
        className="bento-bookmarks__todo-text"
        onDoubleClick={() => onEdit({ kind: 'item', id: item.id })}
      >
        {item.text}
      </Text>
      <RowActions {...props} />
    </div>
  );
}

function sameItem(a: BookmarkItem, b: BookmarkItem): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) =>
    Object.is(a[key as keyof BookmarkItem], b[key as keyof BookmarkItem]),
  );
}

/** Rows compare the item by value: every snapshot is a new set of objects. */
export const ItemRow = memo(ItemRowImpl, (prev, next) => {
  const { item: a, ...restA } = prev;
  const { item: b, ...restB } = next;
  return (
    sameItem(a, b) &&
    (Object.keys(restA) as Array<keyof typeof restA>).every((key) =>
      Object.is(restA[key], restB[key]),
    )
  );
});
