# Chrome design tokens

Bento's Firefox chrome and the `bento-shell` extension have separate document
trees. The native stylesheet therefore receives a generated copy of the
public Mux token surface and Bento's compatibility aliases.

## Pipeline

1. The source is the pinned npm `@muxui/react` package consumed by
   `extensions/bento-shell`. The generator reads its public `styles.css`, the
   Bento token layer, the generated preset index, and the shell's per-theme
   sheets (`extensions/bento-shell/public/themes/<id>.css`, written by
   `pnpm run theme:sync` from the public `themes.css`).
2. [scripts/generate-chrome-tokens.mjs](../scripts/generate-chrome-tokens.mjs)
   writes two outputs next to each other:
   - [bento-chrome-tokens.css](../src/browser/base/content/bento-chrome-tokens.css),
     the shared tokens plus the Default theme;
   - `src/browser/base/content/bento-chrome-themes/<id>.css`, one native sheet
     per other theme (15 today, each about 28 kB, 3 kB gzipped).
     Use `--output <path>` for an isolated package or proof run; the theme sheets
     then go to a `bento-chrome-themes/` directory beside that path, or wherever
     `--themes-dir <path>` says. This is required for checks that must not write
     the engine source tree. Sheets for removed themes are deleted.
3. [scripts/import.sh](../scripts/import.sh) invokes the generator during the
   normal source import workflow.
4. The chrome layout patch registers the base sheet in `browser/base/jar.mn`,
   and the theme directory by wildcard
   (`content/browser/bento-chrome-themes/ (content/bento-chrome-themes/*.css)`).
   `scripts/sync-builtin-addon-symlinks.sh` links that directory into a dev app
   bundle, because the build lists wildcard files once.
5. [src/browser/base/content/bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)
   loads the base sheet, keeps `data-color-mode` on the chrome root, and
   attaches the active theme's sheet before setting `data-bento-theme`.

## Generated content

The output includes the public Mux root, light and dark mode, standard
contrast, and attribute-closure blocks. Mux theme selectors are adapted from
`data-muxui-*` to the native `data-bento-theme`, `data-color-mode`, and
optional `data-bento-contrast` attributes.

Contrast is fixed to `standard` and nothing sets `data-bento-contrast`, so the
generator omits every rule that requires `contrast='more'`: the public base
block, the 30 `themes.css` theme blocks, and the Bento preset projection. The
`:not([data-bento-contrast='more'])` theme selectors remain and always match.
Mux keeps the rules upstream, so they return by restoring `contrast='more'` to
the generator's mode selectors and the theme sync's filter if a contrast setting
is ever added. The shell build applies the same decision to its stylesheet with a
PostCSS step (`extensions/bento-shell/contrast-more.mjs`).

Themes are split so a window parses only the theme it shows. The base sheet
(about 284 kB, 33 kB gzipped; it was 664 kB / 60 kB with every theme) holds the
public Mux root, mode and closure blocks, the Bento token layer, and the Default
theme with the legacy-token bridge. Each theme sheet holds that theme's light and
dark blocks, adapted from the shell sheet (`data-muxui-*` to the native
attributes, the `muxui` layer wrapper removed because native chrome is
unlayered). Base plus all theme sheets contains exactly the rules the single
sheet used to. Documents that link `bento-chrome-tokens.css` statically
(preferences, about:logins, megalist, the migration host) never carry a
non-Default `data-bento-theme`, so they need only the base sheet.

`--monolithic`, also selected by `BENTO_RELEASE_VARIANT=rollback-final-r2`, folds
every theme back into the base sheet. The archived rollback mount script links
only that file.

The Bento token layer supplies product-specific dimensions and surfaces. The
generated preset index supplies the old short aliases used by existing Bento
CSS and native chrome. The aliases are derived from public Mux declarations,
so the bridge does not depend on a private Mux compiler or catalog.

The generator omits package font-face rules because native chrome has no
package URL base. Extension entry points consume Mux's self-hosted font assets
through the package stylesheet. The native output contains no remote font or
stylesheet import.

Document and component styles are not copied into the native sheet. Chrome
continues to provide its own widget styling while sharing the token values.

## Theme behavior

The chrome mount script writes the resolved light or dark mode to
`data-color-mode`, and the persisted presentation id to `data-bento-theme`
through `applyChromeThemeToDocument`. For a non-Default theme it appends
`<link href="chrome://browser/content/bento-chrome-themes/<id>.css">` to the
document root and sets the attribute from the link's `load` event, so the
previous theme stays up until the new one can paint. Default needs no sheet. An id
that is not lowercase kebab-case, or a sheet that fails to load, falls back to
Default. The previous theme's link is removed once the new one applies, and the
native sidebar and Places documents (which mirror the root's attributes) manage
their own link the same way. The theme sheet is not added to shadow roots:
custom properties inherit into them from the host document. The generated Mux
theme rules select the same canonical values as the extension. Bento's Default
preset remains a scoped warm ladder with `--neutral-default-20: #e5e1dd`; the
unscoped shell fallback can keep its cool neutral family.

Theme sheets load after `bento-chrome-theme.css`, so a theme rule now follows
rules it used to precede. That is safe because no property is set by a theme rule
and by another rule of equal or higher specificity (theme selectors have
specificity 0,3,0; the base blocks 0,1,0; `bento-chrome-theme.css` is layered).
Recheck this if a theme or base selector gains specificity.

Custom Scale imports remain supported by
[scripts/import-theme.mjs](../scripts/import-theme.mjs). The importer preserves
foreground overrides and rewrites them to the Bento theme and mode attributes.
Run the theme sync before generating an isolated chrome stylesheet.

## Focused verification

Use the repository Node 24.19 runtime and an isolated output path:

```sh
tmp_dir="$(mktemp -d)"
/Users/admin/.vite-plus/js_runtime/node/24.19.0/bin/node scripts/sync-theme-presets.mjs
/Users/admin/.vite-plus/js_runtime/node/24.19.0/bin/node \
  scripts/generate-chrome-tokens.mjs \
  --output "$tmp_dir/bento-chrome-tokens.css"
```

The base file should contain `--shadow-l`, `--font-size-root`, and
`[data-bento-theme='default']`, and no `@import`, remote font URL,
`data-muxui-*` selector, or theme other than Default. `$tmp_dir/bento-chrome-themes/`
should hold one file per other theme (for example `standard-harbour.css`), each
free of `@layer`, `data-muxui-*`, and any selector that requires
`[data-bento-contrast='more']` (only `:not(...)` negations). `node --test
scripts/theme-sheets.test.mjs` checks all of this.

In a running build, set a non-Default workspace theme and confirm the window root
has that `data-bento-theme` plus one `<link data-bento-chrome-theme-sheet>`;
switch workspaces and confirm the link is replaced, not duplicated.
