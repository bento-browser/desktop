import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Column } from '@tale-ui/react/column';
import { Text } from '@tale-ui/react/text';

import { useTabsStore, useWorkspaceTabIds } from '../../state/tabs';
import { useWorkspacesStore } from '../../state/workspaces';
import { usePanelsStore } from '../../state/panels';
import { TabRow } from '../TabRow/TabRow';
import { TabListSkeleton } from './TabListSkeleton';
import './TabList.css';

export interface TabListProps {
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onOpenInSidePanel: (id: number) => void;
}

const ROW_HEIGHT_FALLBACK = 32;
// Matches --bento-duration-base (200ms) used by the .bento-tab-row--removing
// CSS transition. Keep in sync if either side changes.
const REMOVAL_ANIMATION_MS = 200;
// Workspace-switch slide. Slightly longer than per-tab removal so the eye
// has time to track the directional motion. Keep in sync with the
// .bento-tab-list-pane--{enter,exit}-* CSS animation duration.
const WORKSPACE_SLIDE_MS = 260;

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
  ids: number[];
  activeId: number | null;
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
  onOpenInSidePanel: (id: number) => void;
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
  ids,
  activeId,
  onActivate,
  onClose,
  onOpenInSidePanel,
  className,
}: TabListPaneProps) {
  const { ids: displayedIds, removing } = useDelayedRemovals(ids, REMOVAL_ANIMATION_MS);
  const parentRef = useRef<HTMLDivElement>(null);
  const [rowHeight, setRowHeight] = useState(ROW_HEIGHT_FALLBACK);

  // Persistent probe + ResizeObserver. Vite injects CSS asynchronously in
  // dev, so a one-shot read can race the stylesheet and fall back. Watching
  // a live probe means we pick up the real height as soon as the var
  // resolves — and again if it ever changes (theme swap, HMR, etc.).
  useEffect(() => {
    if (!parentRef.current) return;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;width:0;height:var(--bento-tab-row-height);';
    parentRef.current.appendChild(probe);
    const update = () => {
      const px = probe.offsetHeight;
      if (px > 0) setRowHeight(px);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(probe);
    return () => {
      ro.disconnect();
      probe.remove();
    };
  }, []);

  const virtualizer = useVirtualizer({
    count: displayedIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 5,
  });

  if (displayedIds.length === 0) {
    return (
      <Column gap="xs" align="center" className={`${className} bento-tab-list-pane--empty`}>
        <Text variant="text" size="s" color="muted">
          No tabs yet
        </Text>
      </Column>
    );
  }

  return (
    <div ref={parentRef} className={className}>
      <div
        className="bento-tab-list__viewport"
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const id = displayedIds[vi.index];
          if (id === undefined) return null;
          return (
            <div
              key={id}
              className="bento-tab-list__row"
              style={{ transform: `translateY(${vi.start}px)`, height: `${vi.size}px` }}
            >
              <TabRow
                id={id}
                active={id === activeId}
                removing={removing.has(id)}
                onActivate={onActivate}
                onClose={onClose}
                onOpenInSidePanel={onOpenInSidePanel}
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
export function TabList({ onActivate, onClose, onOpenInSidePanel }: TabListProps) {
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeId);
  const workspaceOrder = useWorkspacesStore((s) => s.orderedIds);
  const orderedIds = useWorkspaceTabIds(activeWorkspaceId);
  const activeId = useTabsStore((s) => s.activeId);
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
  const ready = tabsHydrated && activePanelsHydrated;

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
    <div className="bento-tab-list-stage">
      {outgoing && (
        <TabListPane
          // Re-key by outgoing wsId so consecutive workspace switches each
          // remount the pane and cleanly re-trigger the exit animation.
          key={`out:${outgoing.wsId}`}
          ids={snapshotRef.current.get(outgoing.wsId) ?? []}
          activeId={activeId}
          onActivate={onActivate}
          onClose={onClose}
          onOpenInSidePanel={onOpenInSidePanel}
          className={`bento-tab-list-pane bento-tab-list-pane--exit-${outgoing.direction}`}
        />
      )}
      <TabListPane
        // Re-key when activeWorkspaceId changes so the incoming pane mounts
        // fresh — important for the virtualizer to recompute its window
        // against the new ids without carrying scroll position from the
        // departed workspace.
        key={`in:${activeWorkspaceId ?? 'none'}`}
        ids={orderedIds}
        activeId={activeId}
        onActivate={onActivate}
        onClose={onClose}
        onOpenInSidePanel={onOpenInSidePanel}
        className={incomingClass}
      />
    </div>
  );
}
