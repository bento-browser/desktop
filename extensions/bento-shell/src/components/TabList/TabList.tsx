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
}

const ROW_HEIGHT_FALLBACK = 32;

export function TabList({ onActivate, onClose }: TabListProps) {
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeId);
  const orderedIds = useWorkspaceTabIds(activeWorkspaceId);
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
    count: orderedIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => rowHeight, [rowHeight]),
    overscan: 5,
  });

  if (orderedIds.length === 0) {
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
          const id = orderedIds[vi.index];
          if (id === undefined) return null;
          return (
            <div
              key={id}
              className="bento-tab-list__row"
              style={{ transform: `translateY(${vi.start}px)`, height: `${vi.size}px` }}
            >
              <TabRow id={id} active={id === activeId} onActivate={onActivate} onClose={onClose} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
