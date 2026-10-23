// One highlight per list, shared by the command palette and the Settings palette.
//
// Mux rows paint their own focus and hover fill, so a list shows two fills at once (the keyboard
// row and the row under the pointer) and each one jumps. Here the rows are transparent and the
// list carries a single slab (`RowHighlight.css`, a pseudo-element of the list, so it scrolls
// with the rows) that slides to the row holding the virtual focus. Pointer hover moves that same
// focus, so the keyboard and the pointer share the slab and there are never two.
//
// The hook only measures. It reads the focused row from the DOM (React Aria marks it
// `data-focused`; a stage that keeps no focus of its own marks its row `data-current`) and
// writes its box into custom properties on the list.

import { useCallback, useRef } from 'react';
import { createPointerTracker, type PointerTracker } from './pointerGate';
import './RowHighlight.css';

/** The class that opts a list into the slab. */
export const ROW_HIGHLIGHT_CLASS = 'bento-row-highlight';

/**
 * Props for the list part that make pointer hover move the virtual focus, so the slab follows
 * the pointer. A plain props object: `CommandPaletteListBoxProps` declares no
 * `shouldFocusOnHover`, and the part forwards its props to the React Aria list box, which reads
 * it. A recorded exception in docs/mux-ui-component-customisations.md.
 */
export const FOCUS_ON_HOVER: Record<string, unknown> = { shouldFocusOnHover: true };

/** Offset of `el` inside `list`'s padding box, in layout units (unaffected by the popup's
 * enter transform). Null when `list` is not an ancestor on the offset chain. */
function offsetWithin(list: HTMLElement, el: HTMLElement): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let node: HTMLElement | null = el;
  while (node && node !== list) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return node === list ? { x, y } : null;
}

/** The over and out events React makes hover from. */
const HOVER_EVENTS = ['pointerover', 'pointerout', 'mouseover', 'mouseout'];

/** One tracker per document: where the pointer last was, across every list the document shows. */
const trackers = new WeakMap<Document, PointerTracker>();

function trackerFor(doc: Document): PointerTracker {
  let tracker = trackers.get(doc);
  if (!tracker) {
    const created = createPointerTracker();
    tracker = created;
    trackers.set(doc, created);
    // Capturing, on the document, so the tracker has seen an event before any list's handler.
    for (const type of ['pointermove', 'pointerdown', 'pointerover', 'pointerout']) {
      doc.addEventListener(
        type,
        (event) => {
          const { clientX, clientY, isTrusted } = event as PointerEvent;
          created.observe({ type, x: clientX, y: clientY, trusted: isTrusted });
        },
        true,
      );
    }
  }
  return tracker;
}

function follow(list: HTMLElement, selector: string): () => void {
  let moving = false;
  const gate = trackerFor(list.ownerDocument).gate();

  const place = () => {
    const row = list.querySelector<HTMLElement>(selector);
    const at = row ? offsetWithin(list, row) : null;
    if (!row || !at) {
      list.removeAttribute('data-highlight');
      return;
    }
    list.style.setProperty('--bento-row-highlight-x', `${at.x}px`);
    list.style.setProperty('--bento-row-highlight-y', `${at.y}px`);
    list.style.setProperty('--bento-row-highlight-width', `${row.offsetWidth}px`);
    list.style.setProperty('--bento-row-highlight-height', `${row.offsetHeight}px`);
    list.setAttribute('data-highlight', '');
    if (!moving) {
      // The first placement lands where the row is; only later moves slide.
      moving = true;
      void list.offsetHeight;
      list.setAttribute('data-highlight-motion', '');
    }
  };

  const mutations = new MutationObserver(place);
  mutations.observe(list, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-focused', 'data-current'],
  });
  const resizes = new ResizeObserver(place);
  resizes.observe(list);

  // React Aria moves the focus on hover only once it knows the pointer was the last input, and
  // it learns that from a pointermove, which arrives after the pointerover that starts the
  // hover: the first row entered after a key press would not take the focus. Tell it first.
  // The out event comes first and carries the hover of the row being entered, so both are told.
  const hoverIsPointer = (event: PointerEvent) => {
    if (!gate.open) return;
    list.ownerDocument.dispatchEvent(
      new PointerEvent('pointermove', { pointerType: event.pointerType }),
    );
  };
  list.addEventListener('pointerover', hoverIsPointer, true);
  list.addEventListener('pointerout', hoverIsPointer, true);

  // Until the pointer has really moved since this list appeared, hover is kept from React: it
  // makes `onPointerEnter` from the over and out events, and the out of the element the pointer
  // was on (often outside the list, after a stage change) names the row it is on now. Those
  // events are stopped in the capture phase, before React's listeners see them, when they touch
  // the list. The list then opens on the row its stage chose, not on the row that landed under a
  // stationary pointer.
  const doc = list.ownerDocument;
  const inList = (node: EventTarget | null) => node instanceof Node && list.contains(node);
  const keepHoverOut = (event: Event) => {
    if (gate.open) return;
    const { target, relatedTarget } = event as MouseEvent;
    if (inList(target) || inList(relatedTarget)) event.stopPropagation();
  };
  for (const type of HOVER_EVENTS) doc.addEventListener(type, keepHoverOut, true);
  place();

  return () => {
    mutations.disconnect();
    resizes.disconnect();
    list.removeEventListener('pointerover', hoverIsPointer, true);
    list.removeEventListener('pointerout', hoverIsPointer, true);
    for (const type of HOVER_EVENTS) doc.removeEventListener(type, keepHoverOut, true);
  };
}

/**
 * A ref callback for the list part (give it `ROW_HIGHLIGHT_CLASS` too). `selector` names the
 * row to follow and is fixed for the life of the list element: a list that changes it is
 * remounted (the Settings palette keys its list by stage).
 */
export function useRowHighlight(selector = '[role="option"][data-focused]') {
  const stop = useRef<(() => void) | undefined>(undefined);
  return useCallback(
    (list: HTMLElement | null) => {
      stop.current?.();
      stop.current = list ? follow(list, selector) : undefined;
    },
    [selector],
  );
}
