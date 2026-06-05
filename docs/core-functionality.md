# Bento Browser core functionality

Bento Browser is a workspace-first Firefox fork built around personalised
browsing layouts. Its main difference from conventional browsers is that a
workspace is not just a tab list: it is a reusable arrangement of the main tab
content plus any number of side panels and panel-hosted widgets.

The product goal is to reduce browser-window sprawl. Instead of opening several
windows and manually arranging them with the operating system, a user can keep a
task-specific "bento box" inside one browser window and switch to another box
when their context changes.

On first run with a fresh Bento profile, Bento shows a multi-step onboarding
experience that uses the "Bento box" motif: workspaces, panels, browser data,
and setup actions are presented as compartments in the same tray. Browser-data
import is one state in that onboarding flow. Choosing import opens an embedded
browser-data import host inside the onboarding experience.
Regular browser imports stay in-window. Full Mozilla Firefox or Zen Browser
profile imports use an explicit startup handoff because Firefox's profile-copy
migrator runs before the new profile is initialized. Choosing the Firefox/Zen
action restarts into the startup migration wizard scoped to the detected
Firefox and Zen profiles and preselected on them, rather than a generic picker
defaulted to another browser. This is separate from the additive Bento backup
import flow. The first onboarding step also lets the user
choose Bento's UI theme mode: Light, Dark, or Auto; fresh profiles default to
Light. The onboarding overlay is not dismissed by clicking the scrim or pressing
Esc, and the user exits it only from the final step.

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

The main content slot width is also workspace-specific. Resizing the main
content area in one workspace should not resize the main content area in another
workspace.

Workspaces should feel persistent. Closing Bento and reopening it should restore
the user's active contexts without forcing them to rebuild their browser
arrangement from memory.
In a single-window session, relaunch should reopen on the workspace that was
visible when Bento was quit.

Workspace export/import and automatic backups should preserve the same browsing
layout state as restart persistence: tabs, panels, panel order, panel widths,
main content width, subdivisions, split-panel ratios, pinned panel references,
saved panels, settings, and the panel-strip scroll position.
Replacement import should keep the browser window alive while it swaps the
workspace set; Bento imports the replacement first, then removes the old
workspaces and tabs.

The sidebar tab list supports multi-selection for workspace organization.
Users can Cmd/Ctrl-click individual tabs or Shift-click a range, then right-click
the selected group to move those tabs together into a newly created workspace.
The current tab is highlighted with the active workspace accent color and its
contrast foreground so it stands apart from neutral hover and multi-selection
states.

The workspace switcher should behave like a lightweight anchored menu. Opening
it should leave the current browser content visible behind the menu rather than
covering the window with an opaque overlay.

Chrome-level menus and modals should preserve visual context. A command palette,
workspace editor, confirmation, or welcome dialog may draw its intended modal
scrim, but the overlay page itself should not cover the browser with an opaque
surface. The first-run welcome scrim covers the full chrome window, including the
toolbar and address bar.

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
- close the last regular tab in a workspace while panels remain; Bento promotes
  the leftmost panel into the main content slot instead of leaving the workspace
  blank.
- restore a recently closed panel with `Cmd+Shift+T` as a panel, not as a
  regular tab, using the configured default new-panel width.

Panels are part of the workspace rather than detached windows. This lets users
keep chat, docs, dashboards, references, issue trackers, media, or internal tools
visible beside the page they are actively using.

### Bento layouts

The "Bento" layout model comes from splitting the available workspace into
smaller, movable regions.

At the top level, panels can flow horizontally beside the main content. A panel
can then be subdivided so the workspace can contain smaller panels stacked or
split within the same area. Panels created inside a subdivision appear at the
subdivision's assigned size immediately, rather than starting as default-width
root panels. After creating a vertical group, the top panel can also be split
so the workspace can form a single shared 2x2 grid instead of separate columns.
The empty subdivision chooser offers `Full panel` and `Split panels` side by
side, can open saved-panel bookmarks directly into the subdivision, and can be
closed without first creating a temporary panel.
If one panel in a bottom split is closed, the surviving bottom panel can be
split again in the same row. Splitting or subdividing a panel preserves the
current panel-strip position rather than auto-scrolling away from the user's
current context. Breaking a panel out of a subdivision also preserves the
current strip position. Dragging a subpanel or split panel out of a subdivision
promotes that one panel into the top-level strip, and dragging a top-level panel
onto a one-panel subdivision row adds it beside that panel. A panel can also be
dragged into an unconfigured subdivision area to fill that area as a full panel.
Rows that already contain two panels do not accept another dragged panel.
When the browser window is resized, panels resize to the visible workspace
height instead of retaining stale dimensions from the previous window size.
The intended layout primitives are:

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
- panel navigator controls use the same compact sizing and bottom-edge rhythm as
  the sidebar footer controls;
- grouped panel navigator icons show and refresh the favicons for visible
  panels inside a vertical or 2x2 group;
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
- light, dark, and Auto UI modes;
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
