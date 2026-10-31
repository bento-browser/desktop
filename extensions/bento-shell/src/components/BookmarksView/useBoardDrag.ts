// Pointer drag for the boards, in the PinnedPanels pattern: a press becomes a drag after 4px of
// movement, the pointer is captured only then (so a click still reaches its button), the insertion
// line is an overlay that never reflows the rows, and nothing is sent until the pointer is
// released. Sources are a row, an open tab from the drawer, or a whole column.
//
// While a drag runs the hook draws imperatively (a clone of the source follows the pointer, the
// line follows the slot) from one animation frame loop that also scrolls the boards near their
// edges, so a pointer move costs no React render. React hears only of the start and the end.
//
// Once a press has become a drag, the controls under it must not activate when the button is
// released, however the drag ended (dropped, or cancelled with Esc while the button is still down):
// the click suppressor stays armed from the start of the drag until that release has passed.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { BookmarkGroup, BookmarkItem } from '@shared/protocol';

import {
  contains,
  groupDrop,
  isGroupMoveNoop,
  isItemMoveNoop,
  itemDrop,
  type Box,
  type ColumnBox,
  type GroupDrop,
  type ItemDrop,
} from './drop';
import { createClickSuppressor } from './clickSuppressor';
import { recordFlip, type FlipRecord } from './flip';
import type { BookmarksAction } from './types';

export type DragSource =
  { kind: 'item'; id: string } | { kind: 'tab'; id: number } | { kind: 'group'; id: string };

/** The press has to move this far before it is a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Autoscroll: how close to an edge scrolling starts, and how far it moves per frame. */
const EDGE_PX = 48;
const SCROLL_STEP_PX = 14;

type Target =
  { kind: 'item'; drop: ItemDrop } | { kind: 'group'; drop: GroupDrop } | { kind: 'empty' };

interface Session {
  source: DragSource;
  element: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dragging: boolean;
  captured: boolean;
  ghost: HTMLElement | null;
  /** Where the pointer was in the source when the press began. */
  grabX: number;
  grabY: number;
  rootLeft: number;
  rootTop: number;
  target: Target | null;
  frame: number;
  stop: () => void;
}

export interface BoardDragConfig {
  rootRef: RefObject<HTMLElement | null>;
  boardsRef: RefObject<HTMLElement | null>;
  spaceId: string | null;
  /** Every item of the snapshot, in order, to skip a move that changes nothing. */
  items: readonly BookmarkItem[];
  /** The current space's groups, in order. */
  groups: readonly BookmarkGroup[];
  send: (action: BookmarksAction) => void;
  /** A tab was dropped: into `groupId` before `beforeId` (the end when null), or, with a null
   * `groupId`, onto the empty-space zone for a new group. The view sends the save. */
  onTabDrop: (drop: { tabId: number; groupId: string | null; beforeId: string | null }) => void;
  /** Where everything was just before a move, for the settle once the snapshot arrives. */
  onFlip: (record: FlipRecord) => void;
}

function boxOf(element: Element): Box {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
}

export function useBoardDrag(config: BoardDragConfig) {
  const configRef = useRef(config);
  configRef.current = config;
  const sessionRef = useRef<Session | null>(null);
  const [suppressor] = useState(() => createClickSuppressor(() => window));
  const lineRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<DragSource | null>(null);

  /** The columns' boxes: the item list for dropping items, the whole column for ordering columns. */
  const measureColumns = useCallback((withItems: boolean) => {
    const boards = configRef.current.boardsRef.current;
    const columns: Array<ColumnBox & { column: Box; list: HTMLElement | null }> = [];
    if (!boards) return columns;
    for (const element of boards.querySelectorAll<HTMLElement>('[data-bm-group-id]')) {
      const list = element.querySelector<HTMLElement>('[data-bm-list]');
      columns.push({
        groupId: element.dataset.bmGroupId ?? '',
        box: boxOf(list ?? element),
        column: boxOf(element),
        list,
        items: withItems
          ? Array.from(element.querySelectorAll<HTMLElement>('[data-bm-item-id]'), (row) => ({
              id: row.dataset.bmItemId ?? '',
              box: boxOf(row),
            }))
          : [],
      });
    }
    return columns;
  }, []);

  const targetAt = useCallback(
    (session: Session): Target | null => {
      const { rootRef, boardsRef } = configRef.current;
      const point = { x: session.x, y: session.y };
      const { source } = session;
      if (source.kind === 'tab') {
        const zone = rootRef.current?.querySelector('[data-bm-drop-zone="empty"]');
        if (zone && contains(boxOf(zone), point)) return { kind: 'empty' };
      }
      const boards = boardsRef.current;
      if (!boards || !contains(boxOf(boards), point)) return null;
      if (source.kind === 'group') {
        const drop = groupDrop(
          measureColumns(false).map(({ groupId, column }) => ({ groupId, box: column })),
          point,
          source.id,
        );
        return drop ? { kind: 'group', drop } : null;
      }
      const drop = itemDrop(measureColumns(true), point, source.kind === 'item' ? source.id : null);
      return drop ? { kind: 'item', drop } : null;
    },
    [measureColumns],
  );

  const draw = useCallback(
    (session: Session) => {
      const { rootRef } = configRef.current;
      const line = lineRef.current;
      session.target = targetAt(session);
      if (session.ghost) {
        session.ghost.style.transform = `translate(${session.x - session.rootLeft - session.grabX}px, ${
          session.y - session.rootTop - session.grabY
        }px)`;
      }
      const empty = rootRef.current?.querySelector('[data-bm-drop-zone="empty"]');
      empty?.toggleAttribute('data-bm-drop-active', session.target?.kind === 'empty');
      if (!line) return;
      const target = session.target;
      if (!target || target.kind === 'empty') {
        line.hidden = true;
        return;
      }
      const style = line.style;
      if (target.kind === 'item') {
        const { left, right, y } = target.drop.line;
        line.dataset.orientation = 'horizontal';
        style.left = `${left - session.rootLeft}px`;
        style.top = `${y - session.rootTop}px`;
        style.width = `${right - left}px`;
        style.height = '';
      } else {
        const { x, top, bottom } = target.drop.line;
        line.dataset.orientation = 'vertical';
        style.left = `${x - session.rootLeft}px`;
        style.top = `${top - session.rootTop}px`;
        style.width = '';
        style.height = `${bottom - top}px`;
      }
      line.hidden = false;
    },
    [targetAt],
  );

  /** Scrolls the boards sideways, and the column under the pointer up or down, near their edges. */
  const autoscroll = useCallback(
    (session: Session) => {
      const boards = configRef.current.boardsRef.current;
      if (!boards) return;
      const area = boxOf(boards);
      if (session.y < area.top || session.y > area.bottom) return;
      if (session.x < area.left + EDGE_PX) boards.scrollLeft -= SCROLL_STEP_PX;
      else if (session.x > area.right - EDGE_PX) boards.scrollLeft += SCROLL_STEP_PX;
      if (session.source.kind === 'group') return;
      const column = measureColumns(false).find(
        ({ box }) => session.x >= box.left && session.x < box.right,
      );
      if (!column?.list) return;
      const list = boxOf(column.list);
      if (session.y < list.top + EDGE_PX) column.list.scrollTop -= SCROLL_STEP_PX;
      else if (session.y > list.bottom - EDGE_PX) column.list.scrollTop += SCROLL_STEP_PX;
    },
    [measureColumns],
  );

  const perform = useCallback((session: Session) => {
    const { rootRef, send, spaceId, items, groups, onFlip, onTabDrop } = configRef.current;
    const { source, target } = session;
    if (!target || !rootRef.current) return;
    const record = () => {
      const flip = recordFlip(rootRef.current!);
      // The dragged row settles from where it was let go, not from where it sat.
      const ghost = session.ghost?.getBoundingClientRect();
      if (ghost && source.kind === 'item') flip.rects.set(`item:${source.id}`, ghost);
      onFlip(flip);
    };
    if (source.kind === 'item' && target.kind === 'item') {
      const { groupId, beforeId } = target.drop;
      if (isItemMoveNoop(items, source.id, groupId, beforeId)) return;
      record();
      send({ type: 'bookmarks/item/move', id: source.id, groupId, beforeId });
    } else if (source.kind === 'group' && target.kind === 'group' && spaceId) {
      const { beforeId } = target.drop;
      if (isGroupMoveNoop(groups, source.id, beforeId)) return;
      record();
      send({ type: 'bookmarks/group/move', id: source.id, spaceId, beforeId });
    } else if (source.kind === 'tab' && spaceId) {
      if (target.kind === 'item') {
        const { groupId, beforeId } = target.drop;
        record();
        onTabDrop({ tabId: source.id, groupId, beforeId });
      } else if (target.kind === 'empty') {
        onTabDrop({ tabId: source.id, groupId: null, beforeId: null });
      }
    }
  }, []);

  const finish = useCallback(
    (commit: boolean) => {
      const session = sessionRef.current;
      if (!session) return;
      sessionRef.current = null;
      session.stop();
      cancelAnimationFrame(session.frame);
      if (session.captured) {
        try {
          session.element.releasePointerCapture(session.pointerId);
        } catch {
          // The capture may already be released by a cancelled pointer.
        }
      }
      if (session.dragging) {
        const root = configRef.current.rootRef.current;
        root?.removeAttribute('data-bm-dragging');
        root?.querySelector('[data-bm-drop-zone="empty"]')?.removeAttribute('data-bm-drop-active');
        if (lineRef.current) lineRef.current.hidden = true;
        if (commit) perform(session);
        session.ghost?.remove();
        setActive(null);
      }
    },
    [perform],
  );

  const startDragging = useCallback(
    (session: Session) => {
      const root = configRef.current.rootRef.current;
      if (!root) return;
      session.dragging = true;
      // Armed until the button is released and its click has passed, whatever ends the drag first.
      suppressor.begin(session.pointerId, false);
      try {
        session.element.setPointerCapture(session.pointerId);
        session.captured = true;
      } catch {
        // Without capture the drag works while the pointer stays inside the window.
      }
      const source = session.element;
      const box = source.getBoundingClientRect();
      const rootBox = root.getBoundingClientRect();
      session.rootLeft = rootBox.left;
      session.rootTop = rootBox.top;
      session.grabX = session.startX - box.left;
      session.grabY = session.startY - box.top;
      const ghost = source.cloneNode(true) as HTMLElement;
      for (const node of [ghost, ...ghost.querySelectorAll('[id]')]) node.removeAttribute('id');
      for (const name of ['data-bm-flip', 'data-bm-item-id', 'data-bm-tab-id']) {
        ghost.removeAttribute(name);
      }
      ghost.classList.add('bento-bookmarks__ghost');
      ghost.setAttribute('aria-hidden', 'true');
      ghost.style.width = `${box.width}px`;
      root.append(ghost);
      session.ghost = ghost;
      root.setAttribute('data-bm-dragging', session.source.kind);
      setActive(session.source);
      const tick = () => {
        if (sessionRef.current !== session) return;
        autoscroll(session);
        draw(session);
        session.frame = requestAnimationFrame(tick);
      };
      session.frame = requestAnimationFrame(tick);
    },
    [autoscroll, draw, suppressor],
  );

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, source: DragSource) => {
      if (event.button !== 0 || sessionRef.current) return;
      if (event.target instanceof Element && event.target.closest('[data-bm-no-drag]')) return;
      const element = event.currentTarget;
      const onMove = (move: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || move.pointerId !== session.pointerId) return;
        session.x = move.clientX;
        session.y = move.clientY;
        if (session.dragging) return;
        const dx = move.clientX - session.startX;
        const dy = move.clientY - session.startY;
        if (dx * dx + dy * dy >= DRAG_THRESHOLD_PX ** 2) startDragging(session);
      };
      const onUp = (up: PointerEvent) => {
        if (up.pointerId !== sessionRef.current?.pointerId) return;
        const session = sessionRef.current;
        session.x = up.clientX;
        session.y = up.clientY;
        if (session.dragging) draw(session);
        finish(true);
      };
      const onCancel = () => finish(false);
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== 'Escape' || !sessionRef.current?.dragging) return;
        key.preventDefault();
        key.stopPropagation();
        finish(false);
      };
      const onVisibility = () => {
        if (document.hidden) finish(false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('blur', onCancel);
      document.addEventListener('visibilitychange', onVisibility);
      sessionRef.current = {
        source,
        element,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
        captured: false,
        ghost: null,
        grabX: 0,
        grabY: 0,
        rootLeft: 0,
        rootTop: 0,
        target: null,
        frame: 0,
        stop: () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          window.removeEventListener('pointercancel', onCancel);
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('blur', onCancel);
          document.removeEventListener('visibilitychange', onVisibility);
        },
      };
    },
    [draw, finish, startDragging],
  );

  // A drag does not outlive the view.
  useEffect(
    () => () => {
      finish(false);
      suppressor.end();
    },
    [finish, suppressor],
  );

  /** True for the press that began a drag, through its release: a control checks it before it
   * activates. */
  const isSuppressed = suppressor.isActive;

  /** Drops the drag in progress for good: the view is going away, so the release is moot. */
  const cancel = useCallback(() => {
    finish(false);
    suppressor.end();
  }, [finish, suppressor]);

  return { begin, active, lineRef, isSuppressed, cancel };
}
