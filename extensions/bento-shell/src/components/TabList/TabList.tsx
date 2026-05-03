import { useCallback, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Column } from '@tale-ui/react/column';
import { Text } from '@tale-ui/react/text';

import { useTabsStore } from '../../state/tabs';
import { TabRow } from '../TabRow/TabRow';
import './TabList.css';

export interface TabListProps {
  onActivate: (id: number) => void;
  onClose: (id: number) => void;
}

const ROW_HEIGHT = 28; // matches --bento-tab-row-height in bento-tokens.css

export function TabList({ onActivate, onClose }: TabListProps) {
  const orderedIds = useTabsStore((s) => s.orderedIds);
  const activeId = useTabsStore((s) => s.activeId);
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: orderedIds.length,
    getScrollElement: () => parentRef.current,
    estimateSize: useCallback(() => ROW_HEIGHT, []),
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
