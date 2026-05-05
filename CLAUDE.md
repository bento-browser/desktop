# CLAUDE.md — Bento Browser

Reference docs: see [plans/bento-browser-features.md](plans/bento-browser-features.md) for the product vision and `~/.claude/plans/i-have-created-a-precious-star.md` for the implementation plan and architecture rationale.

## What this project is

Bento Browser is a Surfer-based Firefox 150 fork. The UI shell ships as two privileged built-in extensions:

- **bento-shell** — React + Tale UI, the visible chrome (vertical tabs, workspaces, panels, command palette).
- **bento-tools** — plain TypeScript background logic (tab/keyboard/persistence).

Chrome modification surface is intentionally tiny (~4 patches in M1+M2) to keep Firefox security-patch adoption fast. The architecture is documented in the plan; this file captures only the rules contributors must not violate.

## Tale UI MCP server

A project-scoped MCP server is registered in [.mcp.json](.mcp.json) pointing at Tale UI's own server at `/Users/admin/Projects/tale-ui/core/tools/mcp-server.mjs`. It exposes the `mcp__tale-ui__*` tool family used by the Tale UI consumer workflow below. **Project-scoped MCP servers require one-time user approval on first use in a fresh Claude Code session.**

## UI Components (@tale-ui/react)

This project uses `@tale-ui/react` for all UI components.

Before generating or modifying component code, you MUST:

0. **Plan before generating JSX.** The Tale UI MCP tools are registered as deferred tools — you MUST call `ToolSearch` with `"mcp__tale-ui__plan_ui"` to load the schema before you can invoke them. Then call `mcp__tale-ui__plan_ui` with the UI description. It returns which components to use, a matching recipe if one exists, and key pitfalls — so you choose the right components before writing a single line of JSX. Skip this step only if you are making a trivial single-component change.

1. **Read the setup guide** in `node_modules/@tale-ui/react/README.md` — it contains critical configuration (font-size base, style imports, dark mode, theme overrides) that will produce broken output if skipped.

2. **Check the JSDoc `@example` on each component's .d.ts export** before using it. Every component's Root export includes a `@example` block showing the correct import path, sub-parts, and composition pattern. Read the `.d.ts` file for each component you intend to use:

   ```text
   node_modules/@tale-ui/react/esm/{name}/{Name}.styled.d.ts
   ```

   > **Exception:** A few components use `{Name}.d.ts` (not `.styled.d.ts`): `CSPProvider`, `CheckboxGroup`, `RadioGroup`, `Container`, and `mergeProps`.

   The `@example` block at the top of each file is the authoritative usage reference.

3. **For deeper details** (all props, all variants, advanced patterns), read the local component doc:

   ```text
   node_modules/@tale-ui/react/docs/{name}.md
   ```

4. **Do not guess component APIs.** Always check the `@example` block first. Incorrect usage (wrong sub-part names, missing wrapper components, wrong import paths) causes build failures.

5. **Component pitfalls:** Use `ToolSearch` with `"mcp__tale-ui__get_component"` to load the schema, then call `mcp__tale-ui__get_component` for each component you intend to use — it returns the full pitfall list including anti-patterns and fixes. Cross-component pitfalls (trigger styling, date types, import paths) are surfaced by `mcp__tale-ui__plan_ui` automatically.

### Namespace vs Simple components

**Namespace** (use `<Component.Root>`, never `<Component>` directly):
Accordion, AlertDialog, Autocomplete, Avatar, BadgeGroup, Banner, Breadcrumbs, Calendar, Card, Carousel, Checkbox, ColorArea, ColorField, ColorPicker, ColorSlider, ColorSwatchPicker, ColorWheel, Combobox, ContextMenu, CreditCard, DateField, DatePicker, DateRangePicker, Dialog, Disclosure, Drawer, EmptyState, Field, Fieldset, FileUpload, GridList, HeaderNav, ImageCropper, Input, InputGroup, InputTags, List, Menu, Menubar, Meter, MultiSelect, NavigationMenu, NumberField, Pagination, PaymentInput, PinInput, Popover, PreviewCard, ProgressBar, ProgressCircle, QRCode, Radio, RangeCalendar, ScrollArea, SearchField, Select, Sidebar, Slider, Switch, Table, Tabs, TagGroup, TagSelect, TextArea, TextEditor, TextField, TimeField, Toolbar, Tooltip, Tree, VideoPlayer.

**Simple** (direct use, no `.Root`):
AppStoreButton, BackgroundPattern, Badge, Button, CSPProvider, CheckboxGroup, ColorModeToggle, ColorSwatch, Column, Container, DotIcon, DropZone, FeaturedIcon, FileTrigger, Form, I18nProvider, Icon, IconButton, Illustration, Image, IphoneMockup, Link, PaginationDot, PaginationLine, RadioGroup, RatingBadge, RatingStars, Row, SectionDivider, SelectNative, Separator, SocialButton, SocialButtonGroup, Spinner, Text, ToggleButton, ToggleButtonGroup, mergeProps.

### General conventions

- **No `JSX.Element` return types or `React.FC`** — plain functions with no return type: `export function MyComponent() { ... }`
- **Token suffixes:** CSS tokens use `-s`/`-m`/`-l`; component `size` props use `-sm`/`-md`/`-lg`
- **Max gap:** `Row`/`Column` `gap` max is `'2xl'` — `'3xl'`/`'4xl'` do not exist
- **Layout:** Use `<Row>` (horizontal flex) and `<Column>` (vertical flex) — import each separately; `Column` is NOT re-exported from `@tale-ui/react/row`
- **Triggers:** Never nest `<Button>`/`<IconButton>` inside overlay triggers — triggers render their own `<button>`. Style with `className="tale-button tale-button--primary tale-button--md"`
- **Imports:** Use per-component import paths — `import { Button } from '@tale-ui/react/button'`, not barrel imports
- **No global styles on semantic HTML** — Tale UI renders `<section>`, `<header>`, etc. internally; global element rules leak into overlays

6. **Charts (separate package):** Install `@tale-ui/charts` and `recharts` separately. Import chart styles via `import '@tale-ui/charts/styles';`. Charts use the same compound parts pattern: `BarChart.Root`, `BarChart.Bar`, etc.

7. **A2UI protocol support (optional):** If this project uses AI agents that render UI via the [A2UI protocol](https://a2ui.org/), install `@tale-ui/a2ui`. It maps A2UI agent messages to Tale UI components. See `node_modules/@tale-ui/a2ui/README.md` or the [integration guide](https://github.com/Tale-UI/core/blob/main/docs/a2ui-integration.md). Quick setup:

   ```tsx
   import { A2UIProvider, A2UISurface } from '@tale-ui/a2ui/renderer';
   import { taleUICatalog } from '@tale-ui/a2ui/catalog';

   <A2UIProvider catalog={taleUICatalog} onAction={handleAction}>
     <A2UISurface surfaceId="main" />
   </A2UIProvider>;
   ```

   Common catalog types include `TextInput`, `TextAreaInput`, `NumberInput`, `SliderInput`, `SearchInput`, and `Progress` in addition to shared layout/content types like `Column`, `Text`, and `Button`.

8. **Dark mode must persist between refreshes.** Every new app must:

   a. Add `class="tale-ui"` and `data-color-mode` to `<html>`:

   ```html
   <html class="tale-ui" data-color-mode="light"></html>
   ```

   b. Include this inline script in `<head>` before any CSS or JS to avoid a flash of wrong theme:

   ```html
   <script>
     (function () {
       var mode =
         localStorage.getItem('color-mode') ||
         (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
       document.documentElement.setAttribute('data-color-mode', mode);
     })();
   </script>
   ```

   c. Use `ColorModeToggle` for the toggle UI — it handles `localStorage` and `data-color-mode` automatically:

   ```tsx
   import { ColorModeToggle } from '@tale-ui/react/color-mode-toggle';

   <ColorModeToggle />;
   ```

9. **Theming with category tokens.** Override component families in one place by setting category tokens on `:root`. These tokens are defined in `@tale-ui/react-styles` and default to the same semantic token values they replace — so changing them shifts the entire family simultaneously:

   ```css
   :root {
     /* Retheme all form field inputs at once */
     --field-bg: var(--neutral-10);
     --field-border-color: var(--neutral-20);
     --field-radius: var(--radius-s);

     /* Retheme all dropdown popups and menus */
     --popup-bg: var(--neutral-12);
     --popup-radius: var(--radius-m);
     --popup-shadow: var(--shadow-l);

     /* Retheme all modal dialogs and drawers */
     --modal-title-color: var(--color-80);
     --modal-backdrop-bg: var(--scrim-strong);

     /* Retheme all progress bars and meters */
     --progress-track-height: 0.4rem;
     --progress-indicator-bg: var(--color-60);
   }
   ```

   **Available category token families:**

   | Family            | Tokens                                                                                                                                                                                                                                                                                                                                                                                                     | Components                                                                                                                     |
   | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
   | `--field-*`       | `--field-min-height`, `--field-padding-block`, `--field-padding-inline`, `--field-border-color`, `--field-radius`, `--field-bg`, `--field-color`, `--field-font-family`, `--field-font-size`, `--field-focus-border`, `--field-focus-glow`, `--field-placeholder-color`, `--field-label-color`, `--field-label-font-size`, `--field-label-font-weight`, `--field-description-color`, `--field-error-color` | Input, Select, Combobox, Autocomplete, SearchField, TextField, DateField, TimeField, PaymentInput + labels/descriptions/errors |
   | `--popup-*`       | `--popup-bg`, `--popup-border-color`, `--popup-radius`, `--popup-shadow`                                                                                                                                                                                                                                                                                                                                   | Select, Combobox, Autocomplete, Menu, ContextMenu, Popover popups                                                              |
   | `--item-*`        | `--item-padding-block`, `--item-padding-inline`, `--item-gap`, `--item-radius`, `--item-color`, `--item-font-size`, `--item-focus-bg`, `--item-focus-color`                                                                                                                                                                                                                                                | All dropdown/menu items                                                                                                        |
   | `--group-label-*` | `--group-label-color`, `--group-label-font-size`                                                                                                                                                                                                                                                                                                                                                           | Section headers in dropdowns/menus                                                                                             |
   | `--modal-*`       | `--modal-title-color`, `--modal-title-font-size`, `--modal-description-color`, `--modal-description-font-size`, `--modal-backdrop-bg`, `--modal-actions-gap`                                                                                                                                                                                                                                               | AlertDialog, Dialog, Drawer                                                                                                    |
   | `--progress-*`    | `--progress-track-height`, `--progress-track-bg`, `--progress-indicator-bg`, `--progress-radius`                                                                                                                                                                                                                                                                                                           | ProgressBar, Meter                                                                                                             |

> **Bento note**: the snippet above is mirrored from [tale-ui's canonical source](/Users/admin/Projects/tale-ui/core/docs/consumer-claude-md-snippet.md). When tale-ui updates that file, re-sync this section. The Bento-specific layered design-system rules below build on top of these base rules — they don't replace them.

## Hard guardrails (ESLint or CI enforce these)

- **Layered design system**: Bento composite components (`extensions/bento-shell/src/components/`) import only from `@tale-ui/react/*` and other composites. Never bare HTML elements. Never `react-aria-components` directly. Never CSS-in-JS.
- **Per-component imports only**: `import { Button } from '@tale-ui/react/button'`. Never `from '@tale-ui/react'` (the barrel). Same rule for `@tale-ui/react-styles` and `lucide-react`.
- **Sole chrome touchpoint**: `extensions/bento-shell/src/experiments/chrome-bridge/api.js` is the ONLY file allowed to reach into Firefox chrome XHTML. New chrome interactions go through new `bentoChrome.*` API methods, not ad-hoc.
- **Perf budgets** (CI fails on regression via [.size-limit.json](.size-limit.json)): shell cold-start JS < 125 KB gz (raised from 80 KB → 120 KB → 125 KB as Hello-Bento, react-aria-components, and the bus + Tale UI Text shared chunks established the realistic floor), settings cold-start JS < 100 KB gz, privacy cold-start JS < 80 KB gz, shell CSS < 24 KB gz (raised from 20 KB after `_primitives.css` plus 8 component stylesheets settled the floor), tools < 30 KB gz, cold-start < 80 ms, tab-switch < 16 ms, sustained 60 fps on panel drag. Tab list virtualized from M1, not M3.
- **State pattern**: `bento-tools` is the source of truth for persistent state. `bento-shell` Zustand stores are downstream mirrors. UI never mutates persistent state directly — dispatch a port message to `bento-tools` instead.
- **No raw design values in component CSS**: components reference Tale UI tokens (`--neutral-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--neutral-N-fg`, etc.) or Bento tokens (`--bento-*`). No hex/rgb/hsl colors, no raw durations/easings, no magic dimensions. If a needed value doesn't exist as a token, **add it to [extensions/bento-shell/src/theme/bento-tokens.css](extensions/bento-shell/src/theme/bento-tokens.css) first**, then reference it. The only inline exceptions are CSS conventions (1px hairlines, `0`, `100%`) and explicitly-marked visual patches (e.g. `top: 2px` for optical centering). Active text on a tinted neutral surface uses the paired `--neutral-N-fg` token, not a raw neutral.
- **Every layer-2 component ships with a Ladle story file**: any new file under `extensions/bento-shell/src/components/<Name>/<Name>.tsx` must be accompanied by `<Name>.stories.tsx` covering the meaningful visual states (default, active/selected, edge cases like long text or empty state, narrow/wide containers where layout matters). Stories seed Zustand stores via fixtures in [extensions/bento-shell/src/state/**fixtures**/](extensions/bento-shell/src/state/__fixtures__/) — never import `bridge/useToolsPort` from a story. If a fixture doesn't exist for a store the component reads from, add one alongside the existing `tabs.ts` / `workspaces.ts`. Stories are how we iterate visually without rebuilding the whole browser; missing them slows the next person down.

## 🔔 Tale UI: development → release migration (DO BEFORE FIRST PUBLIC RELEASE)

**During development**, Tale UI is consumed via pnpm `link:` to `/Users/admin/Projects/tale-ui/core/packages/*`. Source edits hot-reload in Bento. This is intentional — we co-evolve the design system alongside the browser.

**Before producing public installer or auto-update artifacts (.dmg, .exe, .msi, MAR files), the Tale UI dependency MUST switch from local link to a pinned, immutable source.** Pick one:

1. Publish Tale UI to npm at a fixed version. Pin in Bento's `package.json` (`"@tale-ui/react": "1.x.y"`) with the lockfile committed. Use `pnpm.overrides` in Bento's root `package.json` to map `@tale-ui/*` back to the local `link:` for individual developers' machines.
2. Vendor Tale UI as a git submodule at `vendor/tale-ui` pinned to a specific SHA. Update the `link:` paths to point inside the submodule.

**Why this is non-negotiable**: release builds must be byte-reproducible across machines, CI runs, and time. A `link:` to a working tree captures whatever is on disk — uncommitted edits, WIP branches, platform variance — and can't be audited or hotfix-rebuilt. Same reasoning Bento already uses for pinning Surfer by SHA (see [docs/maintaining-surfer.md](docs/maintaining-surfer.md)).

**When to do it**: in the same PR that wires up the release pipeline (likely late M1 or start of M2). If a future session is asked to set up release builds, signing, notarization, or update channels — flag this migration as a blocker before producing the first public artifact.

## Dev loop

Pick the fastest loop for what you're changing.

### A. Pure component design (visual states, props, styling)

```sh
pnpm --filter @bento/shell ladle:serve   # http://localhost:5180
```

Stories live next to components: `src/components/<Name>/<Name>.stories.tsx`. Edit → instant HMR. Use `src/state/__fixtures__/tabs.ts` (or write a similar fixture file) to seed Zustand with fake data — no real `browser.*` API.

### B. Standalone shell preview (full React app, no Firefox)

```sh
pnpm --filter @bento/shell dev   # http://localhost:5179
```

The `bridge/` layer should mock `browser.*` here (M1+ work — not built yet). Until then, this only renders the empty/connecting state.

### C. Real Bento iteration (when chrome integration / `browser.tabs.*` / messaging matters)

Launch once with `--jsdebugger` so the Browser Toolbox is open (the dev prefs `devtools.cache.disabled` and `devtools.debugger.prompt-connection` rely on this — set in `prefs/bento.js`):

```sh
engine/obj-aarch64-apple-darwin25.4.0/dist/Bento.app/Contents/MacOS/bento \
  --new-instance --jsdebugger --profile $(mktemp -d)
```

Then iterate by what you changed:

| Changed                                                     | Build command                                                                                    | Reload                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `extensions/bento-shell/src/**/*` (React UI, CSS)           | `pnpm --filter @bento/shell build && npx surfer import`                                          | Press **Alt+Shift+R** in Bento (triggers `browser.runtime.reload()` via the dev-reload command) |
| `extensions/bento-shell/src/background.ts`                  | same                                                                                             | Quit + relaunch (background scripts evaluate once)                                              |
| `extensions/bento-tools/src/**/*`                           | `pnpm --filter @bento/tools build && npx surfer import`                                          | Quit + relaunch                                                                                 |
| `patches/`, `src/browser/`, `prefs/bento.js`, `surfer.json` | `npm run build` (~15 s — mach build is mostly cached)                                            | Quit + relaunch                                                                                 |
| Surfer fork itself                                          | Push to `Bento-Browser/surfer`, bump SHA in `package.json`, `pnpm install`, then `npm run build` | Quit + relaunch                                                                                 |

> **How the reload works**: `surfer import` symlinks the built extension dist into the compiled app bundle — files are live on disk immediately. `frame.reload()` does **not** force Firefox to re-read `moz-extension://` resources; `AddonManager.reload()` does. If it errors for built-in addons, quit + relaunch is the fallback.

<!-- -->

> **Manifest changes that need a version bump**: Firefox caches built-in addon metadata (commands, permissions list, name/description) keyed by `version`. A quit+relaunch alone WON'T re-read a changed manifest if the version stayed the same — the cached entry in the profile's `extensions.json` wins. Bump the addon's `manifest.json` version (e.g. `0.1.0` → `0.1.1`) whenever you add/remove/rename a command or change a permission. Code-only changes don't need a bump (background.js / dist/ are read fresh from disk).

`npm run build` already chains: `ext:build` → `surfer import` (which also runs `scripts/append-prefs.sh` to keep `prefs/bento.js` in `engine/browser/app/profile/firefox.js` so dev prefs survive) → `surfer build`.

`npm run brand:regen` is for when **branding** assets change (`surfer.json` brand fields, `configs/branding/<brand>/**`). It wipes the engine branding dir and re-imports — slower than `surfer import` alone.

**Don't run `npm run build` on every UI change** — the table above's build+import loop is ~3 seconds. Reserve full builds for chrome / engine changes.

## Repo crosswalk

- `extensions/` — `bento-shell` and `bento-tools`. **Note**: upstream Surfer does NOT auto-bundle this folder. The local Surfer fork (pinned by SHA in [package.json](package.json)) adds the copy step. See [docs/maintaining-surfer.md](docs/maintaining-surfer.md).
- `patches/` — git format-patch files applied to Firefox source. Keep small; bigger overlays = harder Firefox bumps.
- `prefs/bento.js` — privacy defaults appended to the engine's branding prefs.
- `surfer.json` — brand, version, URLs.
- Tale UI lives **outside** this repo at `/Users/admin/Projects/tale-ui/core/`.
