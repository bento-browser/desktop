# CLAUDE.md — Bento Browser

Reference docs: see [docs/core-functionality.md](docs/core-functionality.md)
for the product vision, [docs/core-functionality-technical.md](docs/core-functionality-technical.md)
(an index of the topic files under [docs/technical/](docs/technical/))
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

## Agent skills

Repo-scoped agent skills live in `.agents/skills/` (`.claude/skills` links to
it). Each `SKILL.md` owns its step-by-step procedure:

- `bento-upgrade-firefox`: upgrade, assess, or repair the Firefox engine version.

## Backticks inside JS template literals

Chrome layout CSS is not written in JS. It is the static sheet
[src/browser/base/content/bento-shell-mount.css](src/browser/base/content/bento-shell-mount.css),
linked by `injectChromeStyles()` in
[src/browser/base/content/bento-shell-mount.js](src/browser/base/content/bento-shell-mount.js)
and registered in `browser/base/jar.mn`. Add new chrome rules there, not in a template literal.

The rule below still applies to any CSS/HTML you build in a JS template literal (a backtick string),
such as the inline `style.cssText` strings that remain in the mount script. **Never use backticks in
the embedded content**, because they terminate the template literal early and produce confusing TS/JS
syntax errors that are easy to misdiagnose. This hazard is why the chrome stylesheet was moved out of the
mount script, where it had repeatedly broken the whole script.

Bad — backticks around the word `order` end the outer template literal:

```js
el.style.cssText = `
  /* Firefox's flex `order` property */
  order: 0;
`;
```

Good — use single quotes inside CSS comments:

```js
el.style.cssText = `
  /* Firefox's flex 'order' property */
  order: 0;
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
Firefox version and source digest are configured in `bento.json`. Bento's
build driver owns the lifecycle around Mozilla's `mach` entry point; Bento
specific behavior belongs in Bento wrapper scripts. The UI shell ships as two
privileged built-in extensions:

- **bento-shell** — React + Mux UI and Bento primitives, the visible chrome
  (vertical tabs, workspaces, panels, command palette).
- **bento-tools** — plain TypeScript background logic (tab/keyboard/persistence).

The Firefox surface Bento touches is kept as small as practical so security-patch adoption stays fast. It consists of the supported chrome surfaces listed under Contributor guardrails (the mount script and its overlays, the actors, the experiments, and the ordered patch stack in `patches/series.json`); do not add a new kind of surface. The architecture is documented in the plan; this file captures only the rules contributors must not violate.

Architectural simplicity is a project constraint. Bento's core functionality should stay concentrated in the privileged extensions and the smallest practical Firefox core surface. Agents working on features must first ask whether the behavior can be implemented in `bento-shell`, `bento-tools`, or the existing chrome bridge before editing Firefox core. Firefox security and feature updates should remain relatively trivial because Bento touches limited, explicit Firefox core surfaces.

When a feature requires iterating on Firefox core to achieve Bento functionality, record the touched vanilla Firefox surface in [docs/firefox-core-touchpoints.md](docs/firefox-core-touchpoints.md) in the same change. Future Firefox updates must review that file, call out upstream conflicts or regressions, and address them before treating the update as complete.

## Core functionality documentation

[docs/core-functionality.md](docs/core-functionality.md) is the maintained source for
Bento Browser's core functionality and UX, and may be used later for marketing
material.

[docs/core-functionality-technical.md](docs/core-functionality-technical.md) is the
index of the maintained technical companion for how the working core functionality
is achieved and which pitfalls must be preserved against regressions. The notes
themselves live in topic files under [docs/technical/](docs/technical/); the index
lists each one with its scope.

When adding, removing, or changing user-visible functionality:

1. Update `docs/core-functionality.md` in the same change.
2. Record new features in that document once they are implemented or intentionally committed to the product surface.
3. Amend existing feature descriptions when behavior, wording, scope, or UX changes.
4. Remove features from that document when they are removed from the product or no longer reflect current behavior.
5. Keep the document factual and product-facing; do not describe implementation details unless they affect user-visible capability or UX.

When adding, removing, or changing working core implementation behavior:

1. Update the topic file under `docs/technical/` that covers the change, in the same change (see the table below). Add a new topic file, and its entry in `docs/core-functionality-technical.md`, only when no existing file fits.
2. Document the source-of-truth store, chrome bridge, renderer path, persistence path, and manual verification surface affected by the change.
3. Record newly discovered regressions and their fixes as pitfalls in the pitfalls section of that topic file.
4. For future regressions, consult the recorded solutions and pitfalls before implementing a new approach, and reuse the recorded solution unless it is demonstrably unrelated to the current failure.
5. Remove obsolete pitfalls only when the underlying implementation no longer depends on them.
6. Relative links and `#anchors` in `CLAUDE.md`, `README.md`, and `docs/**/*.md` are checked by `pnpm run check:doc-links`; run it after renaming a heading or moving a file.

| Change touches | Topic file in `docs/technical/` |
| --- | --- |
| Shell/tools split, state ownership, stylesheet gate | `architecture.md` |
| Hidden native tabs, titlebar and window controls | `native-tabs-titlebar.md` |
| Inspect in Panel, DevTools panels | `devtools-in-panel.md` |
| Address entry, navigation, autocomplete | `address-entry.md` |
| Privacy levels, search engines | `privacy-search.md` |
| Workspaces, tabs, folders, pinned tabs | `workspaces.md` |
| `PanelStore`, layout tree, panel persistence and actions | `panel-state.md` |
| Welcome flow, first-run and startup import, toolbar scrim | `first-run-import.md` |
| Sidebar footer menu and download buttons | `sidebar-native-surfaces.md` |
| Manual session merge, Settings backups | `session-merge-backups.md` |
| Title IPC, shell bus, bridge bootstrap | `shell-chrome-bridge.md` |
| Overlay documents, tooltip, measuring, overlay transparency | `overlay-documents.md` |
| Command palette, sidebar search, floating address bar | `palettes-and-address-bar.md` |
| `reconcilePanelsSplitView`, split-view shims, progress filters | `chrome-panel-rendering.md` |
| Flat layout geometry, splitters, choosers, subdivisions | `flat-panel-layout.md` |
| Panel cycling, BentoKey actor, favicon navigator, focus rings | `panel-traversal-focus.md` |
| Pinned panels, saved panels, add-panel trailer | `panel-widgets.md` |
| Color mode, themes, tokens, shell bundle | `theming.md` |
| Manual regression checklist, submenu and palette search notes | `manual-regression-areas.md` |

## UI components (Mux UI + Bento primitives)

Migrated React UI uses the public `@muxui/react` API and the shared Bento
primitives under `extensions/bento-shell/src/components/primitives/`. The
published npm package is pinned to an exact version in the dependency lock;
do not add unapproved UI package imports, MCP hooks, or compatibility dependencies.

Before creating or modifying a component:

1. Read `node_modules/@muxui/react/README.md` and the relevant generated
   declaration in `node_modules/@muxui/react/generated/`. The package README
   and generated public declarations are the API authority.
2. Use the root `@muxui/react` export or a documented public subpath. Do not
   import private package files or copy generated package output into Bento.
3. Import `src/theme/muxui.css` once from each entry point. It places the public
   Mux styles in the low-precedence `muxui` layer; keep Bento tokens and the
   generated preset bridge after that boundary. Mux themes are not imported
   there: each non-Default theme is its own `public/themes/<id>.css` sheet that
   `src/theme/themeSheets.ts` loads when a document shows it.
4. Put `data-muxui-theme`, `data-muxui-color-scheme`, and
   `data-muxui-contrast` on the same theme scope. `themeScope.ts` resolves
   persisted aliases and unknown ids at the presentation boundary while the
   tools store keeps the original id.
   Mux-owned states use `data-muxui-state-*`, variants use `data-muxui-variant`,
   and sizes use `data-muxui-size`. Use the public BEM part classes from the
   installed README; RC4 emits no aliases for the former selectors. Keep
   Bento-owned attributes on native elements separate.
5. Build repeated layout and icon behavior with the Bento primitives. Mux
   owns its internal React Aria implementation; Bento composites consume the
   public Mux API or a Bento primitive.
6. Preserve the browser-standard root contract: `1rem = 16px`, external
   `public/boot.js` bootstrap, explicit mode attributes, and the transparent
   site/frame separation. Do not add a remote font import or weaken CSP.
7. Keep component-specific guidance in
   [docs/mux-ui-component-customisations.md](docs/mux-ui-component-customisations.md)
   and update it when a reusable Mux or Bento customization changes.

### Public composition rules

- Use the documented Mux component parts and public props. Do not guess a
  subpart name or pass React Aria props that the Mux declaration does not
  expose.
- Use Bento `Row`, `Column`, and icon adapters for shared layout and icons.
  Keep product-specific composition in the owning component.
- Overlay triggers must use the component's documented trigger part. Do not
  nest a second button inside a trigger that already renders a button.
- Keep global selectors away from semantic elements and overlay internals.
  Scope component rules to the owning class and place them in the appropriate
  CSS layer.
- Use the generated legacy token aliases (`--neutral-*`, `--color-*`,
  `--space-*`, `--radius-*`, `--shadow-*`) only where existing Bento CSS
  requires them. New theme roles should use the public Mux semantic tokens or
  a `--bento-*` token with a clear owner.
- New HTML entry points keep bootstrap logic in the external `public/boot.js`;
  do not add inline scripts that bypass the CSP contract.

## Contributor guardrails and automated checks

- **Layered design system**: generic shell controls use public `@muxui/react` parts; repeated layout/icons use Bento primitives. Semantic structure, host roots, favicon images, skeletons, public `SelectNative` options, product-specific virtualized tab/folder row drag, selection, and context handlers, and the Settings palette's native range slider (a recorded exception: [docs/mux-ui-component-customisations.md](docs/mux-ui-component-customisations.md)) may retain native HTML. Tab/folder structural rows use Bento `Row` and Mux inner controls. Never import `react-aria-components` directly or recreate Mux controls with class names. ESLint checks public import boundaries across shell source and Ladle; it does not ban intrinsic JSX or inspect CSS values. Never CSS-in-JS.
- **Public imports only**: use the root `@muxui/react` export or a documented public subpath. Never import private generated files or a copied registry. `lucide-react` remains per-icon and documented.
- **Mux customisation docs stay current**: any change that adds or changes Bento-specific Mux customisations, token usage patterns, CSS layer/override rules, or reusable component styling conventions must update [docs/mux-ui-component-customisations.md](docs/mux-ui-component-customisations.md) in the same change.
- **Supported chrome surfaces**: Firefox chrome (browser XHTML, `gBrowser`, panels, actors) is reached only through the surfaces below, never from `bento-shell` or `bento-tools` page code. New chrome interactions go through one of them, prefer an existing `bentoChrome.*` method or experiment over a new overlay or patch, and are logged in [docs/firefox-core-touchpoints.md](docs/firefox-core-touchpoints.md).
  - **Mount script and overlays** (`src/browser/`, copied into the Firefox tree by `pnpm run import`): `src/browser/base/content/bento-shell-mount.js` is the chrome-process reconciler. It renders panels through Firefox's split-view machinery, anchors native popups, reads and writes chrome DOM, receives title-IPC from the shell, patches a few Firefox members, and carries the compact firefox-compat probe list. Its siblings are its stylesheets (`bento-shell-mount.css`, the chrome layout rules linked by `injectChromeStyles()`, which also holds the chrome invisible until the tokens, theme, and layout links have a complete sheet; `bento-chrome-theme.css`; and the generated `bento-chrome-tokens.css` and `bento-chrome-themes/`) and the embedded import host (`bento-migration-host.*`, `bento-migration-wizard-bridge.css`).
  - **Actors** (`src/browser/actors/`): `BentoKeyParent` and `BentoKeyChild`, the `BentoKey` JSWindowActor pair registered by the mount script that forwards panel and address shortcuts from web content to chrome; and `BentoShellBusParent` and `BentoShellBusChild`, the shell bus relay that carries private-window and Settings overlay messages (the parent module's hub is what `bentoChrome.*` exposes). All load from `resource:///actors/`, registered by `patches/chrome-layout/04-bento-key-actors.patch`.
  - **Experiments**: `extensions/bento-shell/experiments/chrome-bridge/api.js` (`bentoChrome.*`, which exposes the shell bus hub to the extensions) and `extensions/bento-tools/experiments/` (`bento-privacy`, `bento-external-sessions`) for Firefox services extension code cannot reach: preferences and search engines, and external session files.
  - **Patches** (`patches/`, ordered by `patches/series.json`): `chrome-layout` (host elements, `jar.mn` entries, actor registration), `core-ui` (native tabs and menus, DevTools and focus handling, fullscreen, first-run import, theming), `window-sync` (window tracker and tabbrowser hooks), and `experiments` (build). Keep them small; larger overlays make Firefox bumps harder.
- **firefox-compat registry**: every upstream-private or internal Firefox member the surfaces above depend on (underscore and `on_*` methods, prototype patches, lazy chrome globals, module URLs, chrome DOM ids, event and markup contracts) has an entry in `scripts/firefox-compat-registry.mjs`, a repo-only module that is never shipped. `pnpm run firefox:compat:engine` checks the entries against a Firefox source tree during upgrades. The mount script's `@bento-firefox-compat` section keeps only the compact list of runtime-probable entries (probe `R`) and probes them in each window without calling an accessor or loading a module (`[bento-compat] missing <id>` in the Browser Console; objects not loaded yet count as deferred); a test keeps that list equal to the registry. Add the entry (and its probe-list line when runtime-probable, plus a `bentoCompatNoteNative` call before any patch that replaces the member) in the same change as the dependency and regenerate the table in `docs/firefox-core-touchpoints.md` with `node scripts/check-firefox-compat.mjs --write-docs`.
- **Firefox core touchpoint log**: any feature work that changes or depends on Firefox core files, patches, prefs, or chrome internals must update [docs/firefox-core-touchpoints.md](docs/firefox-core-touchpoints.md) in the same change, including the regression checks future Firefox updates must run.
- **Perf budgets** (a ratchet: CI runs `pnpm run size:check` via [scripts/check-size-budgets.mjs](scripts/check-size-budgets.mjs) and direct file limits in [.size-limit.json](.size-limit.json), and compares every measured gzip size with the committed [.size-baseline.json](.size-baseline.json), measured from a `BENTO_RELEASE=1` build): the check fails when an entry grows past its baseline by more than max(1%, 1 KB) or has no baseline entry, even if it is already over its ceiling; existing overages that do not grow pass, and a shrink prints a note to refresh the baseline. Missing or malformed built assets still fail. `pnpm run size:baseline` refreshes the baseline: it lowers entries that shrank and adds new ones, but refuses to raise an existing entry (exit 1, naming what it refused) unless the PR names it with `pnpm run size:baseline -- --accept-growth <entry path>`, so intended growth shows up explicitly in the committed baseline diff. The ceilings are targets and are still reported: shell cold-start JS < 400 KB gz; palette/address-bar/confirm/edit-workspace/welcome/menu/workspace-palette/merge-palette cold-start JS < 200 KB gz; shell CSS < 40 KB gz. The bento-tools background has no ceiling (an entry in `.size-limit.json` without `limit` is reported as `no target`), but it is still measured and the ratchet applies to it. Other targets: cold-start < 80 ms, tab-switch < 16 ms, sustained 60 fps on panel drag. Tab list virtualized from M1, not M3.
- **State pattern**: `bento-tools` is the source of truth for persistent state. `bento-shell` Zustand stores are downstream mirrors. UI never mutates persistent state directly — dispatch a port message to `bento-tools` instead.
- **No raw design values in component CSS**: components reference public Mux semantic tokens, generated legacy aliases (`--neutral-*`, `--space-*`, `--radius-*`, `--shadow-*`, `--neutral-N-fg`, and similar), or Bento tokens (`--bento-*`). No hex/rgb/hsl colors, no magic dimensions, and no raw durations or easings (see the Motion bullet below). If a reusable value is missing, **add it to [extensions/bento-shell/src/theme/bento-tokens.css](extensions/bento-shell/src/theme/bento-tokens.css) first**, then reference it. The only inline exceptions are CSS conventions (1px hairlines, `0`, `100%`) and explicitly-marked visual patches (e.g. `top: 2px` for optical centering). Active text on a tinted neutral surface uses the paired foreground token for that role, not a raw neutral. Legacy alias uses in shell CSS are capped by `.legacy-alias-cap.json` (`pnpm run lint:aliases`), so new CSS uses public Mux semantic tokens or `--bento-*` tokens. A `var(--x)` with no fallback must name a property something declares (`pnpm run lint:tokens`); otherwise it silently computes to nothing. The same check fails a `bento.*` CSS layer that the top-level `@layer` statement in `theme/muxui.css` does not list, and layer CSS it cannot read (a sheet PostCSS cannot parse, an escaped at-rule name or `@import`, anonymous `@layer` blocks, escaped or non-identifier layer names, `@import` into a `bento` layer).
- **Motion**: Bento defines no motion tokens. Every `transition` and `animation` Bento writes (shell CSS, chrome CSS under `src/browser/base/content`, inline style strings in `bento-shell-mount.js`, React `style` objects) reads only `--muxui-semantic-motion-*`, with no fallback in the `var()`. Use a role as a pair: the composite `--muxui-semantic-motion-<role>-transition`, or for longhands the matching `<role>-transition-duration` and `<role>-transition-easing`, or a role's spring pair `<role>-transition-spring-duration` with `<role>-transition-spring-easing`; never one role's duration with another role's easing. Allowed roles are `interaction`, `state`, `reveal`, `dismiss`, `modal`, `modal-dismiss`, `content-resize` and `progress`; loops use `progress-{spin,sweep,travel}-duration` with `constant-easing` or `progress-easing`; delays and staggers are `calc()` fractions of the token duration. Script never mirrors a CSS duration as a number: code that must act when motion ends uses `afterMotion` (`extensions/bento-shell/src/motion/afterMotion.ts` in the shell, `measureMotion`/`afterMotion` in the mount script), which reads the computed style after the motion's styles are applied and pairs the end event with a timer fallback. Role guide: [docs/mux-ui-component-customisations.md](docs/mux-ui-component-customisations.md#motion). `pnpm run lint:motion` rejects raw times and easings in `transition`, `animation` and their longhands.
- **Every layer-2 component ships with a Ladle story file**: any new file under `extensions/bento-shell/src/components/<Name>/<Name>.tsx` must be accompanied by `<Name>.stories.tsx` covering the meaningful visual states (default, active/selected, edge cases like long text or empty state, narrow/wide containers where layout matters). Stories seed Zustand stores via fixtures in [extensions/bento-shell/src/state/**fixtures**/](extensions/bento-shell/src/state/__fixtures__/) — never import `bridge/useToolsPort` from a story. If a fixture doesn't exist for a store the component reads from, add one alongside the existing `tabs.ts` / `workspaces.ts`. Stories are how we iterate visually without rebuilding the whole browser; missing them slows the next person down.
- **Checks CI runs** (`.github/workflows/ci.yml`; run the same commands locally before pushing). CI never builds the application: it runs these checks and a source import, and nothing more. Bento currently targets macOS only, and application builds run locally on the maintainer's Mac.
  - `static-checks` job: JSON and `bento.json` validation; `bash -n` and ShellCheck on `scripts/*.sh`; `node --check` on `prefs/bento.js` and every `.js`/`.mjs` under `src/browser`; `pnpm run lint:repo` (root ESLint over `scripts/`, `src/browser`, and `.agents/` with Node, Firefox system-module, and Firefox chrome-window globals; add a real global to `eslint.config.mjs`, never disable `no-undef`); `pnpm run check:doc-links` (relative links and `#anchors` in `CLAUDE.md`, `README.md`, and `docs/**/*.md`); the `node --test` suites under `scripts/` and `.agents/` (including `scripts/check-firefox-compat.test.mjs`, which fails when the firefox-compat registry, its call sites, the mount script's compact probe list, or its generated table in `docs/firefox-core-touchpoints.md` drift, and `scripts/release-security.test.mjs`); the competitor-reference boundary check; then `bento.json` loads, its Firefox version is well formed and matches `config/firefox-versions.json` (no hard-coded version), and `pnpm run lc`.
  - `security-gate` job: `pnpm run security:check`, `pnpm run release:security-check`, and `pnpm audit --audit-level high`. It installs no dependencies.
  - `extensions` job: typecheck, ESLint, the legacy alias cap (`pnpm run lint:aliases`), the undefined shell token and `bento.*` layer-order check (`pnpm run lint:tokens`, which also rejects layer CSS it cannot read), the raw motion value check (`pnpm run lint:motion`), and the Vitest suites (`pnpm --filter @bento/shell test`, `pnpm --filter @bento/tools test`) for both extensions, then the extension build, the release-shell check (`pnpm run release:security-check:shell`), and the size report.
  - `source-import` job (check name "Source import (linux-x64)"): starts after `security-gate`, `static-checks`, and `extensions` pass. It restores or downloads the pristine Firefox source, runs `pnpm run ext:build` and `pnpm run import`, checks that a second import is idempotent, and runs `node scripts/check-import-output.mjs` and the release-shell check (`pnpm run release:security-check:shell`), which also covers the manifest the import copied into the engine. It stops there: no bootstrap, build, or package. `pnpm run security:check` fails if a workflow or local composite action adds a manual trigger, a native bootstrap, build, or package command (including the package.json scripts that reach one), an artifact upload, or a release step. Cache keys and behavior: [docs/build-tooling.md](docs/build-tooling.md#ci-jobs-and-caches).
  - In `bento-shell-mount.js`, `no-empty`, `no-redeclare`, `no-self-assign`, and the unused-variable and unused-expression rules are warnings tracked for the mount-script split; every other rule is an error.

## Versioning policy

**Official releases stay private until v0.1.0.** Pre-v0.1.0 release builds are for maintainer iteration: do not publish GitHub Releases or link them from the landing page. CI builds no application packages and uploads no application artifacts. Bento currently targets macOS only, and application builds (dev and release) run locally on the maintainer's Mac.

**Concrete rules for agents:**

- **Version bumps stay inside the v0.0.X range.** When bumping `brands.bento.release.displayVersion` in [bento.json](bento.json), increment the patch component only. Do not bump to v0.1.0 or higher without the maintainer's explicit instruction.
- **Only the maintainer flips to v0.1.0.** That cutover enables official public releases, with their signing, notarization, and distribution requirements.
- **Keep v0.0.X builds private.** Do not publish a GitHub Release, push installers to bentobrowser.app, or announce an official release.
- **CI never builds the application.** Do not add a workflow that builds, packages, or uploads the application, or that creates a release. The Linux and Windows build tooling stays in the repository, unexercised by CI, for when those platforms return.
- **The updater stays disabled.** Do not set `updates.enabled` to `true` in [bento.json](bento.json), or publish a MAR or update metadata, until the readiness inputs in `docs/build-tooling.md` ("Updater") exist. The release gate and the build driver refuse it, and builds with the updater disabled produce and collect no MAR or update XML.

## UI dependencies: development and release

Bento consumes the published `@muxui/react@0.1.0-rc.4` npm package. Use its
public `styles.css`, `themes.css`, and documented component exports. Pin the
exact package version; do not use dist-tags, local archives, or working-tree
links in manifests or locks.

Local Mux development never reaches a release. `MUXUI_LOCAL` (set only by the
`shell:*:mux` scripts) swaps in a local Mux checkout for dev loops; release builds
throw on it, and packaging rejects a packaged shell whose `muxui-source.json` stamp
is not `npm`. See [docs/build-tooling.md](docs/build-tooling.md#local-mux-ui).

**Install** — `pnpm install` for the dev loop; `pnpm install --frozen-lockfile`
for CI and release builds (`.github/actions/setup`, `scripts/build-release.sh`):

- `pnpm-lock.yaml` is the only lockfile. It records the exact npm version and
  registry integrity of `@muxui/react`, and a frozen install fails on any drift
  from the manifests. Release builds install the same full graph (the build needs
  the dev tooling), and the SBOM and release security checks read the same file.
  pnpm owns the lockfile format; do not run Prettier on it.
- Dependabot (`.github/dependabot.yml`) opens weekly lockfile-only npm PRs. It
  ignores major versions, `@muxui/react`, and the React Aria and Tiptap families,
  whose pins and overrides change only through the Mux release procedure in
  [docs/build-tooling.md](docs/build-tooling.md).

**When changing UI dependencies**: keep the exact package pin, the approved
shell runtime dependency set in the SBOM generator, required substrate/security
overrides, and the lock aligned. Run a frozen install and the release-security
checks before regenerating the lock, then repeat them against the new graph. The
SBOM verifies the approved npm version and registry integrity offline and
records the lock's integrity digest.

Bento pins React Aria to one compatible graph and aliases it in Vite so menu
providers and consumers share module identity. Tiptap overrides match the
published Mux version (`3.31.4`) and keep its core and peer family aligned on the
patched line. See [docs/build-tooling.md](docs/build-tooling.md) for the release
dependency and source-cache contracts.

**Firefox updates**: always use Bento's protected source-update workflow
(`pnpm run firefox:sync`); never replace `engine/` source directly. For a newer
version than the one in `bento.json`, pass the SHA-256 of
`source/firefox-<target-version>.source.tar.xz` from Mozilla's per-release
`SHA256SUMS` as `BENTO_SOURCE_SHA256`. Before syncing, finish or export patch
work and remove linked engine worktrees (`git -C engine worktree list --porcelain`).
The `bento-upgrade-firefox` skill owns the full procedure.

## Dev loop

Pick the fastest loop for what you're changing.

### A. Pure component design (visual states, props, styling)

```sh
pnpm --filter @bento/shell ladle:serve   # http://localhost:5180
```

Stories live next to components: `src/components/<Name>/<Name>.stories.tsx`. Edit → instant HMR. Use `src/state/__fixtures__/tabs.ts` (or write a similar fixture file) to seed Zustand with fake data — no real `browser.*` API.

To iterate on the local Mux checkout (`~/Projects/muxui/packages/react`) instead of the npm package, run `pnpm run shell:ladle:mux`: it regenerates Mux, serves Ladle, and re-runs generate when Mux inputs change.

### B. Standalone shell preview (full React app, no Firefox)

```sh
pnpm --filter @bento/shell dev   # http://localhost:5179
```

The `bridge/` layer should mock `browser.*` here (M1+ work — not built yet). Until then, this only renders the empty/connecting state.

`pnpm run shell:dev:mux` runs the same server against the local Mux checkout with the same regenerate-on-change watch.

### C. Real Bento iteration (when chrome integration / `browser.tabs.*` / messaging matters)

Launch once with `--jsdebugger` so the Browser Toolbox is open (the dev prefs `devtools.cache.disabled` and `devtools.debugger.prompt-connection` rely on this — set in `prefs/bento.js`):

```sh
engine/obj-bento/dist/Bento.app/Contents/MacOS/bento \
  --new-instance --jsdebugger --profile $(mktemp -d)
```

Every build mode compiles into `engine/obj-bento` (the generated mozconfig sets `MOZ_OBJDIR`), so the path no longer changes with the host OS version. A platform-named `engine/obj-<triple>` directory from an earlier build is not used any more: the first `pnpm run build` compiles from scratch into `engine/obj-bento`, and the old directory can be deleted by hand.

`node scripts/bento-build.mjs objdir` prints the directory mach builds into; `package`, `updates-browser` and `build-release.sh` use only that directory and fail if it does not exist. `dev-launch.sh`, `sync-shell.sh` and `sync-builtin-addon-symlinks.sh` also accept a single legacy `engine/obj-*` build while `obj-bento` does not exist yet, and say so on stderr; several legacy directories are an error. `BENTO_OBJDIR=obj-<name>` changes the name written into the mozconfig at the next build (it must be an `obj-*` directory directly under `engine/`). A `MOZ_OBJDIR` in `configs/` or the root `mozconfig`, or a `MOZCONFIG` pointing at another file, would send mach somewhere else and is rejected.

Build modes: `dev` (the default) and `debug` compile with `--disable-release` (and `--enable-macos-target=11.0` on macOS), so dev binaries do not exercise release codegen; only `release`, which `scripts/build-release.sh` selects, uses `--enable-release`. The mode's options are appended by `scripts/bento-build.mjs`, not set in `configs/common/mozconfig`. Switching modes in `engine/obj-bento` makes mach reconfigure and rebuild; use `BENTO_OBJDIR` for a second tree. Every mode also compiles with `--disable-updater` while `bento.json` `updates.enabled` is `false`. See `docs/build-tooling.md` ("Build modes and configure flags", "Updater") before changing either, and log configure-flag changes in `docs/firefox-core-touchpoints.md`.

Then iterate by what you changed:

| Changed                                                     | Build command                                                                                    | Reload                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `extensions/bento-shell/src/**/*` (React UI, CSS)           | `pnpm --filter @bento/shell build && pnpm run import`                                            | Press **Alt+Shift+R** in Bento (triggers `browser.runtime.reload()` via the dev-reload command) |
| Shell UI only, no theme, chrome token or manifest change    | `pnpm run shell:sync` (shell build, then copy `dist/` into the built app; no import)             | Press **Alt+Shift+R** in Bento                                                                  |
| `extensions/bento-shell/src/background.ts`                  | same                                                                                             | Quit + relaunch (background scripts evaluate once)                                              |
| Local Mux (`~/Projects/muxui`) and the shell UI against it  | `pnpm run shell:import:mux` (Mux generate, type check, shell build, import)                      | Press **Alt+Shift+R** in Bento                                                                  |
| `extensions/bento-tools/src/**/*`                           | `pnpm --filter @bento/tools build && pnpm run import`                                            | Quit + relaunch                                                                                 |
| `patches/`, `src/browser/`, `prefs/bento.js`, `bento.json`  | `pnpm run build` (compile time depends on what mach must rebuild)                                | Quit + relaunch                                                                                 |
| Firefox source/build tooling                                | Follow the update and validation procedure in `docs/build-tooling.md`                            | Quit + relaunch                                                                                 |

To build against local Mux and launch in one step, run `pnpm run dev:mux` (persistent profile) or `pnpm run dev:fresh:mux` (temporary profile). Plain `pnpm run dev` and `dev:fresh` rebuild the shell from the npm package, which overwrites a local-Mux shell build.

> **How the reload works**: `pnpm run import` runs the Bento import wrapper: theme preset sync, chrome token generation, engine-state verification, patch-stack check/reset, source-overlay import, canonical branding and built-in add-on installation, manifest patch application, prefs append, and built-in add-on symlink sync. Built extension files are live on disk immediately after import. `frame.reload()` does **not** force Firefox to re-read `moz-extension://` resources; `AddonManager.reload()` does. If it errors for built-in addons, quit + relaunch is the fallback.

<!-- -->

> **Release builds drop Alt+Shift+R**: the `dev-reload` command and its handler exist only in dev builds. A release build (`BENTO_RELEASE=1`, `BENTO_BUILD_MODE=release`, or `build.mode: "release"` in `bento.json`, resolved by `scripts/build-mode.mjs`, the one resolver the native and extension builds share; `BENTO_RELEASE=1` selects release for both) compiles the handler out of the background bundle and removes the command from the imported manifest. `pnpm run release:security-check:shell` fails if either remains in the staged sources, and a release `package` fails if the object directory's shell add-on still has it. See [docs/build-tooling.md](docs/build-tooling.md#dev-only-reload-command).

> **Manifest changes that need a version bump**: Firefox caches built-in addon metadata (commands, permissions list, name/description) keyed by `version`. A quit+relaunch alone WON'T re-read a changed manifest if the version stayed the same — the cached entry in the profile's `extensions.json` wins. Bump the addon's `manifest.json` version (e.g. `0.1.0` → `0.1.1`) whenever you add/remove/rename a command or change a permission. Code-only changes don't need a bump (background.js / dist/ are read fresh from disk).

`pnpm run build` already chains: `ext:build` → `pnpm run import` → Bento's
`mach build` driver → built-in add-on symlink sync.

`pnpm run brand:regen` is for changes under `branding/bento/**`. It reinstalls the tracked canonical branding through `pnpm run import`.

**Don't run `pnpm run build` on every UI change.** Use the build+import row, or `pnpm run shell:sync` for shell-only edits. Reserve full builds for chrome / engine changes.

What `pnpm run import` costs depends on what changed:

- The patch-stack check validates the series in a scratch Git index instead of a checked-out worktree (with its whitespace and line-ending settings pinned with `git -c`, also for `apply`), and is skipped while `patches/**` and the Firefox base commit match the last passing check (recorded in `.bento/patch-check.json`; `node scripts/firefox-patch-stack.mjs check --force` replays anyway). Measured on the Firefox 154.0 tree (471,508 files): 5.0 to 7.3 s over nine runs for a full validation, 0.5 to 0.65 s when skipped.
- Engine-state hashing runs in-process: 871 recorded files took 0.095 s, against 8.5 s when each file spawned `shasum`.
- Branding, built-in add-on files, `jar.mn`/`moz.build`, prefs, `engine/mozconfig` and the version files are rewritten only when their content changes, so unchanged inputs keep their mtimes. Patched files are still reset and re-applied on every import, so they get new mtimes and mach rebuilds whatever depends on them.
- `engine/mozconfig`, `version.txt` and `version_display.txt` are regenerated by every build, so engine-state verification accepts freshly generated output or the exact bytes recorded at import, rather than only the recorded hash. A build, a mode switch or a `configs/` or `bento.json` change between two imports no longer fails the next `pnpm run import`; hand edits still do.

## Repo crosswalk

- `extensions/` — `bento-shell`, `bento-tools`, and bundled `ublock-origin`. [scripts/install-builtin-addons.mjs](scripts/install-builtin-addons.mjs) performs Bento's runtime-filtered `builtin-addons/` installation.
- `patches/` — git format-patch files applied to Firefox source. Keep small; bigger overlays = harder Firefox bumps.
- `prefs/bento.js` — privacy defaults appended to the engine's branding prefs.
- `bento.json` — canonical Firefox version and source digest, build identity,
  branding, locale, license, and update configuration.
- `.bento/` — local source cache, source state, import manifest, backups, and
  generated engine state.
- **Chrome design tokens**: chrome (Firefox `browser.xhtml`) consumes public
  Mux tokens and the generated Bento legacy bridge via
  `src/browser/base/content/bento-chrome-tokens.css` (gitignored). The file is
  regenerated by [scripts/generate-chrome-tokens.mjs](scripts/generate-chrome-tokens.mjs)
  during import. Use its `--output` option for isolated packaging and proof;
  see [docs/chrome-tokens.md](docs/chrome-tokens.md) for the pipeline.
