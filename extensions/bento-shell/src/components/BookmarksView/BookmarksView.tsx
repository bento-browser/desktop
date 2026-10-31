// Layer-2 component: BookmarksView.
//
// The Bookmarks manager as a full-window view (layout "Spaces list and tabs drawer"): the spaces
// on the left, the selected space's groups as horizontally scrolling columns of links, notes and
// to-dos, and a drawer of the workspace's open tabs on the right that can be dragged into a
// column. It is presentational: it takes the tools snapshot and the open tabs, and every change is
// a `bookmarks/*` action handed to `send`; the entry (bookmarks/main.tsx) binds those to tools, and
// stories bind them to a fake. Persistent state lives in tools; what is local here is transient:
// the search text, the one open inline editor, the drawer, a pending confirmation.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Button, Dialog, SearchField, Text, ToggleButton } from '@muxui/react';
import AppWindow from 'lucide-react/dist/esm/icons/app-window';
import type { BookmarkGroup, BookmarkItem, BookmarksSnapshot } from '@shared/protocol';

import { afterMotion } from '../../motion/afterMotion';
import { BentoIcon } from '../primitives';
import { AddGroupColumn, BoardColumn } from './BoardColumn';
import { EmptySpace } from './EmptySpace';
import { playFlip, recordFlip, type FlipRecord } from './flip';
import { buildBoard, itemLabel, searchBookmarks, type SpaceSummary } from './model';
import {
  PENDING_CREATE_TTL_MS,
  itemIdsIn,
  placeAt,
  resolvePending,
  restorePlan,
  type PendingCreate,
} from './pending';
import { SearchResults } from './SearchResults';
import { SpacesList } from './SpacesList';
import { TabsDrawer } from './TabsDrawer';
import { UndoToasts, type UndoToast } from './UndoToasts';
import { editingInColumn, type BookmarksAction, type EditTarget, type OpenTab } from './types';
import { useBoardDrag } from './useBoardDrag';
import './BookmarksView.css';

export interface BookmarksViewProps {
  /** Null until tools has sent the first snapshot. */
  snapshot: BookmarksSnapshot | null;
  openTabs: readonly OpenTab[];
  send: (action: BookmarksAction) => void;
  /** Leaves the view. */
  onClose: () => void;
  /** Changes on every show: the view starts fresh and puts the focus in the search field. */
  openToken?: number;
  /** Changes whenever the view is hidden: an unfinished edit is dropped. */
  hideToken?: number;
  /** Starting state, for stories: the drawer open, search text, an inline editor open. */
  initialDrawerOpen?: boolean;
  initialQuery?: string;
  initialEditing?: EditTarget;
}

interface ConfirmRequest {
  title: string;
  description: string;
  confirmLabel: string;
  run: () => void;
}

const KIND_LABEL = { link: 'Link', note: 'Note', todo: 'To-do' } as const;
/** Deleted-item toasts on screen at once; an older one goes when a newer arrives past this. */
const MAX_TOASTS = 3;

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Keeps the drawer mounted while it plays its exit (a dismiss-role fade and slide). */
function useDrawerPresence(open: boolean) {
  const ref = useRef<HTMLElement>(null);
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);
  const exiting = !open && mounted;
  useLayoutEffect(() => {
    if (!exiting) return;
    const drawer = ref.current;
    if (!drawer) {
      setMounted(false);
      return;
    }
    return afterMotion(drawer, { animations: ['bento-bookmarks-drawer-out'] }, () =>
      setMounted(false),
    );
  }, [exiting]);
  return { mounted, exiting, ref };
}

export default function BookmarksView({
  snapshot,
  openTabs,
  send: sendToTools,
  onClose,
  openToken = 0,
  hideToken = 0,
  initialDrawerOpen = false,
  initialQuery = '',
  initialEditing,
}: BookmarksViewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boardsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [toasts, setToasts] = useState<UndoToast[]>([]);
  const nextToastId = useRef(0);
  const [query, setQuery] = useState(initialQuery);
  const [editing, setEditing] = useState<EditTarget | null>(initialEditing ?? null);
  const [drawerOpen, setDrawerOpen] = useState(initialDrawerOpen);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const drawer = useDrawerPresence(drawerOpen);

  const board = useMemo(() => (snapshot ? buildBoard(snapshot) : null), [snapshot]);
  const hits = useMemo(() => (snapshot ? searchBookmarks(snapshot, query) : []), [snapshot, query]);
  const searching = query.trim() !== '';
  const current = board?.current ?? null;

  // Latest values for handlers that outlive a render (the Esc listener, the undo toast).
  const live = useRef({ snapshot, editing, confirm, query });
  live.current = { snapshot, editing, confirm, query };

  // Follow-ups that need the ids tools assigned: a dropped tab's place, a restored to-do's tick,
  // the selection of a new space, the scroll to a new group.
  const pendingRef = useRef<PendingCreate[]>([]);
  const newSpaceRef = useRef<ReadonlySet<string> | null>(null);
  const newGroupRef = useRef<ReadonlySet<string> | null>(null);
  const flipRef = useRef<FlipRecord | null>(null);

  const send = useCallback(
    (action: BookmarksAction) => {
      const state = live.current.snapshot;
      if (state && action.type === 'bookmarks/space/create') {
        newSpaceRef.current = new Set(state.spaces.map((space) => space.id));
      } else if (state && action.type === 'bookmarks/tabs/save' && action.groupId === null) {
        newGroupRef.current = new Set(state.groups.map((group) => group.id));
      } else if (state && action.type === 'bookmarks/group/create') {
        newGroupRef.current = new Set(state.groups.map((group) => group.id));
      }
      sendToTools(action);
    },
    [sendToTools],
  );

  const drag = useBoardDrag({
    rootRef,
    boardsRef,
    spaceId: current?.id ?? null,
    items: snapshot?.items ?? [],
    groups: useMemo(() => board?.groups.map((entry) => entry.group) ?? [], [board]),
    send,
    onTabDrop: ({ groupId, beforeId }) => {
      pendingRef.current.push({
        groupId,
        knownIds: itemIdsIn(live.current.snapshot?.items ?? [], groupId),
        then: placeAt(groupId, beforeId),
        at: Date.now(),
      });
    },
    onFlip: (record) => {
      flipRef.current = record;
    },
  });

  const cancelDrag = drag.cancel;

  // ---- What a new snapshot sets going ------------------------------------------------------

  useLayoutEffect(() => {
    const record = flipRef.current;
    flipRef.current = null;
    if (record && rootRef.current) playFlip(rootRef.current, record);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot) return;
    const known = newSpaceRef.current;
    if (known) {
      const created = snapshot.spaces.find((space) => !known.has(space.id));
      if (created) {
        newSpaceRef.current = null;
        sendToTools({ type: 'bookmarks/space/select', id: created.id });
      }
    }
    const knownGroups = newGroupRef.current;
    if (knownGroups && snapshot.groups.some((group) => !knownGroups.has(group.id))) {
      newGroupRef.current = null;
      const boards = boardsRef.current;
      if (boards) boards.scrollLeft = boards.scrollWidth;
    }
    const now = Date.now();
    pendingRef.current = pendingRef.current.filter((pending) => {
      if (now - pending.at > PENDING_CREATE_TTL_MS) return false;
      const actions = resolvePending(pending, snapshot.items);
      if (!actions) return true;
      // The rows are in the order tools saved them; they settle into the place they were dropped.
      if (actions.length > 0 && rootRef.current) flipRef.current = recordFlip(rootRef.current);
      for (const action of actions) sendToTools(action);
      return false;
    });
  }, [snapshot, sendToTools]);

  // ---- Shown and hidden by chrome ----------------------------------------------------------

  useEffect(() => {
    if (openToken === 0) return;
    cancelDrag();
    setQuery('');
    setEditing(null);
    setConfirm(null);
    searchRef.current?.focus();
  }, [openToken, cancelDrag]);

  useEffect(() => {
    if (hideToken === 0) return;
    cancelDrag();
    setEditing(null);
    setConfirm(null);
    setToasts([]);
  }, [hideToken, cancelDrag]);

  // Esc: an inline edit first, then a drawer that covers the boards, then the view. A dialog,
  // a menu and an editor's own field take their Esc before it gets here.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const state = live.current;
      if (state.confirm) return;
      if (state.editing) {
        setEditing(null);
      } else if (
        drawer.ref.current &&
        getComputedStyle(drawer.ref.current).position === 'absolute'
      ) {
        setDrawerOpen(false);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawer.ref, onClose]);

  // ---- Handlers ----------------------------------------------------------------------------

  const open = useCallback(
    (id: string, where: 'panel' | 'tab') => {
      send({ type: 'bookmarks/item/open', id, where });
      onClose();
    },
    [send, onClose],
  );

  const openAll = useCallback(
    (links: BookmarkItem[]) => {
      for (const link of links) send({ type: 'bookmarks/item/open', id: link.id, where: 'panel' });
      onClose();
    },
    [send, onClose],
  );

  const deleteItem = useCallback(
    (item: BookmarkItem) => {
      const state = live.current.snapshot;
      const plan = restorePlan(
        item,
        (state?.items ?? []).filter((entry) => entry.groupId === item.groupId),
      );
      send({ type: 'bookmarks/item/delete', id: item.id });
      const id = (nextToastId.current += 1);
      const undo = () => {
        if (plan.pending) {
          pendingRef.current.push({
            ...plan.pending,
            knownIds: itemIdsIn(live.current.snapshot?.items ?? [], item.groupId),
            at: Date.now(),
          });
        }
        send(plan.create);
      };
      setToasts((current) =>
        [
          ...current,
          { id, title: `${KIND_LABEL[item.kind]} deleted`, label: itemLabel(item), onUndo: undo },
        ].slice(-MAX_TOASTS),
      );
    },
    [send],
  );

  const removeToast = useCallback(
    (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );

  const deleteGroup = useCallback(
    (group: BookmarkGroup, itemCount: number) =>
      setConfirm({
        title: `Delete "${group.name}"?`,
        description:
          itemCount === 0
            ? 'The group is empty.'
            : `Its ${plural(itemCount, 'item', 'items')} will be deleted with it.`,
        confirmLabel: 'Delete group',
        run: () => send({ type: 'bookmarks/group/delete', id: group.id }),
      }),
    [send],
  );

  const deleteSpace = useCallback(
    ({ space, groupCount, linkCount }: SpaceSummary) =>
      setConfirm({
        title: `Delete "${space.name}"?`,
        description:
          groupCount === 0
            ? 'The space is empty.'
            : `Its ${plural(groupCount, 'group', 'groups')} and ${plural(linkCount, 'link', 'links')} will be deleted with it.`,
        confirmLabel: 'Delete space',
        run: () => send({ type: 'bookmarks/space/delete', id: space.id }),
      }),
    [send],
  );

  const saveTabs = (tabs: readonly OpenTab[]) => {
    if (current && tabs.length > 0) {
      send({
        type: 'bookmarks/tabs/save',
        spaceId: current.id,
        groupId: null,
        tabIds: tabs.map((tab) => tab.id),
      });
    }
  };

  // ---- Render ------------------------------------------------------------------------------

  let main: ReactNode;
  if (!snapshot || !board || !current) {
    main = <div className="bento-bookmarks__empty" />;
  } else if (searching) {
    main = <SearchResults query={query} hits={hits} onOpen={open} />;
  } else if (board.groups.length === 0) {
    main = (
      <EmptySpace
        tabCount={openTabs.length}
        offerImport={!snapshot.firefoxImportOffered}
        onAddGroup={() => setEditing({ kind: 'add-group' })}
        onSaveTabs={() => saveTabs(openTabs)}
        onImport={() => send({ type: 'bookmarks/import/firefox' })}
        onDismissImport={() => send({ type: 'bookmarks/import/dismiss' })}
      />
    );
  } else {
    main = (
      <div ref={boardsRef} className="bento-bookmarks__boards">
        {board.groups.map(({ group, items }) => (
          <BoardColumn
            key={group.id}
            group={group}
            items={items}
            editing={editingInColumn(
              editing,
              group.id,
              items.map((item) => item.id),
            )}
            draggingItemId={drag.active?.kind === 'item' ? drag.active.id : null}
            dragging={drag.active?.kind === 'group' && drag.active.id === group.id}
            send={send}
            onEdit={setEditing}
            onOpen={open}
            onDeleteItem={deleteItem}
            onOpenAll={openAll}
            onDeleteGroup={deleteGroup}
            onPointerDown={drag.begin}
            isSuppressed={drag.consumeSuppress}
          />
        ))}
        <AddGroupColumn spaceId={current.id} editing={editing} send={send} onEdit={setEditing} />
      </div>
    );
  }

  const meta = !board
    ? ''
    : searching
      ? plural(
          hits.reduce((sum, hit) => sum + hit.items.length, 0),
          'result',
          'results',
        )
      : `${plural(board.groups.length, 'group', 'groups')}, ${plural(board.linkCount, 'link', 'links')}`;

  return (
    <div ref={rootRef} className="bento-bookmarks" aria-busy={snapshot ? undefined : true}>
      <div className="bento-bookmarks__frame" data-drawer={drawer.mounted ? 'open' : 'closed'}>
        <SpacesList
          spaces={board?.spaces ?? []}
          currentId={current?.id ?? null}
          editing={editing}
          send={send}
          onEdit={setEditing}
          onClose={onClose}
          onDeleteSpace={deleteSpace}
        />
        <section className="bento-bookmarks__main">
          <header className="bento-bookmarks__header">
            <div className="bento-bookmarks__title">
              <Text as="h1" variant="heading" size="sm" truncate>
                {current?.name ?? ''}
              </Text>
              <Text variant="body" size="sm" color="muted" className="bento-bookmarks__meta">
                {meta}
              </Text>
            </div>
            <SearchField
              className="bento-bookmarks__search"
              aria-label="Search all bookmarks"
              value={query}
              onChange={setQuery}
              inputRef={searchRef}
              inputProps={{
                placeholder: 'Search all bookmarks',
                onKeyDown: (event) => {
                  // The first Esc empties the search; closing the view is the next one.
                  if (event.key === 'Escape' && live.current.query !== '') {
                    event.preventDefault();
                    event.stopPropagation();
                    setQuery('');
                  }
                },
              }}
            />
            <ToggleButton
              size="sm"
              className="bento-bookmarks__drawer-toggle"
              selected={drawerOpen}
              onChange={setDrawerOpen}
            >
              <BentoIcon icon={AppWindow} size="sm" />
              Open tabs
              <span className="bento-bookmarks__count">{openTabs.length}</span>
            </ToggleButton>
          </header>
          {main}
        </section>
        {drawer.mounted ? (
          <TabsDrawer
            ref={drawer.ref}
            tabs={openTabs}
            exiting={drawer.exiting}
            draggingTabId={drag.active?.kind === 'tab' ? drag.active.id : null}
            onClose={() => setDrawerOpen(false)}
            onSaveAll={() => saveTabs(openTabs)}
            onPointerDown={drag.begin}
          />
        ) : null}
      </div>
      <div ref={drag.lineRef} className="bento-bookmarks__drop-line" hidden aria-hidden="true" />
      <UndoToasts toasts={toasts} onRemove={removeToast} />
      {confirm ? (
        <Dialog
          open
          title={confirm.title}
          description={confirm.description}
          onOpenChange={(next) => {
            if (!next) setConfirm(null);
          }}
          actions={
            <>
              <Button variant="neutral" onActivate={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                onActivate={() => {
                  confirm.run();
                  setConfirm(null);
                }}
              >
                {confirm.confirmLabel}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}
