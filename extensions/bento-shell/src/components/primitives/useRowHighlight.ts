// One highlight per list, shared by the command palette and the Settings palette.
//
// Mux rows paint their own focus and hover fill, so a list shows two fills at once (the keyboard
// row and the row under the pointer) and each one jumps. Here the rows are transparent and the
// list carries a single slab (`RowHighlight.css`, a pseudo-element of the list, so it scrolls
// with the rows) that slides to the row holding the virtual focus. Pointer hover moves that same
// focus, so the keyboard and the pointer share the slab and there are never two.
//
// The hook measures: it reads Mux's `data-muxui-state-focused` from the DOM (a number
// editor follows `data-muxui-state-current` instead) and writes the row's box into
// custom properties on the list. It also keeps a list that appears under a stationary pointer
// from taking the hover, and hands hover back at the first real movement (see `follow`).

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
    attributeFilter: ['data-muxui-state-focused', 'data-muxui-state-current'],
  });
  const resizes = new ResizeObserver(place);
  resizes.observe(list);

  // Hover is made by React from the over and out events (`onPointerEnter`, which React Aria turns
  // into a focus move), and it moves the focus only once its last input was the pointer. Three
  // things are done to those events here, all on the document in the capture phase so they come
  // before React's listeners:
  //
  // - Until the pointer has really moved since this list appeared, the events that touch the
  //   list are stopped. A browser reports the element under a stationary pointer after a layout
  //   change, and the out of the element the pointer was on (often outside the list) names the
  //   row entered, so a stage would lose the row it chose to whichever row landed under the
  //   pointer.
  // - Once it has, a pointermove tells React Aria the pointer is the input, before the event
  //   that enters the list reaches React. The out event comes first and may come from outside
  //   the list (the Close button, say), so listening on the list was too late.
  // - At that first real movement the hover the stopped events never made is made: a pointerover
  //   on the row under the pointer, so it takes the focus at once, even if the pointer only moved
  //   within it.
  const doc = list.ownerDocument;
  const inList = (node: EventTarget | null) => node instanceof Node && list.contains(node);
  const touchesList = (event: Event) => {
    const { target, relatedTarget } = event as MouseEvent;
    return inList(target) || inList(relatedTarget);
  };
  const tellPointer = (pointerType: string) => {
    doc.dispatchEvent(new PointerEvent('pointermove', { pointerType }));
  };
  const onHover = (event: Event) => {
    if (!touchesList(event)) return;
    if (!gate.open) event.stopPropagation();
    else if (event instanceof PointerEvent) tellPointer(event.pointerType);
  };
  for (const type of HOVER_EVENTS) doc.addEventListener(type, onHover, true);

  let handedBack = false;
  const handHoverBack = (event: Event) => {
    // Only a real event hands back: the synthetic pointermove above has no position and would
    // use up the hand-back on whatever sits at the top-left corner.
    if (handedBack || !gate.open || !(event instanceof PointerEvent) || !event.isTrusted) return;
    handedBack = true;
    const { clientX, clientY, pointerType } = event;
    const row = doc.elementFromPoint(clientX, clientY)?.closest('[role="option"]');
    if (!row || !list.contains(row)) return;
    tellPointer(pointerType);
    row.dispatchEvent(
      new PointerEvent('pointerover', {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType,
        clientX,
        clientY,
      }),
    );
  };
  const HAND_BACK_EVENTS = ['pointermove', 'pointerover', 'pointerout', 'pointerdown'];
  for (const type of HAND_BACK_EVENTS) doc.addEventListener(type, handHoverBack, true);
  place();

  return () => {
    mutations.disconnect();
    resizes.disconnect();
    for (const type of HOVER_EVENTS) doc.removeEventListener(type, onHover, true);
    for (const type of HAND_BACK_EVENTS) doc.removeEventListener(type, handHoverBack, true);
  };
}

/**
 * A ref callback for the list part (give it `ROW_HIGHLIGHT_CLASS` too). `selector` names the
 * row to follow and is fixed for the life of the list element: a list that changes it is
 * remounted (the Settings palette keys its list by stage).
 */
export function useRowHighlight(selector = '[role="option"][data-muxui-state-focused]') {
  const stop = useRef<(() => void) | undefined>(undefined);
  return useCallback(
    (list: HTMLElement | null) => {
      stop.current?.();
      stop.current = list ? follow(list, selector) : undefined;
    },
    [selector],
  );
}
