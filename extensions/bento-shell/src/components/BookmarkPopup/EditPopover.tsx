// The save popover: what the star and Cmd+D open on the page being saved.
//
// Opening it saves the page (the popover is the confirmation, not a question). If the URL is
// already a link, the newest such link is edited. Otherwise the page is saved with one
// `tabs/save` into the default target (bookmarks/links.ts `defaultSaveTarget`), after creating an
// "Unsorted" group when the space has none. Then Name, Space and Group edit that link in place.
//
// Nothing renders until the link is in the snapshot, so the form never shows controls for a save
// that did not happen; if it does not arrive, or the link is deleted elsewhere, the popover closes.
// The save itself (and not saving twice when the popover is opened again before it lands) is in
// saveFlow.ts.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Popover, SelectNative, Text, TextField } from '@muxui/react';
import { BOOKMARK_LIMITS, type BookmarksSnapshot } from '@shared/protocol';

import type { BookmarkPopupRequest } from '../../bridge/bookmarkPopup';
import { UNSORTED_GROUP_NAME, urlKey, type BookmarkLink } from '../../bookmarks/links';
import { groupCreate, newId } from '../BookmarksView/actions';
import type { BookmarksAction } from '../BookmarksView/types';
import { Column, Row } from '../primitives';
import { createNameCommitter } from './nameCommit';
import { PopoverAnchor, useEscape, useHostHidden } from './parts';
import { createSaveFlow, type SaveFlow } from './saveFlow';

type EditRequest = Extract<BookmarkPopupRequest, { kind: 'edit' }>;

export interface EditPopoverProps {
  request: EditRequest;
  snapshot: BookmarksSnapshot | null;
  send: (action: BookmarksAction) => void;
  /** Closes the popup; safe to call more than once. */
  close: () => void;
}

/**
 * The link this popover edits, saving the page first when it is not saved yet (see `createSaveFlow`
 * for the one save per popover and its wait). Null until the link is in the snapshot.
 */
function useEditedLink(
  request: EditRequest,
  snapshot: BookmarksSnapshot | null,
  send: EditPopoverProps['send'],
  close: () => void,
): BookmarkLink | null {
  const key = urlKey(request.url);
  const [itemId, setItemId] = useState<string | null>(null);
  const flow = useRef<SaveFlow | null>(null);

  useEffect(() => {
    if (key === null) {
      close();
      return;
    }
    const created = createSaveFlow({ key, tabId: request.tabId, send, close, onItem: setItemId });
    flow.current = created;
    return () => {
      created.dispose();
      flow.current = null;
    };
  }, [key, request.tabId, send, close]);

  // After the flow exists: it saves on the first ready snapshot and watches every later one.
  useEffect(() => {
    flow.current?.update(snapshot);
  }, [snapshot, key, request.tabId, send, close]);

  return useMemo(() => {
    const item = itemId === null ? undefined : snapshot?.items.find((entry) => entry.id === itemId);
    return item?.kind === 'link' ? item : null;
  }, [itemId, snapshot]);
}

export function EditPopover({ request, snapshot, send, close }: EditPopoverProps) {
  const link = useEditedLink(request, snapshot, send, close);
  if (snapshot?.status === 'loadFailed') {
    return <LoadFailed request={request} send={send} close={close} />;
  }
  if (!link || !snapshot) return null;
  return (
    <EditForm
      key={link.id}
      request={request}
      link={link}
      snapshot={snapshot}
      send={send}
      close={close}
    />
  );
}

function LoadFailed({
  request,
  send,
  close,
}: Pick<EditPopoverProps, 'request' | 'send' | 'close'>) {
  useEscape(close);
  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      aria-label="Bookmarks couldn't load"
      placement="bottom-end"
      offset={6}
      className="bento-bookmark-popup__edit"
      trigger={<PopoverAnchor anchor={request.anchor} />}
    >
      <Column gap="xs">
        <Text variant="body" size="sm" role="alert">
          Bookmarks couldn&apos;t load, so this page was not saved.
        </Text>
        <Row gap="xs" justify="between">
          <Button
            variant="neutral"
            size="sm"
            onActivate={() => send({ type: 'bookmarks/requestSnapshot' })}
          >
            Retry
          </Button>
          <Button variant="primary" size="sm" onActivate={close}>
            Done
          </Button>
        </Row>
      </Column>
    </Popover>
  );
}

interface EditFormProps {
  request: EditRequest;
  link: BookmarkLink;
  snapshot: BookmarksSnapshot;
  send: EditPopoverProps['send'];
  close: () => void;
}

function EditForm({ request, link, snapshot, send, close }: EditFormProps) {
  // The text being typed; null shows the saved title. It outlives the commit until the snapshot
  // carries the new title, so the field does not jump back to the old one meanwhile.
  const [draft, setDraft] = useState<string | null>(null);
  const reverting = useRef(false);
  const [names] = useState(createNameCommitter);

  useEffect(() => {
    if (draft !== null && draft.trim() === link.title) setDraft(null);
  }, [draft, link.title]);

  // A name that reached the snapshot is no longer on its way, so it can be committed again later.
  useEffect(() => names.acknowledge(link.title), [names, link.title]);

  const commitName = useCallback(() => {
    if (reverting.current) return;
    const commit = names.commit(draft, link.title);
    if (commit.kind === 'restore') setDraft(null);
    else if (commit.kind === 'send') {
      send({ type: 'bookmarks/item/update', id: link.id, title: commit.title });
    }
  }, [names, draft, link.id, link.title, send]);

  // Esc drops an unsaved name, then closes; every other way out keeps it. Mux closes the popover
  // on Esc too, and only after this has run: the capture handler below runs first for an Esc
  // inside the popover, and `useEscape` covers an Esc while the focus is elsewhere.
  const revertAndClose = () => {
    reverting.current = true;
    setDraft(null);
    close();
  };
  useEscape(revertAndClose);

  const dismiss = () => {
    commitName();
    close();
  };
  // Chrome closed the popover itself (a resize, a tab change): the same as a click outside.
  useHostHidden(dismiss);

  const group = snapshot.groups.find((entry) => entry.id === link.groupId);
  const space = snapshot.spaces.find((entry) => entry.id === group?.spaceId);
  const groups = snapshot.groups.filter((entry) => entry.spaceId === space?.id);

  const moveTo = (groupId: string) =>
    send({ type: 'bookmarks/item/move', id: link.id, groupId, beforeId: null });

  /** The link moves to the first group of the space; a space with none gets "Unsorted". */
  const moveToSpace = (spaceId: string) => {
    const first = snapshot.groups.find((entry) => entry.spaceId === spaceId);
    if (first) {
      moveTo(first.id);
      return;
    }
    const created = newId();
    send(groupCreate(spaceId, UNSORTED_GROUP_NAME, created));
    moveTo(created);
  };

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
      aria-label="Edit bookmark"
      placement="bottom-end"
      offset={6}
      className="bento-bookmark-popup__edit"
      trigger={<PopoverAnchor anchor={request.anchor} />}
    >
      <Column
        gap="xs"
        onKeyDownCapture={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing) return;
          event.preventDefault();
          event.stopPropagation();
          revertAndClose();
        }}
      >
        <TextField
          label="Name"
          size="sm"
          value={draft ?? link.title}
          onChange={(value) => {
            names.edited();
            setDraft(value);
          }}
          maxLength={BOOKMARK_LIMITS.linkTitle}
          autoFocus
          inputProps={{
            onFocus: (event) => event.currentTarget.select(),
            onBlur: commitName,
            onKeyDown: (event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              commitName();
            },
          }}
        />
        <SelectNative
          label="Space"
          size="sm"
          value={space?.id ?? ''}
          onChange={(event) => moveToSpace(event.currentTarget.value)}
        >
          {snapshot.spaces.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </SelectNative>
        <SelectNative
          label="Group"
          size="sm"
          value={group?.id ?? ''}
          onChange={(event) => moveTo(event.currentTarget.value)}
        >
          {groups.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </SelectNative>
        <Row gap="xs" justify="between">
          <Button
            variant="danger-ghost"
            size="sm"
            onActivate={() => {
              send({ type: 'bookmarks/item/delete', id: link.id });
              close();
            }}
          >
            Remove
          </Button>
          <Button variant="primary" size="sm" onActivate={dismiss}>
            Done
          </Button>
        </Row>
      </Column>
    </Popover>
  );
}
