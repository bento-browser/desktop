# Bento Browser core functionality

Bento Browser is a workspace-first Firefox fork built around personalised
browsing layouts. Its main difference from conventional browsers is that a
workspace is not just a tab list: it is a reusable arrangement of the main tab
content plus any number of side panels and panel-hosted widgets.

The product goal is to reduce browser-window sprawl. Instead of opening several
windows and manually arranging them with the operating system, a user can keep a
task-specific "bento box" inside one browser window and switch to another box
when their context changes.

## Core model

### Workspaces

A workspace is a named browsing context for a current mode of work: research,
writing, operations, planning, personal browsing, or any other persona the user
wants to preserve.

Each workspace owns:

- its regular tabs;
- its panel layout;
- pinned or saved panel affordances;
- its selected visual theme;
- persisted layout state such as panel order, widths, subdivisions, and scroll
  position.

Workspaces should feel persistent. Closing Bento and reopening it should restore
the user's active contexts without forcing them to rebuild their browser
arrangement from memory.

### Main content

The main content area is the normal browser surface. It behaves like a regular
Firefox tab view and remains the user's primary page for the active task.

Panels sit alongside this main content instead of replacing it. This keeps Bento
compatible with normal browsing habits while adding a richer workspace layout
around the page.

### Panels

Panels are persistent browsing surfaces that live next to the main content. A
workspace can have as many panels as the user needs.

Panels support the core Bento workflow:

- promote an existing tab into a panel;
- open a link or URL directly into a new panel;
- create a blank panel from the trailer at the end of the panel strip and move
  focus to it;
- save a useful panel target for reuse later;
- pin important panels so they are reachable across workspace changes;
- resize panels without disturbing the entire layout;
- close or remove a panel without losing the rest of the workspace; closing
  panels fade out without resizing neighboring panels during the exit animation,
  then plain top-level panel slots glide closed when the panel is removed.

Panels are part of the workspace rather than detached windows. This lets users
keep chat, docs, dashboards, references, issue trackers, media, or internal tools
visible beside the page they are actively using.

### Bento layouts

The "Bento" layout model comes from splitting the available workspace into
smaller, movable regions.

At the top level, panels can flow horizontally beside the main content. A panel
can then be subdivided so the workspace can contain smaller panels stacked or
split within the same area. The intended layout primitives are:

- horizontal splits for wide and ultrawide displays;
- vertical splits for portrait displays and stacked reference views;
- drag-based panel reordering;
- splitter handles for resizing;
- persisted per-workspace layout state.

This turns browser layout into an application-level feature. Users with
ultrawide monitors can keep several work surfaces visible without manual window
tiling. Users with vertical displays can stack contextual panels without wasting
horizontal space.

### Widgets

Widgets use the same mental model as panels: compact, persistent surfaces that
belong to a workspace. A widget may be a saved web panel, a pinned utility, or a
future built-in tool.

The important product rule is that widgets should not become a separate mode of
window management. They should inherit the same workspace, layout, traversal,
and theming behavior as panels.

## Primary user flows

### Build a persona workspace

1. Create or switch to a workspace for the current task.
2. Open the primary page in the main content area.
3. Add supporting pages as panels.
4. Split or resize panels to match the shape of the work.
5. Pick a theme that makes the workspace visually recognizable.

The result should be a reusable persona: a browser arrangement for a mode of
work, not a one-off collection of tabs.

### Work without window management

The user should be able to keep related pages visible in one Bento window:

- main page in the primary content slot;
- reference material in one or more panels;
- communication or monitoring tools in narrow panels;
- saved panels available from the panel trailer;
- pinned panels reachable from the sidebar.

The browser should handle panel placement, persistence, and traversal so the
operating system window manager is not the main productivity tool.

### Traverse panels efficiently

Panel traversal is a core accessibility and productivity requirement. A user
should be able to move between the main content, side panels, saved panel
targets, and pinned panels without relying only on precise pointer movement.

The intended behavior is:

- visible panel controls are keyboard reachable;
- focused panels have clear visual state;
- panel cycling is predictable;
- saved and pinned panels are reachable from compact controls;
- workspace switching preserves enough layout state that returning to a
  workspace feels immediate;
- restored panel-strip scroll position remains stable until the user explicitly
  navigates the strip or selects another target.

### Personalise the workspace

Bento's theming engine gives each workspace an identity while staying accessible.

The theme system should support:

- curated accessible presets;
- per-workspace theme selection;
- light and dark UI modes;
- independent content color-scheme preference where possible;
- user customization through token-based theme presets.

The goal is not decorative skinning alone. Themes should help users recognize
the active workspace quickly and make long-lived browsing contexts comfortable
to use.

## Design principles

### Workspace state is first-class

Tabs, panels, layout, saved panel affordances, and theme selection belong to the
workspace. Bento should treat that state as the user's working environment, not
as incidental UI state.

### Panels should stay browser-compatible

Panel content should behave like normal browser content. Extensions, page state,
keyboard behavior, history, media, and developer tools should work as close to
regular tabs as possible.

### Layout should scale with display shape

Bento should not assume a laptop-sized horizontal viewport. The panel system
must support wide monitors, ultrawide monitors, and vertically oriented displays
without forcing the user into multiple OS windows.

### Customisation must remain accessible

Themes and layout controls should improve recognition and comfort without
creating low-contrast or hard-to-navigate states. Curated presets are the default
path; deeper customization builds on the same token system.

### Window count should go down

The core product test is simple: a user who previously needed several browser
windows for one task should be able to express that task as one Bento workspace.

## Implementation anchors

These files define or document the current core model:

- `extensions/_shared/protocol.ts` defines workspace, panel, layout, theme,
  pinned-panel, saved-panel, settings, privacy, and backup wire contracts.
- `extensions/bento-shell/src/state/workspaces.ts` mirrors workspace metadata
  into the shell UI.
- `extensions/bento-shell/src/state/panels.ts` mirrors panel membership per
  workspace.
- `extensions/bento-shell/src/state/pinnedPanels.ts` and
  `extensions/bento-shell/src/state/savedPanels.ts` mirror reusable panel
  affordances.
- `docs/themes.md` documents the workspace theme system.
- `plans/bento-spaces-split-view-panels.md` documents the native split-view
  panel architecture.
