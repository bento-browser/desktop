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

function follow(list: HTMLElement, selector: string): () => void {
  let moving = false;

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
  const hoverIsPointer = (event: PointerEvent) => {
    list.ownerDocument.dispatchEvent(
      new PointerEvent('pointermove', { pointerType: event.pointerType }),
    );
  };
  list.addEventListener('pointerover', hoverIsPointer, true);
  place();

  return () => {
    mutations.disconnect();
    resizes.disconnect();
    list.removeEventListener('pointerover', hoverIsPointer, true);
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
