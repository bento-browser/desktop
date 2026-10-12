# Mux UI and Bento component customisations

This guide records the reusable rules for Bento's migrated UI. It complements
[CLAUDE.md](../CLAUDE.md), which owns the contributor guardrails.

## Sources

- `node_modules/@muxui/react/README.md` and its generated public declarations
  define the Mux component API.
- `extensions/bento-shell/src/components/primitives/` owns shared Bento
  layout, icon, and browser-specific adapters.
- [bento-tokens.css](../extensions/bento-shell/src/theme/bento-tokens.css)
  owns Bento-specific values and the staged legacy token surface.
- [themes.md](themes.md) covers workspace theme persistence and presentation
  scope resolution.
- [chrome-tokens.md](chrome-tokens.md) covers the native token projection.

Use the public Mux root export or a documented public subpath. Do not import
private generated files, copy package registries, or call React Aria
Components directly from a Bento composite. Mux owns its internal React Aria wiring. The primitives layer owns Bento
icon/layout adaptation.

## Consumer migration status

Bento consumes the exact published `@muxui/react@0.1.0-rc.1` npm release in both
frozen dependency graphs. All normal React documents and both supported
rollback variants use public Mux controls, the shared stylesheet boundary, and
Bento layout/icon primitives. The normal Settings surface is native Firefox;
the standalone React Settings and Shortcuts surfaces belong to the rollback
archive and are compiled against the same npm package. Native controls consume
the generated Mux token projection.

Text uses the public `xs`, `sm`, `md`, and `lg` size values. There is no
Bento compatibility wrapper for the old Text API. React Aria is an internal Mux
dependency; shared Vite aliases and graph overrides preserve one menu context
identity. Vite no longer forces React Aria into one `react-aria` chunk: Rollup
already places each module in one chunk, and the forced chunk made every
overlay download the whole package. `module-identity-guard.ts` fails the build
instead when a context-bearing package (React, React Aria, `@internationalized`)
is bundled from two install paths, which is how the original
`SubmenuTriggerContext` defect arose. Release SBOM validation binds the exact
published version and npm integrity and retains the approved shell runtime
dependency policy.

On 2026-10-05, isolated Node 24.21 validation passed both frozen installs,
normal shell typecheck/lint/build, the active and archived Settings Ladle
builds and provider/config typecheck, 64 shell tests, 154 tools tests, six release-security tests, and four
theme-selector tests. Both rollback variants passed 14-entry builds, shell and
tools typechecks, background bundling, and two backup privacy tests each.
Theme regeneration is deterministic and chrome tokens were generated to a
scratch path. The production dependency audit reported zero known
vulnerabilities, and the release SBOM contains 709 components with the npm Mux
integrity digest. These results cover the published RC; prior alpha test counts
and screenshots are not evidence for it.

The size checker covers the 12 normal JavaScript entries, `style.css`, the
plain `panel-newtab.css`, and standalone Settings when the rollback source
stages it. Existing advisory ceilings remain unchanged.
An unchanged alpha baseline built in a separate source copy measured shell
JavaScript at 386.09 KB gzipped and CSS at 91.41 KB. The RC measures 364.64 KB and
107.41 KB respectively: JavaScript decreases 21.45 KB, while CSS increases
16.00 KB. Both variants measure rollback Settings at 373.66 KB and shared CSS
at 108.00 KB. The ceilings are still exceeded; passing builds are not a claim
that those budgets pass. Public Mux styles alone are 79.92 KB gzipped, with
public themes at 30.83 KB and Bento's generated aliases at 17.54 KB; combined
compression means these source sizes do not add directly to the bundle size.
Full public component/theme coverage is retained.

On 2026-10-12 the shell build dropped the forced React Aria chunk, the
modulepreload polyfill, and the contrast `more` CSS, and `panel-newtab` became a
plain page. The summed gzip closure of the 12 JavaScript entries fell from
3,959 KB to 3,233 KB (-18.4%), and palette, confirm, merge-palette, and
panel-navigator-tooltip now fit their 200 KB ceilings while the other overlays
still exceed them. `style.css` fell from 107.37 KB to 103.13 KB gzipped (1.45 MB
to 1.08 MB raw); gzip had already collapsed most of the repeated contrast
blocks. `panel-newtab` now loads a 17.92 KB gzipped sheet instead of the shared
sheet (its heading still loads the Inter file). The generated chrome token sheet
fell from 1,045 kB to 664 kB.

On 2026-10-12 the shell CSS and fonts were split and pruned. Themes became
per-theme sheets (the shared `style.css` carries Default only), the Mux CSS for
components Bento never renders was pruned, and the six fonts became WOFF2.
`style.css` fell from 103.13 KB to 63.01 KB gzipped (1.08 MB to 0.60 MB raw), the
theme sheets are 28 kB each (3 kB gzipped; a document loads one, or all of them
where it previews them), the fonts fell from 2.74 MB to 1.22 MB, and the generated
chrome token sheet from 664 kB to 284 kB (60 kB to 33 kB gzipped). The 40 KB
ceiling for `style.css` is still exceeded.

Firefox validation uses a disposable app/profile and legitimate protocol fixtures
to activate the normal entries and both rollback Settings variants. Entry coverage
through those fixture/bridge-contract scenarios is separate from representative
real `moz-extension` host evidence: the populated sidebar, sidebar theme/collapse
bridge updates, the address editor, and a confirm overlay. This does not claim that every normal
overlay flow was individually exercised in the native extension host.

Fresh RC rollback checks show readable disabled dark NumberField values `30`
and `5` in both variants; enabling backups and incrementing the interval to `35`
produce the expected settings update. This resolves the old alpha-era blank-field
observation without a custom value renderer or package patch. Both variants also
pass Shortcuts filtering, nonempty-query Escape and pointer Close, plus FileTrigger
invalid/valid JSON, same-file reselection, import dispatch, and completion. Public
picker Tabs pass pointer categories and current-focus Home/End/arrows with
DOM focus following selection; Enter/Space retain that category and search typing
retains input focus. Active-panel association, inactive-panel hiding, search
fallback, emoji/theme selection, Escape, and workspace Save also pass. Normal command and merge palettes pass pointer Close with empty and
nonempty queries, and their public ClearButtons reset the controlled query.
Runtime artifacts and the per-surface `acceptance-report.md` are retained under
`/tmp/bento-mux-runtime-20261005/` for this review. No fresh native engine build or cross-platform CI was run.

## Composition model

Prefer the Mux component props, variants, sizes, and documented compound parts
before adding CSS. Use Bento primitives for repeated layout and icon behavior,
then keep product-specific composition in the owning component. A trigger that
renders a button must not contain another button. Keep overlay state and focus
behavior on the documented Mux parts. Public native Input handlers may adapt
browser-specific keyboard behavior without bypassing the component renderer. Set `placement="end-top"` explicitly on nested
`Menu.Popup` parts so chrome submenus open beside their parent item. This
preserves pointer travel and keeps the child popup clear of subsequent root
menu rows under the RC collection renderer.

Generic buttons and picker triggers use Mux `Button` or `IconButton`. Emoji
categories use public `Tabs` with controlled `value`/`onChange`; Mux owns tab
roles, panel association, selection, and arrow-key navigation. Scoped layout
keeps the existing emoji panel above its category strip. The RC can update
selection and roving `tabIndex` while leaving DOM focus on the previous tab.
A small effect uses the public Tabs root ref and standard ARIA roles to focus
its selected tab directly after the controlled update commits. Do not defer
this correction to an animation frame: Firefox can delay those callbacks in
background overlay windows. It runs only when focus already belongs to that
category tab list, so search, emoji results, and outside focus are preserved.
Mux still owns the key-to-selection algorithm; no private renderer API or
package patch is used. Recheck current-focus Home/End/arrows and
Enter/Space, plus search focus, before removing this adaptation after a package
upgrade. Inline
tab/folder rename fields, tab search, and the read-only sidebar address display
use the public `Input.Input` leaf with native input props and refs. The leaf's
optional field context allows it to occupy the existing product grid without
an extra wrapper. Sidebar address submission uses Mux `Form`, and the panel
trailer uses public `Toolbar`; scoped Bento layout rules preserve their chrome
geometry.

The virtualized tab/folder composite is browser-specific structure. Its Bento
`Row` host retains drag, multi-selection, context-menu, and middle-click events;
its inner generic controls use Mux. Semantic headings/sections, host roots,
favicon images, skeletons, and native `SelectNative` options remain ordinary
HTML. ESLint enforces public imports in all shell source, Ladle, and rollback
UI (CI lints the rollback sources through `pnpm run rollback:check`). It does not claim to ban every intrinsic JSX element.

Tab and folder labels use the row's center alignment with single-line leading.
Keep them free of relative vertical offsets: the former `top: 2px` adjustment
put Mux text below the centered favicon and folder count.

Rollback Backup import uses public `FileTrigger` around its Mux button. Mux
owns the hidden input and resets selection before reopening the picker; Bento
retains the 10 MB limit, JSON parsing, preview, and dispatch behavior. Shortcuts
uses public CommandPalette `ListBox`, `Section`, and `Item` parts with read-only
activation semantics (`closeOnSelect={false}`). Public ClearButton and Close
parts occupy separate positions in the search row in Shortcuts, the normal and
archived command palette, and merge. The scoped static Close position prevents
the sticky search row's Input/Clear/Refresh from covering the button. A native Input Escape
handler closes the controlled dialog, since the RC SearchField can otherwise
consume Escape while the controlled leaf query remains unchanged. Preserve IME
composition before handling that key.

Each React HTML entry point imports `theme/muxui.css` once. That Bento-owned boundary
places the public Mux component styles in the low-precedence `muxui` layer, then
the entry point loads Bento tokens, generated preset layers, and
`theme/document-base.css`, the shared `html`/`body` defaults. Theme and mode
attributes belong on the same scope element. `themeScope.ts` resolves aliases
and unknown ids for presentation while `bento-tools` keeps persisted ids
unchanged.

The preset palettes (`@muxui/react/themes.css`) are not part of that import. Each
document loads only the themes it shows, from per-theme sheets:

- `scripts/sync-theme-presets.mjs` splits the public `themes.css` into
  `extensions/bento-shell/public/themes/<id>.css` (one canonical sheet per theme
  that `@muxui/react/themes` exports, each `@layer muxui { ... }`, standard
  contrast only) plus one sheet per repo-local
  custom theme. `theme/presets/index.css` keeps the Default theme, which every
  document needs for its first paint and as the unknown-id fallback. The sheets
  are tracked generated files; `pnpm run theme:sync` rewrites them and drops sheets
  of removed themes.
- `theme/themeSheets.ts` attaches a sheet as a `<link href="./themes/<id>.css">`
  (no inline style or script, so the extension CSP is unchanged). `useWorkspaceTheme`
  requests the active workspace theme and writes the scope attributes after the
  sheet has loaded, and only for its latest request (a superseded one changes
  nothing). So that a new window does not wait for the workspace snapshot before
  starting that request, `public/boot.js` inserts the sheet of the last applied
  theme (localStorage `workspace-theme`) before any CSS loads, and `themeSheets.ts`
  adopts that link instead of creating a second one. `useThemeSheet(id)` and `useThemeSheets(ids)` keep sheets for nested
  scopes, called by the component that renders the scope: `PinnedPanels` (a pin
  uses its own workspace's theme), `WorkspaceSwitcher`, `WorkspaceThemePicker` (all
  16), the `workspace-switcher` overlay, and the Ladle provider. A new component
  that renders another workspace's theme must call one of them, or its nested
  scope paints the unscoped Mux palette; `themeScopeSheets.test.ts` enforces it.
- Layer order is unaffected: `theme/muxui.css` still declares
  `@layer muxui, bento;` first, and a sheet's `muxui` rules append to that layer
  after the package styles, as `themes.css` did when it was imported. A sheet
  that boot.js inserted sits before the shared stylesheet in document order, which
  changes nothing: `muxui` is the first layer either way, and a theme rule
  (three attribute selectors) outranks the `:root` and `[data-muxui-color-scheme]`
  rules of the shared sheet that set the same properties, so source order never
  decides between them.

The shell build keeps `cssCodeSplit: false`, so every entry shares one
`style.css`. `public/panel-newtab.html` is the exception: a plain page with no
script and no Mux stylesheet. The `panelNewtabCss` Vite plugin
(`extensions/bento-shell/panel-newtab-css.ts`, also used by the archived rollback
config) bundles `src/panel-newtab/panel-newtab.css` (tokens, presets, document
base, page rules) into `assets/panel-newtab.css` with esbuild and the page links
only that file.
It uses `--bento-panel-newtab-*` and `--bento-font-system` tokens. Because Mux
is absent, the page restates the Mux foundation defaults it relied on (body
line height, heading color). Its heading keeps Inter through a page-local
`@font-face`, limited to weight 650, that points by relative URL at the Inter
file the shell build already emits into `assets/` from the Mux font-face
(`Inter_opsz_wght_.woff2`, after `woff2-fonts.ts` converts it). The Vite plugin
fails the build if that file name stops existing, since it derives from the Mux
package path.

Fonts are served as WOFF2. The Mux package ships TrueType only, so
`extensions/bento-shell/woff2-fonts.ts` converts each emitted `.ttf` at build
time (a Brotli container that keeps every table byte for byte), renames the
asset, and rewrites the `@font-face` source in the stylesheet; it fails the
build if a `.ttf` reference survives. The six files go from 2.74 MB to 1.22 MB and
stay local files in `assets/`. Fonts were checked by decoding each file with
fontTools and Google's reference decoder, and by rendering in Firefox.

### Pruning Mux component CSS

The package has one stylesheet for all components. `mux-css-prune.ts` removes the
rules that need a class from a component family the finished bundle does not
name, using only the public `styles.css` and the built chunks and pages:

- A family in `MUX_UNUSED_COMPONENT_CLASSES` is pruned only when no JavaScript
  chunk or HTML page contains its class prefix. Mux writes a component's class
  names as literals in the component's own code, and Rollup keeps that code only
  when Bento can reach the component, so a literal in the bundle keeps the family.
  Bento's own hard-coded `muxui-*` classes count too. Adding a component to
  Bento therefore needs no change here.
- Selector lists are narrowed to the alternatives that do not need a pruned class.
  A class inside `:not()`, `:is()`, `:where()`, `:has()` or an attribute test, a
  rule with nested rules, and every other at-rule stay.
- After pruning, every `muxui-*` class (or built-name prefix such as
  `muxui-tree-`) that the scripts name must still have a rule, or the build fails
  and names the family to remove.

Do not list a family whose classes Mux composes only at runtime (`muxui-${name}`
and `muxui-text--${variant}-${size}`: grid-list, listbox, menu, text), or one whose
literal lives only in shared code: the literal check cannot see those. The
Calendar base class is built that way, but its parts (`muxui-calendar-grid`,
`-cell`, `-header`) are literal in the same code, which the prefix check sees.
Check an entry against the Mux source (`grep -n "muxui-<family>"
node_modules/@muxui/react/generated/*.mjs`) and keep it only if the component
writes its class names literally. The 28 families listed cut the shipped
`style.css` by 118 kB raw and 12.6 kB gzipped. Unit tests check that every entry
matches the public stylesheet, so a Mux rename shows up as a failure.

## CSS and tokens

Component rules belong inside the owning CSS layer and use scoped component
selectors. Keep global selectors away from semantic elements and overlay
internals. Use public Mux semantic roles for new theme decisions and Bento
tokens for product-specific behavior. Existing CSS may use the generated
legacy aliases such as `--neutral-*`, `--color-*`, `--space-*`, `--radius-*`,
and `--shadow-*` while the native chrome and shell surfaces finish their
compatibility transition.

```css
@layer bento.components {
  .my-component {
    color: var(--neutral-90);
    background: var(--neutral-5);
    border-radius: var(--radius-s);
    box-shadow: var(--shadow-m);
  }
}
```

### Legacy alias cap

`pnpm run lint:aliases` (CI, extensions job) counts the legacy alias uses in the
shell's hand-written CSS (`var(--neutral-*)`, `--color-*`, `--space-*`,
`--radius-*`, `--shadow-*` in `extensions/bento-shell/src/**/*.css`; the generated
`theme/presets/` define the aliases and are skipped) and fails when a file, or the
total, is above the committed `.legacy-alias-cap.json`. On 2026-10-12 that was 408
uses of 94 aliases in 20 files. The cap is a ratchet like `.size-baseline.json`:
`node scripts/check-legacy-aliases.mjs --write-cap` lowers it to the current counts
and refuses to raise any file unless the change names it with
`--accept-growth <file>`, so intended growth shows in the committed diff. A new file
with alias uses is growth. Write new CSS with public Mux semantic tokens or
`--bento-*` tokens; remove cap entries as files migrate.

Whether an alias can be swapped for a public token without changing any pixel
depends on the generated CSS, not on the alias name. The alias is a pass-through
(`--radius-s: var(--muxui-reference-dimension-radius-s)`) only when every
declaration of it in the shell CSS and theme sheets is that one `var()` and the
target token is declared only in rules the alias bridge also covers (`:root` and the
`:is([data-muxui-theme], [data-muxui-color-scheme], ...)` block), so both resolve on
the same element in every theme and color scheme. Checked on 2026-10-12:

- Exact: the 5 `--radius-*` aliases (31 uses), `--color-60-fg` (7 uses, the only
  one whose target is a semantic-tier token), and 27 `--neutral-cool-*` names used
  only inside `bento-tokens.css`.
- Exact unless an element sets `data-muxui-responsive`, which Bento never does:
  the 8 `--space-*` aliases (166 uses), because Mux's `[data-muxui-responsive]`
  block also declares the space tokens. Their targets are reference-tier tokens.
- Not exact: `--neutral-N` (15 aliases, 97 uses) and `--color-N` other than
  `--color-60-fg` (7 aliases, 44 uses). The shell bridge points them at
  `--muxui-semantic-color-*`, but `bento-tokens.css` also re-links them to Bento's
  raw ladders (`--neutral-default-N`, `--brand-N`) on `[data-bento-theme]`
  elements. The unlayered bridge wins where an element has a `data-muxui-*`
  attribute, which the shell's theme scope always sets, but a stylesheet cannot
  prove that for every element. The raw `--neutral-default-N` ladders themselves
  (27 names, 30 uses) are Bento values with three declarations each, not
  pass-throughs.
- Not declared anywhere: `--neutral-0`, `--neutral-6`, `--neutral-8`
  (`welcome.css`) and `--radius-2xs` (`PanelTrailer.css`). Those declarations
  resolve to nothing, so the properties that use them are invalid at computed-value
  time.

Add a missing reusable value to `bento-tokens.css` before using it. Avoid raw
colors, durations, easings, or unexplained dimensions. Pair a tinted surface
with its foreground role. Keep the browser-standard root contract of
`1rem = 16px`.

Contrast is fixed to `standard` (`themeScope.ts`, `useFirefoxTheme.ts`,
`public/boot.js`), so Bento drops every rule that requires
`data-muxui-contrast='more'` instead of shipping unreachable CSS. The shell build
removes them with the `stripContrastMore` PostCSS plugin
(`extensions/bento-shell/contrast-more.mjs`), which only removes a selector that
tests the attribute at its top level; `:not(...)` forms and standard-contrast
rules stay. A rule with nested rules is never removed or rewritten, because a
nested `:not(&)` is still reachable and `&` takes its specificity from the whole
parent selector list. A `@layer name { }` block the plugin empties becomes
`@layer name;` so the layer keeps its place in the layer order. `scripts/sync-theme-presets.mjs` and
`scripts/generate-chrome-tokens.mjs` no longer emit those blocks. Mux keeps them
upstream, so adding a contrast setting later means removing the plugin and
restoring the generator selectors. Do not add `contrast='more'` styling in
Bento CSS while the plugin is active; it would be stripped.

Firefox-owned chrome cannot import React components. Map native variables in
`bento-chrome-theme.css` to the generated aliases from
`bento-chrome-tokens.css`; keep the existing `data-bento-theme` and
`data-color-mode` hook boundary. Chrome loads one theme sheet per document from
`bento-chrome-themes/` (see [chrome-tokens.md](chrome-tokens.md)).

The prior design-system customization notes were folded into this guide during
the Mux migration. New code follows the public Mux API and the Bento-owned
layers above.
