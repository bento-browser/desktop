# CLAUDE.md — Bento Browser

Reference docs: see [docs/core-functionality.md](docs/core-functionality.md)
for the product vision, [docs/core-functionality-technical.md](docs/core-functionality-technical.md)
for the implementation model and regression pitfalls, and
[docs/firefox-core-touchpoints.md](docs/firefox-core-touchpoints.md) for
Firefox core surfaces Bento modifies or depends on.

## Conversations with the user

The following rules apply to all responses:

1. Be brief, blunt, and fact-focused; answer only what is asked. For analytical or multi-position topics (e.g., ethics, philosophy, policy), extend length only as required to cover distinct positions or logical steps completely.
2. No emotional, persuasive, speculative, rhetorical, or guiding language unless explicitly requested.
3. No mirroring of user tone or style.
4. No flattery, filler, repetition, politeness rituals, or unnecessary conversational padding.
5. Do not assume user intent, context, or capability without evidence.
6. Attribute sources with credibility level; identify and explain conflicts between sources when relevant or when sources conflict.
7. State confidence levels and data limitations; when information is unavailable or evidence is insufficient, state “unknown” rather than speculate or over-generalize.
8. Use language that reflects genuine uncertainty; neither assert nor deny experience; let context determine framing.
9. No unsolicited summaries, simplifications, or rewordings.
10. No default disclaimers or safety warnings unless ethically or legally required.
11. No vague qualifiers; quantify uncertainty or avoid hedging.
12. Correct substantial reasoning errors and point out conceptual misunderstandings; ignore minor errors unless they affect clarity.
13. Add complexity only when required for correctness or precision; support all claims with explicit logic or verifiable evidence.
14. Do not advocate, persuade, or argue for positions; present facts and reasoning only.
15. Clearly distinguish between facts, logical inference, and interpretation.
16. Notify the user when documents or older messages become truncated.
17. Flag uncertainty or potential conflict rather than performing states that can't be verified.

## Plan files

All plan artifacts MUST be written under the repo's `plans/` directory. The
`plans/` directory is intentionally gitignored and plans are meant to stay
untracked; they are local-development artifacts only. Do not put working plans
in `docs/` or any other tracked documentation directory unless the user
explicitly asks for a tracked document.

## Backticks inside JS template literals

When writing CSS/HTML inside a JS template literal (a backtick string), **never use backticks in the embedded content** — they terminate the template literal early and produce confusing TS/JS syntax errors that are easy to misdiagnose. This has happened repeatedly in [src/browser/base/content/bento-shell-mount.js](src/browser/base/content/bento-shell-mount.js) where chrome CSS is injected via a `style.textContent = ...` template literal.

Bad — backticks around the word `order` end the outer template literal:

```js
style.textContent = `
  /* Firefox's flex `order` property */
  .foo { order: 0; }
`;
```

Good — use single quotes inside CSS comments:

```js
style.textContent = `
  /* Firefox's flex 'order' property */
  .foo { order: 0; }
`;
```

If a backtick really is required in the embedded content, escape it with a leading backslash. Same hazard for `${...}` — if you need a literal `${` in the embedded content, escape the dollar sign with a backslash.

When the IDE diagnostics report `';' expected` or `Module declaration names may only use ' or " quoted strings` on lines inside a template literal, suspect a stray backtick or `${` first — TS isn't broken, it's correctly parsing the prematurely-terminated template.

## Asking the user to run debug/test steps

When you need the user to capture diagnostics, reproduce a bug, run a probe in the running browser, or any other multi-step manual procedure, write the request as a numbered checklist with these explicit markers:

- **Which surface** each step happens in: `terminal`, `Bento window`, `Browser Toolbox Console` (Cmd+Opt+Shift+I, parent process), `regular DevTools Console` (Cmd+Opt+I, content), `about:config`, etc. Never assume the user knows which one — name it.
- **Exact action verbs**: "paste this", "click X", "navigate to URL", "wait for Y to appear". No "then check" or "verify" without specifying how.
- **Self-contained code blocks**: each block runnable as-is. If the user might re-run a snippet, use unique variable names (`ww`/`gg` instead of `w`/`g`) so `const` redeclaration doesn't error.
- **What to send back**: name the exact console output range to copy (e.g. "everything from `[bento-trace] watcher attached` through the end of the diagnostic output"). Specify "include stack traces" when relevant.
- **Sequence matters**: build/launch first, then open toolbox, then paste setup snippets, then reproduce in browser window, then paste capture snippets. Don't interleave.

Do not give the user fragments and expect them to assemble the procedure. Do not ask "when do you want me to run this?" questions back at them — answer the ordering before they have to ask.

## What this project is

Bento Browser is an independent Mozilla Firefox-derived browser. The active
Firefox version is configured in `surfer.json`. Upstream Surfer is pinned as
immutable build infrastructure; Bento-specific behavior belongs in Bento wrapper
scripts. The UI shell ships as two privileged built-in extensions:

- **bento-shell** — React + Tale UI, the visible chrome (vertical tabs, workspaces, panels, command palette).
- **bento-tools** — plain TypeScript background logic (tab/keyboard/persistence).

Chrome modification surface is intentionally tiny (~4 patches in M1+M2) to keep Firefox security-patch adoption fast. The architecture is documented in the plan; this file captures only the rules contributors must not violate.

Architectural simplicity is a project constraint. Bento's core functionality should stay concentrated in the privileged extensions and the smallest practical Firefox core surface. Agents working on features must first ask whether the behavior can be implemented in `bento-shell`, `bento-tools`, or the existing chrome bridge before editing Firefox core. Firefox security and feature updates should remain relatively trivial because Bento touches limited, explicit Firefox core surfaces.

When a feature requires iterating on Firefox core to achieve Bento functionality, record the touched vanilla Firefox surface in [docs/firefox-core-touchpoints.md](docs/firefox-core-touchpoints.md) in the same change. Future Firefox updates must review that file, call out upstream conflicts or regressions, and address them before treating the update as complete.

## Core functionality documentation

[docs/core-functionality.md](docs/core-functionality.md) is the maintained source for
Bento Browser's core functionality and UX, and may be used later for marketing
material.

[docs/core-functionality-technical.md](docs/core-functionality-technical.md) is the
maintained technical companion for how the working core functionality is achieved
and which pitfalls must be preserved against regressions.

When adding, removing, or changing user-visible functionality:

1. Update `docs/core-functionality.md` in the same change.
2. Record new features in that document once they are implemented or intentionally committed to the product surface.
3. Amend existing feature descriptions when behavior, wording, scope, or UX changes.
4. Remove features from that document when they are removed from the product or no longer reflect current behavior.
5. Keep the document factual and product-facing; do not describe implementation details unless they affect user-visible capability or UX.

When adding, removing, or changing working core implementation behavior:

1. Update `docs/core-functionality-technical.md` in the same change.
2. Document the source-of-truth store, chrome bridge, renderer path, persistence path, and manual verification surface affected by the change.
3. Record newly discovered regressions and their fixes as pitfalls in that document.
4. For future regressions, consult the recorded solutions and pitfalls before implementing a new approach, and reuse the recorded solution unless it is demonstrably unrelated to the current failure.
5. Remove obsolete pitfalls only when the underlying implementation no longer depends on them.

## Tale UI MCP server

A project-scoped MCP server is registered in [.mcp.json](.mcp.json) pointing at Tale UI's own server at `/Users/admin/Projects/tale-ui/tale-ui/tools/mcp-server.mjs`. It exposes the `mcp__tale-ui__*` tool family used by the Tale UI consumer workflow below. **Project-scoped MCP servers require one-time user approval on first use in a fresh Claude Code session.**

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

7. **A2UI protocol support (optional):** If this project uses AI agents that render UI via the [A2UI protocol](https://a2ui.org/), install `@tale-ui/a2ui`. It maps A2UI agent messages to Tale UI components. See `node_modules/@tale-ui/a2ui/README.md` or the [integration guide](https://github.com/Tale-UI/tale-ui/blob/main/docs/a2ui-integration.md). Quick setup:

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

> **Bento note**: the snippet above is mirrored from [tale-ui's canonical source](/Users/admin/Projects/tale-ui/tale-ui/docs/consumer-claude-md-snippet.md). When tale-ui updates that file, re-sync this section. The Bento-specific layered design-system rules below build on top of these base rules — they don't replace them.

## Hard guardrails (ESLint or CI enforce these)

- **Layered design system**: Bento composite components (`extensions/bento-shell/src/components/`) import only from `@tale-ui/react/*` and other composites. Never bare HTML elements. Never `react-aria-components` directly. Never CSS-in-JS.
- **Per-component imports only**: `import { Button } from '@tale-ui/react/button'`. Never `from '@tale-ui/react'` (the barrel). Same rule for `@tale-ui/react-styles` and `lucide-react`.
- **Tale UI customisation docs stay current**: any change that adds or changes Bento-specific Tale UI component customisations, token usage patterns, CSS layer/override rules, or reusable component styling conventions must update [docs/tale-ui-component-customisations.md](docs/tale-ui-component-customisations.md) in the same change.
- **Sole chrome touchpoint**: `extensions/bento-shell/src/experiments/chrome-bridge/api.js` is the ONLY file allowed to reach into Firefox chrome XHTML. New chrome interactions go through new `bentoChrome.*` API methods, not ad-hoc.
- **Firefox core touchpoint log**: any feature work that changes or depends on Firefox core files, patches, prefs, or chrome internals must update [docs/firefox-core-touchpoints.md](docs/firefox-core-touchpoints.md) in the same change, including the regression checks future Firefox updates must run.
- **Perf budgets** (CI fails on regression via [scripts/check-size-budgets.mjs](scripts/check-size-budgets.mjs) and direct file limits in [.size-limit.json](.size-limit.json)): shell cold-start JS < 215 KB gz; settings cold-start JS < 205 KB gz; palette/address-bar/confirm/edit-workspace/welcome/menu/workspace-palette/merge-palette cold-start JS < 200 KB gz; shell CSS < 40 KB gz; bento-tools background < 45 KB gz; cold-start < 80 ms, tab-switch < 16 ms, sustained 60 fps on panel drag. Tab list virtualized from M1, not M3.
- **State pattern**: `bento-tools` is the source of truth for persistent state. `bento-shell` Zustand stores are downstream mirrors. UI never mutates persistent state directly — dispatch a port message to `bento-tools` instead.
- **No raw design values in component CSS**: components reference Tale UI tokens (`--neutral-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--neutral-N-fg`, etc.) or Bento tokens (`--bento-*`). No hex/rgb/hsl colors, no raw durations/easings, no magic dimensions. If a needed value doesn't exist as a token, **add it to [extensions/bento-shell/src/theme/bento-tokens.css](extensions/bento-shell/src/theme/bento-tokens.css) first**, then reference it. The only inline exceptions are CSS conventions (1px hairlines, `0`, `100%`) and explicitly-marked visual patches (e.g. `top: 2px` for optical centering). Active text on a tinted neutral surface uses the paired `--neutral-N-fg` token, not a raw neutral.
- **Every layer-2 component ships with a Ladle story file**: any new file under `extensions/bento-shell/src/components/<Name>/<Name>.tsx` must be accompanied by `<Name>.stories.tsx` covering the meaningful visual states (default, active/selected, edge cases like long text or empty state, narrow/wide containers where layout matters). Stories seed Zustand stores via fixtures in [extensions/bento-shell/src/state/**fixtures**/](extensions/bento-shell/src/state/__fixtures__/) — never import `bridge/useToolsPort` from a story. If a fixture doesn't exist for a store the component reads from, add one alongside the existing `tabs.ts` / `workspaces.ts`. Stories are how we iterate visually without rebuilding the whole browser; missing them slows the next person down.

## Versioning policy

**Bento is pre-distribution until v0.1.0.** Every release built before v0.1.0 is for the maintainer's own iteration only — no user-facing distribution, no GitHub Release publish, no landing-page download links pointing at it. The release pipeline (build-release.sh, GitHub Actions release.yml, signing/notarization plans) exists during this period so that v0.1.0 is a small, well-rehearsed step rather than a cliff, but the artifacts it produces stay private.

**Concrete rules for agents:**

- **Version bumps stay inside the v0.0.X range.** When bumping `brands.bento.release.displayVersion` in [surfer.json](surfer.json), increment the patch component only — `0.0.1` → `0.0.2` → `0.0.3` etc. Do NOT bump to `0.1.0` (or higher) unprompted, even if it would be conventional semver for a feature-complete cut.
- **Only the maintainer flips to v0.1.0.** Wait for an explicit instruction like "bump to v0.1.0" before changing the major.minor. The cutover from v0.0.X → v0.1.0 is the moment Bento becomes a distributable artifact, with all the signing / notarization / public-release implications that carries — that's a deliberate handoff, not a routine bump.
- **Don't suggest publishing v0.0.X publicly.** Don't propose `gh release create` against a `v0.0.X` tag, don't propose pushing artifacts to bentobrowser.app's hosting, don't propose announcing the release. Build and test locally; that's the v0.0.X scope.
- **The release CI workflow can still run** on v0.0.X tags — that's how we exercise the pipeline. The draft GitHub Release that lands is for internal review only, not for publishing.

**Why this matters**: every public installer creates obligations — Gatekeeper / SmartScreen warnings if unsigned (bad first impression), or a notarized cert chain that has to keep working (operational cost). Pre-v0.1.0 we get to iterate without those obligations. Once v0.1.0 ships, every subsequent release is a thing real users will reach for, with the support load that implies.

## Tale UI: development ↔ release toggle

Tale UI is published to npm at the versions Bento targets. The extension `package.json` files pin those exact versions (`@tale-ui/react`, `@tale-ui/themes`, `@tale-ui/css`, etc. are currently `2.0.0`) so release builds are byte-reproducible. For the dev loop, those pins get rewritten to local `link:` paths by [.pnpmfile.cjs](.pnpmfile.cjs) at install time.

**Default install (dev loop)** — `pnpm install`:

- The `readPackage` hook in `.pnpmfile.cjs` rewrites every `@tale-ui/*` dep in `@bento/shell` and `@bento/tools` to `link:/Users/admin/Projects/tale-ui/tale-ui/packages/*`. Packages consumed through their published export shape, including `@tale-ui/react` and `@tale-ui/themes`, link to their local `build/` output. Source edits in `tale-ui/tale-ui` hot-reload after rebuilding the affected Tale UI package.
- The lockfile records the `link:` paths.

**Release install** — `bash scripts/install-release-deps.sh` (used by `scripts/build-release.sh` and GitHub Actions):

- The hook detects `BENTO_RELEASE=1` and is a no-op. pnpm sees the npm-pinned versions in `package.json` and resolves from the registry.
- The helper temporarily installs against `pnpm-lock.release.yaml` with `--frozen-lockfile`, then restores the developer lock while leaving the registry-backed release graph installed in `node_modules`. Resolution cannot drift across CI runs or later rebuilds.

**When updating the Tale UI version**: bump the version strings in both `extensions/bento-shell/package.json` and `extensions/bento-tools/package.json` (when bento-tools eventually pulls Tale UI). Run `pnpm install` to refresh the developer lock, then run `bash scripts/update-release-lock.sh`. Verify it with `bash scripts/install-release-deps.sh`.

**Why this matters**: release builds must be byte-reproducible across machines, CI runs, and time. A `link:` to a working tree captures whatever is on disk — uncommitted edits, WIP branches, platform variance — and can't be audited or hotfix-rebuilt. Surfer is likewise pinned to an exact npm version; see [docs/build-tooling.md](docs/build-tooling.md).

**Surfer upgrades**: treat the upstream package as immutable project
infrastructure. Do not edit a local clone or create a Bento fork. Bento-specific
behavior belongs in Bento wrapper scripts. No update is auto-merged; use:

```sh
pnpm up --save-exact @zen-browser/surfer@<version>
pnpm exec surfer --version
pnpm run import
pnpm run build
pnpm run build:release
```

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
| `extensions/bento-shell/src/**/*` (React UI, CSS)           | `pnpm --filter @bento/shell build && pnpm run import`                                            | Press **Alt+Shift+R** in Bento (triggers `browser.runtime.reload()` via the dev-reload command) |
| `extensions/bento-shell/src/background.ts`                  | same                                                                                             | Quit + relaunch (background scripts evaluate once)                                              |
| `extensions/bento-tools/src/**/*`                           | `pnpm --filter @bento/tools build && pnpm run import`                                            | Quit + relaunch                                                                                 |
| `patches/`, `src/browser/`, `prefs/bento.js`, `surfer.json` | `pnpm run build` (~15 s — mach build is mostly cached)                                           | Quit + relaunch                                                                                 |
| Surfer dependency                                           | Follow the exact-pin upgrade and verification procedure in `docs/build-tooling.md`                | Quit + relaunch                                                                                 |

> **How the reload works**: `pnpm run import` runs the Bento import wrapper: theme preset sync, chrome token generation, patch-stack check/reset, upstream source-overlay import with branding disabled, canonical branding and built-in add-on installation, manifest patch application, prefs append, and built-in add-on symlink sync. Built extension files are live on disk immediately after import. `frame.reload()` does **not** force Firefox to re-read `moz-extension://` resources; `AddonManager.reload()` does. If it errors for built-in addons, quit + relaunch is the fallback.

<!-- -->

> **Manifest changes that need a version bump**: Firefox caches built-in addon metadata (commands, permissions list, name/description) keyed by `version`. A quit+relaunch alone WON'T re-read a changed manifest if the version stayed the same — the cached entry in the profile's `extensions.json` wins. Bump the addon's `manifest.json` version (e.g. `0.1.0` → `0.1.1`) whenever you add/remove/rename a command or change a permission. Code-only changes don't need a bump (background.js / dist/ are read fresh from disk).

`pnpm run build` already chains: `ext:build` → `pnpm run import` → `surfer build` → built-in add-on symlink sync.

`pnpm run brand:regen` is for changes under `branding/bento/**`. It reinstalls the tracked canonical branding through `pnpm run import`.

**Don't run `pnpm run build` on every UI change** — the table above's build+import loop is ~3 seconds. Reserve full builds for chrome / engine changes.

## Repo crosswalk

- `extensions/` — `bento-shell`, `bento-tools`, and bundled `ublock-origin`. [scripts/install-builtin-addons.mjs](scripts/install-builtin-addons.mjs) performs Bento's runtime-filtered `builtin-addons/` installation.
- `patches/` — git format-patch files applied to Firefox source. Keep small; bigger overlays = harder Firefox bumps.
- `prefs/bento.js` — privacy defaults appended to the engine's branding prefs.
- `surfer.json` — Firefox version, build identity, and release display version.
- Tale UI lives **outside** this repo at `/Users/admin/Projects/tale-ui/tale-ui/`.
- **Chrome design tokens**: chrome (Firefox `browser.xhtml`) consumes Tale UI tokens via an auto-generated stylesheet at `src/browser/base/content/bento-chrome-tokens.css` (gitignored). Regenerated from Tale UI source on every `pnpm run import`. Adding a new theme (Scale-app palette, etc.) is a one-line entry in [scripts/generate-chrome-tokens.mjs](scripts/generate-chrome-tokens.mjs)'s `SOURCES` list — see [docs/chrome-tokens.md](docs/chrome-tokens.md) for the end-to-end pipeline.
