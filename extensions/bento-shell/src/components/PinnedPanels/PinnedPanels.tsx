import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, PointerEvent } from 'react';
import { IconButton } from '@tale-ui/react/icon-button';
import { Tooltip } from '@tale-ui/react/tooltip';

import { usePinnedPanelsStore } from '../../state/pinnedPanels';
import { usePanelFocusStore } from '../../state/panelFocus';
import { useTab } from '../../state/tabs';
import { dispatch } from '../../bridge/useToolsPort';
import type { PinnedPanelEntry } from '@shared/protocol';
import './PinnedPanels.css';

interface PinnedPanelRowProps {
  entry: PinnedPanelEntry;
  entryKey: string;
  dragging: boolean;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>, entryKey: string) => void;
  onPointerMove: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => void;
  onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => void;
  shouldSuppressOpen: (entryKey: string) => boolean;
}

function PinnedPanelRowImpl({
  entry,
  entryKey,
  dragging,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
  shouldSuppressOpen,
}: PinnedPanelRowProps) {
  // useTab returns undefined when the tab isn't in this shell's tab store
  // yet (cross-window — a pin pointing at a tab in another window's
  // gBrowser). The pin is still valid; tools holds the canonical entry.
  // Render a fallback label so the row stays visible and clickable —
  // the activation handler dispatches through bento-tools which has
  // access to every window's tabs.
  const tab = useTab(entry.tabId);
  const focusedTabId = usePanelFocusStore((s) => s.focusedTabId);
  const title = tab?.customTitle || tab?.title || entry.title || entry.url || 'Pinned panel';
  const favIconUrl = tab?.favIconUrl || entry.favIconUrl;
  const isFocused = focusedTabId === entry.tabId;

  const openPinnedPanel = () =>
    dispatch({ type: 'pinnedPanel/open', workspaceId: entry.workspaceId, tabId: entry.tabId });
  const closePinnedPanel = () =>
    dispatch({ type: 'pinnedPanel/close', workspaceId: entry.workspaceId, tabId: entry.tabId });
  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = {
      anchor: { left: event.clientX, top: event.clientY, width: 1, height: 1 },
      pinnedPanel: { workspaceId: entry.workspaceId, tabId: entry.tabId },
      items: [
        { id: 'pinned-panel-remove', label: 'Remove pinned panel' },
        { id: 'pinned-panel-close', label: 'Close pinned panel' },
      ],
    };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    document.title = `BENTO_SIDEBAR_CONTEXT_MENU:${Date.now()}:${encoded}`;
  };

  return (
    <Tooltip.Root delay={400}>
      <IconButton
        className={`bento-pinned-panels__button${dragging ? ' bento-pinned-panels__button--dragging' : ''}`}
        data-bento-pinned-panel-key={entryKey}
        data-bento-focused={isFocused ? 'true' : undefined}
        variant="neutral"
        size="sm"
        aria-label={`Open pinned panel: ${title}`}
        onPress={() => {
          if (!shouldSuppressOpen(entryKey)) openPinnedPanel();
        }}
        onPointerDown={(event) => onPointerDown(event, entryKey)}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onAuxClick={(e) => {
          if (e.button === 1) {
            e.preventDefault();
            e.stopPropagation();
            closePinnedPanel();
          }
        }}
        onContextMenu={openContextMenu}
      >
        {favIconUrl ? (
          <img className="bento-pinned-panels__favicon" src={favIconUrl} alt="" draggable={false} />
        ) : (
          <span className="bento-pinned-panels__favicon bento-pinned-panels__favicon--placeholder" />
        )}
      </IconButton>
      <Tooltip.Popup placement="right" offset={8}>
        <Tooltip.Arrow />
        {title}
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

const PinnedPanelRow = memo(PinnedPanelRowImpl);

const PINNED_PANEL_DRAG_THRESHOLD_PX = 4;

function getEntryKey(entry: Pick<PinnedPanelEntry, 'workspaceId' | 'tabId'>): string {
  return JSON.stringify([entry.workspaceId, entry.tabId]);
}

interface PendingDrag {
  entryKey: string;
  pointerId: number;
  startX: number;
  startY: number;
  lastClientX: number;
  lastClientY: number;
  sourceButton: HTMLButtonElement;
  captured: boolean;
  dragging: boolean;
}

export function PinnedPanels() {
  const entries = usePinnedPanelsStore((s) => s.entries);
  const railRef = useRef<HTMLElement>(null);
  const entriesRef = useRef(entries);
  const dragRef = useRef<PendingDrag | null>(null);
  const pendingFlipRectsRef = useRef<Map<string, DOMRect> | null>(null);
  const suppressOpenKeysRef = useRef(new Set<string>());
  const [dragState, setDragState] = useState<{ entryKey: string; indicatorTop: number } | null>(
    null,
  );

  entriesRef.current = entries;

  useLayoutEffect(() => {
    const previousRects = pendingFlipRectsRef.current;
    if (!previousRects) return;
    pendingFlipRectsRef.current = null;
    const rail = railRef.current;
    if (!rail) return;

    const moved: HTMLButtonElement[] = [];
    for (const button of rail.querySelectorAll<HTMLButtonElement>(
      '.bento-pinned-panels__button[data-bento-pinned-panel-key]',
    )) {
      const key = button.dataset.bentoPinnedPanelKey;
      const previous = key ? previousRects.get(key) : undefined;
      if (!previous) continue;
      const deltaY = previous.top - button.getBoundingClientRect().top;
      if (Math.abs(deltaY) < 1) continue;
      button.style.transition = 'none';
      button.style.transform = `translateY(${deltaY}px)`;
      moved.push(button);
    }
    if (moved.length === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const button of moved) {
        button.style.removeProperty('transition');
        button.style.removeProperty('transform');
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [entries]);

  const computeDropPosition = useCallback((sourceKey: string, clientY: number) => {
    const rail = railRef.current;
    if (!rail) return null;
    const allButtons = Array.from(
      rail.querySelectorAll<HTMLButtonElement>(
        '.bento-pinned-panels__button[data-bento-pinned-panel-key]',
      ),
    );
    const sourceButton = allButtons.find(
      (button) => button.dataset.bentoPinnedPanelKey === sourceKey,
    );
    const buttons = allButtons.filter((button) => button !== sourceButton);
    let slot = 0;
    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) slot += 1;
      else break;
    }
    const railRect = rail.getBoundingClientRect();
    let y: number;
    if (buttons.length === 0) {
      if (!sourceButton) return null;
      y = sourceButton.getBoundingClientRect().top - railRect.top + rail.scrollTop;
    } else if (slot >= buttons.length) {
      const lastButton = buttons.at(-1);
      if (!lastButton) return null;
      const rect = lastButton.getBoundingClientRect();
      y = rect.bottom - railRect.top + rail.scrollTop;
    } else {
      const targetButton = buttons[slot];
      if (!targetButton) return null;
      const rect = targetButton.getBoundingClientRect();
      y = rect.top - railRect.top + rail.scrollTop;
    }
    return { slot, indicatorTop: y - 1 };
  }, []);

  const finishDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number, commit: boolean) => {
      const pending = dragRef.current;
      if (!pending || pointerId !== pending.pointerId) return;
      dragRef.current = null;
      if (pending.captured) {
        try {
          pending.sourceButton.releasePointerCapture(pointerId);
        } catch {
          // Pointer capture can already be released after a cancellation.
        }
      }
      if (pending.dragging && commit) {
        const drop = computeDropPosition(pending.entryKey, clientY);
        if (drop) {
          const currentEntries = entriesRef.current;
          const source = currentEntries.find((entry) => getEntryKey(entry) === pending.entryKey);
          if (source) {
            const withoutSource = currentEntries.filter((entry) => entry !== source);
            withoutSource.splice(Math.max(0, Math.min(drop.slot, withoutSource.length)), 0, source);
            if (withoutSource.some((entry, index) => entry !== currentEntries[index])) {
              const rail = railRef.current;
              const rects = new Map<string, DOMRect>();
              for (const button of rail?.querySelectorAll<HTMLButtonElement>(
                '.bento-pinned-panels__button[data-bento-pinned-panel-key]',
              ) ?? []) {
                const key = button.dataset.bentoPinnedPanelKey;
                if (key) rects.set(key, button.getBoundingClientRect());
              }
              pendingFlipRectsRef.current = rects;
              dispatch({
                type: 'pinnedPanels/reorder',
                orderedKeys: withoutSource.map(({ workspaceId, tabId }) => ({
                  workspaceId,
                  tabId,
                })),
              });
            }
          }
        }
        suppressOpenKeysRef.current.add(pending.entryKey);
      } else if (pending.dragging) {
        suppressOpenKeysRef.current.delete(pending.entryKey);
      }
      setDragState(null);
    },
    [computeDropPosition],
  );

  useEffect(() => {
    const cancelActiveDrag = () => {
      const pending = dragRef.current;
      if (!pending) return;
      finishDrag(pending.pointerId, pending.lastClientX, pending.lastClientY, false);
    };
    const cancelOnWindowExit = (event: globalThis.MouseEvent) => {
      if (event.relatedTarget === null) cancelActiveDrag();
    };
    const cancelOnVisibilityChange = () => {
      if (document.hidden) cancelActiveDrag();
    };
    window.addEventListener('blur', cancelActiveDrag);
    window.addEventListener('mouseout', cancelOnWindowExit, true);
    document.addEventListener('visibilitychange', cancelOnVisibilityChange);
    return () => {
      window.removeEventListener('blur', cancelActiveDrag);
      window.removeEventListener('mouseout', cancelOnWindowExit, true);
      document.removeEventListener('visibilitychange', cancelOnVisibilityChange);
    };
  }, [finishDrag]);

  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLButtonElement>, entryKey: string) => {
      if (event.button !== 0) return;
      dragRef.current = {
        entryKey,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastClientX: event.clientX,
        lastClientY: event.clientY,
        sourceButton: event.currentTarget,
        captured: false,
        dragging: false,
      };
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      const pending = dragRef.current;
      if (!pending || event.pointerId !== pending.pointerId) return;
      pending.lastClientX = event.clientX;
      pending.lastClientY = event.clientY;
      const distanceX = event.clientX - pending.startX;
      const distanceY = event.clientY - pending.startY;
      if (!pending.dragging) {
        if (distanceX * distanceX + distanceY * distanceY < PINNED_PANEL_DRAG_THRESHOLD_PX ** 2) {
          return;
        }
        pending.dragging = true;
        suppressOpenKeysRef.current.add(pending.entryKey);
        try {
          pending.sourceButton.setPointerCapture(event.pointerId);
          pending.captured = true;
        } catch {
          // A missed capture only limits the drag to the rail's bounds.
        }
      }
      const drop = computeDropPosition(pending.entryKey, event.clientY);
      if (drop) setDragState({ entryKey: pending.entryKey, indicatorTop: drop.indicatorTop });
    },
    [computeDropPosition],
  );

  const shouldSuppressOpen = useCallback((entryKey: string) => {
    return suppressOpenKeysRef.current.delete(entryKey);
  }, []);

  if (entries.length === 0) return null;
  return (
    <nav
      ref={railRef}
      className={`bento-pinned-panels${dragState ? ' bento-pinned-panels--dragging' : ''}`}
      aria-label="Pinned panels"
    >
      {entries.map((entry) => (
        <PinnedPanelRow
          key={getEntryKey(entry)}
          entry={entry}
          entryKey={getEntryKey(entry)}
          dragging={dragState?.entryKey === getEntryKey(entry)}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishDrag(event.pointerId, event.clientX, event.clientY, true)}
          onPointerCancel={(event) =>
            finishDrag(event.pointerId, event.clientX, event.clientY, false)
          }
          onLostPointerCapture={(event) =>
            finishDrag(
              event.pointerId,
              event.clientX,
              event.clientY,
              dragRef.current?.dragging === true,
            )
          }
          shouldSuppressOpen={shouldSuppressOpen}
        />
      ))}
      {dragState ? (
        <span
          className="bento-pinned-panels__drop-indicator"
          style={{ top: dragState.indicatorTop }}
          aria-hidden="true"
        />
      ) : null}
    </nav>
  );
}
