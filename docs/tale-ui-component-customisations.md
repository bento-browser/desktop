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

- [CommandPalette.css](../extensions/bento-shell/src/components/CommandPalette/CommandPalette.css)
  uses narrow unlayered selectors for the Tale UI `CommandPalette` popup and
  listbox sizing because `@tale-ui/react-styles/command-palette` is unlayered.
  The dimensions come from `--bento-command-palette-*` tokens.
- [AddressBar.css](../extensions/bento-shell/src/components/AddressBar/AddressBar.css)
  uses the same override pattern for the floating address/new-tab palette's
  translucent `CommandPalette` surface, with dimensions from
  `--bento-address-bar-*` tokens. It disables the address palette's local
  `backdrop-filter` and enter/exit transform overrides; the actual clipped
  page/sidebar blur behind the transparent chrome frame comes from the
  chrome-owned `#bento-addrbar-frost` bitmap layer in
  [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js) and
  [bento-chrome-theme.css](../src/browser/base/content/bento-chrome-theme.css).
  The bitmap must be captured before the overlay fades in so the popup shadow
  does not visually resize after opening. Its search-field wrapper stays
  transparent so it does not stack another color-mix layer over the popup
  surface, and its hover/focus/pressed/selected states use translucent
  `color-mix(..., transparent)` or `--bento-surface-*` layers rather than solid
  neutral/accent fills.
- [WorkspaceSwitcher.css](../extensions/bento-shell/src/components/WorkspaceSwitcher/WorkspaceSwitcher.css)
  uses unlayered rules for Avatar, Menu popup, trigger label, and icon/text
  overrides that must beat Tale UI defaults.
- [TabRow.css](../extensions/bento-shell/src/components/TabRow/TabRow.css)
  uses unlayered foreground rules so active-row text, buttons, and icons keep
  the correct contrast tokens.
- [TabList.css](../extensions/bento-shell/src/components/TabList/TabList.css)
  has an unlayered alignment override for Tale UI button defaults.

## Component drift register

This section records intentional Bento drift from upstream Tale UI component
recipes. Treat these entries as upgrade notes: when bumping Tale UI, compare the
upstream component CSS/API against the drift below before deleting local rules.

### CommandPalette translucent address palette

Upstream base: Tale UI `CommandPalette` and the
`tale-command-palette__popup--translucent` recipe.

Bento owners:

- [AddressBar.tsx](../extensions/bento-shell/src/components/AddressBar/AddressBar.tsx)
  composes the floating address/new-tab palette with Tale UI's
  `CommandPalette`.
- [AddressBar.css](../extensions/bento-shell/src/components/AddressBar/AddressBar.css)
  owns the local CommandPalette drift.
- [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js) and
  [bento-chrome-theme.css](../src/browser/base/content/bento-chrome-theme.css)
  own the chrome-side frost proxy behind the transparent extension frame.

Current drift:

- Bento disables the palette-local `backdrop-filter` on the Tale UI backdrop and
  popup. A WebExtension overlay frame can show parent chrome pixels through
  transparency, but its internal backdrop filter cannot reliably blur those
  parent pixels. The blur is instead supplied by chrome's clipped
  `#bento-addrbar-frost` bitmap. The capture may use targeted remote
  `browser.drawSnapshot` calls for the sidebar frame, `gBrowser.selectedBrowser`,
  and visible side-panel browsers only. Do not use broad tabpanel queries or
  delayed bitmap recaptures for this surface; during new-workspace handoff
  Firefox can return retained previous-tab layers, which creates stale blur and
  distracting late updates. Native top-urlbar opens after workspace creation
  wait for the new workspace surface to stabilize before the first capture; on a
  timeout, prefer no frost to a previous-workspace frost. The working guard
  records the palette-close surface identity and rejects that same
  workspace/tab/browser identity on immediate native-urlbar `focus` opens before
  snapshotting.
- Bento disables Tale UI's popup enter/exit transform for this surface. The real
  `box-shadow` stays on the CommandPalette popup; transforming a filtered
  translucent popup changes compositor bounds and makes the shadow appear to grow
  and shrink during open/close.
- Bento uses a stronger translucent popup surface
  `color-mix(in srgb, var(--neutral-5) 84%, transparent)` so text remains
  readable over dark page or panel content. The search-field and chip containers
  stay transparent so they do not stack a second translucent layer over the
  popup.
- Bento overrides translucent item, clear-button, chip, and shortcut-key states
  to remain translucent. Hover, focus, pressed, selected, and selected-combined
  states must use `color-mix(..., transparent)` or `--bento-surface-*` overlays,
  not solid neutral/accent fills.
- Address result favicons use Tale UI `Image` but are fully styled by
  `AddressBar.css`; this overlay intentionally does not import the global
  `@tale-ui/react-styles/image` stylesheet.

Regression checks:

- Open the address/new-tab palette over dark page content and hover rows. The
  row state should read as a translucent wash, not a solid rectangle.
- The top browser toolbar must not receive a modal scrim when the address/new-tab
  palette opens.
- Only the content directly behind the command palette bounds should blur; the
  whole Bento UI must not blur.
- Create a new workspace and let the auto-created new tab focus the address
  palette. The blurred pixels inside the palette should come from the new
  workspace/new-tab surface, not the previously active workspace.
- The popup shadow must not visibly resize during open or dismiss.
- The search field area must not look like an extra opaque band stacked on top of
  the popup surface.

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
