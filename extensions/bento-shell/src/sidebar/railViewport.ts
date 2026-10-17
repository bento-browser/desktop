import { useSyncExternalStore } from 'react';

/**
 * The shell's rail visual state: `data-bento-collapsed="true"` on <html> while the
 * shell is laid out as the collapsed rail. All rail CSS and every component that
 * reads the state key off it.
 *
 * It follows the width the shell is actually rendered at, never the sidebar
 * setting. Chrome animates the sidebar by sliding it at its expanded width and
 * only narrows the host (the shell's viewport) at the end of a collapse, or at the
 * start of an expand. If the setting drove the visuals, the rail layout would
 * show while the shell is still wide, or the other way round.
 */
export const RAIL_ATTRIBUTE = 'data-bento-collapsed';

// The rail token is rem-based, so chrome and the shell each resolve it to their
// own fractional pixel width. The slack keeps the two readings from disagreeing
// by a rounding error.
const RAIL_WIDTH_SLACK_PX = 1;

/** True when a shell rendered `width` wide is the rail (at most `railWidth`). */
export function isRailWidth(width: number, railWidth: number): boolean {
  return width > 0 && railWidth > 0 && width <= railWidth + RAIL_WIDTH_SLACK_PX;
}

/** Width in px of `--bento-tab-strip-width-collapsed`, or 0 while it is not defined yet. */
export function measureRailWidth(doc: Document = document): number {
  const probe = doc.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;height:0;width:var(--bento-tab-strip-width-collapsed)';
  doc.body.appendChild(probe);
  const width = probe.getBoundingClientRect().width;
  probe.remove();
  return width;
}

/**
 * Calls `onRail(isRail)` whenever the width of `root` changes. The callback runs in
 * the resize-observer step, after layout and before paint, so what it writes lands
 * in the same frame as the width change and the narrower layout is never painted
 * with the wide visuals. The rail width is measured on the first observation that
 * can read the token (the stylesheet may not be in yet) and then kept.
 */
export function observeRailViewport(
  root: Element,
  onRail: (isRail: boolean) => void,
  measure: () => number = measureRailWidth,
): () => void {
  let railWidth = 0;
  const observer = new ResizeObserver((entries) => {
    const entry = entries[entries.length - 1];
    if (!entry) return;
    railWidth ||= measure();
    if (railWidth <= 0) return;
    const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
    onRail(isRailWidth(width, railWidth));
  });
  observer.observe(root);
  return () => observer.disconnect();
}

/** Writes the rail visual state onto <html>. */
export function setRailAttribute(isRail: boolean, doc: Document = document): void {
  if (isRail) doc.documentElement.setAttribute(RAIL_ATTRIBUTE, 'true');
  else doc.documentElement.removeAttribute(RAIL_ATTRIBUTE);
}

function subscribeToRailAttribute(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: [RAIL_ATTRIBUTE],
  });
  return () => observer.disconnect();
}

function readRailAttribute(): boolean {
  return document.documentElement.getAttribute(RAIL_ATTRIBUTE) === 'true';
}

/**
 * True while the shell is laid out as the rail. Reads the <html> attribute, so
 * it agrees with the CSS and with stories that set the attribute directly. The
 * update arrives as a microtask right after the attribute write, before paint.
 */
export function useRailViewport(): boolean {
  return useSyncExternalStore(subscribeToRailAttribute, readRailAttribute);
}
