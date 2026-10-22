/**
 * Props for a button inside a palette's SearchField (Clear, and Close where it sits in the
 * field) that make it work from the keyboard. The SearchField's button context does two things
 * that stop that: it gives every button in it `excludeFromTabOrder`, so Tab never leaves the
 * field; and its press-start focuses the input, so a key press (Enter, Space) moved the focus off
 * the button before its key-up and the press never finished. This puts the button back in the tab
 * order and, for a key press, takes the focus back after the context has moved it (props merge
 * with the context's handlers run after them). A plain props object: `ButtonPartProps` declares
 * neither prop, and the Mux part forwards its props to React Aria. A recorded exception in
 * docs/mux-ui-component-customisations.md.
 */
export const IN_TAB_ORDER: Record<string, unknown> = {
  excludeFromTabOrder: false,
  onPressStart: (event: { pointerType: string; target: Element }) => {
    if (event.pointerType === 'keyboard' && event.target instanceof HTMLElement) {
      event.target.focus();
    }
  },
};
