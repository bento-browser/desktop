// Theme presets registry. Each entry corresponds to a sibling `<id>.css`
// that re-points `--brand-*`, `--neutral-default-*`, `--color-N-fg`, and
// the display/text/mono color aliases when `data-bento-theme="<id>"` is
// set on the host root. The Default theme is Bento-owned too:
// presets/default.css is a scoped local override, not an upstream Tale UI
// change.
//
// New themes land via `pnpm theme:import <id> <scale.css>` (scripts/
// import-theme.mjs) which writes the `<id>.css` preset, patches
// `index.css` to `@import` it, and appends the metadata entry here.
//
// The metadata is intentionally minimal — only the fields the picker
// needs (display name + a brand-60 hex to render the swatch). The full
// palette lives in CSS, not TS, because:
//   - The Scale generator outputs canonical CSS already.
//   - Applying themes is `setAttribute('data-bento-theme', id)` — no
//     runtime string construction needed.
//   - Both the shell (Vite-imported) and the chrome window (via
//     generate-chrome-tokens.mjs) load the same CSS, so the surfaces
//     stay in lockstep without duplicating data.

export interface BentoThemeMeta {
  /** Stable storage id, also the value written to `data-bento-theme`. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** Hex value for the picker swatch's primary (brand) half. Should
   * equal the theme's `--brand-60`. Baked in directly (rather than
   * read from `var(--brand-60)`) so the swatch reflects the *target*
   * theme rather than whatever theme is currently active in the
   * document hosting the picker. */
  brand60: string;
  /** Hex value for the picker swatch's secondary (neutral) half —
   * paired with `brand60` via ColorSwatch's split-diagonal display.
   * Should equal the theme's `--neutral-default-20`. The pale-neutral
   * stop reads as a "page surface" against the saturated brand half,
   * making the swatch pair look like a mini preview of a themed UI. */
  neutral20: string;
}

/** The id used when a workspace has no `themeId` set (or has it cleared
 * back to the default). */
export const DEFAULT_THEME_ID = 'default';

export const BENTO_THEMES: BentoThemeMeta[] = [
  {
    id: 'default',
    name: 'Default',
    // Matches @tale-ui/core's `--brand-60` and `--neutral-cool-20`.
    brand60: '#025768',
    neutral20: '#d3d6e0',
  },
  {
    id: 'teal',
    name: 'Teal',
    brand60: '#1dccb8',
    neutral20: '#d5d0cd',
  },
  {
    id: 'terracotta',
    name: 'Terracotta',
    brand60: '#a64300',
    neutral20: '#d0d2c8',
  },
  {
    id: 'rosewater',
    name: 'Rosewater',
    brand60: '#e7939b',
    neutral20: '#cdd2d0',
  },
];

export function getThemeMeta(id: string | undefined | null): BentoThemeMeta {
  if (!id) return BENTO_THEMES[0]!;
  return BENTO_THEMES.find((t) => t.id === id) ?? BENTO_THEMES[0]!;
}
