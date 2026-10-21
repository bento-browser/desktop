// The Theme step's pointer, focus and selection rules, kept free of React and the DOM so they can
// be tested (WelcomeSurfaces.tsx wires them to the swatch rows).

/** Carried by each swatch (as `data-theme-swatch=<theme id>`), and by nothing else: `data-theme`
 * is also set on `<html>`, so a lookup on it from the whitespace between swatches finds Default. */
export const SWATCH_ATTRIBUTE = 'data-theme-swatch';

/** The part of an element `swatchThemeId` reads. */
interface SwatchTarget {
  closest(selector: string): { getAttribute(name: string): string | null } | null;
}

/** The theme of the swatch `target` is (or is inside), or null for anything else, such as the
 * whitespace inside the rows. */
export function swatchThemeId(target: SwatchTarget): string | null {
  return target.closest(`[${SWATCH_ATTRIBUTE}]`)?.getAttribute(SWATCH_ATTRIBUTE) ?? null;
}

/** What moved the preview off the selected theme: the pointer over a swatch (`null` swatch: over
 * whitespace in the rows), focus on a swatch, the pointer or focus leaving the rows, or a swatch
 * being activated. */
export type PreviewEvent =
  | { type: 'point'; swatch: string | null }
  | { type: 'focus'; swatch: string | null }
  | { type: 'leave' }
  | { type: 'select' };

/** The theme the preview shows next, or null to show the selected one. Moving from a swatch to
 * whitespace and activating a swatch both end the override, so the preview never lingers on a
 * theme that is not the selection. */
export function nextPreview(current: string | null, event: PreviewEvent): string | null {
  switch (event.type) {
    case 'point':
      return event.swatch;
    case 'focus':
      return event.swatch ?? current;
    case 'leave':
    case 'select':
      return null;
  }
}

/** The theme a selection event asks to write, or null for none. Mux keeps one swatch selected and
 * reports the same id again when it is pressed, which must not write the workspace again. */
export function requestedTheme(next: string | undefined, selected: string): string | null {
  return next !== undefined && next !== selected ? next : null;
}
