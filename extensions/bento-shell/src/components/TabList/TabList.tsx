import { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Column } from '@tale-ui/react/column';
import { Text } from '@tale-ui/react/text';

import { useTabsStore, useWorkspaceTabIds } from '../../state/tabs';
import { useWorkspacesStore } from '../../state/workspaces';
import { TabRow } from '../TabRow/TabRow';
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

export function TabList({ onActivate, onClose, onOpenInSidePanel }: TabListProps) {
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeId);
  const orderedIds = useWorkspaceTabIds(activeWorkspaceId);
  const { ids: displayedIds, removing } = useDelayedRemovals(orderedIds, REMOVAL_ANIMATION_MS);
  const activeId = useTabsStore((s) => s.activeId);
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
      <Column gap="xs" align="center" className="bento-tab-list bento-tab-list--empty">
        <Text variant="text" size="s" color="muted">
          No tabs yet
        </Text>
      </Column>
    );
  }

  return (
    <div ref={parentRef} className="bento-tab-list">
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
