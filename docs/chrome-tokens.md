# Chrome design tokens

Bento's chrome (Firefox `browser.xhtml` + scripts under `src/browser/`) is a
separate document tree from the `bento-shell` extension, so chrome inline
styles can't read the extension's `:root` cascade. This doc covers how
chrome gets Tale UI design tokens anyway, and how that pipeline absorbs
future themes.

## How it works today

1. **Source of truth:** Tale UI CSS at
   `/Users/admin/Projects/tale-ui/core/packages/css/src/{tokens,themes}/`.
2. **Generator:** [scripts/generate-chrome-tokens.mjs](../scripts/generate-chrome-tokens.mjs)
   reads those files and writes
   [src/browser/base/content/bento-chrome-tokens.css](../src/browser/base/content/bento-chrome-tokens.css)
   (gitignored — regenerated on every build).
3. **Build wire-up:** [package.json](../package.json) `import` script runs
   the generator before `surfer import`. Every `pnpm run dev` /
   `pnpm run build` pulls fresh values — drift = 0.
4. **Chrome registration:** [patches/chrome-layout/01-bento-shell-mount.patch](../patches/chrome-layout/01-bento-shell-mount.patch)
   adds `content/browser/bento-chrome-tokens.css` to `browser/base/jar.mn`.
5. **Dev sync:** [scripts/sync-builtin-addon-symlinks.sh](../scripts/sync-builtin-addon-symlinks.sh)
   creates a symlink under the deployed app's
   `chrome/browser/content/browser/` so changes land without a full mach
   rebuild.
6. **Loaded at boot:** [src/browser/base/content/bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)
   `injectChromeTokens()` adds a `<link rel="stylesheet">` to the chrome
   `<window>` pointing at `chrome://browser/content/bento-chrome-tokens.css`.
   Tale UI variable names (`--color-60`, `--neutral-90`, `--radius-m`, …)
   are then available to chrome inline styles via `var()`.

## What gets included, what doesn't

The generator copies these files verbatim, in this order:

```
tokens/_colors.css        →  --brand-X primitives + per-hue scales
tokens/_neutrals.css      →  --neutral-{cool,warm,…}-X scales
tokens/_effects.css       →  --radius-X, --shadow-X, --scrim-X
tokens/_spacing.css       →  --space-X
themes/_color-modes.css   →  light/dark @media flips for --color-X
themes/_color-themes.css  →  .color-red, .color-blue, … overrides
themes/_neutral-themes.css→  .neutral-cool, .neutral-warm, … overrides
```

It deliberately **skips**:

- `tokens/_base.css`'s `html { font-size: 62.5% }` — would resize all of
  Firefox chrome (URL bar, tabs, menus). The `:root` vars in that file
  are inlined into `_effects.css`'s scale anyway.
- `index.css`'s Google Fonts `@import` — chrome CSP blocks the network
  fetch and Bento bundles fonts locally for the extension.
- All `foundations/`, `layout/`, `utilities/` — those style HTML/JSX
  elements; chrome XUL has its own widget styling.

It **adds** a `--scale: 1.25px` override at the end so the calc-based
radii resolve to the same px values the extension renders under its
62.5%-root font-size (`0.125rem` at 10px root == 1.25px). Without this
override, chrome's system 16px root would double the radii.

## Activating a different theme

Tale UI's `_color-themes.css` and `_neutral-themes.css` ship CSS rules
shaped like:

```css
.color-red {
  --brand-5: var(--red-5);
  --brand-10: var(--red-10);
  /* … */
}
.neutral-cool {
  --neutral-default-5: var(--neutral-cool-5);
  /* … */
}
```

To activate a theme on the chrome side, add the corresponding class to
the chrome `<window>` element. The simplest spot is
[bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js),
right after `injectChromeTokens()`:

```js
document.documentElement.classList.add('color-red', 'neutral-cool');
```

Tale UI's cascade then redefines `--brand-X` (and through it, `--color-X`)
to the chosen palette, and chrome inline styles using `var(--color-60)`
re-render in the new accent. Same mechanism the extension uses on
`<html data-workspace-color="…">`.

## Adding a new theme via the Scale app

When the Scale app's algorithm produces a new palette in Tale UI core:

1. Generate the palette CSS with the Scale app and commit it as
   `tale-ui/core/packages/css/src/themes/_<name>-themes.css` — same
   shape as the existing `_color-themes.css` / `_neutral-themes.css`
   (a top-level class selector that overrides `--brand-X` /
   `--neutral-default-X` with calculated values).
2. Add the new file to the `SOURCES` array in
   [scripts/generate-chrome-tokens.mjs](../scripts/generate-chrome-tokens.mjs)
   (preserve the order: tokens → color-modes → palette themes).
3. Run `pnpm run import`. The generator picks the new file up; chrome
   gets the rules.
4. Activate via `documentElement.classList.add('<your-theme-class>')`
   in the chrome script (or, eventually, drive the class from a
   `bento.theme.*` pref + a runtime listener).

The extension's [extensions/bento-shell/src/main.tsx](../extensions/bento-shell/src/main.tsx)
already imports Tale UI's index.css indirectly via `@tale-ui/core`, so
the same theme classes apply on the extension side without any extra
plumbing — single source of truth across both surfaces.

## Updating Tale UI

When Tale UI's primitives shift (recolored brand, new neutral scale,
added radius step, shadow tweak, etc.), the next `pnpm run import`
regenerates the chrome stylesheet from the new source. Nothing manual.
The only times this file needs human attention are:

- A new file is added under `tokens/` or `themes/` that we want chrome
  to consume — add it to the `SOURCES` array.
- A new file under `tokens/` introduces something chrome should NOT
  apply (a new `_base.css`-style document-root override, or content
  styles that target HTML elements chrome doesn't have) — update the
  "skips" list in this doc and the generator.
- The `--scale: 1.25px` override needs revisiting if Tale UI changes
  its root font-size convention away from 62.5% / 10px.

If `pnpm run import` ever fails with `cannot read .../tokens/_X.css`,
either Tale UI removed a file we're reading or the path to the Tale UI
checkout changed — fix the `SOURCES` list or the `TALE_UI_CSS` constant
at the top of the generator.
