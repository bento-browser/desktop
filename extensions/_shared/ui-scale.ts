// The interface scales Bento offers, shared by the settings rules, the Settings palette and
// bento-tools.
//
// A scale is stored as the text of its factor, so it fits the fixed-choice (enum) settings rules
// and the Settings palette list without a second kind of value. The factor is relative to the
// display's own size: tools turns it into Firefox's absolute `layout.css.devPixelsPerPx` (see
// docs/technical/theming.md, "Interface scale").

export const UI_SCALES = ['1', '1.25', '1.5', '1.75', '2'] as const;

export type UiScale = (typeof UI_SCALES)[number];

/** No scaling: Firefox follows the display. */
export const DEFAULT_UI_SCALE: UiScale = '1';

export function isUiScale(value: unknown): value is UiScale {
  return UI_SCALES.some((scale) => scale === value);
}

/** The factor a scale stands for: `'1.25'` is 1.25 times the display's own size. */
export function uiScaleFactor(scale: UiScale): number {
  return Number(scale);
}

/** The label of a scale in the Settings palette: `1.00x`, `1.25x` and so on. */
export function uiScaleLabel(scale: UiScale): string {
  return `${uiScaleFactor(scale).toFixed(2)}x`;
}
