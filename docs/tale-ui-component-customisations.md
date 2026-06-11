# Tale UI component customisations for Bento

This guide collects the Bento-specific rules for customising Tale UI
components. It is a contributor map, not a replacement for the canonical
agent instructions in [CLAUDE.md](../CLAUDE.md). If the rules drift, update
`CLAUDE.md` first and then mirror the practical guidance here.

## Source of truth

- [CLAUDE.md](../CLAUDE.md) defines the required Tale UI workflow,
  component usage rules, and hard guardrails.
- Tale UI component API examples live in
  `node_modules/@tale-ui/react/esm/{name}/{Name}.styled.d.ts`.
- Deeper component docs live in
  `node_modules/@tale-ui/react/docs/{name}.md`.
- Bento's token layer lives in
  [extensions/bento-shell/src/theme/bento-tokens.css](../extensions/bento-shell/src/theme/bento-tokens.css).
- Workspace theme authoring is covered by [themes.md](themes.md).
- Firefox chrome token plumbing is covered by [chrome-tokens.md](chrome-tokens.md).

## Customisation model

Bento uses Tale UI primitives as the base design system and adds only the
minimum local layer needed for browser-specific surfaces.

Use this order when customising UI:

1. Prefer existing Tale UI props, variants, sizes, and compound parts.
2. For broad family changes, override Tale UI category tokens on `:root`
   such as `--field-*`, `--popup-*`, `--item-*`, `--modal-*`, and
   `--progress-*`.
3. For Bento-wide browser shell values, add or update a `--bento-*` token in
   `bento-tokens.css`, then consume that token from component CSS.
4. For a component-specific layout or state rule, add a scoped selector in
   that component's `.css` file.
5. Use an unlayered rule only when it must beat Tale UI's own unlayered
   component or utility CSS. Document why next to the rule.

## Component rules

Bento composite components under `extensions/bento-shell/src/components/`
build on Tale UI primitives. They should not import bare `react-aria-components`,
use CSS-in-JS, or rely on unstyled semantic HTML as their component base.

Use per-component imports:

```tsx
import { Button } from '@tale-ui/react/button';
import { IconButton } from '@tale-ui/react/icon-button';
import { Row } from '@tale-ui/react/row';
import { Column } from '@tale-ui/react/column';
```

Do not import from the package barrel:

```tsx
import { Button } from '@tale-ui/react';
```

For overlays, do not nest a `Button` or `IconButton` inside a Tale UI trigger.
Tale UI triggers render their own button. Style the trigger with Tale UI
classes when needed:

```tsx
<Menu.Trigger className="tale-button tale-button--primary tale-button--md">Open</Menu.Trigger>
```

Use `Row` and `Column` for flex layout. `Column` is imported from
`@tale-ui/react/column`; it is not re-exported from `@tale-ui/react/row`.

Avoid global rules against semantic elements such as `section`, `header`, and
`button`. Tale UI renders semantic elements internally, and global selectors can
leak into dialogs, menus, and popovers.

## Token rules

Component CSS must use Tale UI tokens or Bento tokens:

```css
background: var(--neutral-10);
color: var(--neutral-90);
border-color: var(--bento-sidebar-divider-color);
border-radius: var(--radius-s);
box-shadow: var(--shadow-m);
```

Do not introduce raw colors, durations, easings, or unexplained dimensions in
component CSS. If a reusable value is missing, add it to
`bento-tokens.css` first. The usual exceptions are CSS conventions such as
`0`, `100%`, and `1px` hairlines, plus documented optical corrections.

When text or icons sit on a tinted accent surface, use the paired foreground
token for that surface. For example, active workspace/tab affordances should
pair `--color-60` with `--color-60-fg`, not with an arbitrary neutral.

## CSS layers and overrides

Most Bento component rules belong inside:

```css
@layer bento.components {
  .my-component {
    /* component styles */
  }
}
```

Some Tale UI component and utility styles are unlayered. CSS gives unlayered
rules higher priority than layered rules regardless of selector specificity.
When a Bento rule has to override those styles, keep that rule outside
`@layer` and leave a short comment explaining which Tale UI rule it must beat.

Existing examples:

- [WorkspaceSwitcher.css](../extensions/bento-shell/src/components/WorkspaceSwitcher/WorkspaceSwitcher.css)
  uses unlayered rules for Avatar, Menu popup, trigger label, and icon/text
  overrides that must beat Tale UI defaults.
- [TabRow.css](../extensions/bento-shell/src/components/TabRow/TabRow.css)
  uses unlayered foreground rules so active-row text, buttons, and icons keep
  the correct contrast tokens.
- [TabList.css](../extensions/bento-shell/src/components/TabList/TabList.css)
  has an unlayered alignment override for Tale UI button defaults.

## Themes and chrome

Workspace themes retune Tale UI variables by setting `--brand-*`,
`--neutral-default-*`, and foreground override tokens under
`[data-bento-theme="<id>"]`. The active workspace theme is mirrored onto shell
documents and Firefox chrome roots.

For theme work, follow [themes.md](themes.md). After importing or changing a
theme, run:

```sh
pnpm run import
```

That regenerates the chrome-side token stylesheet so Firefox chrome can consume
the same Tale UI and Bento variables as the extension shell. The chrome pipeline
is documented in [chrome-tokens.md](chrome-tokens.md).

## Chrome-side Tale translations

Some browser chrome surfaces cannot render React components, but still mirror
Tale UI component classes and states so they remain visually aligned with the
extension shell.

Current translations:

- `IconButton variant="ghost" size="sm"`:
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)
  applies `tale-button tale-button--ghost tale-icon-button
tale-icon-button--sm` to panel-header controls and defines a scoped
  chrome-safe CSS translation for hover, pressed, focus-visible, disabled, and
  pending states.
- `Button size="md"` with `primary` / `neutral` variants:
  [bento-migration-host.js](../src/browser/base/content/bento-migration-host.js)
  maps embedded migration wizard buttons to `tale-button` classes, with the
  matching chrome-host CSS in
  [bento-migration-host.css](../src/browser/base/content/bento-migration-host.css).
- ASRouter `menu-message` default-browser nudge:
  [bento-chrome-theme.css](../src/browser/base/content/bento-chrome-theme.css)
  scopes inherited custom properties on `#appMenu-menu-message > menu-message`
  so the upstream shadow-DOM component uses Tale UI neutral, accent, foreground,
  and button tokens instead of Firefox's default information banner colours.
- `Card` with `outlined` / `filled` and `sm` / `md` classes:
  [bento-migration-host.html](../src/browser/base/content/bento-migration-host.html)
  and [bento-migration-host.js](../src/browser/base/content/bento-migration-host.js)
  apply `tale-card` classes to the static import host and embedded wizard
  summary card, with the chrome-host CSS in
  [bento-migration-host.css](../src/browser/base/content/bento-migration-host.css).

When adding a new chrome-side translation, list it here with the React
component, variant, size, and chrome files that own the class/state mapping.

Chrome also has Bento-only widgets that use Tale/Bento tokens but are not
translations of React components. Keep them documented as chrome widgets rather
than adding Tale class names unless they intentionally mirror a Tale component:

- Startup veil skeleton: `bento-startup-veil*` in
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).
- Strip scrollbar: `bento-strip-scrollbar*` in
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).
- Panel navigator and its fallback context menu: `bento-panel-nav*` in
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).
- Panel header URL input and loading overlay: `bento-panel-header-url` and
  `bento-panel-loading-overlay` in
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).
- Panel, subdivision, and flat-layout splitters/choosers:
  `bento-panel-splitter*`, `bento-subdivision-*`, and `bento-layout-*` in
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js).
- Migration wizard chrome-element bridge styles:
  [bento-migration-wizard-bridge.css](../src/browser/base/content/bento-migration-wizard-bridge.css).

## New component checklist

- Read the Tale UI component `.d.ts` example and docs before writing JSX.
- Use per-component imports only.
- Use Tale UI primitives and Bento composite components as the building blocks.
- Put reusable design values in `bento-tokens.css`.
- Keep ordinary component CSS in `@layer bento.components`.
- Use unlayered CSS only with a comment explaining the override.
- Add a Ladle story for every new layer-2 component under
  `extensions/bento-shell/src/components/<Name>/`.
- Run the relevant typecheck, lint, and visual/story checks for the change.
