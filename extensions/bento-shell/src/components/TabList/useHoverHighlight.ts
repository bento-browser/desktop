import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

const ROW_SELECTOR = '.bento-tab-list__row';
const SEARCH_ACTION_SELECTOR = '.bento-tab-list__search-button';
const ACTION_SELECTOR = `.bento-tab-list__new-action-button, ${SEARCH_ACTION_SELECTOR}`;

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

/** Moves the highlight onto `target`; returns false when the target cannot be
 * highlighted, which hides it. */
type Place = (highlight: HTMLElement, target: HTMLElement) => boolean;

const placeRow: Place = (highlight, row) => {
  if (row.hasAttribute('data-row-inert')) return false;
  highlight.style.transform = `translateY(${row.dataset.rowStart ?? 0}px)`;
  highlight.toggleAttribute('data-indented', row.hasAttribute('data-row-indented'));
  return true;
};

// The action highlight does not track the button's rect. The Search trigger widens
// on hover (and the New button shrinks with it) over a transition, so a rect read now
// would be a mid-transition box. `data-target` names the button instead and
// TabList.css gives each target its final geometry from the same width variable,
// motion role the buttons use, so a highlight that is already visible
// lands with them. A fresh show starts on the button's current box (the trigger
// may only just have begun to widen) and `settleAction` hands it to CSS, which
// carries it to the final box in step with the button. A button that is not
// rendered has no box, which hides the highlight. The collapsed rail stacks the
// two buttons, so the same start covers `top`.
const placeAction: Place = (highlight, button) => {
  const bar = highlight.parentElement;
  const box = button.getBoundingClientRect();
  if (!bar || box.width === 0) return false;
  highlight.dataset.target = button.matches(SEARCH_ACTION_SELECTOR) ? 'search' : 'new';
  if (!highlight.hasAttribute('data-visible')) {
    const barBox = bar.getBoundingClientRect();
    highlight.style.left = `${box.left - barBox.left}px`;
    highlight.style.top = `${box.top - barBox.top}px`;
    highlight.style.width = `${box.width}px`;
  }
  return true;
};

const settleAction = (highlight: HTMLElement) => {
  highlight.style.removeProperty('left');
  highlight.style.removeProperty('top');
  highlight.style.removeProperty('width');
};

/**
 * Sliding hover highlight: one element that glides to the hovered target
 * instead of each target painting its own `:hover` background.
 *
 * A delegated `mouseover` on the container finds the target (`targetSelector`)
 * under the pointer and `place` positions the returned element imperatively: an
 * inline offset, or a data attribute that CSS turns into geometry. CSS drives
 * the slide, fade and geometry from `data-visible` and whatever `place` sets.
 * `settle` runs right after a fresh show sets `data-visible`, to drop anything
 * `place` wrote only as a starting position. Mouse events are used rather than
 * scroll math because Gecko synthesizes a mouse move after a scroll or reflow,
 * which re-targets the element under a stationary pointer.
 *
 * The layout effect re-syncs after every commit, so the highlight follows its
 * target through reorders and shifts, and hides if that target unmounted
 * (closed tab, folder collapse, virtualizer recycling) rather than sitting at a
 * stale offset. A ResizeObserver re-syncs layout changes that are not commits,
 * such as the sidebar collapse resizing the action bar and removing the Search
 * trigger's box. `disabled` (a drag in progress, search open, the New menu open)
 * hides it and drops the tracked target.
 */
function useHoverHighlight(
  containerRef: RefObject<HTMLElement | null>,
  disabled: boolean,
  targetSelector: string,
  place: Place,
  settle?: (highlight: HTMLElement) => void,
): RefObject<HTMLDivElement | null> {
  const highlightRef = useRef<HTMLDivElement>(null);
  const hoveredRef = useRef<HTMLElement | null>(null);
  const disabledRef = useRef(disabled);

  const sync = useCallback(() => {
    const highlight = highlightRef.current;
    if (!highlight) return;
    if (disabledRef.current || !hoveredRef.current?.isConnected) hoveredRef.current = null;
    const target = hoveredRef.current;
    if (!target || !place(highlight, target)) {
      highlight.removeAttribute('data-visible');
      return;
    }
    if (!highlight.hasAttribute('data-visible')) {
      // The slide transitions only apply while visible. Flush the new position
      // first so a fresh show appears in place instead of gliding from wherever
      // the highlight last was, then fade in.
      void highlight.offsetHeight;
      highlight.setAttribute('data-visible', '');
      settle?.(highlight);
    }
  }, [place, settle]);

  // After every commit: targets may have moved, been removed or unmounted.
  useLayoutEffect(() => {
    disabledRef.current = disabled;
    sync();
  });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleOver = (event: MouseEvent) => {
      if (disabledRef.current || !(event.target instanceof Element)) return;
      // Gaps between targets keep the previous one highlighted instead of flickering.
      const target = event.target.closest<HTMLElement>(targetSelector);
      if (!target || target === hoveredRef.current) return;
      hoveredRef.current = target;
      sync();
    };
    const handleLeave = () => {
      hoveredRef.current = null;
      sync();
    };
    container.addEventListener('mouseover', handleOver);
    container.addEventListener('mouseleave', handleLeave);
    const resizeObserver = new ResizeObserver(sync);
    resizeObserver.observe(container);
    return () => {
      container.removeEventListener('mouseover', handleOver);
      container.removeEventListener('mouseleave', handleLeave);
      resizeObserver.disconnect();
    };
  }, [containerRef, sync, targetSelector]);

  return highlightRef;
}

/** Highlight for the virtualized tab list. Hidden for rows that are fading out. */
export function useRowHoverHighlight(
  viewportRef: RefObject<HTMLDivElement | null>,
  disabled: boolean,
): RefObject<HTMLDivElement | null> {
  return useHoverHighlight(viewportRef, disabled, ROW_SELECTOR, placeRow);
}

/** Highlight for the New and Search buttons of the tab-list action bar. It
 * stays inside the bar: the list highlight handles the rows. Its geometry is
 * CSS's, selected by `data-target` (`new` or `search`). */
export function useActionHoverHighlight(
  barRef: RefObject<HTMLDivElement | null>,
  disabled: boolean,
): RefObject<HTMLDivElement | null> {
  return useHoverHighlight(barRef, disabled, ACTION_SELECTOR, placeAction, settleAction);
}
