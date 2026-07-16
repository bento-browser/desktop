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

Tale UI uses the browser-standard rem root: `1rem = 16px`. Bento-authored
custom `rem` values in tokens, critical CSS, chrome-injected CSS, and
standalone migration surfaces should use that contract directly. Do not add a
Tale-specific `font-size: 10px` or `62.5%` root override.

When text or icons sit on a tinted accent surface, use the paired foreground
token for that surface. For example, active workspace/tab affordances should
pair `--color-60` with `--color-60-fg`, not with an arbitrary neutral.

Firefox-owned chrome surfaces such as native toolbar customization cannot use
`@tale-ui/react` directly. Style those surfaces in
`src/browser/base/content/bento-chrome-theme.css` by mapping native Firefox
semantic variables and scoped selectors to generated Tale UI/Bento chrome
tokens from `bento-chrome-tokens.css`.

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
- [ShortcutsDialog.css](../extensions/bento-shell/src/features/Settings/ShortcutsDialog.css)
  uses the same scoped unlayered `CommandPalette` sizing pattern for the
  searchable Settings keyboard-shortcuts reference.
- [AddressBar.css](../extensions/bento-shell/src/components/AddressBar/AddressBar.css)
  uses the same override pattern for the floating address/new-tab palette's
  standard `CommandPalette` surface, with dimensions from
  `--bento-address-bar-*` tokens and an explicit `var(--neutral-5)` popup
  background. The search field and input are transparent so the toolbar reads
  as one continuous neutral surface. Its chrome host is larger than the popup
  so transparent gutters can carry the Tale UI popup shadow without clipping. Its
  `CommandPalette.Backdrop` is a non-painting wrapper used only for React Aria
  modal context; it does not use Tale UI's translucent command-palette recipe
  or run chrome-side frost scripts.
- [MergePalette.css](../extensions/bento-shell/src/components/MergePalette/MergePalette.css)
  uses a scoped unlayered `CommandPalette` override for the active import
  overlay. The overlay is positioned inside the popup, covers the search,
  source list, footer, and close control with an opaque token-backed surface,
  and leaves only the in-progress `ProgressBar` plus Close and Cancel actions
  visible.
- [WorkspaceSwitcher.css](../extensions/bento-shell/src/components/WorkspaceSwitcher/WorkspaceSwitcher.css)
  uses unlayered rules for Avatar, Menu popup, trigger label, and icon/text
  overrides that must beat Tale UI defaults.
- [TabRow.css](../extensions/bento-shell/src/components/TabRow/TabRow.css)
  uses unlayered foreground rules so active-row text, buttons, and icons keep
  the correct contrast tokens.
- [FolderRow.css](../extensions/bento-shell/src/components/FolderRow/FolderRow.css)
  uses a three-column grid for the folder icon, truncating label, and right-aligned
  `Text` tab count. The count uses Tale UI's `xs` text style with the
  `--neutral-50` token, one step below the `s` folder label.
- [TabList.css](../extensions/bento-shell/src/components/TabList/TabList.css)
  has an unlayered alignment override for Tale UI button defaults.
- [PinnedPanels.css](../extensions/bento-shell/src/components/PinnedPanels/PinnedPanels.css)
  uses scoped unlayered `IconButton` variant overrides so pinned-panel buttons
  can keep neutral/accent interactive fills without visible borders or a default
  fill.

## Component drift register

This section records intentional Bento drift from upstream Tale UI component
recipes. Treat these entries as upgrade notes: when bumping Tale UI, compare the
upstream component CSS/API against the drift below before deleting local rules.

### CommandPalette address palette

Upstream base: Tale UI `CommandPalette`, plus Tale UI `Select` for the one-shot
search-engine picker.

Bento owners:

- [AddressBar.tsx](../extensions/bento-shell/src/components/AddressBar/AddressBar.tsx)
  composes the floating address/new-tab palette with Tale UI's
  `CommandPalette`, `Row`, and `Select`.
- [AddressBar.css](../extensions/bento-shell/src/components/AddressBar/AddressBar.css)
  owns the local CommandPalette drift.
- [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js) owns
  the chrome overlay host and shortcut/open lifecycle.

Current drift:

- Bento uses the standard opaque CommandPalette surface and explicitly sets the
  address popup background to `var(--neutral-5)`. Its
  `CommandPalette.Backdrop` must stay transparent and non-scrimmed, and the
  chrome address overlay frame is sized around the popup plus transparent
  shadow gutters instead of covering the full browser window. Do not re-add a
  painting/full-window backdrop,
  `tale-command-palette__popup--translucent`,
  `tale-command-palette__backdrop--transparent`, `backdrop-filter`, or the old
  chrome-side frost bitmap path.
- Bento renders command-palette search clear affordances as
  `CommandPalette.ClearButton` with `tale-button tale-button--ghost
tale-button--sm` classes and visible `Clear` text. Keep them as the
  CommandPalette clear part so it preserves Tale UI's field-clearing behavior;
  do not nest a separate `Button` inside it.
- Bento wraps the input and search-engine `Select` trigger in a compact `Row`.
  The row owns the toolbar padding and divider while the inner
  `CommandPalette.SearchField` remains flush, avoiding a doubled search-field
  inset around the picker trigger.
- Bento keeps the closed address-palette search-engine `Select` trigger
  icon-only and content-sized. The popover items show full engine names, so long
  names cannot resize or occlude the CommandPalette input while the closed
  trigger keeps a tight icon-to-chevron gap.
- Bento gives the Select popover the same `var(--neutral-5)` surface as the
  popup so it remains opaque and token-driven in light and dark modes.
- Bento renders Firefox search-engine icons from the bridged `iconUrl` data URL.
  The privileged bridge converts native Firefox `SearchEngine.getIconURL()`
  results because raw chrome/object URLs are not reliable extension-frame image
  sources. It falls back to bundled copies of Firefox's search-config icon
  attachments for the default providers when native conversion is unavailable.
- The CommandPalette backdrop is not React-Aria-dismissable. Bento closes the
  address palette through its own outside-pointer handler. The nested
  search-engine `Select.Popover` must stay `isNonModal` so React Aria does not
  render a full-window select underlay that steals clicks from the command
  palette and escalates a picker dismissal into an address-palette dismissal.
- Bento disables Tale UI's default command-palette transform animation for this
  overlay. Centered and sidebar-anchored opens fade only, without slide
  movement.
- Address result favicons use Tale UI `Image` but are fully styled by
  `AddressBar.css`; this overlay intentionally does not import the global
  `@tale-ui/react-styles/image` stylesheet.

Regression checks:

- Open the address/new-tab palette over dark page content and hover rows. The
  popup should remain an opaque neutral-5 command-palette surface.
- The browser content, sidebar, and top browser toolbar must not receive a modal
  scrim when the address/new-tab palette opens; scrolling outside the palette
  should not be blocked by an invisible full-window overlay frame.
- Create a new workspace from the workspace manager. If the address/new-tab
  palette opens, it should remain below the workspace manager and should not
  steal focus from it.
- The closed search-engine picker should stay icon-sized with a tight
  icon-to-chevron gap. Long engine names should appear only in the picker
  popover, which should remain opaque and readable over dark content.
- Open the search-engine picker, then click its trigger again to dismiss it; the
  address palette should remain open.
- Open the search-engine picker, then click back into the address palette input
  or result area; only the picker should close.
- Reopen after switching between sidebar-anchored and centered shortcut modes;
  the popup should fade without any transform movement.

### SidebarAddressBar

Upstream base: Tale UI `IconButton`, `Icon`, `Spinner`, and `Tooltip`, with a
native read-only launcher input.

Bento owners:

- [SidebarAddressBar.tsx](../extensions/bento-shell/src/components/SidebarAddressBar/SidebarAddressBar.tsx)
  composes the expanded-sidebar address row.
- [SidebarAddressBar.css](../extensions/bento-shell/src/components/SidebarAddressBar/SidebarAddressBar.css)
  owns the stable row sizing.
- [bento-tokens.css](../extensions/bento-shell/src/theme/bento-tokens.css)
  defines `--bento-sidebar-address-*` dimensions.

Current drift:

- The row is a browser chrome control, not a Tale UI form recipe. It keeps fixed
  security/copy/bookmark button slots and a stable input slot so long URLs,
  loading state, and bookmark/security changes do not resize the sidebar.
- The read-only native input uses an unlayered rule on
  `.bento-sidebar-address-bar__input` with the exact sidebar tab-row font
  shorthand; do not rely on inherited or layered input fonts for this chrome
  control.
- The row keeps its neutral border while focused; it does not apply a
  workspace-brand `--color-60` focus outline.
- The TabList scroller owns a `--space-3xs` top padding matching the gap between
  the workspace switcher and this row. The padding must remain scrollable so tab
  rows become flush with the row edge after scrolling; collapsed mode removes
  it with the address row.
- Activating the row opens the shared `AddressBar` overlay anchored below the
  row. Keyboard shortcuts, the `New tab` action, and native top-urlbar fallback
  opens use the centered `AddressBar` overlay. The overlay owns the focused
  input, suggestions, and search-engine picker so those surfaces can render
  outside the sidebar iframe when anchored.
- The copy and bookmark affordances use Tale UI `IconButton`; the bookmark
  button fills the lucide bookmark icon via a scoped data attribute when the
  current page has a regular Firefox bookmark.
- The component hides entirely under `html[data-bento-collapsed='true']`; the
  floating address palette owns collapsed-sidebar address entry.

Regression checks:

- Expanded sidebar: click the URL row, type a long URL in the anchored address
  overlay, toggle loading and bookmark states, and confirm row height and button
  slots do not move. Then use `Cmd/Ctrl+L`, `Cmd/Ctrl+E`, and `Cmd/Ctrl+T` and
  confirm those paths open the centered address overlay.
- Narrow sidebar: long URLs truncate without overlapping the security, copy,
  search-engine, or bookmark buttons, and the provider menu opens with full
  names while the closed trigger stays icon-sized.
- Expanded sidebar: suggestions can overhang the sidebar onto the panel strip or
  main content, and Escape/outside click returns the shell frame to normal.
- Collapsed sidebar: the row is not visible and the floating address fallback
  remains reachable.

### Sidebar footer buttons

Upstream base: Tale UI `Row`, `IconButton`, `Icon`, and `Tooltip`.

Bento owners:

- [App.tsx](../extensions/bento-shell/src/App.tsx) composes the footer actions.
- [app.css](../extensions/bento-shell/src/app.css) owns the expanded and
  collapsed footer layout overrides.

Current drift:

- Footer action buttons intentionally use the smallest Tale UI Row gap
  (`4xs`) in both expanded and collapsed sidebar modes. Tale UI `Row` always
  emits an inline token gap, so `app.css` uses scoped
  `gap: var(--space-4xs) !important` rules to keep collapsed mode aligned with
  the footer's explicit Row prop.

Regression checks:

- In expanded sidebar mode, footer icon buttons should use the `4xs` token gap
  between button boxes.
- In collapsed sidebar mode, the vertical footer stack should also use the
  `4xs` token gap between button boxes.
- Hover each footer button and confirm its Tale UI tooltip and button state
  still appear.

### CommandPalette settings shortcut reference

Upstream base: Tale UI `CommandPalette`.

Bento owners:

- [ShortcutsDialog.tsx](../extensions/bento-shell/src/features/Settings/ShortcutsDialog.tsx)
  builds the static, read-only keyboard-shortcuts command records.
- [ShortcutsDialog.css](../extensions/bento-shell/src/features/Settings/ShortcutsDialog.css)
  owns the local sizing override.
- [settings/main.tsx](../extensions/bento-shell/src/settings/main.tsx)
  imports `@tale-ui/react-styles/command-palette` for the Settings entry.

Current drift:

- The shortcut reference uses the standard opaque CommandPalette popup but is
  read-only: rows use command-palette item visuals without
  `CommandPalette.Item` selection or action behavior.
- Popup, content, and listbox sizing use the same
  `--bento-command-palette-*` token-backed unlayered override pattern as the
  full command palette so category sections and key tokens scroll inside the
  palette surface.

Regression checks:

- Open Settings → Keyboard shortcuts and search for a category, command title,
  or key name. Results should filter without losing category section headers,
  and rows should not take focus or run actions when clicked.
- Press Escape or the close affordance. The palette should close and reopen
  with an empty query.

### Workspace theme picker

Upstream base: Tale UI's Emoji Picker recipe adapted to workspace theme
metadata. Bento uses `Popover`, `SearchField`, interactive `Card.Button`,
`Tooltip`, `ColorSwatch`, and `Text`; it intentionally uses a grid of Tale UI
interactive cards instead of `ListBox` so every option can be the trigger for
a Tale UI `Tooltip` that shows the full theme name. It also does not use
`Virtualizer` for the current small static theme list. There is no
`@tale-ui/react-styles/virtualizer` import.

Bento owners:

- [WorkspaceThemePicker.tsx](../extensions/bento-shell/src/components/WorkspaceThemePicker/WorkspaceThemePicker.tsx)
  owns the shared picker behavior for single-workspace and all-workspaces
  editing.
- [WorkspaceThemePicker.css](../extensions/bento-shell/src/components/WorkspaceThemePicker/WorkspaceThemePicker.css)
  owns the compact trigger, popover width, search wrapper, theme grid, and
  interactive-card layout overrides. Tale UI owns the card hover, press,
  focus-visible, and selected states.
- [WorkspacePalette.tsx](../extensions/bento-shell/src/components/WorkspacePalette/WorkspacePalette.tsx)
  wires the shared picker into each workspace row and dispatches theme ids
  through `workspace/update` immediately.
- [edit-workspace/main.tsx](../extensions/bento-shell/src/edit-workspace/main.tsx)
  wires the shared picker into the single-workspace draft form and saves the
  selected theme id only when the dialog is saved.
- [workspace-palette/main.tsx](../extensions/bento-shell/src/workspace-palette/main.tsx)
  and [edit-workspace/main.tsx](../extensions/bento-shell/src/edit-workspace/main.tsx)
  import the per-component Tale UI styles required by their standalone Vite
  entries.

Current drift:

- Bento uses a fixed-width trigger so workspace manager rows keep stable
  columns while long theme names truncate.
- The Popover keeps Tale UI's frameless picker surface but overrides the recipe
  width with `--bento-workspace-theme-picker-*` tokens.
- The option grid uses two larger theme tiles rather than the emoji recipe's
  small virtualized cells. Each item shows a two-colour swatch and the theme
  name; `Card.Button` exposes the selected theme through its standard outlined
  selected state instead of reserving space for a check icon. The inter-tile
  grid gap is `--space-3xs`. The stable theme id stays searchable but is not
  rendered as a duplicate subtitle.
- The SearchField clear button must render an explicit `X` icon; Tale UI does
  not provide one automatically.
- The SearchField receives focus when the Popover opens and uses `slot={null}`
  so it does not inherit surrounding overlay input context.
- Each option button is wrapped in `Tooltip.Root`; the popup shows the full
  theme name on hover/focus so truncated names remain inspectable.

Regression checks:

- Open the single-workspace Edit Workspace dialog, open the theme picker, search
  by both theme name and id, select a theme, save, and confirm the workspace
  updates through the normal workspace store mirror.
- Open the workspace manager, open a row theme picker, and search by both theme
  name and id.
- While the theme picker is open, typing in its search field must stay local to
  the picker and must not trigger parent dialog keyboard handling.
- Select a theme and confirm the row updates via the normal workspace store
  mirror rather than local-only optimistic state.
- Check narrow layouts: workspace name, icon trigger, theme trigger, status, and
  delete button must not overlap.
- Press Escape inside the theme picker once to close only the picker, then a
  second time to close the workspace manager.

### Workspace icon emoji picker

Upstream base: Tale UI's Emoji Picker recipe adapted to workspace icons in the
all-workspaces dialog. Bento uses `Popover`, `SearchField`,
`ListBox`, `Icon`, and `Text` over the English `emojibase-data` dataset. The
JSON files are emitted as local extension assets and loaded on picker open.
There is no runtime CDN dependency, no `Virtualizer`, and no
`@tale-ui/react-styles/virtualizer` import.

Bento owners:

- [WorkspacePalette.tsx](../extensions/bento-shell/src/components/WorkspacePalette/WorkspacePalette.tsx)
  owns the private `WorkspaceIconPicker`, Emojibase asset loading, dataset
  normalization, filtering, selection, and `workspace/update` dispatch.
- [WorkspacePalette.css](../extensions/bento-shell/src/components/WorkspacePalette/WorkspacePalette.css)
  owns the fixed icon trigger, popover width, category tab strip, emoji grid
  sizing, and legacy custom-icon clamping.
- [workspace-palette/main.tsx](../extensions/bento-shell/src/workspace-palette/main.tsx)
  imports the per-component Tale UI styles, including `list-box`.

Current drift:

- Bento keeps the existing `Workspace.icon?: string` schema and persistence
  path. Existing non-emoji strings display in the trigger as legacy custom icons
  and can be cleared or replaced.
- Bento fetches the local `emojibase-data/en/data.json` and
  `emojibase-data/en/messages.json` assets only when the picker opens, so the
  full emoji collection is not parsed during workspace-palette cold start.
- Bento flattens Emojibase skin-tone variants into selectable grid items and
  renders them under Emojibase category tabs and subgroup sections.
- Bento maps each Emojibase category tab to a lucide icon in a lightweight ARIA
  tab strip and keeps the category text as an accessible label rather than
  visible tab copy. Category tabs are fixed 1:1 square controls, and the icon
  picker popover is widened to fit the tab strip.
- Selected emoji cells use an outline instead of a fill. Emoji cells and
  category icon tabs have explicit hover and focus-visible states, and subgroup
  headers align flush with the emoji grid. Emoji glyphs are wrapped in a fixed
  size flex-centered icon span inside the fixed size emoji button.
- The emoji results and empty/loading/error states use a fixed block size so the
  picker height does not change between categories or search results.
- The emoji grid and category tab strip hide native scrollbars to avoid a
  mount-time vertical/horizontal scrollbar flash; wheel, trackpad, and keyboard
  scrolling still work inside the picker.
- Bento uses `ListBox` grid layout directly rather than the recipe's
  `Virtualizer`; keeping virtualizer code out of the entry preserves the
  workspace-palette cold-start budget.
- The workspace row keeps fixed-size columns for the square icon trigger, name,
  theme trigger, status action, and delete button so controls stay aligned
  between rows. The icon picker is the first column; there is no duplicate
  avatar beside the workspace name. The name input, icon trigger, theme trigger,
  status button, and delete button use the icon-column width as their shared
  block size. Row containers are unframed: no item padding, border, outline,
  shadow, or fill; the parent list gap supplies row separation. When an icon is
  present, its clear action is an overlaid close-icon button at the top-right of
  the square icon trigger.
- The all-workspaces manager is a Tale UI `Dialog` titled "Edit workspaces"; it
  uses the default corner close affordance, keeps a footer text Close button,
  and places the Add workspace action at the bottom of the workspace list.
- The row name `TextField.Root` keeps row renaming local while typing and
  commits through the normal `workspace/update` path only after blur or Enter
  blur.
- The row icon trigger renders emoji and fallback initials in an unclipped fixed
  glyph box; only legacy custom strings use overflow clamping.
- Workspace avatars with emoji icons force a white avatar background across the
  sidebar trigger and workspace switcher menu in both light and dark modes;
  themed avatar backgrounds still apply to initials and legacy custom strings.
- The sidebar workspace switcher trigger keeps Tale UI's neutral button shape
  but overrides that variant's background, border, and text colors with
  `--color-*` tokens so it follows the active workspace brand.
- The SearchField clear button renders an explicit `X` icon; Tale UI does not
  provide one automatically.
- The SearchField uses `slot={null}` so typing in the icon picker stays local to
  the picker.
- Escape is contained inside the icon popover: first Escape closes the icon
  picker, second Escape can close the workspace manager.

Regression checks:

- Open the workspace manager, open an icon picker, search by emoji label,
  keyword, group, subgroup, and emoji glyph, then select a result.
- Switch between icon category tabs and confirm the active tab keeps its
  subgroup sections and selected emoji state.
- Confirm emoji and category-tab hover/focus states are visible, and selected
  emoji cells are outlined rather than filled.
- Open the icon picker and confirm no vertical or horizontal native scrollbars
  flash inside the emoji grid or category tab strip.
- Clear an icon and confirm the workspace initial fallback returns.
- Seed a workspace with a legacy string such as `W` or `Ops`; confirm it
  displays safely, has no selected emoji cell, and can be replaced.
- Press Escape inside the icon picker once to close only the picker, then a
  second time to close the workspace manager.
- Type into a workspace name field and confirm the row list does not filter or
  trigger palette row handling; blur the name field and confirm the workspace
  rename is then applied.
- Check narrow layouts: workspace name, icon trigger, theme trigger, status, and
  delete button must not overlap.
- Confirm the dialog title reads "Edit workspaces", the top-right default close
  icon is present, the footer shows the Close button, Add workspace sits at the
  bottom of the workspace list, and the row controls share a consistent height.
- Confirm the icon picker is the first row column and no duplicate avatar appears
  beside the workspace name.
- Confirm workspace rows have no item padding, border, outline, shadow, or fill,
  while the vertical gap between rows remains visible.

### Pinned panel rail buttons

Upstream base: Tale UI `IconButton` with `variant="neutral"` and `size="sm"`.

Bento owners:

- [PinnedPanels.tsx](../extensions/bento-shell/src/components/PinnedPanels/PinnedPanels.tsx)
  renders the pinned-panel rail buttons.
- [PinnedPanels.css](../extensions/bento-shell/src/components/PinnedPanels/PinnedPanels.css)
  owns the local button-state overrides.

Current drift:

- Each pinned-panel button carries its destination workspace's
  `data-bento-theme`, making its `--color-*` tokens independent of the active
  workspace. Its default/pressed background is the workspace's solid
  `--color-20`, hover is `--color-30`, pressed is `--color-40`, and focused is
  `--color-60`; borders use the workspace switcher trigger's 16%/22%/28% accent
  mixes. Its state changes transition all properties over the dedicated 300ms
  pinned-panel token. The focused pin keeps the paired foreground token.
- A drag past the shared 4px threshold dims and scales the source button,
  changes the rail cursor to grabbing, and shows a non-reflowing accent insertion
  marker. On drop, FLIP transforms settle the reordered buttons with the panel
  navigator's duration and easing. A completed drag suppresses the button open.

Regression checks:

- In the expanded sidebar, each pinned-panel button should have its destination
  workspace's solid `color-20` fill and a workspace-coloured border.
- Hover a pinned panel to show `color-30`, press it to show `color-40`, and focus
  it to show `color-60`. State changes should transition over 300ms. Borders
  should retain that destination workspace's colour, including when it is not active.
- Drag a pin above or below another pin. The source should dim and scale, the
  accent marker should track the intended slot without moving other buttons
  during the drag, and the buttons should settle into the persisted order on
  release without opening the dragged pin.

### Settings NumberFields

Upstream base: Tale UI `NumberField`.

Bento owners:

- [Settings.tsx](../extensions/bento-shell/src/features/Settings/Settings.tsx)
  and [BackupSection.tsx](../extensions/bento-shell/src/features/Settings/BackupSection.tsx)
  render Settings number fields.
- [Settings.css](../extensions/bento-shell/src/features/Settings/Settings.css)
  owns the shared `bento-settings__number-field` sizing rule.

Current drift:

- Settings NumberFields use a shared root class whose inner
  `NumberField.Group` is capped by `--bento-settings-number-field-max-width`.
  Labels and descriptions keep the surrounding settings row width while the
  visible input control stays narrow. Bento applies the cap through Tale UI's
  public `--tale-number-field-group-width` variable.

Regression checks:

- In Settings, default-panel-width, custom-size, sleep-timeout, discard-delay,
  and backup interval/count NumberFields should render no wider than the token
  cap and should still keep decrement, input, and increment controls on one
  line.

## Themes and chrome

Workspace themes retune Tale UI variables by setting `--brand-*`,
`--neutral-default-*`, and foreground override tokens under
`[data-bento-theme="<id>"]`. The active workspace theme is mirrored onto shell
documents and Firefox chrome roots.

The shipped Standard and Monochromatic collections come directly from
`@tale-ui/themes`. `scripts/sync-theme-presets.mjs` adapts the package metadata
and CSS to Bento's single `data-bento-theme` persistence/bridge contract and
keeps repo-local CSS only for Bento-specific themes such as Default. The shared
picker groups the collections; `standard-*` and `monochrome-*` ids disambiguate
themes with the same display name.

For theme work, follow [themes.md](themes.md). After importing or changing a
theme, run:

```sh
pnpm run import
```

That regenerates the chrome-side token stylesheet so Firefox chrome can consume
the same Tale UI and Bento variables as the extension shell. Firefox-owned
native `about:preferences` also loads that generated token sheet and maps its
in-content semantic variables onto Tale UI tokens. The chrome pipeline is
documented in [chrome-tokens.md](chrome-tokens.md).

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
- Native Firefox bookmark / Places surfaces:
  [bento-chrome-theme.css](../src/browser/base/content/bento-chrome-theme.css)
  maps bookmark toolbar popups, app-menu bookmark panelviews, Places context
  menus, and native sidebar bookmark trees onto Tale UI neutral, text, button,
  field, accent, and paired foreground tokens. The native Bookmarks sidebar
  search box maps Firefox `moz-input-search` variables to Tale UI `--field-*`
  category tokens plus the Bento sidebar address-field size and focus tokens,
  and the Bookmarks sidebar title uses Tale UI `label-l` typography so it
  visually matches the Bento sidebar. The browser window
  already loads the token sheets directly; [bento-shell-mount.js](../src/browser/base/content/bento-shell-mount.js)
  also injects the same token/theme stylesheets into `chrome://browser/content/sidebar/*`
  and `chrome://browser/content/places/*` sidebar documents and mirrors
  `data-color-mode` / `data-bento-theme` attributes there so bookmark text does
  not fall back to OS menu colours.
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
