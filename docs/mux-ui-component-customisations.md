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
frozen dependency graphs. All React documents, the Settings palette included,
use public Mux controls, the shared stylesheet boundary, and Bento layout/icon
primitives. Native chrome and the remaining Firefox pages consume the generated
Mux token projection.

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
normal shell typecheck/lint/build, the Settings Ladle build and
provider/config typecheck, 64 shell tests, 154 tools tests, six release-security tests, and four
theme-selector tests. Theme regeneration is deterministic and chrome tokens were generated to a
scratch path. The production dependency audit reported zero known
vulnerabilities, and the release SBOM contains 709 components with the npm Mux
integrity digest. These results cover the published RC; prior alpha test counts
and screenshots are not evidence for it.

The size checker covers the 12 normal JavaScript entries, `style.css`, and the
plain `panel-newtab.css`. Existing advisory ceilings remain unchanged.
An unchanged alpha baseline built in a separate source copy measured shell
JavaScript at 386.09 KB gzipped and CSS at 91.41 KB. The RC measures 364.64 KB and
107.41 KB respectively: JavaScript decreases 21.45 KB, while CSS increases
16.00 KB. The ceilings are still exceeded; passing builds are not a claim
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
to activate the entries. Entry coverage
through those fixture/bridge-contract scenarios is separate from representative
real `moz-extension` host evidence: the populated sidebar, sidebar theme/collapse
bridge updates, the address editor, and a confirm overlay. This does not claim that every normal
overlay flow was individually exercised in the native extension host.

The virtualized tab/folder composite is browser-specific structure. Its Bento
`Row` host retains drag, multi-selection, context-menu, and middle-click events;
its inner generic controls use Mux. Semantic headings/sections, host roots,
favicon images, skeletons, and native `SelectNative` options remain ordinary
HTML. ESLint enforces public imports in all shell source and Ladle. It does not claim to ban every intrinsic JSX element.

Tab and folder labels use the row's center alignment with single-line leading.
Keep them free of relative vertical offsets: the former `top: 2px` adjustment
put Mux text below the centered favicon and folder count.

The sidebar action bar's New and Search `Button`s (ghost, `sm`; Search was an
`IconButton` before it gained a peek label) are hovered by a second sliding
highlight behind them, so they paint no hover fill of their own. Mux paints `:hover` and `[data-hovered]` from
`--muxui-button-background-hover` (the ghost variant sets it to a 10%
`surface-contrast` mix) and `:active`/`[data-pressed]` from
`--muxui-button-background-pressed`. Bento sets only the hover property to
`transparent` on `.bento-tab-list__new-action-button` and
`.bento-tab-list__search-button`, in unlayered CSS after the `muxui` layer, so
the pressed feedback and the focus ring stay Mux's. Do not restyle the `:hover`
or `[data-hovered]` selectors for this. After a Mux upgrade, recheck that the
ghost variant still reads `--muxui-button-background-hover` for both states, or
the buttons stack a second fill over the highlight (about twice a hovered
row's darkening).

The Search `Button` is a 2rem square at rest and widens leftward on hover or
keyboard focus to reveal its label (motion and field:
[technical/palettes-and-address-bar.md](technical/palettes-and-address-bar.md#search-trigger-and-field-motion)).
Its `.bento-tab-list__search-button` rule is unlayered, like New's, and sets
`width: 100%` of its `span.bento-tab-list__search-trigger` (the span owns the
animated width), `min-height: 0`, `padding-block: 0`, `overflow: clip` with
`overflow-clip-margin: content-box` and an inline padding of
`--bento-tab-list-search-trigger-inset`, which keeps the icon where it was
centered in the square. The label is always opaque; the clip reveals it. The
content-box clip edge sits at the inline padding, not the border, so the label
(it starts 29.2px in, past the 24px content edge) shows nothing in the square's
right padding at rest, and it is uncovered as the button widens. The button's own
painting is not clipped by its own overflow (the focus ring is a `box-shadow`, the
pressed fill is its background). `padding-block: 0` keeps the content box the full
row height: Mux's block padding (about 9.35px) would shrink it below the 1rem icon
and clip the icon top and bottom. The published package lays the icon and
label out inline in `.muxui-button-content`, which is not a flex container, so
the gap between them is a `margin-inline-start` on the label, not a `gap`. Mux
main's wrapper is an inline-flex with `gap: inherit`, so the trigger sets that
part's `gap` to 0 and the margin stays the only spacing in both. The
peeked state uses native `:focus-visible` (the selector Mux's own ring uses);
React Aria also sets `data-focus-visible` on the button.

In the search field, Bento sets `opacity` and its transition on the public
`Input.Input` leaf (replacing Mux's 0.15s outline, shadow and background
transitions, which the borderless transparent input never shows) and wraps the
clear `IconButton` in `.bento-tab-list-search__clear`, which fades and scales
instead of the button, so Mux's own button transitions stay intact.

While the New menu is up in the chrome overlay, `TabList` sets
`data-bento-menu-open='true'` and `aria-expanded` on the New `Button`, and the
unlayered `[data-bento-menu-open='true']` rule paints `--bento-surface-active`
over the highlight (see
[overlay-documents.md](technical/overlay-documents.md#menu-open-state-of-the-sidebar-new-button)).
Mux already drops its pressed fill under `aria-expanded='true'`, so the open fill
is the only one on the button. Do not add a second open-state selector.

Tab and folder rows paint no plain `:hover` fill. `TabList` slides one hover
highlight behind the rows instead (see
[workspaces.md](technical/workspaces.md)). A tab row's hover actions are Mux
`sm` ghost `IconButton`s over the title and paint no backstop: the title is
masked out under them. The mask width is `--bento-tab-row-actions-inset` plus
the visible button count (two, or one on the active row) times
`--bento-tab-row-action-size`, which is `--muxui-control-size-sm`, with
`--bento-tab-row-actions-fade` as the fade. After a Mux upgrade that changes the
`sm` control size or IconButton padding, recheck the mask against the real
actions width. The label foreground rules (default, selected, sleeping, active)
stay unlayered because Mux text utilities are unlayered. A sleeping (discarded)
label uses `--muxui-semantic-color-neutral-60`; keep any dark-mode value at or
above 4.5:1 against the sidebar.

Public ClearButton and Close parts occupy separate positions in the search row
in the command palette, merge, and the Settings palette. The scoped static Close position prevents
the sticky search row's Input/Clear/Refresh from covering the button. A native Input Escape
handler closes the controlled dialog, since the RC SearchField can otherwise
consume Escape while the controlled leaf query remains unchanged. Preserve IME
composition before handling that key.

The Settings palette (`components/SettingsPalette`) is a staged quick pick on the same
CommandPalette parts and adds these customisations. Its popup is a sibling of the Root,
so its size rule finds it through the dialog
(`.muxui-command-palette__popup:has(> .bento-settings-palette__dialog)`) and reads the
command palette's `--bento-command-palette-width`, `-height` and the two max tokens: the
same size, fixed height, on every list. Above the search field a nav row holds a Mux
`IconButton` (Back, `ghost`, `sm`), the path and `CommandPalette.Close`; the path is a `nav`
with an `ol` of Mux `Button`s (`ghost`, `sm`, one per ancestor) and a plain `span`
(`aria-current="page"`) for the current page. Mux `Breadcrumbs` is not used because it
makes a link only of an item that has an `href`, and these levels are actions. Close sits in
the nav row, outside the SearchField, which gives every button inside it `tabindex="-1"`;
Clear stays in the field and opts back into the tab order and keyboard use (exception below). A row is a Mux `Item` with a title, an optional note beside it
(`.bento-settings-palette__note`: Current, Min, Default, Max), a spacer, then an `ItemMeta`
value or a switch, and a trailing icon; its state is carried by data attributes (`data-info`
for a static row, `data-tone` for danger, muted or warning, `data-pending` for a write in
flight, `data-switch` for a row that shows a switch, `data-separated`, `data-detail`,
`data-current` for the preset that matches the typed number) so the rules stay scoped to
`.bento-settings-palette__item`. The switch is Mux `SwitchField` (`Root`, `Button`,
`Thumb`, `size="sm"`) in an `aria-hidden`, `inert` wrapper: a picture of the state, the row
is the control, and the row keeps On or Off in its text value. The root `Switch` was tried and
dropped: it lives in the `fields` chunk, which added about 45 KB gzip to the Settings entry,
where `SwitchField` is in the `supplemental` chunk the palette already loads. Static rows
are `disabled` items, which keyboard navigation skips, restyled so they read as text.
A list of four rows or fewer has no visible field row: the `SearchField` keeps `data-hidden`
(`position: absolute`, 1px, `clip-path: inset(50%)`, the usual visually-hidden recipe) and the
`Input` is `readOnly`, because the Autocomplete input is what drives the list's virtual focus.
A page description is `CommandPalette.Description` between the nav row and the field
(`.bento-settings-palette__page-description`: no Mux margins, a bottom rule like the nav
row), outside the list so it does not scroll. An option's second line is
`CommandPalette.ItemDescription` placed in the item (not in `ItemContent`, so it can take
the full row width under the note and value): a row with a description or a detail
(`[data-described]`, `[data-detail]`) wraps (`flex-wrap`, `row-gap` the micro gap), the line
is `flex: 1 0 100%` with Mux's muted colour (one step lighter on the focused and hovered
row) and wrapping instead of Mux's one-line ellipsis, and it is indented past the leading
mark by `--bento-settings-palette-lead-size` (the 1.25rem Mux gives `.muxui-command-palette__item-icon`)
plus the row gap. A protection level carries its benefits and caveats inside the item and
shows them in two columns under `[data-focused]`. The search field is the command palette's stock one: no
leading icon, and the Input keeps Mux's own padding in every stage. A number stage gives it one fixed width,
`--bento-settings-palette-number-input-width` (the longest `NUMBER_SPECS` bound in digits,
half a digit for the caret, and Mux's inline padding; `ch` resolves against the input's own
font where it is used), so the box never changes with what is typed. A longer value scrolls
inside it, and the unit and bounds after it in the field do not move.
A number with a range of at most 50 (`usesSlider`) is a page of its own kind: a slider in place of
the field row and the preset list. It is not the Mux `Slider`; see the recorded exception below.
The page keeps the Back, path and Close nav row and the description. Above the track is the value
in `neutral-90` at the control weight with its unit in `neutral-60` (an `aria-hidden` `p`, since the
input announces the value and unit itself through `aria-valuetext`, "12 px"). Under the track is a
plain `p` in `neutral-60`, left aligned: "Default N unit" and "min to max unit". The stage is a flex
column that takes the rest of the dialog, so the footer stays at the bottom as on a list page.
Danger text uses `--muxui-semantic-action-danger-foreground`, invalid text
`--muxui-semantic-feedback-invalid-content` and the warning mark
`--muxui-semantic-status-warning`; a pending row dims and ends in an ellipsis rather than
animating (a switch row shows its target state instead). A stage change slides the list in
from the side it came from with one keyframe animation on the `reveal` pair
(`bento-settings-stage-forward` and `-back`, a `--muxui-semantic-layout-inset-large` offset;
none under reduced motion). The Settings palette and the command palette share one row
highlight (`components/primitives/useRowHighlight.ts`, `RowHighlight.css`): the rows paint
no fill (focused, hovered, pressed and selected rows are transparent under
`.bento-row-highlight`) and one slab, the list's `::before`, moves to the focused row. Its
box is written into `--bento-row-highlight-*` properties by the hook; it transitions
`transform`, block and inline size, colour and opacity on the Mux `state` pair (120 ms, the
speed of the sidebar's hover highlight; the
first placement and a stage change are instant, since the list is new), and its colour is
`--bento-palette-highlight-bg` (neutral-26, pressed neutral-30; Mux's own item focus fill is
neutral-14) in `bento-tokens.css`.

Recorded exceptions to the public-API rule. Each reaches React Aria only because the Mux
part forwards its props to it, is passed as a plain props object (the declarations do not
list it), is permanent (Bento does not wait on a Mux prop for it) and is replaced only if a
pinned Mux version documents the prop:

- `autoFocus: 'first'` on `CommandPalette.ListBox` (`FOCUS_FIRST_ROW` in
  `SettingsPalette.tsx`): each stage opens with its first row focused.
- `selectionMode: 'single'` with `selectedKeys` on that list for one frame (`StageList`):
  React Aria focuses the first selected row when the list mounts, which is how a stage opens
  on the row that opened it or on the current choice. The selection is dropped at once; a
  list left in single selection would not run `onAction` on press.
- `aria-describedby` on a Settings option (`describeOptions` in `SettingsPalette.tsx`, a
  `MutationObserver` on the list that writes the attribute on the rendered options): a Mux
  `Item` forwards no `aria-describedby` to React Aria (its item props keep only `id` and
  `data-*`; setting it from a `ref` on the item did not take effect in the built app), and Mux's plain `ItemDescription`
  span registers no description slot. The observer links each option to its own description
  line (and the protection detail), and the row is named by `aria-label` (label, note, value)
  so the line is read once, as the description. Replaced if Mux registers the slot from
  `ItemDescription`.
- `shouldFocusOnHover: true` on `CommandPalette.ListBox` in both palettes
  (`FOCUS_ON_HOVER` in `useRowHighlight.ts`): pointer hover moves the virtual focus, so
  the keyboard and the pointer share the one highlight. React Aria only does this once its
  last input was the pointer, which it learns from `pointermove`; the hook dispatches one
  from a capturing `pointerover` and `pointerout` listener so the first row entered after a key
  press takes the focus too, and keeps hover from a list that appears under a stationary pointer
  until the pointer really moves (see the highlight pitfalls in
  [palettes-and-address-bar.md](technical/palettes-and-address-bar.md#row-highlight)).
- `IN_TAB_ORDER` (`components/primitives/inTabOrder.ts`) on `CommandPalette.ClearButton` in
  both palettes and on `CommandPalette.Close` in the command palette, the buttons that sit
  inside the SearchField: `excludeFromTabOrder: false`, because the SearchField's button
  context makes every button in it `tabindex="-1"`; and an `onPressStart` that takes the focus
  back for a key press, because the context's press-start focuses the input, which moved the
  focus off the button before its key-up and left Enter and Space doing nothing.

Recorded exception to the layering rule: the Settings slider is a native `<input type="range">`
(`components/SettingsPalette/RangeSlider.tsx`), not the Mux `Slider`. Why: Mux's `Slider` lives in
the `collections` module that most entries share, and building the page with it cost about 109 KB
gzip on the Settings entry (which did not load that chunk before) and about 16 KB on the shell and
most overlays; a lazy import does not help, because Rollup keeps one module in one chunk. The
native control gives the same behaviour at no JavaScript cost: arrows, Page keys (a tenth of the
range, 4 on 0 to 36), Home and End, focus, pointer drag and track click are the browser's (Gecko
steps one on Shift+arrow, so nothing is added for it), and `aria-valuetext` carries the unit, which
the Mux slider could not (it has no `formatOptions`). Enter is the only key Bento handles on it
(keep), on the input's `keydown`. The accessible name is `aria-label` (the setting's label) and
`aria-describedby` the page description. The page focuses the input with a ref, and the ring shows
whenever the input has the focus (`:has(input:focus)`), not only after a key press, because the page
opens by programmatic focus and a click on the row that opened it is as common as Enter.

Because a native thumb cannot be transitioned, the input is full size and invisible
(`opacity: 0`, `appearance: none`, transparent `::-moz-range-*` and `::-webkit-slider-*` parts;
its thumb is the drawn thumb's size and its track the slider's height, so the hit area is the
drawn thumb and a press anywhere on the row lands on the input) over a track, fill and thumb drawn
as elements of our own, in the Mux slider's tokens (`surface-track`, `selection-track`,
`border-indicator`, `border-dragging`, `surface-canvas`, `elevation-indicator`, `shape-pill-radius`,
and the focus ring `--muxui-focus-ring-inner` and `-outer`) and sized by the
`--bento-settings-palette-range-*` tokens in `bento-tokens.css`, which copy the Mux slider's
dimensions (control 1.25rem, track 0.25rem, thumb 1.125rem plus a 2px border, ring 2px and 4px).
`RangeSlider` sets one custom property on the wrapper, `--bento-slider-ratio` (0 to 1, from the
value), and the thumb and the fill move only by `transform` from it. The thumb is
`translateX(calc(var(--bento-slider-direction) * (100cqw - thumb) * var(--bento-slider-ratio)))`
and the fill, which is as wide as the track and parked one width behind its start, is
`translateX(calc(var(--bento-slider-direction) * (-100% + thumb / 2 + (100cqw - thumb) * var(--bento-slider-ratio))))`
(`thumb` is `--bento-settings-palette-range-thumb-size`), with the wrapper as the
`container-type: inline-size` that gives `cqw`. `--bento-slider-direction` is 1, and -1 under
`:dir(rtl)`: Gecko inverts a native range in RTL (the thumb travels from the right edge and the
value grows leftward), so the drawn thumb anchors at the inline start and the fill grows from it,
and both stay on the native thumb's centre in either direction. The movement transitions on the
`state` motion pair (`--muxui-semantic-motion-state-transition-duration` and `-easing`, 120 ms,
the speed of the sidebar hover highlight) for key presses and track clicks, so the thumb glides
between steps instead of jumping a step's width, and not while the handle is dragged: a
transition per step would leave the drawn thumb behind the native one, which is what the pointer
hits (a fast sweep trailed by tens of pixels, and a quick re-grab could set the value backward).
`RangeSlider` marks a drag with `data-dragging` once the pointer that pressed the input travels
more than a few pixels (the slop, tracked by `dragTracker.ts` from window listeners, since the
input keeps the pointer; another pointer's release or movement does not touch it, and a second
press does not replace an active drag), so a single click on the track still glides; the mark ends
at that pointer's release. The transition is on only after the slider has settled
(`data-settled`, set a frame after mount, so a page opening on its value does not slide in), and
`prefers-reduced-motion: reduce` turns it off. The wrapper must stay a container with a definite
inline size, and the drawn thumb must keep the native thumb's size and travel (centre from half a
thumb to the width less half a thumb, from the inline start), or the drawn thumb and the hit area
part.

Each React HTML entry point imports `theme/muxui.css` once. That Bento-owned boundary
places the public Mux component styles in the low-precedence `muxui` layer and
declares the `bento` sublayer order (`bento.tokens`, `bento.fonts`,
`bento.components`, `bento.app`; later wins) before any other Bento stylesheet.
Then the entry point loads Bento tokens, generated preset layers, and
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
(`extensions/bento-shell/panel-newtab-css.ts`) bundles `src/panel-newtab/panel-newtab.css` (tokens, presets, document
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

The floating sidebar cards (`SidebarCards`, and the merge progress card in them) are
one raised surface per card, styled only with public Mux semantic tokens:
`--muxui-semantic-surface-raised`, `border-default` (hover `border-indicator`),
`elevation-overlay` (hover `elevation-modal`) and `shape-container-radius`, plus
`--bento-sidebar-card-*` and `--bento-merge-card-*` tokens for the sizes. Hover
moves the border and shadow on the `state` role; a card enters on `reveal` and leaves
on `dismiss`. Each card is drawn in the opposite colour scheme to the sidebar, in its
own theme scope (see "Inverted scope for floating cards" below), so the raised surface
is dark on a light sidebar and light on a dark one. The merge card's primary control is
a Mux `Button` filling
the surface, with its content part (`.muxui-button-content`) as the flex row; the
dismiss `IconButton` is its sibling. Text lines are Mux `Text`: the title is the
default role, the detail and the hostname `color="muted"` (the faint role is 4.3:1 on
the light card). The ring is `ProgressCircle` with a
value: the track is sized by token (Mux's `sm` track is 2rem), the percentage is
`ProgressCircle.Value` stacked over the track in a one-cell grid and shown only while
the ring is partial (four characters do not fit it), and the indicator stroke follows
the card's `data-kind`. Mux paints a complete ring in its success color; the card
keeps the accent for a finished import (its check in `content-strong`, which the
accent ring alone left faint in dark mode), mutes a cancelled one and tints a failed one
with `--muxui-semantic-status-warning` (Mux has no danger status). A Mux `Tooltip`
cannot show in the 52 px rail frame, and Mux `Button` does not forward `title`, so the
rail card's title and detail show in the chrome-side tooltip overlay beside it (see
"Tooltip document" in [technical/overlay-documents.md](technical/overlay-documents.md)),
which stays in the page's colour mode.

### Inverted scope for floating cards

An element can show a theme in the opposite colour scheme to its page by carrying its
own scope attributes. `useInvertedThemeScope()` (`theme/useInvertedThemeScope.ts`)
returns `getThemeScopeAttributes(<active workspace theme>, <opposite of
useResolvedColorScheme()>)` and registers the theme's sheet; spread the result on the
element (workspace avatars and pins use the same pattern with their own theme). The
three attributes `data-muxui-theme`, `data-muxui-color-scheme` and
`data-muxui-contrast` stay together on that one element, and the scheme follows the
document's resolved mode, so it flips live, Auto included. A component that is not
connected to the store (a Ladle story of the pure view) takes the attributes as a prop.

What follows the scope and what does not:

- Mux semantic tokens (`--muxui-semantic-*`) and the component tokens Mux re-declares
  per scheme resolve on the scoped element, so Mux components and any rule reading a
  semantic token render in the inverted scheme. Mux's scoped focus-ring variables
  follow too.
- The `[data-bento-theme]` re-link rule in `bento-tokens.css` re-declares the legacy
  aliases (`--neutral-*`, `--color-*`) and `--bento-workspace-accent(-fg)` and
  `--bento-brand-bg` on every element that carries `data-bento-theme`, which the scope
  attributes include, so those follow as well.
- A token declared on `:root` that reads a colour is computed at the root and inherits
  as that value, so it keeps the page's mode inside the scope (measured: a
  `:root { --x: var(--muxui-semantic-surface-raised) }` read inside the inverted card
  returns the page's surface). Do not declare a colour for a scoped component on
  `:root`: read the Mux semantic token in the component rule, or declare the
  component's own `--bento-*` colour on its scoped selector (`.bento-merge-card[data-kind]`
  does, for `--bento-merge-card-ring-color`). Lengths and durations are not affected.
- Values that must stay the page's are resolved on an ancestor that is in the page
  scope and inherited. The cards' shadows are: `--bento-sidebar-card-shadow` and
  `--bento-sidebar-card-shadow-hover` are declared on `.bento-sidebar-cards`, not on the
  card.

Rules live in `bento.components` with the component, as for any layer-2 component; the
scope attributes need no layer. To check an inversion, flip `<html>`'s mode with the
element's own attributes fixed and compare every computed colour inside it (rest,
hover, focus): a difference is a leak. Measured for the merge card in Ladle: 138
elements, five states, no difference between a light and a dark page. Contrast is
read from the computed colours, not the token names (the card's numbers are in
[technical/session-merge-backups.md](technical/session-merge-backups.md)).

### Inverted block without a scope

A block that must read as the opposite of the page (the Private band in a private
window's sidebar, `components/PrivateBand`) does not need the scope above when it is one
flat fill: `background-color: var(--muxui-semantic-color-neutral-90)` with
`color: var(--muxui-semantic-color-neutral-90-fg)` is light on a dark page and dark on a
light one, because the step and its paired foreground both follow the page's mode.
Mux `Text` sets its own colour, so the text parts reset it with `color: inherit`; the
Mux `Button` keeps its press state and keyboard activation while the rule drops its box,
radius and fill. The Button's focus ring is an outer `box-shadow`, which clips on a block
that spans its frame, so the rule redraws it inset from `--muxui-semantic-focus-inner`,
`--muxui-semantic-focus-ring` and `--bento-focus-ring-width`. A Mux `Popover` is a strong
(inverted) surface by default; a note that opens from such a block overrides it to the
raised surface and default content colour so the block stays the only inverted element.

### Welcome dialog and selectable tiles

The onboarding overlay (`extensions/bento-shell/src/welcome/`) is one controlled,
non-dismissable Mux `Dialog` that keeps its frame and footer across all eight
steps; only the step body changes. Its Bento rules sit in the `bento.components`
layer of `welcome.css`, with one exception: the `.muxui-dialog.bento-welcome`
override (`--bento-welcome-dialog-width` by `--bento-welcome-dialog-height`, 45rem
by 33rem, clamped to the viewport minus `--bento-welcome-viewport-gap`, with its
padding) stays unlayered. Every size local to the overlay is a `--bento-welcome-*`
token declared in `bento-tokens.css` (dialog, text measure, illustration, tour
image, preview, option list, dots); `welcome.css` only references them, and the narrow
window re-points `--bento-welcome-viewport-gap` at
`--bento-welcome-viewport-gap-compact`. Mux's dialog surface sizing is unlayered, so a
layered override would lose to it and the dialog would fall back to the default
30rem modal width. Keep that rule, and any new rule that must beat a Mux dialog
surface property, outside the layer next to the existing comment.

The override also keeps the plain `transform: translate(-50%, -50%)` positioning
instead of letting Mux's entry scale animation run. Mux measures a
`ToggleButtonGroup`'s selected fill once on mount, and measuring inside the
scaled dialog left the fill about 3% too small for its tile. Recheck this after a
Mux upgrade before restoring the entry scale.

Appearance, Privacy, and Search share one selectable surface, `WelcomeOptions`: a
Mux `ToggleButtonGroup` with `selectionMode='single'` and `disallowEmptySelection`
whose `ToggleButton` items Bento lays out as three tiles (Appearance), one column
of rows (Privacy), or a two-column grid in a capped-height list that scrolls when it is long (Search).
`RadioGroup` is not used because its rc.1 options carry no description. Mux owns
selection state, roles, and arrow-key navigation, and a selection is applied at
once. Bento sets the grid, the item content layout (preview, icon, label, tag,
description), and two things on Mux's sliding selected fill: the group's
`--muxui-toggle-button-group-motion-fill` is a subtle surface
(`--muxui-semantic-surface-hover`) so each item's own `Text` colours stay
readable over it, and the fill's corner radius matches the tile's. The selected
tile also gets a strong outline (`--muxui-semantic-border-emphasis`) on
`[data-selected]`. Mux clones the selected item into its motion layer, so the
item rules use descendant selectors rather than child selectors. Do not rebuild
the tiles from clickable `div`s.

A Search item puts its `icon` slot, the label and the tag on one line. The icon is
the engine's favicon as a Mux `Image` with empty `alt` and `fit="contain"` (shown
as shipped, with no chip or background, though some ship white squares), or a
muted `BentoIcon` search glyph when Firefox has none, both in the
`--bento-welcome-source-logo` box so names stay aligned. The item's accessible
name stays the engine name.

Appearance thumbnails are small windows built from Bento markup. Each pane sets
`data-muxui-color-scheme` to `light` or `dark`, so the Light and Dark thumbnails
keep their colours whatever mode the dialog is in; the Auto thumbnail shows a
light and a dark pane side by side. The illustrations on Welcome and Ready are
Mux `Image` with empty `alt`, loading `./welcome/welcome.webp` and
`./welcome/ready.webp` relative to the entry document, since the welcome document
loads from `/dist/welcome.html`. Each tour tile does the same with
`./welcome/workspaces.webp`, `panels.webp` or `command-palette.webp` at
`--bento-welcome-tour-image`, standing directly on the card with no inset well
behind it; the tile's title and body carry the meaning. At the compact breakpoint
the tile switches to a grid template (`image`, `title`, `body`, `chips` areas) and
the illustration drops to `--bento-welcome-tour-image-compact`.

The Theme step does not use `WelcomeOptions`. Its swatches are two single-select
`ToggleButtonGroup`s (one per row, `ThemeChooser`), each `ToggleButton` holding the Mux
`ColorSwatch` the workspace theme picker draws (circle, `brand60` and `neutral20`, the
swatch's own theme scope attributes) at `--bento-welcome-swatch`. Keying is by theme id
rather than a colour picker's colour value, because Default and Harbour share their
colours. Bento declares the group's `--muxui-toggle-button-group-motion-fill` as
transparent and clears the group border and clipping and the button fill, border and
hover background (the Bento layer outranks the Mux layer), so a swatch is just its
colour; the selected one gets a 2px outline ring in `--muxui-semantic-content-default`
and a hovered one `--muxui-semantic-border-strong`. A swatch carries `data-theme-swatch`, and
the wrapper reads that from hover and focus to preview a theme without selecting it.

The preview above the swatches (`ThemePreview`) is one low-fidelity themed window made
of shapes with no text: its root carries the previewed theme's own
`getThemeScopeAttributes` (`data-muxui-theme` and `data-muxui-color-scheme`), so it is
coloured only from public Mux semantic tokens (`surface-canvas`, `surface-background`,
`surface-hover`, `surface-track` for the neutral bars, `border-default`,
`border-subtle`, `content-muted` for the heading bar and toolbar squares,
`action-background` for the button, and `color-color-60` with its `-fg` for the
workspace circle and active tab, as the real tab row uses `--color-60`), and its
theme's sheet must be attached: `ThemeChooser` keeps every theme's sheet loaded with
`useThemeSheets(ALL_THEME_IDS)` while the step shows. Its sizes are four small
tokens (`--bento-welcome-theme-preview-unit`, `-gap`, `-radius`, `-bar`) or `calc()` of
them, with only the skeleton bars' widths in percentages, and the selected swatch's ring
is `--bento-focus-ring-width`; the width is
`min(100%, --bento-welcome-theme-preview-width)` (22.5rem, centred) and the height
`--bento-welcome-theme-preview`, or `-compact` at 48rem and below, where the New row,
toolbar squares and a skeleton bar drop out. Panel and sidebar children are
`flex: none` so a tight preview clips instead of collapsing the bars.

`WelcomeSurfaces.stories.tsx` lays its fixed-width story frames out in the story-only
`WelcomeSurfaces.stories.css`; nothing in that file ships.

At 48rem and below the dialog goes compact: the option and tile grids lose
columns, the tour tiles become rows (illustration left, text beside it, shortcut
chips at the row end), and the footer reflows from three columns (Back, dots,
actions) to a wrapping flex row. The three columns need about 42rem of dialog on the Import step,
where Back, eight dots and the Skip and Import actions sit in two equal side
columns around the dots, so the footer uses the dialog's one existing compact
breakpoint rather than a second one. Compact puts the dots on their own row, then
Back and the actions on the next row, with the actions pushed to the end; when they
do not fit together (about 360px wide) Back takes the row above the actions.

The step dots are a presentational Bento element marked `aria-hidden`. The
visible "Step N of 7" text (steps 1 to 7) is the accessible progress; do not add
roles or labels to the dots.

Motion uses the Mux roles only. The step body enters on `reveal`
(`--muxui-semantic-motion-reveal-transition`) and replays on every step because it
remounts per step. The import source tiles and tour tiles also
stagger: each sets an inline `animationDelay` computed in JS as a
`calc()` of `--muxui-semantic-motion-reveal-transition-duration`, the index, and
a fixed fraction, so no script holds a duration. The delay is inline because a
CSS `calc()` over a per-item custom property failed the motion lint. The
option tiles do not stagger: Mux measures the toggle group's selected fill once on
mount, and animating each tile separately misplaced it, so they move with the
step body. The dots' width and colour use `state`. Under
`prefers-reduced-motion: reduce` the entry animation is opacity only, with no
transform.

The entry slide is a `translateY` of `--muxui-semantic-layout-inset-tiny`, and a
transformed box counts toward scrollable overflow, so the content column
(`overflow-y: auto`) reserves that same token as `padding-block-end`; without it a
scrollbar shows for the length of each step change. Reserve room, do not clip.

While the import wizard is up the dialog takes a `bento-welcome--<state>` modifier
class (`out`, `hidden`, `restoring`, `faded`; `welcome/importHandoff.ts`). Its
content fades out on `dismiss` and back in on `modal`, and the whole dialog
cross-fades on `modal` under reduced motion; the rules are in the same layer as the
rest of `welcome.css`, and the import card in `bento-migration-host.css` takes the
dialog's surface tokens at the dialog's rectangle so the two swap invisibly and then
travels on the `reveal` spring pair, with its content fade-in delayed 160 ms (see the
Motion roles below)
([first-run-import.md](technical/first-run-import.md#import-handoff)).

Import source tiles (`.bento-welcome__source`) are Mux `Button`s, `variant="ghost"`,
so hover, pressed and focus-ring states stay Mux's. The border is Mux's own outline:
the class sets `--muxui-button-border` (`border-strong`, `border-emphasis` on hover),
which wins over the variant's value because Bento's layer sits above `muxui`. The
body is three spans (logo or glyph, name and sub-label, chevron) laid out as a grid
on `> .muxui-button-content`, with `padding-block: 0` and a `--bento-welcome-source-*`
height; `Row` and `Column` are not used inside it because they render divs, which
a button cannot contain. Logos are Mux `Image`s (`fit="contain"`), and a tile whose
logo could not be read shows a `BentoIcon` globe. The placeholder tiles use
`--muxui-semantic-action-neutral-background` (the neutral button fill), not
`surface-track`, which is far lighter than the dialog in dark mode.

### Import host: Firefox buttons and popups

The embedded import host (`bento-migration-host.css`, `bento-migration-wizard-bridge.css`)
is a chrome page around Firefox's `<migration-wizard>`, so it cannot render Mux
components. It maps Firefox's own design tokens onto Mux's public semantic tokens
instead, and the rules for doing it are in
[first-run-import.md](technical/first-run-import.md#host-styling-against-firefoxs-sheets):

- A host button variant (`.bento-button--primary`, `--neutral`) sets Firefox's
  `--button-background-color`, `-hover`, `-active` and `--button-text-color`, `-hover`,
  `-active` and reads them back, because Firefox's `html|button:enabled:hover` outranks
  a one-class hover rule. The primary values are the `--button-*-primary*` mapping in
  the host's `body` block (`--color-60`, `-50`, `-40` and their `-fg` pairs).
- A Firefox popup (the wizard's XUL `<panel>`) takes the Mux popover roles through
  Firefox's `--panel-*` tokens: surface `--muxui-semantic-surface-raised`, border
  `border-popup`, radius `control-radius`, text `content-default`. Rows use
  `surface-hover` with `content-strong` for hover and keyboard focus, `shape-option-radius`,
  `control-size-md` and `layout-inset-tight`/`-small` for geometry. The selected row takes
  `selection-background` (Mux's selected table-row and tree-item surface) with
  `content-link` text (Mux's `selection-track` is 4.1:1 on the dark surface); hover and
  focus on it stack a second `selection-background` and use `content-strong`. The shadow
  stays the native window shadow.
- Do not map Firefox tokens by guessing names: `--panel-background`, `--panel-color` and
  `--panel-shadow` are not read by Firefox, and the `--panel-list-*` tokens paint nothing
  inside a XUL panel. Read the computed value of the element Firefox paints.

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
selectors. The layer order is the `@layer` statement in `theme/muxui.css`; add a
new `bento.*` layer there. Keep global selectors away from semantic elements and overlay
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
total, is above the committed `.legacy-alias-cap.json`. On 2026-10-12 that was 402
uses of 90 aliases in 20 files. The cap is a ratchet like `.size-baseline.json`:
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
- Every alias the shell CSS reads is declared (see "Undefined token reads" below).

### Undefined token reads

`var(--x)` with no fallback is invalid at computed-value time when nothing declares
`--x`, so the property silently falls back to its initial value (a transparent
background, a square corner). `pnpm run lint:tokens` (CI, extensions job) fails when
shell CSS reads such a name. Declared means any `--x:` in the shell CSS (generated
presets and `bento-tokens.css` included) or in the public `@muxui/react`
`styles.css` and `themes.css`; a `var(--x, fallback)` read is allowed, which covers
properties components set from JS. Native chrome CSS under `src/browser` is not
scanned. The same command fails a `bento.*` cascade layer that the root-level
`@layer` statement in `theme/muxui.css` does not list, and layer CSS it cannot
read (see `docs/technical/theming.md`).

When a read names a step that does not exist (the neutral ladder is 5, 10, 12, ...,
100; the radius ladder is none, xs, s, m, l, xl, 2xl, full), take the nearest real
step and prefer its public semantic role over the legacy alias. The former welcome
tray and privacy summary (replaced by the selectable tiles above) used
`--neutral-0`, `--neutral-6` and `--neutral-8`; they were moved to
`--muxui-semantic-surface-background` (neutral-5) and
`--muxui-semantic-surface-raised` (neutral-10), the same surfaces the Mux dialog
and its page use. PanelTrailer favicons used `--radius-2xs`; they now use
`--muxui-semantic-shape-radius-xs`, the smallest radius, as an earlier fix of the
same typo did (`ee95ebe5`).

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

### Motion

Bento defines no motion tokens. Every transition and animation Bento writes, in
shell CSS, chrome CSS (`src/browser/base/content`), inline style strings in the
mount script and React `style` objects, reads the Mux `--muxui-semantic-motion-*`
tokens, so the durations and curves live in one place and a Mux theme can change
them. `pnpm run lint:motion` (CI, extensions job) fails on a raw time, an easing
keyword or function, or a retired `--bento-duration-*` / `--bento-easing-*` read in
those files (scope and limits are in the header of `scripts/check-motion-values.mjs`).

Rules:

1. Reference only `--muxui-semantic-motion-*` tokens. No fallback inside the
   `var()`: an unset token makes the declaration invalid, which means no motion
   rather than a wrong one.
2. Use a role as a pair: the composite `--muxui-semantic-motion-<role>-transition`
   (a duration and its easing) as a `transition` or `animation` value, or the
   matching `<role>-transition-duration` and `<role>-transition-easing` for
   longhands. Never combine one role's duration with another role's easing.
   A role that ships a spring (`reveal` does) also has
   `<role>-transition-spring-duration` with `<role>-transition-spring-easing`, a
   sampled `linear()` spring (reveal: 400 ms, bounce 0). That same-role pair is
   allowed in place of the plain pair, for geometry that should settle like a
   physical object. Time the `state` fades that accompany it from
   `<role>-transition-spring-visual-duration` (reveal: 200 ms, when the spring has
   covered about 97% of the move), not from the 400 ms tail (the import card morph
   below is the deliberate exception). A hide or hand-off
   that must wait for the geometry to finish (a `visibility` step) runs the spring
   duration, tail included.
3. Pick from the roles below. Delays and staggers are `calc()` fractions of the
   token's duration (`calc(var(--muxui-semantic-motion-progress-sweep-duration) / 12)`).
4. Script never copies a duration as a number. Code that has to act when motion ends
   (hide a host after its fade, drop a row after its removal transition) calls
   `afterMotion` (`extensions/bento-shell/src/motion/afterMotion.ts` in the shell,
   `measureMotion`/`afterMotion` in `bento-shell-mount.js`, same contract), which reads
   the time from the element's computed style after the styles that start the motion
   are applied.

Roles (values are the installed Mux rc.1 defaults; they change with Mux, not in Bento):

| Role             | Use in Bento                                                                                                                                                                                                                                                                                                                                                                                                         | Default                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `state`          | Colour, border, shadow, opacity of controls and indicators (hover, focus ring, active marker, workspace fade, sidebar card hover); one stated exception, the sidebar row hover highlight's slide between rows; the palettes' one row highlight sliding between rows (`RowHighlight.css`) and the Settings slider's drawn thumb and fill for key presses and track clicks, not while dragging (`SettingsPalette.css`) | 120 ms, `ease`                                                   |
| `interaction`    | Not used by Bento CSS today (the palettes' row highlight moved to `state`); Mux's own components use it                                                                                                                                                                                                                                                                                                              | 150 ms, `ease`                                                   |
| `reveal`         | Geometry and appearance that follows a layout change: sidebar collapse and expand slide, hidden-sidebar slide-over, panel enter and reorder settles, header collapse, pinned rail, workspace slide, sidebar card enter; its spring pair drives the sidebar Search peek and field, the sidebar collapse, expand and hide push, the hidden-sidebar edge-hover slide-over, and the onboarding-to-import card morph      | 200 ms, `ease-out`; spring pair 400 ms (visual 200 ms), bounce 0 |
| `dismiss`        | Something leaving: tab row removal, panel close fade, startup veil, sidebar card exit                                                                                                                                                                                                                                                                                                                                | 120 ms, `ease-in`                                                |
| `modal`          | Overlay hosts and scrims fading in and out, the address bar popup                                                                                                                                                                                                                                                                                                                                                    | 180 ms, `cubic-bezier(0.16, 1, 0.3, 1)`                          |
| `modal-dismiss`  | Modal exit; Bento fades hosts in and out on `modal` and does not use it today                                                                                                                                                                                                                                                                                                                                        | 120 ms, modal easing                                             |
| `content-resize` | Content that changes size; Bento does not use it today                                                                                                                                                                                                                                                                                                                                                               | 600 ms, `ease`                                                   |
| `progress`       | Progress updates; loops use `progress-spin-duration` (1000 ms), `progress-sweep-duration` (1200 ms) and `progress-travel-duration` (1500 ms) with `progress-easing` (`ease-in-out`) or `constant-easing` (`linear`)                                                                                                                                                                                                  | per token                                                        |

Loops: the panel loading spinner (`spin` with `constant-easing`, dash arc with
`sweep` and `progress-easing`), the startup veil pulse and the tab list shimmer
(`sweep` and `progress-easing`, the second bar staggered by a `calc()` twelfth of
the duration), the audio note particles (`travel` with `constant-easing`; the
reduced-motion variant runs on `spin`).

Pairs that must stay in lockstep use the same role: every part of the sidebar push
(the host, the shell frame's counter-translation, the page group, the bookmarks
toolbar, the divider, Back/Forward/Reload and the band in `bento-shell-mount.css`, and
the hidden sidebar's edge-hover slide-over that follows it) is the `reveal` spring pair
(400 ms, no overshoot), and the strip itself never fades. The rail colour is the one
fade: in a collapse or expand the toolbar's sidebar-side colour (the registered
`--bento-toolbar-left-bg`), the host's background, the chrome divider line (to transparent)
and the host's edge line (opacity) run on the same pair, and the shell's rail-look
backgrounds (`railTransition.css`, only while `data-bento-rail-transition` is present) do
too; a hide, a show, boot, reduced motion and theme changes switch the colour at once. The
footer fades the registered, inherited `<color>` property `--bento-footer-fill` (`app.css`)
rather than its `background-color`, because its backdrop pseudo-element paints the same
property and `background-color: inherit` on a pseudo-element does not follow a transition
through a real-time fade. The workspace slide
(`TabList.css`), the main panel width one-shot and the panel enter are `reveal` too.

The sidebar collapse and expand choreography (`extensions/bento-shell/src/sidebar/railTransition.css`,
the "Cascade" direction) runs inside that push while the shell document stays put and
the strip's edge wipes over it. It animates only `translate` and `opacity`, keyed on
`data-bento-rail-transition` on `<html>`:

- Moves (the workspace avatar, the list region and the scroller as it rises over the
  address bar, the New plus, each tab and folder row and its favicon or icon, the
  active row's retracting tail, the pinned panel rail and the main column's shift, the
  footer buttons, and the footer backdrop that rises with the divider) are the `reveal`
  spring pair at `calc()` 0.6 of its duration, so a staggered move still ends inside
  the slide. A collapse moves to the measured rail places and holds them until the
  rail layout replaces it; an expand starts at them and moves back.
- Fades (the workspace name, the New label, row titles, the switcher's fill and the
  rail square that replaces it, folder outlines, the pinned and folder band, the
  address bar's fold, pinned panels) are the `state` pair. Trailing controls (the
  switcher chevron, Search, row buttons and audio controls, an open search field,
  sidebar cards) leave on the `dismiss` pair in a collapse and return on `state` in an
  expand, after `calc()` 0.3 of the spring duration (titles after 0.15).
- A private window's band takes no part in the moves and fades: its glyph's start inset
  (rail width minus glyph size, halved, from tokens) is the same in both layouts, and its
  text keeps full opacity and starts at the rail's edge, so the strip's edge clips and
  reveals it. Only its slot's stacking is lifted for the phase.
- Staggers are `calc()` fractions of the spring duration in units of 1/32: the
  switcher 0, the address bar and the list 1, New 2, then the rows from 3 by their
  visible position (capped at 11, so the last collapse move ends by 0.95 of the
  spring), and the footer buttons one unit apart, the toggle first in a collapse and
  last in an expand. The header units are fixed in the stylesheet. The row and footer
  delays depend on the scroll position and the phase, and the motion check allows no
  `--bento-*` variable in an animation value, so `railLayout.ts` writes them at the
  phase start as inline `animation-delay: calc(var(--muxui-semantic-motion-reveal-transition-spring-duration) * <fraction>)`
  on each row wrapper, title and trailing group (a row's other parts take the wrapper's
  through `animation-delay: inherit`) and clears them at the end. That is the only
  script-written motion value; it names the Mux token and a literal fraction, never a
  time.
- The end of an expand is `afterMotion` on a timer-only `bento-rail-hold` animation of
  one spring duration on the app root; a collapse ends on the viewport snap, with the
  same animation at twice the spring duration as a fallback.
  The sidebar Search peek group is one `reveal` spring pair: the trigger's width, the
  action highlight's `left` and `width`, the closed field row's `margin-inline-start`
  and `padding-inline-start` (which is also the field's open and close growth) and the
  clear button's open `scale`; the New button follows through flex, and the closed
  overlay's `visibility` hide runs the same spring duration. The closed field row's
  fade waits the spring's visual duration; the other fades stay on `state`.
  The onboarding-to-import card morph (`bento-migration-host.css`) is a `reveal` spring
  pair too: the card's `left`, `top`, `width`, `height`, `border-radius` and
  `border-color`, and its sheen layer's `opacity`, run on the spring duration and easing
  (400 ms, no overshoot). The wizard content fades in on `modal` after a delay of
  `calc()` 0.4 of the spring duration, 160 ms, and out on `dismiss` on the way back.
  The 160 ms delay is deliberately later than rule 2's advice to time accompanying fades
  from the 200 ms visual duration (0.4 of that is 80 ms, what the plain `reveal` pair
  gave before): it was picked from a side-by-side prototype and is kept.

A fraction of a role is `calc()` over its duration token, as a delay or a shorter
phase: the collapse choreography's 0.6 moves and 1/32 staggers above, the import
wizard's 0.4 delay. There is no Bento token for one, and the motion check allows no
`--bento-*` variable in a `transition` or `animation`.

Timing consequences of the default values worth knowing when comparing with an
older build: the workspace slide runs 200 ms (was 260 ms), the focus ring settles in
120 ms (was 350 ms), the sidebar footer cross-fade is gone (the footer buttons move into the rail's column instead), the pinned
rail's `all` transition is 200 ms (was 300 ms), the hidden-sidebar slide-over is
the 400 ms spring (was 200 ms, and 160 ms before that) and the skeleton shimmer is 1200 ms (was 1400 ms).

Chrome-only notes:

- The chrome sheet gets the Mux tokens through `bento-chrome-tokens.css`, so chrome
  CSS and the inline styles in the mount script use the same names. The three overlay
  hosts declared in `browser-box.inc.xhtml` (palette, merge palette, confirm) have no
  inline transition any more: `bento-shell-mount.css` gives them
  `opacity var(--muxui-semantic-motion-modal-transition)`. Hosts the mount script
  creates carry the same value inline.
- `--drag-drop-transition-duration` (a Firefox custom property used by customize
  mode) is set to `--muxui-semantic-motion-reveal-transition-duration`.
- Keep property names literal in inline strings: the drag code checks
  `style.transition.includes('transform')`.
