import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

const ROW_SELECTOR = '.bento-tab-list__row';

interface RowHighlightOptions {
  /** Row is indented under a folder (narrower highlight). */
  indented?: boolean;
  /** Row is fading out or otherwise not hoverable; the highlight hides. */
  inert?: boolean;
}

/** Data attributes for a `.bento-tab-list__row` wrapper. The highlight reads
 * them straight from the DOM, so moving it never re-renders the list. `start`
 * is the same offset as the wrapper's `translateY`. */
export function rowHighlightProps(start: number, { indented, inert }: RowHighlightOptions = {}) {
  return {
    'data-row-start': start,
    'data-row-indented': indented ? '' : undefined,
    'data-row-inert': inert ? '' : undefined,
  };
}

/**
 * Sliding hover highlight for the virtualized tab list: one element that
 * glides to the hovered row instead of each row painting its own `:hover`
 * background.
 *
 * A delegated `mouseover` on the viewport finds the row wrapper under the
 * pointer and positions the returned element imperatively (CSS drives the
 * slide, fade and geometry from `data-visible` / `data-indented`). Mouse events
 * are used rather than scroll math because Gecko synthesizes a mouse move after
 * a scroll or reflow, which re-targets the row under a stationary pointer.
 *
 * The layout effect re-syncs after every commit, so the highlight follows its
 * row through reorders and shifts, and hides if that row unmounted (closed tab,
 * folder collapse, virtualizer recycling) rather than sitting at a stale offset.
 * `disabled` (a drag in progress) hides it and drops the tracked row.
 */
export function useRowHoverHighlight(
  viewportRef: RefObject<HTMLDivElement | null>,
  disabled: boolean,
): RefObject<HTMLDivElement | null> {
  const highlightRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<HTMLElement | null>(null);
  const disabledRef = useRef(disabled);

  const sync = useCallback(() => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    if (disabledRef.current || !hoveredRef.current?.isConnected) hoveredRef.current = null;
    const row = hoveredRef.current;
    if (!row || row.hasAttribute('data-row-inert')) {
      highlight.removeAttribute('data-visible');
      return;
    }
    highlight.style.transform = `translateY(${row.dataset.rowStart ?? 0}px)`;
    highlight.toggleAttribute('data-indented', row.hasAttribute('data-row-indented'));
    if (!highlight.hasAttribute('data-visible')) {
      // The slide transitions only apply while visible. Flush the new position
      // first so a fresh show appears in place instead of gliding from wherever
      // the highlight last was, then fade in.
      void highlight.offsetHeight;
      highlight.setAttribute('data-visible', '');
    }
  }, []);

  // After every commit: rows may have moved, been removed or unmounted.
  useLayoutEffect(() => {
    disabledRef.current = disabled;
    sync();
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleOver = (event: MouseEvent) => {
      if (disabledRef.current || !(event.target instanceof Element)) return;
      // Gaps between rows keep the previous row highlighted instead of flickering.
      const row = event.target.closest<HTMLElement>(ROW_SELECTOR);
      if (!row || row === hoveredRef.current) return;
      hoveredRef.current = row;
      sync();
    };
    const handleLeave = () => {
      hoveredRef.current = null;
      sync();
    };
    viewport.addEventListener('mouseover', handleOver);
    viewport.addEventListener('mouseleave', handleLeave);
    return () => {
      viewport.removeEventListener('mouseover', handleOver);
      viewport.removeEventListener('mouseleave', handleLeave);
    };
  }, [sync, viewportRef]);

  return highlightRef;
}
