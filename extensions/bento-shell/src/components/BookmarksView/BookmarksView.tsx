// Layer-2 component: BookmarksView.
//
// The Bookmarks manager as a full-window view (layout "Spaces list and tabs drawer"): the spaces
// on the left, the selected space's groups as horizontally scrolling columns of links, notes and
// to-dos, and a drawer of the workspace's open tabs on the right that can be dragged into a
// column. It is presentational: it takes the tools snapshot and the open tabs, and every change is
// a `bookmarks/*` action handed to `send`; the entry (bookmarks/main.tsx) binds those to tools, and
// stories bind them to a fake. Persistent state lives in tools; what is local here is transient:
// the search text, the one open inline editor, the drawer, a pending confirmation.
//
// Every create carries a client id (actions.ts), and what follows a change (select the new space,
// scroll to the new row, put the focus back after a keyboard move) waits for that id in a snapshot
// (followups.ts). Everything a drag does has a menu on the keyboard: Save to group on an open tab,
// Move in a row's More actions menu, Move left and right on a column. The page's own right-click
// menu is replaced (contextMenuModel.ts): a row, column, space, open tab or the board gets a Bento menu
// built from the same entries as those menus (menuEntries.ts), and a text field keeps the native one.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { Button, Dialog, SearchField, Text, ToggleButton } from '@muxui/react';
import AppWindow from 'lucide-react/dist/esm/icons/app-window';
import type {
  BookmarkGroup,
  BookmarkItem,
  BookmarkItemInput,
  BookmarksSnapshot,
} from '@shared/protocol';

import { afterMotion } from '../../motion/afterMotion';
import { BentoIcon } from '../primitives';
import {
  groupCreate,
  itemCreate,
  itemRestore,
  spaceCreate,
  tabsSave,
  type TabsTarget,
} from './actions';
import { isGroupMoveNoop, isItemMoveNoop } from './drop';
import { AddGroupColumn, BoardColumn } from './BoardColumn';
import { ContextMenu } from './ContextMenu';
import {
  contextMenuFor,
  routeContextKey,
  routeContextMenu,
  type ContextTarget,
} from './contextMenuModel';
import { EmptySpace } from './EmptySpace';
import {
  editReturnSelector,
  groupAddItemSelector,
  groupMenuSelector,
  itemMainSelector,
  itemMenuSelector,
  neighbourMoves,
  revealSelector,
} from './focus';
import { exists, groupPlacedAt, itemPlacedAt, settleFollowups, type Followup } from './followups';
import { playFlip, recordFlip, type FlipRecord } from './flip';
import { LoadFailed } from './LoadFailed';
import {
  buildBoard,
  groupChoices,
  itemLabel,
  searchBookmarks,
  stableChoices,
  type SpaceSummary,
} from './model';
import { SearchResults } from './SearchResults';
import { SpacesList } from './SpacesList';
import { TabsDrawer } from './TabsDrawer';
import { UndoToasts, type UndoToast } from './UndoToasts';
import {
  editingInColumn,
  type BookmarksAction,
  type EditHandler,
  type EditTarget,
  type GroupChoice,
  type OpenTab,
} from './types';
import { useBoardDrag } from './useBoardDrag';
import './BookmarksView.css';

export interface BookmarksViewProps {
  /** Null until tools has sent the first snapshot. */
  snapshot: BookmarksSnapshot | null;
  openTabs: readonly OpenTab[];
  send: (action: BookmarksAction) => void;
  /** Leaves the view. */
  onClose: () => void;
  /** Changes on every show: the view starts fresh and, unless `focusSearchOnOpen` is false, puts
   * the focus in the search field. */
  openToken?: number;
  /** Whether a show may take the focus. Chrome says no when something above the view has it (a
   * prompt, another overlay); default true. Read when `openToken` changes. */
  focusSearchOnOpen?: boolean;
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

/** The open right-click menu: what it is about and where it opened (from the view's top left). */
interface ContextMenuState {
  target: ContextTarget;
  x: number;
  y: number;
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
  send,
  onClose,
  openToken = 0,
  focusSearchOnOpen = true,
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
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const drawer = useDrawerPresence(drawerOpen);

  const board = useMemo(() => (snapshot ? buildBoard(snapshot) : null), [snapshot]);
  const hits = useMemo(() => (snapshot ? searchBookmarks(snapshot, query) : []), [snapshot, query]);
  const searching = query.trim() !== '';
  const current = board?.current ?? null;

  const choicesRef = useRef<GroupChoice[]>([]);
  choicesRef.current = stableChoices(choicesRef.current, groupChoices(board?.groups ?? []));
  const groups = choicesRef.current;

  // Latest values for handlers that outlive a render (the Esc listener, the undo toast, the
  // callbacks handed to memoized rows).
  const latest = {
    snapshot,
    editing,
    confirm,
    query,
    spaceId: current?.id ?? null,
    emptyBoard: board?.groups.length === 0,
    focusSearchOnOpen,
  };
  const live = useRef(latest);
  live.current = latest;

  const followupsRef = useRef<Followup[]>([]);
  const flipRef = useRef<FlipRecord | null>(null);
  const returnFocusRef = useRef<EditTarget | null>(null);

  const follow = useCallback((ready: Followup['ready'], run: Followup['run']) => {
    followupsRef.current.push({ ready, run });
  }, []);

  /** Scrolls the first of these (a new row or column) into view. */
  const reveal = useCallback((ids: readonly string[]) => {
    for (const id of ids) {
      const element = rootRef.current?.querySelector(revealSelector(id));
      if (element) {
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
    }
  }, []);

  const focusOn = useCallback((selector: string) => {
    rootRef.current?.querySelector<HTMLElement>(selector)?.focus();
  }, []);

  /** Opens or closes the one inline editor. A close by keyboard hands the focus back to the row
   * or trigger the editor began on, once the editor is gone. */
  const edit = useCallback<EditHandler>((target, returnFocus = false) => {
    if (target === null && returnFocus) returnFocusRef.current = live.current.editing;
    setEditing(target);
  }, []);

  useLayoutEffect(() => {
    const target = returnFocusRef.current;
    if (editing !== null || !target) return;
    returnFocusRef.current = null;
    focusOn(editReturnSelector(target));
  }, [editing, focusOn]);

  /** Saves tabs as links in one action; the first one that arrives is scrolled into view. */
  const saveTabs = useCallback(
    (tabIds: readonly number[], target?: TabsTarget) => {
      const spaceId = live.current.spaceId;
      if (!spaceId || tabIds.length === 0) return;
      const action = tabsSave(spaceId, tabIds, target);
      follow(exists(action.ids), () => reveal(action.ids));
      send(action);
    },
    [follow, reveal, send],
  );

  const drag = useBoardDrag({
    rootRef,
    boardsRef,
    spaceId: current?.id ?? null,
    items: snapshot?.items ?? [],
    groups: useMemo(() => board?.groups.map((entry) => entry.group) ?? [], [board]),
    send,
    onTabDrop: ({ tabId, groupId, beforeId }) => saveTabs([tabId], { groupId, beforeId }),
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
    if (snapshot) followupsRef.current = settleFollowups(followupsRef.current, snapshot);
  }, [snapshot]);

  // ---- Shown and hidden by chrome ----------------------------------------------------------

  useEffect(() => {
    if (openToken === 0) return;
    cancelDrag();
    followupsRef.current = [];
    setQuery('');
    setEditing(null);
    setConfirm(null);
    setContextMenu(null);
    if (live.current.focusSearchOnOpen) searchRef.current?.focus();
  }, [openToken, cancelDrag]);

  useEffect(() => {
    if (hideToken === 0) return;
    cancelDrag();
    followupsRef.current = [];
    setEditing(null);
    setConfirm(null);
    setContextMenu(null);
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

  const createSpace = useCallback(
    (name: string) => {
      const action = spaceCreate(name);
      follow(exists([action.id]), () => send({ type: 'bookmarks/space/select', id: action.id }));
      send(action);
    },
    [follow, send],
  );

  const createGroup = useCallback(
    (name: string, viaKeyboard: boolean) => {
      const { spaceId, emptyBoard } = live.current;
      if (!spaceId) return;
      const action = groupCreate(spaceId, name);
      follow(exists([action.id]), () => {
        reveal([action.id]);
        // The empty space's "Group" button is gone once the board shows: continue in the new column.
        if (viaKeyboard && emptyBoard) focusOn(groupAddItemSelector(action.id));
      });
      send(action);
    },
    [follow, reveal, focusOn, send],
  );

  const createItem = useCallback(
    (groupId: string, item: BookmarkItemInput) => {
      const action = itemCreate(groupId, null, item);
      follow(exists([action.id]), () => reveal([action.id]));
      send(action);
    },
    [follow, reveal, send],
  );

  /** The keyboard route to dropping a row: into `groupId` before `beforeId`. The focus follows
   * the row, which is a new element when it changes column. */
  const moveItem = useCallback(
    (id: string, groupId: string, beforeId: string | null) => {
      const state = live.current.snapshot;
      if (!state || isItemMoveNoop(state.items, id, groupId, beforeId)) return;
      if (rootRef.current) flipRef.current = recordFlip(rootRef.current);
      follow(itemPlacedAt(id, groupId, beforeId), () => focusOn(itemMenuSelector(id)));
      send({ type: 'bookmarks/item/move', id, groupId, beforeId });
    },
    [follow, focusOn, send],
  );

  const moveGroup = useCallback(
    (id: string, beforeId: string | null) => {
      const { snapshot: state, spaceId } = live.current;
      if (!state || !spaceId) return;
      const siblings = state.groups.filter((group) => group.spaceId === spaceId);
      if (isGroupMoveNoop(siblings, id, beforeId)) return;
      if (rootRef.current) flipRef.current = recordFlip(rootRef.current);
      follow(groupPlacedAt(id, spaceId, beforeId), () => focusOn(groupMenuSelector(id)));
      send({ type: 'bookmarks/group/move', id, spaceId, beforeId });
    },
    [follow, focusOn, send],
  );

  const deleteItem = useCallback(
    (item: BookmarkItem) => {
      const state = live.current.snapshot;
      const restore = itemRestore(
        item,
        (state?.items ?? []).filter((entry) => entry.groupId === item.groupId),
      );
      send({ type: 'bookmarks/item/delete', id: item.id });
      const id = (nextToastId.current += 1);
      const undo = (viaKeyboard: boolean) => {
        // The Undo button is gone once it has been used: a keyboard user continues on the row.
        follow(exists([item.id]), () => {
          reveal([item.id]);
          if (viaKeyboard) focusOn(itemMainSelector(item.id));
        });
        send(restore);
      };
      setToasts((current) =>
        [
          ...current,
          { id, title: `${KIND_LABEL[item.kind]} deleted`, label: itemLabel(item), onUndo: undo },
        ].slice(-MAX_TOASTS),
      );
    },
    [follow, reveal, focusOn, send],
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

  const saveAllTabs = () => saveTabs(openTabs.map((tab) => tab.id));
  // Stable, because the drawer's memoized rows take it.
  const saveTab = useCallback(
    (tab: OpenTab, groupId: string | null) => saveTabs([tab.id], { groupId, beforeId: null }),
    [saveTabs],
  );

  // ---- Context menu ------------------------------------------------------------------------

  // Needs the Clipboard API's user activation, which the menu item's click or key press gives.
  const copy = useCallback((text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
  }, []);

  const contextContent =
    contextMenu && board
      ? contextMenuFor(contextMenu.target, {
          board,
          openTabs,
          groups,
          handlers: {
            send,
            onEdit: edit,
            onOpen: open,
            onCopy: copy,
            onDelete: deleteItem,
            onMove: moveItem,
            onMoveGroup: moveGroup,
            onOpenAll: openAll,
            onDeleteGroup: deleteGroup,
            onDeleteSpace: deleteSpace,
            onSaveAllTabs: saveAllTabs,
            onSaveTab: saveTab,
          },
        })
      : null;

  // The element the menu is about is gone (another window deleted it): the menu goes with it.
  useEffect(() => {
    if (contextMenu && !contextContent) setContextMenu(null);
  }, [contextMenu, contextContent]);

  const openContextMenu = (target: ContextTarget, clientX: number, clientY: number) => {
    const origin = rootRef.current?.getBoundingClientRect();
    setContextMenu({
      target,
      x: clientX - (origin?.left ?? 0),
      y: clientY - (origin?.top ?? 0),
    });
  };

  /** The page's menu never shows here. A text field keeps the native one; an element with actions
   * gets the Bento menu at the pointer; anything else gets nothing. */
  const onContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    const route = routeContextMenu(event.target instanceof Element ? event.target : null);
    if (route.route === 'native') return;
    event.preventDefault();
    if (route.route === 'menu' && !drag.active) {
      openContextMenu(route.target, event.clientX, event.clientY);
    }
  };

  /** The Menu key and Shift+F10 open the menu of the focused element, below it. */
  const onKeyDownCapture = (event: ReactKeyboardEvent<HTMLElement>) => {
    const focused = event.target instanceof Element ? event.target : null;
    const route = routeContextKey(event.nativeEvent, focused);
    if (!focused || !route || route.route === 'native') return;
    event.preventDefault();
    if (route.route === 'menu' && !drag.active) {
      const box = focused.getBoundingClientRect();
      openContextMenu(route.target, box.left, box.bottom);
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
        editing={editing}
        onEdit={edit}
        onCreateGroup={createGroup}
        onSaveTabs={saveAllTabs}
        onImport={() => send({ type: 'bookmarks/import/firefox' })}
        onDismissImport={() => send({ type: 'bookmarks/import/dismiss' })}
      />
    );
  } else {
    main = (
      <div ref={boardsRef} className="bento-bookmarks__boards" data-bm-board>
        {board.groups.map(({ group, items }, index) => {
          const { earlier, later } = neighbourMoves(
            board.groups.map((entry) => entry.group.id),
            index,
          );
          return (
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
              groups={groups}
              moveLeftBefore={earlier}
              moveRightBefore={later}
              send={send}
              onEdit={edit}
              onCreateItem={createItem}
              onMove={moveItem}
              onMoveGroup={moveGroup}
              onOpen={open}
              onCopy={copy}
              onDelete={deleteItem}
              onOpenAll={openAll}
              onDeleteGroup={deleteGroup}
              onPointerDown={drag.begin}
              isSuppressed={drag.isSuppressed}
            />
          );
        })}
        <AddGroupColumn editing={editing} onEdit={edit} onCreate={createGroup} />
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

  if (snapshot?.status === 'loadFailed') {
    return (
      <div
        ref={rootRef}
        className="bento-bookmarks"
        onContextMenu={onContextMenu}
        onKeyDownCapture={onKeyDownCapture}
      >
        <LoadFailed
          snapshot={snapshot}
          onRetry={() => send({ type: 'bookmarks/requestSnapshot' })}
          onClose={onClose}
        />
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="bento-bookmarks"
      aria-busy={snapshot ? undefined : true}
      onContextMenu={onContextMenu}
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="bento-bookmarks__frame" data-drawer={drawer.mounted ? 'open' : 'closed'}>
        <SpacesList
          spaces={board?.spaces ?? []}
          currentId={current?.id ?? null}
          editing={editing}
          send={send}
          onEdit={edit}
          onCreate={createSpace}
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
            groups={groups}
            onClose={() => setDrawerOpen(false)}
            onSaveAll={saveAllTabs}
            onSaveTab={saveTab}
            onPointerDown={drag.begin}
          />
        ) : null}
      </div>
      <div ref={drag.lineRef} className="bento-bookmarks__drop-line" hidden aria-hidden="true" />
      <UndoToasts toasts={toasts} onRemove={removeToast} />
      <ContextMenu
        request={
          contextMenu && contextContent
            ? { x: contextMenu.x, y: contextMenu.y, ...contextContent }
            : null
        }
        onClose={() => setContextMenu(null)}
      />
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
