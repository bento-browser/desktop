// Where Enter goes in a palette search field (the command palette and the address bar).
//
// Mux wraps the field in a React Aria Autocomplete, which keeps virtual focus on one row and
// publishes it as the input's `aria-activedescendant`. Its input handler runs after ours, skips
// its navigation when our handler prevents default, and on Enter clicks the row holding the
// virtual focus. So a handler that wants the highlighted row to win does nothing and returns.

/** What the check reads from the input, so tests need no DOM. */
interface ActiveDescendantHost {
  getAttribute(name: string): string | null;
  ownerDocument: { getElementById(id: string): unknown };
}

const HIGHLIGHT_KEYS = new Set(['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * Whether this key press moves the highlight: React Aria's list navigation, which takes the
 * plain key only (Cmd+ArrowDown and the like are not navigation), outside IME composition.
 */
export function movesHighlight(event: {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean };
}): boolean {
  return (
    HIGHLIGHT_KEYS.has(event.key) &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing
  );
}

/**
 * True when Enter belongs to the highlighted row, which Mux then activates. `moved` is whether
 * the user moved the highlight on purpose (a key from `movesHighlight`, or a real pointer move
 * over the list): the palettes pass it so the automatic first-row highlight, and a row that
 * landed under a resting pointer, do not take Enter from the typed text or the first row.
 *
 * The row must still be in the document: after typing, the Autocomplete keeps naming a row that
 * the new filter removed until it highlights the new first row, and Mux activates nothing then.
 */
export function enterActivatesHighlight(input: ActiveDescendantHost, moved = true): boolean {
  const id = input.getAttribute('aria-activedescendant');
  return moved && !!id && !!input.ownerDocument.getElementById(id);
}
