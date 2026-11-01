// One row of a column: a link, a note or a to-do, with its "More actions" menu and its inline
// editor. The row starts a drag (useBoardDrag) from anywhere but its own controls; a press that
// ended a drag must not also open the link, so the open checks `isSuppressed` first. The menu
// trigger is the row's one hover action: it shows on focus too, so it is reached by Tab, and its
// Move submenu is the keyboard route to dragging.

import { memo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Button, Checkbox, Input, Text } from '@muxui/react';
import Globe from 'lucide-react/dist/esm/icons/globe';
import { BOOKMARK_LIMITS, type BookmarkItem } from '@shared/protocol';
import { MAX_URL_LENGTH } from '@shared/export-schema';

import { BentoIcon } from '../primitives';
import { useFocusWhenReady } from './focusWhenReady';
import { InlineEditor } from './InlineEditor';
import { ItemMenu } from './ItemMenu';
import { itemEntries, type ItemHandlers, type ItemSlots } from './menuEntries';
import { hostnameOf, normalizeUrl } from './model';
import type { BookmarksAction, EditHandler } from './types';
import type { DragSource } from './useBoardDrag';

/** The handlers and slots of the row's menu (menuEntries.ts), plus the row's own state. */
export interface ItemRowProps extends ItemHandlers, ItemSlots {
  item: BookmarkItem;
  editing: boolean;
  /** This row is the source of the drag in progress. */
  dragging: boolean;
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
  onEdit: EditHandler;
}) {
  const [title, setTitle] = useState(item.title);
  const [url, setUrl] = useState(item.url);
  const [done, setDone] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  useFocusWhenReady(titleRef);

  const commit = (viaKeyboard: boolean) => {
    if (done) return;
    setDone(true);
    const nextUrl = normalizeUrl(url);
    send({
      type: 'bookmarks/item/update',
      id: item.id,
      ...(title !== item.title ? { title } : {}),
      ...(nextUrl && nextUrl !== item.url ? { url: nextUrl } : {}),
    });
    onEdit(null, viaKeyboard);
  };
  const cancel = () => {
    if (done) return;
    setDone(true);
    onEdit(null, true);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commit(true);
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
        if (!event.currentTarget.contains(event.relatedTarget)) commit(false);
      }}
    >
      <Input.Input
        className="bento-bookmarks__field"
        ref={titleRef}
        aria-label="Title"
        value={title}
        maxLength={BOOKMARK_LIMITS.linkTitle}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setTitle(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <Input.Input
        className="bento-bookmarks__field"
        aria-label="Address"
        value={url}
        maxLength={MAX_URL_LENGTH}
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

function RowActions(props: ItemRowProps) {
  const { item, groups, moveUpBefore, moveDownBefore } = props;
  return (
    <div className="bento-bookmarks__row-actions" data-bm-no-drag>
      <ItemMenu entries={itemEntries(item, { groups, moveUpBefore, moveDownBefore }, props)} />
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
    // The row has a hover action (its menu): the stylesheet makes room for it in the text mask.
    'data-bm-actions': 1,
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
          maxLength={BOOKMARK_LIMITS.text}
          hint={
            <>
              <span>Enter to save</span>
              <span>Esc to cancel</span>
            </>
          }
          onCommit={(text, reason) => {
            const next = text.trim();
            if (next && next !== item.text) {
              send({ type: 'bookmarks/item/update', id: item.id, text: next });
            }
            onEdit(null, reason === 'enter');
          }}
          onCancel={() => onEdit(null, true)}
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
