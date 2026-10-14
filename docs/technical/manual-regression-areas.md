# Manual regression areas

Part of the [technical notes index](../core-functionality-technical.md).

When changing core functionality, manually verify at least the affected subset:

- shell menus and submenus (kebab, context, New menu with nested items) in a
  running browser after any Vite chunking or Mux/React Aria change;
- workspace switch with different panel sets;
- workspace switch with saved strip scroll positions;
- first panel add in a workspace;
- panel add from main context menu and from panel context menu;
- panel trailer blank add and saved-panel add;
- panel resize, including `about:preferences` or `about:settings` in a panel,
  main resize, and workspace switch after resize;
- panel reorder with grouped and ungrouped roots;
- subdivision create, fill, resize, break out, and remove;
- closing main tabs while panels exist;
- closing a sidebar multi-selection with Cmd/Ctrl+W and with the multi-select
  context-menu item;
- closing side panels with descendant sub-panels;
- closing a workspace's last sidebar tab and a panel in the same action (close the
  panel then immediately the tab, and the reverse; a multi-tab close): the window
  ends on a tab of the workspace tools reports, or on the next free workspace when
  nothing is left, never on another workspace's tab with the sidebar unchanged;
- deleting the workspace a window shows while a second window shows another
  workspace: the second window keeps its tabs, and the first window moves to a
  free workspace or closes when none is free; deleting it with a free workspace
  that has no tab yet (and, separately, with "close tabs" chosen) leaves the first
  window open on that workspace with one new tab;
- cold start with several restored windows and workspaces: after startup every
  restored tab is still in the workspace it was in last session (no tab moved to
  its window's workspace), and a window opened or torn out after startup still
  adopts its own tabs without a blank extra tab;
- a selection that lands on another workspace's tab without a workspace switch
  (select it from the Browser Console): the curtain lifts within about 1.5 s;
- tearing out the selected tab, a panel tab, a background tab, and a
  multi-selection from a workspace with panels (drag out, tab context menu "Move
  to New Window"): each moves into a new window with the same page, the new
  window has exactly one tab per moved tab and no blank extra tab, the moved tabs
  appear in the new window's sidebar, and the source workspace promotes a panel
  when its last sidebar tab left;
- closing a sidebar tab, a panel, and a pinned panel whose page has a
  `beforeunload` handler: "Stay" keeps the tab in its workspace and folder (a panel
  returns visible at its slot, width and header state) with no leftover closing
  marker; "Leave" closes it with normal succession. With the prompt left open,
  switch that window to another workspace and open the original workspace in a
  second window, then choose "Stay": the tab joins the workspace its window shows
  as a normal tab and the second window's layout does not gain a panel slot;
- Cmd+Shift+T restore of a closed panel;
- Cmd/Ctrl+Shift+arrow panel traversal while content has focus, and plain
  Left/Right arrow behavior inside page content;
- Vimium or another content-key extension inside a panel;
- AMO install permission prompt from a panel;
- Dark Reader or another content-script extension inside a panel;
- video fullscreen from the main content slot and from a side panel while side
  panels are present, with the side-panel video visible and no Bento loading
  overlay, spinner, or neutral chrome background replacing it;
- theme switch and sidebar footer UI light/dark/Auto switch;
- new windows with a persisted non-Default workspace theme: the sidebar shows
  that theme no later than the frame in which chrome lifts its launch veil
  (compare the `data-bento-theme` change with the veil lift over several windows;
  the first window of a launch waits for `bento-tools` and is slower);
- profile restart with panels, pinned panels, saved panels, widths, and scroll
  positions restored;
- after any Firefox update, the Browser Console shows
  `[bento-compat] probed N members on Firefox <platform version>` (the Gecko
  version, for example `158.0`) and no `[bento-compat] missing` lines.

If a regression touches these areas, record the cause and fix in this document
or in the relevant feature section before closing the task.

## Chrome submenu placement

The chrome menu overlay (`extensions/bento-shell/src/menu/ChromeMenu.tsx`)
composes public Mux `Menu.Submenu`, `Menu.Item`, `Menu.Popup`, and `Menu.List`
parts from serialized chrome menu payloads. Nested popups explicitly use
`placement="end-top"`. In `@muxui/react@0.1.0-rc.1`, relying on the submenu
default can resolve to a bottom popup anchored to the correct item, overlapping
subsequent root rows. Keep placement explicit when changing menu composition.
Verify in the `menu.html` overlay that pointer travel from a submenu trigger
reaches visible child rows, keyboard ArrowRight opens the child, and selection
preserves `BENTO_MENU_SELECT:<context>:<id>` for the chrome title handler.

## Palette search headers and rollback file selection

Command and merge palettes, including the archived command palette, compose
public ClearButton and Close parts inside the search flex row. A scoped static
Close position prevents the sticky Input/Clear/Refresh row from covering its
pointer target. Verify pointer Close with empty/nonempty queries and Clear
reset before changing that geometry.

Standalone rollback Settings uses the same published Mux renderer as the
normal shell. Shortcuts uses the same search-row composition and public
CommandPalette collection parts.
The controlled Input explicitly dismisses on Escape outside IME composition;
the RC SearchField can otherwise intercept the key without updating the leaf
query. Verify nonempty search, native Escape, and native Close in both rollback
variants. Backup import uses public `FileTrigger`; verify invalid/oversize
files, a valid preview, and selecting the same file again after reopening.

## Workspace picker category focus

The published RC Tabs renderer can update the selected emoji category while
leaving DOM focus on an inactive tab. WorkspaceIconPicker uses the public root
ref and standard `tablist`/`tab` roles to follow the committed ARIA selection
in the selection effect. Animation-frame scheduling can delay the correction
in Firefox overlay windows, so it runs directly, only when focus is already in
that category list. It does not implement arrow selection or move focus from search/results/outside. Verify Home/End/arrows from
the current focused tab, Enter/Space keeping that selection, and search typing
preserving input focus when changing the package.
