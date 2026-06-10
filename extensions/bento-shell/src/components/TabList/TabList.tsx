import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '@tale-ui/react/button';
import { Icon } from '@tale-ui/react/icon';
import PanelRight from 'lucide-react/dist/esm/icons/panel-right';
import Plus from 'lucide-react/dist/esm/icons/plus';

import { useTabsStore, useWorkspaceTabIds } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { usePanelsStore } from '../../state/panels';
import { useSettingsStore } from '../../state/settings';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import { useTabFoldersStore, useWorkspaceFolders } from '../../state/tabFolders';
import { TabRow } from '../TabRow/TabRow';
import { FolderRow } from '../FolderRow/FolderRow';
import { TabListSkeleton } from './TabListSkeleton';
import { buildDisplayRows, flattenTabOrder, pruneSelection, rowKey } from './displayRows';
import './TabList.css';

export interface TabListProps {
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onCloseSelected?: (ids: number[]) => void;
  onCreateTab: () => void;
  onCreatePanel: () => void;
  onOpenInSidePanel: (id: number) => void;
  onTabContextMenu?: (
    id: number,
    event: React.MouseEvent<HTMLDivElement>,
    selectedIds: number[],
  ) => void;
  onFolderContextMenu?: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  /** Called when the user drops a tab at a new position. The dragged tab
   * should land immediately before (`before=true`) or after (`before=false`)
   * `anchorId` in the chrome window's tab strip. Anchor-based (not
   * absolute-index-based) because Bento panels assign each active tab a
   * plain-object `splitview` marker; browser.tabs.move's
   * index-with-splitview-transformation throws on those tabs. Chrome's
   * gBrowser.moveTabBefore / moveTabAfter operate on element references
   * and preserve tab identity, so anchor coords map cleanly. Optional so
   * stories can render without wiring a port. */
  onReorder?: (id: number, anchorId: number, before: boolean) => void;
}

const ROW_HEIGHT_FALLBACK = 32;
// Matches --bento-duration-base (200ms) used by the .bento-tab-row--removing
// CSS transition. Keep in sync if either side changes.
const REMOVAL_ANIMATION_MS = 200;
// Workspace-switch slide. Slightly longer than per-tab removal so the eye
// has time to track the directional motion. Keep in sync with the
// .bento-tab-list-pane--{enter,exit}-* CSS animation duration.
const WORKSPACE_SLIDE_MS = 260;
const SELECTED_TABS_TITLE_PREFIX = 'BENTO_SELECTED_TABS:';

function encodeSelectedTabIds(ids: number[]): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(ids))));
}

// Keeps removed ids in `displayedIds` for REMOVAL_ANIMATION_MS so the row
// can fade out before truly unmounting. Removed ids stay at their previous
// position until the timer fires; new ids appear at their orderedIds
// position immediately. The virtualizer sees `displayedIds.length`, so
// each fading row keeps its layout slot — siblings only shift up after
// the timer has actually pulled the id out.
function useDelayedRemovals(
  ids: number[],
  delayMs: number,
): { ids: number[]; removing: Set<number> } {
  const [displayed, setDisplayed] = useState<number[]>(ids);
  const [removing, setRemoving] = useState<Set<number>>(new Set());
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    setDisplayed((prev) => {
      const orderedSet = new Set(ids);

      const newlyRemoved: number[] = [];
      for (const id of prev) {
        if (!orderedSet.has(id) && !timersRef.current.has(id)) newlyRemoved.push(id);
      }

      // Schedule a real removal for each newly-removed id. After the
      // delay the id is filtered out of displayed and the removing set,
      // siblings shift up via the virtualizer.
      for (const id of newlyRemoved) {
        const timer = setTimeout(() => {
          timersRef.current.delete(id);
          setDisplayed((cur) => cur.filter((x) => x !== id));
          setRemoving((cur) => {
            if (!cur.has(id)) return cur;
            const next = new Set(cur);
            next.delete(id);
            return next;
          });
        }, delayMs);
        timersRef.current.set(id, timer);
      }

      if (newlyRemoved.length > 0) {
        setRemoving((cur) => {
          const next = new Set(cur);
          for (const id of newlyRemoved) next.add(id);
          return next;
        });
      }

      // Build the next displayed list: keep ordered IDs in their new
      // positions, re-insert each still-removing id at the position it
      // held in the previous list (so it doesn't visually jump).
      const next = ids.slice();
      for (let i = 0; i < prev.length; i++) {
        const id = prev[i];
        if (id === undefined) continue;
        if (orderedSet.has(id)) continue;
        if (!timersRef.current.has(id)) continue;
        // Insert at min(i, next.length) so trailing removes don't get
        // bunched at the front of a now-shorter list.
        next.splice(Math.min(i, next.length), 0, id);
      }

      // Skip state update if nothing changed (avoids loop when ids
      // reference is stable but content matches displayed already).
      if (next.length === prev.length && next.every((v, i) => v === prev[i])) return prev;
      return next;
    });
  }, [ids, delayMs]);

  useEffect(
    () => () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    },
    [],
  );

  return { ids: displayed, removing };
}

interface TabListPaneProps {
  workspaceId: string | null;
  ids: number[];
  tabsById: ReturnType<typeof useTabsStore.getState>['byId'];
  activeId: number | null;
  selectedIds: Set<number>;
  onCreateTab: () => void;
  onCreatePanel: () => void;
  onSelectClick: (id: number, event: React.MouseEvent<HTMLDivElement>) => void;
  onClose: (id: number) => void;
  onOpenInSidePanel: (id: number) => void;
  onTabContextMenu?: (
    id: number,
    event: React.MouseEvent<HTMLDivElement>,
    selectedIds: number[],
  ) => void;
  onFolderContextMenu?: (id: string, event: React.MouseEvent<HTMLDivElement>) => void;
  onSelectionContextMenu: (id: number) => number[];
  /** When defined, the pane enables HTML5 drag-and-drop reordering and
   * calls back with (id, anchorId, before) once the user drops. The
   * outgoing pane during a workspace-switch slide passes undefined so
   * its rows aren't grabbable while sliding off (it is also
   * pointer-events:none in CSS, but the prop gate is clearer). */
  onReorder?: (id: number, anchorId: number, before: boolean) => void;
  isCollapsed: boolean;
  className: string;
}

// One scrollable, virtualized tab list. The TabList stage composes one
// or two of these — a single steady-state pane, or two layered panes
// during a workspace-switch slide animation. Keeping the per-tab fade-
// removal logic inside the pane (rather than in the stage) means the
// outgoing pane during a workspace switch sees a stable `ids` snapshot
// from its parent and naturally won't trigger any per-tab animations of
// its own — the entire pane just slides off.
function TabListPane({
  workspaceId,
  ids,
  tabsById,
  activeId,
  selectedIds,
  onCreateTab,
  onCreatePanel,
  onSelectClick,
  onClose,
  onOpenInSidePanel,
  onTabContextMenu,
  onFolderContextMenu,
  onSelectionContextMenu,
  onReorder,
  isCollapsed,
  className,
}: TabListPaneProps) {
  const { ids: displayedIds, removing } = useDelayedRemovals(ids, REMOVAL_ANIMATION_MS);
  const folders = useWorkspaceFolders(workspaceId);
  const parentRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_FALLBACK);
  const [rowGap, setRowGap] = useState(0);
  const rowSlotSize = rowHeight + rowGap;
  // Drag source — the tab id the user is currently grabbing, or null.
  // Removed-but-fading rows in displayedIds keep their slot; locking the
  // source id (not its filtered index) means the indicator math stays
  // correct even if a fade-out and the drag overlap.
  const [dragSourceId, setDragSourceId] = useState<number | null>(null);
  const [dragFolderId, setDragFolderId] = useState<string | null>(null);
  // Drop slot — 0..displayedIds.length, where slot N means "insert above
  // the row that currently occupies filtered position N" (and `length`
  // means "drop at end"). Null when the cursor isn't over a valid drop
  // target so the indicator hides.
  const [dropSlot, setDropSlot] = useState<number | null>(null);

  // Persistent probe + ResizeObserver. Vite injects CSS asynchronously in
  // dev, so a one-shot read can race the stylesheet and fall back. Watching
  // live probes means we pick up the real row height and gap as soon as
  // the vars resolve — and again if either changes (theme swap, HMR, etc.).
  useEffect(() => {
    if (!parentRef.current) return;
    const rowProbe = document.createElement('div');
    rowProbe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--bento-tab-row-height);';
    const gapProbe = document.createElement('div');
    gapProbe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--bento-tab-list-row-gap);';
    parentRef.current.append(rowProbe, gapProbe);
    const update = () => {
      const nextRowHeight = rowProbe.getBoundingClientRect().height;
      const nextRowGap = gapProbe.getBoundingClientRect().height;
      if (nextRowHeight > 0) setRowHeight(nextRowHeight);
      if (nextRowGap >= 0) setRowGap(nextRowGap);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(rowProbe);
    ro.observe(gapProbe);
    return () => {
      ro.disconnect();
      rowProbe.remove();
      gapProbe.remove();
    };
  }, []);

  const rows = useMemo(
    () =>
      buildDisplayRows(displayedIds, tabsById, folders, activeId, {
        isCollapsed,
        forceCollapsedFolders: dragFolderId !== null,
      }),
    [activeId, displayedIds, dragFolderId, folders, isCollapsed, tabsById],
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => rowSlotSize, [rowSlotSize]),
    overscan: 5,
  });

  useLayoutEffect(() => {
    virtualizer.measure();
  }, [rowSlotSize, rows.length, virtualizer]);

  // Translate the pointer's y position into a drop slot (0..displayedIds.length).
  // Reads the viewport's scrollable coords, divides by the measured row
  // slot size, then rounds toward the nearest gap (top-half = insert above,
  // bottom-half = insert below). Returns null if the geometry isn't ready
  // or the pointer is outside the viewport bounds.
  const computeDropSlot = useCallback(
    (clientY: number): number | null => {
      const el = parentRef.current;
      if (!el || rowSlotSize <= 0) return null;
      const rect = el.getBoundingClientRect();
      const relY = clientY - rect.top + el.scrollTop;
      const len = rows.length;
      if (len === 0) return 0;
      let slot = Math.round(relY / rowSlotSize);
      if (slot < 0) slot = 0;
      if (slot > len) slot = len;
      return slot;
    },
    [rowSlotSize, rows.length],
  );

  // Resolve the dragged tab's drop position to an anchor tab + side.
  // Picks the displayed tab adjacent to the drop slot (after removing the
  // source from the filtered list) and returns whether the dragged tab
  // should be inserted before or after it. Returns null if state is
  // incoherent (source not in displayedIds, empty list after removal,
  // etc.) so the caller skips dispatch.
  //
  // Anchor-based (not absolute-index) because Bento marks each active
  // tab's `.splitview` with a plain-object marker; Firefox's
  // browser.tabs.move() transforms `element = element.splitview` inside
  // moveTabTo, then throws "Can only move a tab, tab group, or split
  // view within the tab bar" because the marker isn't a real
  // MozTabSplitViewWrapper. Chrome's gBrowser.moveTabBefore/After don't
  // do that transformation — they operate on the original element
  // reference. So we pass anchor coords across title-IPC and let chrome
  // call the safe API.
  const resolveAnchor = useCallback(
    (sourceId: number, hoverSlot: number): { anchorId: number; before: boolean } | null => {
      const srcSlot = displayedIds.indexOf(sourceId);
      if (srcSlot < 0) return null;
      const tabRows = rows.filter((row) => row.kind === 'tab');
      const rowTabOrder = tabRows.map((row) => row.id);
      const rowSrcSlot = rowTabOrder.indexOf(sourceId);
      if (rowSrcSlot < 0) return null;
      const tabSlot = rows.slice(0, hoverSlot).filter((row) => row.kind === 'tab').length;
      const slotInRemoved = tabSlot <= rowSrcSlot ? tabSlot : tabSlot - 1;
      const without = rowTabOrder.filter((id) => id !== sourceId);
      if (without.length === 0) return null;
      if (slotInRemoved >= without.length) {
        const anchor = without[without.length - 1];
        if (anchor === undefined) return null;
        return { anchorId: anchor, before: false };
      }
      const anchor = without[slotInRemoved];
      if (anchor === undefined) return null;
      return { anchorId: anchor, before: true };
    },
    [displayedIds, rows],
  );

  const onPaneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (dragSourceId === null && dragFolderId === null) return;
    // preventDefault opts this element in as a drop target — without it
    // Firefox blocks the drop and the cursor shows a "not allowed"
    // icon. dropEffect='move' mirrors the effectAllowed we set in
    // onDragStart so the cursor reads as a reorder.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const slot = computeDropSlot(e.clientY);
    if (slot !== null && slot !== dropSlot) setDropSlot(slot);
  };

  const onPaneDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    // dragleave fires when the cursor moves onto a child element too —
    // ignore those by gating on relatedTarget being outside the pane.
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    setDropSlot(null);
  };

  const onPaneDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (dragSourceId === null && dragFolderId === null) return;
    e.preventDefault();
    const slot = computeDropSlot(e.clientY);
    const sourceId = dragSourceId;
    const sourceFolderId = dragFolderId;
    setDropSlot(null);
    setDragSourceId(null);
    setDragFolderId(null);
    if (slot === null) return;
    if (sourceFolderId !== null && workspaceId) {
      const folderRows = rows
        .map((row) => (row.kind === 'folder' ? row.folderId : null))
        .filter((id): id is string => id !== null);
      const from = folderRows.indexOf(sourceFolderId);
      if (from < 0) return;
      const target = rows.slice(0, slot).filter((row) => row.kind === 'folder').length;
      const without = folderRows.filter((id) => id !== sourceFolderId);
      without.splice(Math.max(0, Math.min(target, without.length)), 0, sourceFolderId);
      dispatch({ type: 'tabFolder/reorder', workspaceId, orderedIds: without });
      return;
    }
    if (sourceId === null || !onReorder) return;
    const anchor = resolveAnchor(sourceId, slot);
    if (anchor === null || anchor.anchorId === sourceId) return;
    onReorder(sourceId, anchor.anchorId, anchor.before);
  };

  const handleDragStart = useCallback((id: number) => {
    setDragSourceId(id);
    setDragFolderId(null);
    setDropSlot(null);
  }, []);
  const handleDragEnd = useCallback(() => {
    setDragSourceId(null);
    setDragFolderId(null);
    setDropSlot(null);
  }, []);
  const handleFolderDragStart = useCallback((id: string) => {
    setDragFolderId(id);
    setDragSourceId(null);
    setDropSlot(null);
  }, []);
  const handleFolderDragEnd = useCallback(() => {
    setDragFolderId(null);
    setDropSlot(null);
  }, []);
  const handleRowContextMenu = useCallback(
    (tabId: number, event: React.MouseEvent<HTMLDivElement>) => {
      onTabContextMenu?.(tabId, event, onSelectionContextMenu(tabId));
    },
    [onSelectionContextMenu, onTabContextMenu],
  );

  const dragEnabled = onReorder !== undefined || workspaceId !== null;
  const dropIndicatorY = dropSlot === null ? 0 : Math.max(0, dropSlot * rowSlotSize - rowGap / 2);

  return (
    <div
      ref={parentRef}
      className={className}
      onDragOver={dragEnabled ? onPaneDragOver : undefined}
      onDragLeave={dragEnabled ? onPaneDragLeave : undefined}
      onDrop={dragEnabled ? onPaneDrop : undefined}
    >
      <div
        className="bento-tab-list__viewport"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {dropSlot !== null && (dragSourceId !== null || dragFolderId !== null) && (
          <div
            className="bento-tab-list__drop-indicator"
            style={{ transform: `translateY(${dropIndicatorY}px)` }}
            aria-hidden="true"
          />
        )}
        {virtualizer.getVirtualItems().map((vi) => {
          const row = rows[vi.index];
          if (!row) return null;
          if (row.kind === 'new-tab') {
            return (
              <div
                key={rowKey(row)}
                className={
                  row.afterPinnedSection
                    ? 'bento-tab-list__row bento-tab-list__row--new-tab bento-tab-list__row--after-pinned'
                    : 'bento-tab-list__row bento-tab-list__row--new-tab'
                }
                style={{ transform: `translateY(${vi.start}px)`, height: `${rowHeight}px` }}
              >
                <div className="bento-tab-list__new-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="bento-tab-list__new-action-button"
                    aria-label="New tab"
                    onPress={onCreateTab}
                  >
                    <Icon icon={Plus} size="sm" />
                    <span className="bento-tab-list__new-action-label">New tab</span>
                  </Button>
                  {!isCollapsed && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="bento-tab-list__new-action-button"
                      aria-label="New panel"
                      onPress={onCreatePanel}
                    >
                      <Icon icon={PanelRight} size="sm" />
                      <span className="bento-tab-list__new-action-label">New panel</span>
                    </Button>
                  )}
                </div>
              </div>
            );
          }

          if (row.kind === 'new-panel') {
            return (
              <div
                key={rowKey(row)}
                className="bento-tab-list__row bento-tab-list__row--new-tab"
                style={{ transform: `translateY(${vi.start}px)`, height: `${rowHeight}px` }}
              >
                <div className="bento-tab-list__new-actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="bento-tab-list__new-action-button"
                    aria-label="New panel"
                    onPress={onCreatePanel}
                  >
                    <Icon icon={PanelRight} size="sm" />
                    <span className="bento-tab-list__new-action-label">New panel</span>
                  </Button>
                </div>
              </div>
            );
          }

          if (row.kind === 'folder') {
            const folder = folders.find((candidate) => candidate.id === row.folderId);
            if (!folder) return null;
            return (
              <div
                key={rowKey(row)}
                className="bento-tab-list__row"
                style={{ transform: `translateY(${vi.start}px)`, height: `${rowHeight}px` }}
              >
                <FolderRow
                  folder={folder}
                  dragging={row.folderId === dragFolderId}
                  onContextMenu={onFolderContextMenu}
                  onDragStart={handleFolderDragStart}
                  onDragEnd={handleFolderDragEnd}
                />
              </div>
            );
          }

          const id = row.kind === 'tab' || row.kind === 'peek' ? row.id : undefined;
          if (id === undefined) return null;
          return (
            <div
              key={rowKey(row)}
              className="bento-tab-list__row"
              style={{ transform: `translateY(${vi.start}px)`, height: `${rowHeight}px` }}
            >
              <TabRow
                id={id}
                active={id === activeId}
                selected={selectedIds.has(id)}
                removing={removing.has(id)}
                dragging={id === dragSourceId}
                indent={row.kind === 'peek' || row.indent}
                onActivate={onSelectClick}
                onClose={onClose}
                onOpenInSidePanel={onOpenInSidePanel}
                onContextMenu={onTabContextMenu ? handleRowContextMenu : undefined}
                onDragStart={dragEnabled && row.kind === 'tab' ? handleDragStart : undefined}
                onDragEnd={dragEnabled && row.kind === 'tab' ? handleDragEnd : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Workspace-switch slide:
//   - When the active workspace changes, we capture the previous
//     workspace's ids (snapshotRef) and render the previous pane as
//     "outgoing" alongside the new pane as "incoming".
//   - Direction comes from comparing positions in the workspace switcher:
//     if the new workspace is later in the list, motion is rightward (new
//     enters from right, old exits to left); otherwise leftward.
//   - After WORKSPACE_SLIDE_MS the outgoing pane is dropped from the DOM,
//     leaving the steady-state layout (incoming pane fills the stage).
//
// Why a directional slide instead of cross-fading the per-tab removal
// animation: useDelayedRemovals interprets a workspace-induced id-set
// change as "every previous tab was just closed" and renders the union
// of both workspaces' tabs while the fade timer runs. With many tabs per
// workspace that flash of all-tabs-at-once was visibly jarring. The
// stage-level slide replaces it: the OLD pane carries OLD ids only, the
// NEW pane carries NEW ids only, and the user sees a directional swap.
export function TabList({
  onActivate,
  onClose,
  onCloseSelected,
  onCreateTab,
  onCreatePanel,
  onOpenInSidePanel,
  onTabContextMenu,
  onFolderContextMenu,
  onReorder,
}: TabListProps) {
  // Per-window active workspace (phase A.3): each chrome window's TabList
  // resolves its active workspace via the document's captured windowId.
  // Falls back to the global activeId when the windowId hasn't yet
  // resolved or hasn't been activated per-window. Single-window users see
  // no behavioural change; multi-window users get independent tab lists
  // per window once they activate workspaces per-window.
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const workspaceOrder = useWorkspacesStore((s) => s.orderedIds);
  const tabsById = useTabsStore((s) => s.byId);
  const sidebarCollapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  // Pass windowId so the filter ALSO restricts to tabs in this window's
  // gBrowser — cross-window tabs from another window with the same
  // workspaceId aren't actionable here (clicking them activates them in
  // their original window, not this one), so showing them confuses the
  // user. See useWorkspaceTabIds for the full rationale.
  const orderedIds = useWorkspaceTabIds(activeWorkspaceId, windowId);
  const activeId = useTabsStore((s) => s.activeId);
  const folders = useWorkspaceFolders(activeWorkspaceId);
  const visualRows = useMemo(
    () =>
      buildDisplayRows(orderedIds, tabsById, folders, activeId, {
        isCollapsed: sidebarCollapsed,
      }),
    [activeId, folders, orderedIds, sidebarCollapsed, tabsById],
  );
  const visualTabOrder = useMemo(() => flattenTabOrder(visualRows), [visualRows]);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const lastSelectedIdRef = useRef<number | null>(null);
  const mirroredSelectedTitleRef = useRef(false);

  const closeSelectedTabs = useCallback(() => {
    if (!onCloseSelected || selectedIds.size === 0) return;
    const ids = visualTabOrder.filter((id) => selectedIds.has(id));
    if (ids.length === 0) return;
    onCloseSelected(ids);
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  }, [onCloseSelected, selectedIds, visualTabOrder]);

  useLayoutEffect(() => {
    setSelectedIds(new Set());
    lastSelectedIdRef.current = null;
  }, [activeWorkspaceId]);

  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const next = pruneSelection(prev, visualTabOrder);
      if (next.size === prev.size) return prev;
      return next;
    });
    if (lastSelectedIdRef.current !== null && !visualTabOrder.includes(lastSelectedIdRef.current)) {
      lastSelectedIdRef.current = null;
    }
  }, [visualTabOrder]);

  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName.toLowerCase();
      if (
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target?.isContentEditable
      ) {
        return;
      }
      const isAccel = navigator.platform.toLowerCase().includes('mac')
        ? event.metaKey
        : event.ctrlKey;
      if (!isAccel || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== 'w') return;
      event.preventDefault();
      event.stopPropagation();
      closeSelectedTabs();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [closeSelectedTabs, selectedIds.size]);

  useEffect(() => {
    const ids = visualTabOrder.filter((id) => selectedIds.has(id));
    if (ids.length === 0 && !mirroredSelectedTitleRef.current) return;
    document.title = `${SELECTED_TABS_TITLE_PREFIX}${Date.now()}:${encodeSelectedTabIds(ids)}`;
    mirroredSelectedTitleRef.current = ids.length > 0;
  }, [selectedIds, visualTabOrder]);

  const handleSelectClick = useCallback(
    (id: number, event: React.MouseEvent<HTMLDivElement>) => {
      if (event.shiftKey) {
        event.preventDefault();
        const targetIndex = visualTabOrder.indexOf(id);
        if (targetIndex < 0) return;
        const anchorId = lastSelectedIdRef.current;
        const anchorIndex = anchorId === null ? -1 : visualTabOrder.indexOf(anchorId);
        if (anchorIndex < 0) {
          lastSelectedIdRef.current = id;
          setSelectedIds(new Set([id]));
          return;
        }
        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        setSelectedIds(new Set(visualTabOrder.slice(start, end + 1)));
        return;
      }

      if (event.metaKey || event.ctrlKey) {
        event.preventDefault();
        lastSelectedIdRef.current = id;
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        return;
      }

      if (selectedIds.size > 0) setSelectedIds(new Set());
      lastSelectedIdRef.current = id;
      onActivate(id);
    },
    [onActivate, selectedIds.size, visualTabOrder],
  );

  const handleSelectionContextMenu = useCallback(
    (id: number): number[] => {
      if (selectedIds.has(id) && selectedIds.size > 0) {
        return visualTabOrder.filter((candidate) => selectedIds.has(candidate));
      }
      return [id];
    },
    [selectedIds, visualTabOrder],
  );
  // Readiness gate: render the skeleton until BOTH stores have hydrated
  // for the active workspace. tabsStore.hydrated flips on the first
  // tabs/snapshot from bento-tools; panelsStore.hydratedWorkspaces gets
  // an entry for a workspace on its first panels/sync (even an empty
  // sync). Without this gate the sidebar momentarily shows the
  // unfiltered tab list (panels included as tabs) for one frame at boot
  // before panels/sync arrives. Rules of Hooks: the early return for
  // the skeleton MUST come after every hook call below, otherwise the
  // hook count diverges between the not-ready and ready renders and
  // React tears the subtree down (observed: blank sidebar after the
  // gate flipped).
  const tabsHydrated = useTabsStore((s) => s.hydrated);
  const activePanelsHydrated = usePanelsStore((s) =>
    activeWorkspaceId ? s.hydratedWorkspaces.has(activeWorkspaceId) : false,
  );
  const foldersHydrated = useTabFoldersStore((s) => s.hydrated);
  const ready = tabsHydrated && activePanelsHydrated && foldersHydrated;

  // Per-workspace ids snapshot, kept across renders so the outgoing pane
  // during a slide can render the workspace it represents (the store has
  // already moved on to the new active workspace by the time we render).
  // Updated on every render with the freshest ids for the current
  // active workspace — when the user later switches AWAY, the snapshot
  // for the leaving workspace is right-up-to-date.
  const snapshotRef = useRef<Map<string, number[]>>(new Map());
  if (activeWorkspaceId) snapshotRef.current.set(activeWorkspaceId, orderedIds);

  const prevWorkspaceRef = useRef<string | null>(activeWorkspaceId);
  const [outgoing, setOutgoing] = useState<{
    wsId: string;
    direction: 'left' | 'right';
  } | null>(null);

  // useLayoutEffect so the outgoing pane is in the DOM in the same paint
  // as the incoming pane — using useEffect would let the browser paint
  // the new pane alone for one frame before the outgoing pane mounts,
  // missing the opening frames of the slide animation.
  useLayoutEffect(() => {
    const prev = prevWorkspaceRef.current;
    prevWorkspaceRef.current = activeWorkspaceId;
    if (prev === activeWorkspaceId) return;
    if (prev === null || activeWorkspaceId === null) return;
    if (!snapshotRef.current.has(prev)) return;
    const prevIdx = workspaceOrder.indexOf(prev);
    const newIdx = workspaceOrder.indexOf(activeWorkspaceId);
    // 'right' = motion is leftward across the screen so the new pane
    // enters from the right edge (and old exits to the left). Mirrors a
    // mobile carousel: swiping to next page moves content leftward.
    const direction: 'left' | 'right' =
      newIdx >= 0 && prevIdx >= 0 && newIdx < prevIdx ? 'left' : 'right';
    setOutgoing({ wsId: prev, direction });
  }, [activeWorkspaceId, workspaceOrder]);

  // Drop the outgoing pane after the slide completes. Any subsequent
  // workspace switch will replace the outgoing state with a fresh entry
  // (and new direction); the timer here only fires for the current one.
  useEffect(() => {
    if (!outgoing) return;
    const t = setTimeout(() => setOutgoing(null), WORKSPACE_SLIDE_MS);
    return () => clearTimeout(t);
  }, [outgoing]);

  const incomingClass =
    'bento-tab-list-pane' + (outgoing ? ` bento-tab-list-pane--enter-${outgoing.direction}` : '');

  if (!ready) {
    return <TabListSkeleton />;
  }

  return (
    <div className="bento-tab-list">
      <div className="bento-tab-list-stage">
        {outgoing && (
          <TabListPane
            // Re-key by outgoing wsId so consecutive workspace switches each
            // remount the pane and cleanly re-trigger the exit animation.
            key={`out:${outgoing.wsId}`}
            workspaceId={outgoing.wsId}
            ids={snapshotRef.current.get(outgoing.wsId) ?? []}
            tabsById={tabsById}
            activeId={activeId}
            selectedIds={selectedIds}
            onCreateTab={onCreateTab}
            onCreatePanel={onCreatePanel}
            onSelectClick={handleSelectClick}
            onClose={onClose}
            onOpenInSidePanel={onOpenInSidePanel}
            onTabContextMenu={onTabContextMenu}
            onFolderContextMenu={onFolderContextMenu}
            onSelectionContextMenu={handleSelectionContextMenu}
            isCollapsed={sidebarCollapsed}
            className={`bento-tab-list-pane bento-tab-list-pane--exit-${outgoing.direction}`}
          />
        )}
        <TabListPane
          // Re-key when activeWorkspaceId changes so the incoming pane mounts
          // fresh — important for the virtualizer to recompute its window
          // against the new ids without carrying scroll position from the
          // departed workspace.
          key={`in:${activeWorkspaceId ?? 'none'}`}
          workspaceId={activeWorkspaceId}
          ids={orderedIds}
          tabsById={tabsById}
          activeId={activeId}
          selectedIds={selectedIds}
          onCreateTab={onCreateTab}
          onCreatePanel={onCreatePanel}
          onSelectClick={handleSelectClick}
          onClose={onClose}
          onOpenInSidePanel={onOpenInSidePanel}
          onTabContextMenu={onTabContextMenu}
          onFolderContextMenu={onFolderContextMenu}
          onSelectionContextMenu={handleSelectionContextMenu}
          isCollapsed={sidebarCollapsed}
          // Only the steady-state incoming pane allows reorder. The
          // outgoing pane (rendered above during a workspace-switch slide)
          // is mid-animation and pointer-events:none anyway; gating here
          // also keeps `dragging` state from leaking between pane mounts.
          onReorder={onReorder}
          className={incomingClass}
        />
      </div>
    </div>
  );
}
