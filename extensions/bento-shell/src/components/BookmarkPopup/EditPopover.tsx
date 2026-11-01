// The save popover: what the star and Cmd+D open on the page being saved.
//
// Opening it saves the page (the popover is the confirmation, not a question). If the URL is
// already a link, the newest such link is edited. Otherwise the page is saved with one
// `tabs/save` into the default target (bookmarks/links.ts `defaultSaveTarget`), after creating an
// "Unsorted" group when the space has none. Then Name, Space and Group edit that link in place.
//
// Nothing renders until the link is in the snapshot, so the form never shows controls for a save
// that did not happen; if it does not arrive, or the link is deleted elsewhere, the popover closes.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Popover, SelectNative, Text, TextField } from '@muxui/react';
import { BOOKMARK_LIMITS, type BookmarksSnapshot } from '@shared/protocol';

import type { BookmarkPopupRequest } from '../../bridge/bookmarkPopup';
import {
  UNSORTED_GROUP_NAME,
  defaultSaveTarget,
  newestLinkFor,
  urlKey,
  type BookmarkLink,
} from '../../bookmarks/links';
import { groupCreate, newId, tabsSave } from '../BookmarksView/actions';
import type { BookmarksAction } from '../BookmarksView/types';
import { Column, Row } from '../primitives';
import { PopoverAnchor, useEscape } from './parts';

type EditRequest = Extract<BookmarkPopupRequest, { kind: 'edit' }>;

/** How long a save may take to reach the snapshot before the popover gives up. */
const SAVE_WAIT_MS = 3000;

export interface EditPopoverProps {
  request: EditRequest;
  snapshot: BookmarksSnapshot | null;
  send: (action: BookmarksAction) => void;
  /** Closes the popup; safe to call more than once. */
  close: () => void;
}

/**
 * The link this popover edits, saving the page first when it is not saved yet. The save runs once
 * per popover, as soon as the snapshot is ready. Null until the link is in the snapshot.
 */
function useEditedLink(
  request: EditRequest,
  snapshot: BookmarksSnapshot | null,
  send: EditPopoverProps['send'],
  close: () => void,
): BookmarkLink | null {
  const key = urlKey(request.url);
  const [itemId, setItemId] = useState<string | null>(null);
  const started = useRef(false);
  const seen = useRef(false);
  const failed = snapshot?.status === 'loadFailed';

  useEffect(() => {
    if (started.current) return;
    if (key === null) {
      close();
      return;
    }
    if (snapshot?.status !== 'ready') return;
    started.current = true;
    const existing = newestLinkFor(snapshot, key);
    if (existing) {
      setItemId(existing.id);
      return;
    }
    const target = defaultSaveTarget(snapshot);
    if (!target) {
      close();
      return;
    }
    // A client id for each new thing, so the follow-ups name exactly what this popover made.
    const id = newId();
    let groupId = target.groupId;
    if (groupId === null) {
      groupId = newId();
      send(groupCreate(target.spaceId, UNSORTED_GROUP_NAME, groupId));
    }
    send(tabsSave(target.spaceId, [request.tabId], { groupId, beforeId: null }, () => id));
    setItemId(id);
  }, [key, snapshot, request.tabId, send, close]);

  const link = useMemo(() => {
    const item = itemId === null ? undefined : snapshot?.items.find((entry) => entry.id === itemId);
    return item?.kind === 'link' ? item : null;
  }, [itemId, snapshot]);

  useEffect(() => {
    if (link) {
      seen.current = true;
      return;
    }
    // Deleted from the Bookmarks view meanwhile.
    if (seen.current) {
      close();
      return;
    }
    if (failed) return;
    const timer = window.setTimeout(close, SAVE_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [link, failed, close]);

  return link;
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
  const lastCommitted = useRef<string | null>(null);

  useEffect(() => {
    if (draft !== null && draft.trim() === link.title) setDraft(null);
  }, [draft, link.title]);

  const commitName = useCallback(() => {
    if (reverting.current || draft === null) return;
    const next = draft.trim();
    if (!next) {
      setDraft(null);
      return;
    }
    if (next === link.title || next === lastCommitted.current) return;
    lastCommitted.current = next;
    send({ type: 'bookmarks/item/update', id: link.id, title: next });
  }, [draft, link.id, link.title, send]);

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
          onChange={setDraft}
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
