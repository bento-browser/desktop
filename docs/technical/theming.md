# Theming and color mode

Part of the [technical notes index](../core-functionality-technical.md).

Workspace theme metadata is stored as `Workspace.themeId`.

Shell theme flow:

- `scripts/sync-theme-presets.mjs` reads public `@muxui/react/themes`
  metadata, its `themes.css` rules, and its `styles.css` projection. All reading
  of Mux's CSS shape and theme list lives in `scripts/mux-css.mjs`, which
  `scripts/generate-chrome-tokens.mjs` shares; it derives the theme list from the
  package (no fixed count) and fails with a message naming the file and block
  when a rule, token or color-scheme pair is missing. It emits
  the shared `theme/presets/index.ts` registry (canonical ids, legacy
  monochromatic aliases), `theme/presets/index.css` (the Default theme and the
  legacy token bridge, imported by every entry), and one sheet per other theme,
  `extensions/bento-shell/public/themes/<id>.css`. Canonical sheets hold that
  theme's `data-muxui-theme` rules inside `@layer muxui`; repo-local custom
  themes are unlayered. All of these are tracked generated files.
- `extensions/bento-shell/src/theme/themeSheets.ts` attaches a theme's sheet as
  a `<link>` (`./themes/<id>.css`) only in documents that show the theme.
  `useWorkspaceTheme.ts` calls `applyRootTheme.ts`, which asks for the active
  workspace theme's sheet and writes `<html data-bento-theme>` (and the other
  scope attributes) once it has loaded,
  so the previous theme stays on screen until the new one can paint and a sheet
  that fails to load falls back to Default. Only an owner's latest request applies:
  a request a newer one replaced resolves `'superseded'` and neither sets
  attributes nor lets the displayed sheet be pruned (A, B, C with B loading first
  keeps A until C applies or fails). Default is inline, so the boot.js attributes
  paint it on the first frame exactly as before. Every component that renders a
  theme scope other than the document's own registers that theme for as long as it
  renders it (`useThemeSheet` / `useThemeSheets`): `PinnedPanels` (each pin uses its
  own workspace's theme), `WorkspaceSwitcher` (the avatar), `WorkspaceThemePicker`
  (the trigger and all 16 swatches) and the `workspace-switcher` overlay (one avatar
  per workspace). `themeScopeSheets.test.ts` fails when a file calls
  `getThemeScopeAttributes` without registering.
- Early sheet request (new windows). The workspace snapshot reaches a new
  window after its theme sheet could already have loaded, so the request starts
  before React mounts:
  - Source: `bento-tools` still owns `Workspace.themeId`. `applyRootTheme.ts`
    mirrors the theme it applied to localStorage `workspace-theme`, beside
    `color-mode` and `resolved-color-mode` (`writeThemeHint` in `themeSheets.ts`).
    It stores the resolved id (an alias or unknown id never reaches it; Default
    is stored as `default`) and writes only once the active workspace has
    reached the document and its sheet has loaded or failed (a failure stores
    `default`). The key is shared by every window of the profile, so the last
    writer wins.
  - Request: `public/boot.js` reads the hint and, for a value that matches
    `^[a-z0-9]+(-[a-z0-9]+)*$` (at most 64 characters, not `default`), inserts
    `<link rel="stylesheet" href="./themes/<id>.css">` into `<head>`, marked
    `data-bento-theme-sheet=<id>` and `data-bento-boot-sheet=loading`. Its own
    `load` and `error` listeners flip the marker to `loaded` or `failed`. The
    root theme attributes stay Default: the sheet may not have loaded by first
    paint. Membership in the theme list is not checked there (boot.js cannot
    import it); a well-formed id with no sheet costs one failed request.
    `public/panel-newtab.html` loads boot.js with `data-bento-no-theme-sheet`
    because it always shows Default and loads no shared stylesheet. Every other
    shell entry HTML loads `boot.js` and calls `useWorkspaceTheme`.
  - Adoption: the first `setThemeSheets` call in a document looks for that link
    and joins it to the normal bookkeeping (one link per theme, owner refcounts).
    A marker of `loaded`, or a sheet whose `cssRules` can be read, counts as
    loaded without waiting for an event that may already have fired. A link still
    loading is awaited through the same `load`/`error` listeners as any other.
    A `failed` link, an id that is not a registered sheet, and `default` are
    removed; the next request for that theme creates a fresh link (the retry).
  - Hold: a synthetic `boot` owner (`BOOT_THEME_OWNER`) keeps the adopted
    sheet, so the empty requests other owners make while the snapshot is still
    pending cannot prune it. `applyRootTheme` releases it as soon as the
    workspace is known: the root request has by then adopted the sheet when the
    theme matches, and a sheet for any other theme is pruned like any
    unreferenced sheet.
  - Cascade: the boot link precedes the shared stylesheet in document order
    (adopted sheets are never moved, because moving a link reloads it). Rule
    precedence does not depend on that: the `muxui` layer is first in either
    order (`theme/muxui.css` and each sheet only append to it, the shared sheet
    still declares `@layer muxui, bento;`), and every theme rule matches with
    three attribute selectors, above the `:root` and `[data-muxui-color-scheme]`
    rules in the shared sheet that set the same custom properties.
    Re-check this when a theme rule gets lower specificity (for example
    `:where()`) or the shared sheet gains a rule of equal specificity for a
    theme property.
- `useToolsPort.ts` includes the active workspace theme id in the active
  `BENTO_PANELS` payload.
- `bento-shell-mount.js` mirrors that payload's theme id to the chrome window
  root through `applyChromeThemeToDocument`, which attaches
  `chrome://browser/content/bento-chrome-themes/<id>.css` and sets
  `data-bento-theme` once it has loaded (see [chrome-tokens.md](../chrome-tokens.md)).

UI color mode flow:

- `BentoSettings.uiColorMode` is the source for shell and chrome UI mode. It
  accepts `light`, `dark`, and `system`; `system` is the user-facing Auto mode.
- `useFirefoxTheme.ts` resolves `system` against
  `(prefers-color-scheme: dark)`, updates shell `<html data-color-mode>` with
  the resolved `light`/`dark` value, and mirrors the stored preference to
  localStorage for pre-React boot. `theme/document-base.css` sets every shell
  page's `color-scheme` from that attribute, so native scrollbars and form
  controls match the UI mode instead of the page's `prefers-color-scheme`,
  which can follow the content color mode (a dark content mode drew the light
  sidebar's scrollbar with the faint dark-scheme thumb).
- `public/boot.js` reads that localStorage value before CSS loads. Explicit
  `light`/`dark` values paint directly; `system` paints from the current OS
  preference; missing values paint the fresh-profile Light default. It reads
  `workspace-theme` the same way (see the early sheet request above).
- Chrome receives `uiColorMode` through `BENTO_PANELS`, resolves `system`
  against the same media query, and applies explicit `data-color-mode` to the
  chrome root. If the settings mirror has not hydrated when the first targeted
  panel sync arrives, the shell forwards the pre-React boot value from
  `data-bento-color-mode-pref` / `data-color-mode`.
- The native Settings page (`about:preferences`) is its own document and links
  `bento-chrome-tokens.css`. Its root carries `data-bento-theme="default"`
  statically and `data-color-mode`, which `preferences.js` copies from the root of
  the window hosting the page (`patches/core-ui/12-center-native-preferences.patch`).
  `applyChromeColorMode` announces every change on the `bento-ui-color-mode`
  observer topic and the page re-reads its host window then, so a Settings tab
  moved to another window (a docshell swap keeps the document) keeps following
  instead of watching the window it first loaded in. A move into a window whose
  mode already differs announces nothing, so the page also re-reads when it
  becomes visible (`visibilitychange`) and on window `focus`. `preferences.css` sets
  `color-scheme` from that attribute so Firefox's own `light-dark()` tokens agree.
  The page's `prefers-color-scheme` does not follow `uiColorMode` (measured: it
  stays light with UI mode dark); it follows the content color mode and the OS.
- `bento-shell-mount.js` seeds chrome `<window data-color-mode="light">` before
  injecting chrome token/theme stylesheets. This matches Bento's fresh-profile
  default and prevents OS-dark chrome from flashing behind the light sidebar
  before the first `BENTO_PANELS` payload arrives.
- During that same startup interval, chrome sets `bento-startup-loading="true"`
  on the root, hides the native navigator toolbox, and shows a chrome-owned
  startup skeleton over the browser area. The skeleton is dismissed after the
  first `BENTO_PANELS` payload applies theme/color/sidebar state, with a timeout
  fallback so a failed sync cannot leave the window covered.
- Auto UI mode must resolve from chrome/sidebar state, not from ordinary
  content tabs. Bento's content color-scheme override can make
  `matchMedia('(prefers-color-scheme: dark)')` return the content preference,
  while chrome resolves Auto against the actual browser/OS theme.
  `useFirefoxTheme` writes `resolved-color-mode` from authoritative shell
  contexts, and native Bento Settings consumes the same durable preference.

Content color mode is separate: `BentoSettings.contentColorMode` is applied by
`bento-tools` through Firefox's content color-scheme browser setting.

Theme authoring and import workflow is documented in [themes.md](../themes.md).

## Shell bundle and stylesheet

- Source of truth: `extensions/bento-shell/vite.config.ts`. All React entries
  share one `style.css` (`cssCodeSplit: false`, Default theme only; the other
  themes are `dist/themes/<id>.css`) and chunk by Rollup's default
  rules. There is no `manualChunks`; `module-identity-guard.ts` fails the build
  when React, React Aria, or `@internationalized` would be bundled from two
  install paths (the cause of the `SubmenuTriggerContext` "is null" defect).
  Keep the `resolve.alias` entries and run the menu/submenu check below after
  any change to chunking or to the Mux, React Aria, or React versions.
- Fonts ship as WOFF2. `woff2-fonts.ts` converts the six TrueType files the Mux
  stylesheet makes Vite emit (2.74 MB) into WOFF2 (1.22 MB) and rewrites the
  `@font-face` sources; `@font-face` stays a local file under `assets/`. It runs
  before `panelNewtabCss`, whose Inter reference is `./Inter_opsz_wght_.woff2`.
  The archived rollback config lists the same plugin order. Brotli at maximum
  quality takes about 5 s for all six fonts, so results are cached under
  `extensions/bento-shell/node_modules/.cache/bento-woff2`. Do not point
  `@font-face` at a remote font.
- `mux-css-prune.ts` removes Mux component rules for families the finished bundle
  never names (`MUX_UNUSED_COMPONENT_CLASSES`: calendar, date pickers, radio,
  switch, slider, toast, tree, multi-select, and similar). See
  [mux-ui-component-customisations.md](../mux-ui-component-customisations.md#pruning-mux-component-css)
  before adding a family. A used family is never pruned, so adding a component to
  Bento needs no change.
- The build targets `firefox150` (`gecko.strict_min_version`) and disables the
  modulepreload polyfill. Sourcemaps stay `mode !== 'production'`; the package
  scripts always build in production mode, so none are emitted.
- Contrast is fixed to `standard`. The shell build strips every rule that
  requires `data-muxui-contrast='more'` (`contrast-more.mjs`, a PostCSS plugin),
  and the theme sync and chrome token generators do not emit them. Do not add
  `contrast='more'` CSS to Bento files while that is true. The plugin leaves
  rules with nested rules alone and turns an emptied `@layer name { }` block into
  `@layer name;`; deleting either would change the cascade for `standard`.
- `public/panel-newtab.html` is a plain page: no script, no Mux stylesheet. The
  `panelNewtabCss` plugin (`panel-newtab-css.ts`, shared with the archived
  rollback Vite config, which has no `panel-newtab` entry) bundles
  `src/panel-newtab/panel-newtab.css` into `assets/panel-newtab.css` with
  esbuild. Run both `build-rollback-variant.mjs <variant> check` actions after
  changing shell entries, because the archived config lists its own entries. Its heading keeps Inter through a
  page-local `@font-face` (weight 650) that points at the Inter file the Mux
  stylesheet makes the build emit into `assets/`; the Vite plugin fails the
  build if that file name stops existing. A hashed or renamed Inter file would
  otherwise silently fall back to the system font.
- `theme/document-base.css` holds the `html`/`body` defaults every entry
  inherits. They used to sit in `panel-newtab.css`, which the shared sheet
  carried into every document, so removing that file's global rules changed the
  sidebar background, the tooltip font, and the root color. When moving or
  deleting CSS that reaches the shared sheet, diff `html` and `body` computed
  styles for every entry in light and dark before accepting the change.
- `shell-document.css` holds the shell page's `html`/`body`/`#root` sizing
  (full height and width, no margin or padding, in `@layer bento.app`). It was
  part of `app.css`; `main.tsx` imports it right before `app.css`, and it still
  reaches every entry's document through the shared `style.css`. `app.css` now
  holds only selectors scoped to the shell's own classes, so Ladle loads it
  from `App.stories.tsx` (only the App stories render the shell layout; where
  the import sits no longer changes the layer order, see the next bullet) and
  never loads `shell-document.css`.
- CSS layer order is declared once, in `theme/muxui.css`: `@layer muxui, bento;`
  and then `@layer bento.tokens, bento.fonts, bento.components, bento.app;`.
  Later layers win, so the shell layout (`bento.app`) outranks the component
  rules (`bento.components`). Every entry's `main.tsx` and the Ladle provider
  import `muxui.css` before any other Bento stylesheet, so the statement is the
  first layer rule in every document. That includes component modules that
  import their own CSS: `components/primitives` loads `BentoStack.css`, so
  `muxui.css` goes above it. A new `bento.*` layer goes in that list;
  without it the layer ranks by whichever file declares it first, which differs
  between the dev server (one `<style>` per CSS module in import order), the
  build (one `style.css` concatenated in chunk order) and Ladle (story load
  order). `pnpm run lint:tokens` fails when a shell stylesheet uses a `bento.*`
  layer missing from that list. It reads each sheet's PostCSS tree (the shell's
  own `postcss` devDependency), so declaration values, strings and comments never
  count as layers. Only a root-level `@layer a, b;` statement in `muxui.css`
  counts as the list, not one inside `@media` or another block, and a statement
  with any invalid name orders nothing. The check rejects layer CSS it cannot read
  instead of guessing: a sheet PostCSS cannot parse, an escape in an at-rule name
  or in `@import` params (`@l\61yer`), an anonymous `@layer { }` block, a layer
  name that is not plain dotted identifiers (an escape or a string can spell
  `bento`), and an `@import ... layer(bento...)`. Keywords match in any case,
  layer names do not, and nested blocks (also through `@media`, `@supports`,
  `@container` and style rules) qualify the names inside them. Chrome CSS under
  `src/browser` is not scanned.
  `panel-newtab.css` does not import `muxui.css` and declares only
  `bento.tokens`.
- Known limit: the dev server (`pnpm --filter @bento/shell dev`) does not
  serve `assets/panel-newtab.css`; preview the page from a built `dist/`.

## Theme pitfalls

- The dev server (`pnpm --filter @bento/shell dev`) once ranked `bento.app`
  below `bento.components` while the build ranked it above. `main.tsx` imports
  `shell-document.css` and `app.css` (both `bento.app`) before `App` pulls in
  the component sheets, and the dev server injects CSS in that import order, so
  `.bento-stack[data-bento-layout='row'] { justify-content: flex-start }` beat
  the footer's `justify-content: flex-end` and the footer icons sat on the left
  in dev only. The build concatenates component chunks first, which hid it.
  Found 2026-10-18; the order statement in `theme/muxui.css` fixes all three
  environments. To check one, walk `document.styleSheets` for
  `CSSLayerStatementRule` and `CSSLayerBlockRule` names in first-declared order
  (expect `bento.tokens`, `bento.fonts`, `bento.components`, `bento.app`), or read
  the first `@layer` declarations of each built CSS asset.
- Every native document that links `bento-chrome-tokens.css` needs
  `data-bento-theme` and `data-color-mode` on its root. The legacy aliases
  (`--neutral-*`, `--color-*`, `--radius-*`, `--shadow-*`, `--space-2xs`) and the
  Mux mode blocks are declared only for elements with those attributes, so an
  attribute-less document computes every alias to nothing. On `about:preferences`
  that left `--background-color-box`, `--border-radius-circle` and every other
  token patch 12 maps onto an alias empty, and the unscoped
  `:root { --space-large: var(--space-2xs) }` (also `--space-medium`, `-small`,
  `-xsmall`, `-xxsmall`) emptied those five Firefox spacing tokens, so cards had
  no fill or radius and every rule that spaces with one of the five lost it.
  `moz-card` padding comes from `--card-padding-*` (`--space-xlarge`), which the
  bridge does not touch, so card padding was unaffected. It came in with the Tale
  to Mux migration, which moved the aliases from `:root` to the attribute scope;
  found 2026-10-12. Disabling the sheet does not show the cause: the aliases
  vanish with it.
- Do not add standalone theme title writes on shell mount. Theme and
  `uiColorMode` must ride together inside `BENTO_PANELS`; otherwise a
  theme-only title can overwrite the first panel sync before chrome reads it.
- Keep Auto mode resolved to explicit `light`/`dark` on DOM roots. Mux UI's
  runtime styling expects `data-color-mode` to carry the rendered mode; the
  stored user preference is mirrored separately as `data-bento-color-mode-pref`.
- Workspace themes are static scoped CSS in per-theme sheets. Do not generate
  runtime style elements for theme switching; attach or swap the sheet.
- Never set a non-Default `data-bento-theme` / `data-muxui-theme` on a root before
  that theme's sheet has loaded: the scope would match no theme rules and paint
  the unscoped Mux palette for a frame. `useWorkspaceTheme` and
  `applyChromeThemeToDocument` set the attribute from the sheet's `load` event.
  A nested scope (avatar, pin, picker swatch) cannot wait, so the component that
  renders it registers its theme (`useThemeSheet`); a new component that renders
  another workspace's theme needs the same, in the component and not only in the
  document entry. Registering only the active workspace's theme leaves a pin from
  another workspace unthemed and lets a workspace switch prune its sheet.
- Waiting for the theme sheet without requesting it early delays the first
  themed paint in new windows. Measured at cold start with a persisted
  non-Default theme, requesting the sheet only after the workspace snapshot
  arrived left the sidebar on Default for 9 to 107 ms after chrome lifted its
  launch veil in 4 of 8 new windows (sheet load 11 to 159 ms). The single
  stylesheet it replaced themed the sidebar 40 to 99 ms before the lift in all 10
  windows measured. Keep the `boot.js` request and the adoption in
  `themeSheets.ts`; do not move the request back behind `useWorkspaceTheme`.
- `boot.js` must not apply the hinted theme's attributes. Only the sheet request
  starts early; the attributes still wait for the sheet through `applyRootTheme`.
  The hint can be stale (another window wrote it last, the theme was removed, the
  workspace theme changed offline), so it must never decide the presentation.
- Do not write the hint or release the `boot` owner before the active workspace
  has reached the document. `useWorkspaceTheme` first runs with a placeholder
  Default; writing `default` then erases the hint for the next document, and
  releasing then lets that placeholder request prune the sheet still loading.
  `useThemeSheet(s)` callers with an empty list prune the same way, which is why
  the hold is an owner and not a flag on the root request.
- Do not wait for the boot link's `load` event alone. It can fire before React
  adopts the link; boot.js's `data-bento-boot-sheet` marker and a readable
  `cssRules` record that. Firefox may expose `link.sheet` while the sheet is still
  loading, so a non-null `sheet` is not proof of a finished load.
- Do not unload a theme sheet before its replacement has loaded, and do not
  remove one an owner still needs. `themeSheets.ts` keeps one link per theme
  while any owner (`root`, or a `useThemeSheet(s)` caller) names it, and keeps an
  owner's displayed sheet until that owner's latest request has loaded. Never
  prune in response to a superseded request finishing: with A shown, B and C
  requested, B finishing first would otherwise drop A while C still loads.
- Canonical sheets keep their rules in `@layer muxui`, after the layer order
  declared in `theme/muxui.css`. An unlayered theme rule would beat Bento's
  component layers. `scripts/mux-css.mjs` (called by `sync-theme-presets.mjs`)
  fails on any `themes.css` rule it cannot assign to one canonical theme and on a
  theme that lacks a light or dark rule.
- Chrome token updates require regenerating/importing the chrome stylesheets
  (`bento-chrome-tokens.css` and `bento-chrome-themes/`); the shell CSS bundle
  alone is not enough. A new Bento theme needs `pnpm run theme:sync` (shell
  sheet) and `pnpm run import` (chrome sheet).
- The archived rollback-final-r2 mount script links only `bento-chrome-tokens.css`.
  The generator folds every theme into that sheet when
  `BENTO_RELEASE_VARIANT=rollback-final-r2` (or `--monolithic`); keep that branch
  while the archive exists.
- A rem token is a different length in chrome (system UI font, 11 px on macOS) and
  the shell (`--font-size-root`, 16 px). The generator pins the rem tokens chrome
  sizes shell-laid-out geometry from (`SHELL_SIZED_TOKENS`: the collapsed rail width
  and the add-panel trailer's button, gap, padding and select widths) in px in the
  chrome sheet, except in the monolithic rollback sheet; see
  [Shell-sized geometry](../chrome-tokens.md#shell-sized-geometry), the rail
  pitfall in [workspaces.md](workspaces.md#workspace-pitfalls), and the trailer
  pitfall in [panel-widgets.md](panel-widgets.md#widget-pitfalls).
- Firefox notification bars (`notification-message`, including the popup-blocked
  banner) are `moz-message-bar`/infobar custom elements with shadow-root CSS.
  `bento-chrome-theme.css` can theme their host and inherited custom properties,
  but it cannot directly remove the default left gradient stripe inside
  `infobar.css`. Keep `patches/core-ui/10-bento-infobar-accent-token.patch` in
  place: it makes the stripe read `--info-bar-accent-background`, and Bento sets
  that token to `none` while using an inverted neutral scheme
  (`--neutral-90` background, `--neutral-5` text/icon, light neutral action
  buttons) so notification bars pop against both light and dark chrome.
