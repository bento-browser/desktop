# Workspace themes

Bento workspaces can each pick a theme — a swap of the `--brand-*`,
`--neutral-default-*`, and `--color-N-fg` CSS variables that re-skins
the entire UI (sidebar, overlays, and Firefox chrome) when that
workspace is active. Bento consumes the curated Standard and Monochromatic
collections from `@tale-ui/themes`; repo-local CSS remains available for the
Bento Default palette and custom developer themes. Users pick a theme in the
Edit Workspace dialog or all-workspaces palette.

This doc covers the developer workflow: generating a theme, importing
it, what the import produces, where it lands at runtime, and how to
troubleshoot.

## Mental model

- The eight **Standard** and seven **Monochromatic** shipped themes are sourced
  from `@tale-ui/themes` metadata and production CSS.
- `scripts/sync-theme-presets.mjs` rewrites the package selectors to Bento's
  `[data-bento-theme="<id>"]` contract and generates
  `theme/presets/index.css` plus `index.ts`.
- A repo-local **Bento/custom theme** is a CSS file at
  `extensions/bento-shell/src/theme/presets/<id>.css`. `default.css` supplies
  Bento's Default option.
- A **workspace** stores a `themeId` string (`extensions/_shared/protocol.ts`).
  Undefined means "use the Default theme" (`default`).
- The **Default theme** is repo-local too:
  `extensions/bento-shell/src/theme/presets/default.css`. Updating it
  does not require changing Tale UI upstream.
- `useWorkspaceTheme()` mirrors the active workspace's `themeId` onto
  `<html data-bento-theme="…">` in every shell document. The sidebar
  also pushes it to the Firefox chrome window via the `BENTO_THEME:`
  document.title sentinel; `bento-shell-mount.js` picks it up and
  copies it to the chrome `<window>` root.
- Both surfaces share the generated theme stylesheet bundle — Vite consumes
  `theme/presets/index.css`, while `pnpm run import` includes that same generated
  artifact in `bento-chrome-tokens.css` for Firefox chrome.

Switching themes is a single `setAttribute` call. No runtime CSS
generation, no `<style>` element churn.

## Generating a custom Bento theme with Scale

The [Tale UI Scale app](file:///Users/admin/Projects/tale-ui/tale-ui/playground/scale)
generates the canonical palette CSS that Bento's converter consumes.

1. From the tale-ui repo:

   ```sh
   cd /Users/admin/Projects/tale-ui/tale-ui
   pnpm --filter scale dev   # opens Scale at http://localhost:<port>
   ```

2. In the Scale UI, pick a brand colour (the `--brand-60` BASE shade).
   Scale auto-derives the 11-stop brand palette.

3. Switch Scale's mode to "neutral" and pick a neutral hue. Scale
   derives the 27-stop `--neutral-default-*` palette (with the
   intermediate 12/14/16/18/22/24/26/28/82/84/86/88/92/94/96/98 stops
   that bento-tokens consumers expect).

4. Click **Copy CSS** in Scale to copy the combined output. Paste it
   into a file you control, e.g. `~/Desktop/sunset.css`.

The CSS shape Scale emits is documented in the
[Scale source](file:///Users/admin/Projects/tale-ui/tale-ui/playground/scale/src/utils.js)
— roughly:

```css
:root {
  --brand-5:  …;
  …
  --brand-100: …;
}

:where(html:not([data-color-mode="dark"])) .tale-ui,
.light .tale-ui {
  --color-60-fg: var(--color-100);
  …
}

@media (prefers-color-scheme: dark) {
  :where(html:not([data-color-mode="light"])) .tale-ui {
    --color-60-fg: var(--color-5);
    …
  }
}

html[data-color-mode="dark"] .tale-ui,
.dark .tale-ui {
  --color-30-fg: var(--color-5);
  …
}

:root {
  --neutral-default-5:  …;
  …
  --neutral-default-100: …;
  --display-color: var(--neutral-default-90);
  --text-color:    var(--neutral-default-90);
  --mono-color:    var(--neutral-default-90);
}
```

## Importing a theme

From the bento-browser repo root:

```sh
pnpm theme:import <id> <path-to-scale.css> [--name "Display Name"]
```

Example:

```sh
pnpm theme:import sunset ~/Desktop/sunset.css \
  --name "Sunset"
```

`<id>` must be lowercase kebab-case (`/^[a-z][a-z0-9-]*$/`). Use
`default` when you want to replace Bento's built-in Default theme. Package ids
and their legacy monochromatic aliases are reserved and cannot be shadowed by a
repo-local theme.

The script ([scripts/import-theme.mjs](../scripts/import-theme.mjs))
does three things:

1. **Writes** `extensions/bento-shell/src/theme/presets/<id>.css`,
   rewriting Scale's selectors so the overrides are scoped:
   - `:root { … }` → `[data-bento-theme="<id>"] { … }`
   - Light fg overrides → `html[data-bento-theme="<id>"]:not([data-color-mode="dark"]).tale-ui`
   - Dark fg overrides → `html[data-bento-theme="<id>"][data-color-mode="dark"].tale-ui`
   - `@media (prefers-color-scheme: dark)` inner selector → similar compound form
   - Legacy `.light .tale-ui` / `.dark .tale-ui` siblings are dropped
     (Bento uses `data-color-mode`, not those class names)

2. **Runs** `scripts/sync-theme-presets.mjs`, which discovers the new sibling
   CSS file and regenerates `index.css` and `index.ts` alongside the installed
   `@tale-ui/themes` collections. `brand60` and `neutral20` are parsed for the
   split picker swatch.

Re-running with the same `<id>` overwrites the `.css` file and deterministically
regenerates both generated artifacts.

### Updating the Default theme

Default is not a Tale UI upstream edit. Generate CSS in Scale, then run:

```sh
pnpm theme:import default ~/Desktop/default.css \
  --name "Default"
```

That regenerates `extensions/bento-shell/src/theme/presets/default.css`
with `[data-bento-theme="default"]` selectors and updates the first
`BENTO_THEMES` entry's `brand60` / `neutral20` values. Workspaces with
`themeId` unset, cleared, or explicitly set to `default` will use this
theme.

After importing:

```sh
pnpm run import   # regenerate bento-chrome-tokens.css with the new theme
```

This rebuilds the chrome stylesheet so the new theme reaches the
Firefox chrome window too — required if you want the URL bar /
tabstrip / titlebar to re-skin alongside the shell.

## Picking a theme inside Bento

1. Open the workspace switcher (sidebar trigger).
2. Click **Edit `<workspace>`**.
3. The Edit Workspace dialog shows a **Theme** picker grouped into **Bento**,
   **Standard**, and **Monochromatic** sections. Search matches collection,
   theme name, id, and package description. Each tile shows a circular split swatch:
   the brand colour (`--brand-60`) and pale surface neutral
   (`--neutral-default-20`) read as a mini preview of the themed UI. Save.

Saving persists the change to `bento.workspaces` storage and the active shell +
chrome re-skin atomically.

Each workspace's row in the switcher menu shows that workspace's
theme via the avatar tint, so you can identify workspaces at a glance.

### Auto-rotated themes on new workspaces

Clicking **+ New workspace** in the switcher menu auto-assigns a theme
from a rotation list ([`THEME_ROTATION`](../extensions/bento-shell/src/workspace-switcher/main.tsx)).
The rotation picks the first non-default theme that isn't already in
use, then round-robins once every theme has been claimed at least
once. The first workspace at fresh-profile boot ("Personal") keeps the
Default theme — only workspaces created from the menu rotate.

All shipped package themes participate in the rotation. A custom theme imported
via `pnpm theme:import` joins automatically because the rotation reads from
`BENTO_THEMES` minus Default.

Existing workspaces created before this rotation was in place keep
whatever `themeId` they were saved with (typically undefined → Default
appearance). Edit them via the Edit Workspace dialog if you want them
visually distinct without recreating.

## Hand-authoring a theme (without the script)

If you need finer control than Scale offers (e.g. matching an
existing brand exactly), you can author a repo-local preset by hand. Use
[default.css](../extensions/bento-shell/src/theme/presets/default.css) as the
local template; shipped Standard and Monochromatic CSS remains owned by
`@tale-ui/themes`.

Minimum required structure:

```css
[data-bento-theme='<id>'] {
  --brand-5:   …;
  --brand-10:  …;
  …
  --brand-100: …;
}
```

That alone re-skins the accent (`--bento-workspace-accent`, which
derives from `--color-60`, which aliases `--brand-60`).

Add the neutral palette for a full UI re-skin:

```css
[data-bento-theme='<id>'] {
  --neutral-default: var(--neutral-default-60);
  --neutral-default-5: …;
  --neutral-default-10: …;
  --neutral-default-12: …;
  /* full 27-stop ladder, see the generated presets/index.css */
  --neutral-default-100: …;
  --display-color: var(--neutral-default-90);
  --text-color: var(--neutral-default-90);
  --mono-color: var(--neutral-default-90);
}
```

Add fg overrides if your brand-60 doesn't pass contrast with Tale
UI's default `--color-60-fg`:

```css
html[data-bento-theme='<id>']:not([data-color-mode='dark']).tale-ui {
  --color-60-fg: var(--color-100);
  --color-70-fg: var(--color-100);
}

html[data-bento-theme='<id>'][data-color-mode='dark'].tale-ui {
  --color-30-fg: var(--color-5);
  --color-40-fg: var(--color-5);
  --color-50-fg: var(--color-5);
}

@media (prefers-color-scheme: dark) {
  html[data-bento-theme='<id>']:not([data-color-mode='light']).tale-ui {
    /* Mirror the explicit-dark block here so the theme still reacts
       to the OS preference when the user hasn't pinned light mode. */
    --color-30-fg: var(--color-5);
    --color-40-fg: var(--color-5);
    --color-50-fg: var(--color-5);
  }
}
```

Run `pnpm run theme:sync` to regenerate `index.css` and `index.ts`, then
`pnpm run import` to regenerate `bento-chrome-tokens.css`.

## Token surface

A theme can override:

| Token family          | Stops                                                                                                      | Effect                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `--brand-N`           | 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100                                                                 | Accent palette. Tale UI aliases `--color-N` to `--brand-N`, so this also retunes Bento's workspace accent. |
| `--neutral-default-N` | 5, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 40, 50, 60, 70, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100 | Neutral palette. Drives sidebar bg, text colour, dividers, etc.                                            |
| `--color-N-fg`        | per-stop, light + dark                                                                                     | Foreground contrast pairs against brand backgrounds (e.g. text on `--color-60`-tinted buttons).            |
| `--display-color`     | single                                                                                                     | Top-level heading colour alias.                                                                            |
| `--text-color`        | single                                                                                                     | Body text colour alias.                                                                                    |
| `--mono-color`        | single                                                                                                     | Mono / code text colour alias.                                                                             |

A theme does **not** need to override every token in a family — Scale
emits the full ladder, but a hand-authored theme can supply only the
slots it wants to change and let the others fall back to Tale UI
defaults via inheritance.

## How it works (under the hood)

For maintainers — skip this if you're just adding themes.

### Shell side

- Every shell entry (`main.tsx`, `palette/main.tsx`, `confirm/main.tsx`,
  `settings/main.tsx`, `welcome/main.tsx`, `workspace-switcher/main.tsx`,
  `menu/main.tsx`, `edit-workspace/main.tsx`) imports
  `theme/presets/index.css`. The generated file contains the adapted
  `@tale-ui/themes` CSS plus any repo-local presets, so every scoped rule ships
  in every shell bundle.
- `useWorkspaceTheme()` ([theme/useWorkspaceTheme.ts](../extensions/bento-shell/src/theme/useWorkspaceTheme.ts))
  subscribes to the active workspace via the existing Zustand store
  and calls `document.documentElement.setAttribute('data-bento-theme',
themeId ?? 'default')`. Flipping that attribute swaps which scoped
  rules apply across the document.
- The sidebar (`App.tsx`) passes `pushChrome: true` so the hook also
  writes a `BENTO_THEME:<ts>:<themeId>` sentinel to `document.title`.
- The workspace switcher menu avatars set `data-bento-theme` on each
  avatar element so even non-active workspaces' rows show their own
  theme colour (otherwise CSS inheritance bleeds the active theme
  down into every avatar).

### Chrome side

- [scripts/generate-chrome-tokens.mjs](../scripts/generate-chrome-tokens.mjs)
  reads generated `presets/index.css` into the chrome-side
  `bento-chrome-tokens.css`. The existing
  `rewriteHtmlToRoot` regex converts bare `html` selectors to `:root`
  so the chrome `<window>` element matches.
- [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)
  injects that stylesheet at boot, then polls the shell sidebar's
  `document.title`. When it sees `BENTO_THEME:`, `handleThemeTitle`
  copies the `themeId` onto chrome's `documentElement[data-bento-theme]`.

### Why this shape

- Static CSS scoped by attribute = atomic theme switch via
  `setAttribute`, no runtime CSS string construction.
- IPC payload is just the `themeId` (~20 bytes), not the rendered
  CSS (~3 KB), so the title-sentinel channel stays cheap.
- Shell and chrome share one generated artifact. Package upgrades refresh
  shipped themes through `pnpm run theme:sync`; adding a custom theme is one
  `pnpm theme:import` + one `pnpm run import`.
- `@media (prefers-color-scheme)` and `[data-color-mode]` selectors
  work natively because the CSS is static — no need to re-render on
  mode flip.

### The per-element re-link rule (non-obvious cascade quirk)

CSS custom properties inherit as their **resolved** values, not as
unresolved `var()` references. So this naive setup _doesn't work_ for
per-element themes:

```css
:root {
  --color-60: var(--brand-60); /* declared on :root */
  --accent: var(--color-60); /* declared on :root */
}
[data-bento-theme='teal'] {
  --brand-60: #1dccb8;
}

.avatar {
  background: var(--accent);
}
```

When `<html data-bento-theme="rosewater">` and `<span class="avatar"
data-bento-theme="teal">`:

1. `--accent` is declared only on `:root`. Computed at `:root`, it
   resolves via `--color-60` → `--brand-60` → rosewater's hex (since
   html matches `[data-bento-theme="rosewater"]`).
2. The avatar inherits `--accent` from `:root` as the already-resolved
   rosewater color. The avatar's local `--brand-60: #1dccb8` never
   reaches `--accent`.

To fix, the chain must be redeclared _at the element_:

```css
[data-bento-theme] {
  --color-60: var(--brand-60);
  --bento-workspace-accent: var(--color-60);
}
```

With this rule, any element carrying a `data-bento-theme` attribute
gets local declarations for the whole chain. Substitution now happens
_at the element_, picking up the local `--brand-60` from the theme
preset.

This rule lives in [bento-tokens.css](../extensions/bento-shell/src/theme/bento-tokens.css)
alongside the root `--bento-workspace-accent` declaration. If you add
new derived tokens that should re-resolve per-theme (e.g. `--card-bg:
var(--brand-10)`), add them to the `[data-bento-theme]` block too.

## Removing or renaming a theme

There is no `pnpm theme:remove` script. Only repo-local custom themes can be
removed independently:

1. Delete `extensions/bento-shell/src/theme/presets/<id>.css`.
2. Run `pnpm run theme:sync`.
3. Run `pnpm run import` to drop the rules from `bento-chrome-tokens.css`.

Shipped Standard and Monochromatic themes are controlled by the pinned
`@tale-ui/themes` version and are not edited in Bento.

Workspaces still carrying the deleted `themeId` will fall back to the
Default theme at runtime (see `getThemeMeta` in
[presets/index.ts](../extensions/bento-shell/src/theme/presets/index.ts)).

Renaming is delete + import with the new id; persisted workspace data
keeps the old id, so users need to re-pick the theme in Edit Workspace.

## Troubleshooting

**The new theme doesn't show up in the picker.**
Run `pnpm run theme:sync`, then open
`extensions/bento-shell/src/theme/presets/index.ts` and confirm the generated
metadata entry is present. A package-resolution error means the local Tale UI
build or registry install is incomplete.

**The picker shows the theme but selecting it changes nothing.**
Run `pnpm run theme:sync` and check `presets/index.css` for the theme's
`[data-bento-theme]` selector. Then check the dev server / built bundle — Vite's
CSS pipeline may have a stale cache; restart
`pnpm --filter @bento/shell dev` or rebuild.

**Shell re-skins but chrome stays default.**
You haven't re-run `pnpm run import` since adding the theme. The
chrome stylesheet (`bento-chrome-tokens.css`) is rebuilt by
`scripts/generate-chrome-tokens.mjs`, which is wired into the
`import` script. After rebuilding, restart Bento — the chrome
stylesheet is loaded at boot, not hot-swapped.

**Foreground text reads poorly on a tinted button.**
Tale UI's defaults for `--color-N-fg` aren't tuned for your custom
brand. Add explicit `--color-N-fg` overrides under the
`html[data-bento-theme="<id>"]:not([data-color-mode="dark"]).tale-ui`
selector (and the dark + `@media` variants). The generated package section in
`presets/index.css` shows the pattern.

**Workspace avatars in the switcher menu all show the same colour.**
Three things to check, in order:

1. **Do the workspaces actually have distinct `themeId`s?** Open the
   Edit Workspace dialog on each one. If they're all showing the
   Default theme, the rotation hasn't kicked in yet for them — only
   workspaces created via "+ New workspace" after the rotation was
   wired auto-pick a theme. Edit each one and pick a non-default
   theme, or delete + recreate via the menu.
2. **The avatar attribute needs `data-bento-theme={w.themeId ??
DEFAULT_THEME_ID}` explicitly** — without the fallback, undefined
   `themeId` workspaces inherit the document root's theme. Both the
   sidebar trigger
   ([WorkspaceSwitcher.tsx](../extensions/bento-shell/src/components/WorkspaceSwitcher/WorkspaceSwitcher.tsx))
   and the overlay menu
   ([workspace-switcher/main.tsx](../extensions/bento-shell/src/workspace-switcher/main.tsx))
   do this — verify if you've cloned the pattern elsewhere.
3. **The `[data-bento-theme]` re-link rule in
   [bento-tokens.css](../extensions/bento-shell/src/theme/bento-tokens.css)
   must be present.** It re-aliases `--color-N` and
   `--bento-workspace-accent` at every themed element so the cascade
   substitutes locally. Without it, custom-property inheritance
   carries the document-root theme's already-resolved values past
   per-element overrides — see "The per-element re-link rule" above.

**My theme's `--brand-60` is missing from the parser output.**
The script's `--brand-60` regex requires a `#hex` value (3-, 6-, or
8-digit). If Scale emitted a non-hex (`hsl()`, `oklch()`), the parser
won't find the swatch hex. Use a CSS converter to convert the value
to hex and re-import.

## Reference

- Source-of-truth Scale generator:
  [`/Users/admin/Projects/tale-ui/tale-ui/playground/scale/`](file:///Users/admin/Projects/tale-ui/tale-ui/playground/scale/)
- Theme converter script:
  [`scripts/import-theme.mjs`](../scripts/import-theme.mjs)
- Shipped theme source: `@tale-ui/themes`
- Theme artifact generator:
  [`scripts/sync-theme-presets.mjs`](../scripts/sync-theme-presets.mjs)
- Theme presets registry:
  [`extensions/bento-shell/src/theme/presets/index.ts`](../extensions/bento-shell/src/theme/presets/index.ts)
- Shell hook:
  [`extensions/bento-shell/src/theme/useWorkspaceTheme.ts`](../extensions/bento-shell/src/theme/useWorkspaceTheme.ts)
- Chrome bridge:
  [`extensions/bento-shell/src/theme/themeBridge.ts`](../extensions/bento-shell/src/theme/themeBridge.ts)
- Chrome-tokens generator (loads every preset into the chrome
  stylesheet): [`scripts/generate-chrome-tokens.mjs`](../scripts/generate-chrome-tokens.mjs)
- Chrome title-IPC handler: search
  [`src/browser/base/content/bento-shell-mount.js`](../src/browser/base/content/bento-shell-mount.js)
  for `THEME_PREFIX` and `handleThemeTitle`.
