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
defaulted to another browser. Empty Firefox/Zen profile entries with no
migratable resources are not offered. Zen imports also translate Zen spaces into
Bento workspaces and restore Zen tabs through Bento's workspace-aware session
restore as the import completes. Zen pinned tabs become pinned Bento tabs. Zen
essential tabs become pinned Bento panels. Chrome and other regular browser
imports in this flow use Firefox's native migration wizard and are separate from
the additive Bento backup import flow. The first
onboarding step also lets the user choose Bento's UI theme mode: Light, Dark, or
Auto; fresh profiles default to Light. After import, onboarding asks for a
privacy protection level and default search engine. Fresh profiles default to
Standard privacy and DuckDuckGo search. The onboarding overlay is not dismissed
by clicking the scrim or pressing Esc, and the user exits it only from the final
step.

The sidebar footer also exposes a manual "Merge browser session" action. This
is a runtime, additive, one-way merge from another browser profile's latest
persisted session snapshot. Bento does not sync with or write to the external
profile. It imports mergeable open tabs into new Bento workspaces, maps source
tab groups or tab folders to Bento tab folders when the source format exposes
them, creates those imported folders collapsed, preserves pinned tabs as pinned
tabs, skips URLs already open in Bento, and activates the first imported
workspace when the merge completes. Imported
workspaces use
Bento's normal restart persistence, so their tabs remain assigned to those
workspaces after relaunch. If Bento finds a browser profile but cannot read or
import its session snapshot, the profile remains in the merge picker as an
unavailable row instead of disappearing, including when other browser sessions
are mergeable. The merge picker includes a refresh button so the user can
rescan browser session snapshots without closing and reopening the picker.
Readable sources can be expanded to show importable spaces or windows. Each
space/window starts with its tab preview collapsed; expanding it shows up to 10
tab titles and URLs plus an "X more tabs" count, and it can be imported on its
own instead of importing the whole browser session. If every tab from a selected
source, space, or window is already open in Bento, the picker reports that no
new tabs were imported instead of silently doing nothing. While an import is
running, the picker covers the command palette with an opaque in-palette
progress view naming the source being imported, an indeterminate loader, and a
Cancel button. The progress view also has a Close button that hides the picker
without cancelling the active import.
Cancel stops the remaining import work without rolling back tabs that were
already opened. Selecting a source does not close the picker; it stays open
through progress, success, or error. During progress the in-palette Close and
Cancel buttons are the visible actions. After progress completes, the user can
dismiss the picker with the Close button, backdrop, or chrome close control.

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
workspace. Until a workspace has its own resized main width, the main content
slot keeps at least the configured default new-panel width while side panels are
added.

Workspaces should feel persistent. Closing Bento and reopening it should restore
the user's active contexts without forcing them to rebuild their browser
arrangement from memory.
Closing a window that is showing a workspace should release that workspace for
another window without clearing its tabs, panels, or panel layout.
In a single-window session, relaunch should reopen on the workspace that was
visible when Bento was quit.

Workspace export/import and automatic backups should preserve the same browsing
layout state as restart persistence: tabs, panels, panel order, panel widths,
main content width, subdivisions, split-panel ratios, pinned panel references
including their remembered widths, saved panels, settings, and the panel-strip
scroll position.
Stored backup restore and delete controls identify themselves on hover and ask
for confirmation before dispatching either action.
Replacement import should keep the browser window alive while it swaps the
workspace set; Bento imports the replacement first, then removes the old
workspaces and tabs.

The sidebar tab list supports multi-selection for workspace organization.
The tab list exposes `New tab` and `New panel` buttons. In expanded sidebar
mode, `New tab` opens the centered address/search overlay in new-tab mode,
creating the tab only after the user commits. In collapsed sidebar mode, it
opens the same centered address/search fallback. `New panel`
opens a blank panel in the active workspace. A
search icon beside those controls expands into a sidebar search field over the
action row. Typing filters open tabs and side panels by title across all
workspaces. The field has a clear
button labeled "Clear". While a query is active, the sidebar shows only the
search field and matching result rows; normal tabs, folders, pinned sections,
and creation controls are hidden until the query is cleared or search closes.
Results use the same row footprint as sidebar tabs, identify each result's workspace with its
workspace icon or initial, tint the workspace marker with that workspace's theme,
and selecting a result switches to that tab or focuses that panel. When pinned
tabs exist, these controls appear below the pinned run and above regular tabs.
Workspace tabs can be grouped into collapsible tab folders from the sidebar
context menu. Folders live below pinned tabs and above the regular tab section,
can be renamed, deleted, collapsed, expanded, and reordered among themselves,
can be moved to another workspace from their context menu, and persist across
restarts. Tabs inside folders remain normal unpinned Firefox tabs. Folder names
are not directly editable by clicking the row; rename starts from the folder
context menu and opens an inline field that is immediately ready for typing.
Deleting a folder returns its member tabs to the regular section.
Dragging a normal tab into the pinned run pins it; dragging a pinned tab below
that run unpins it. Dragging a tab onto a folder places it in that folder; pinned
tabs dragged onto folders are first converted back into normal tabs.
When the active tab is inside a collapsed folder, Bento shows that active tab as
a single peek row beneath the folder.
Users can Cmd/Ctrl-click individual tabs or Shift-click a range, then right-click
the selected group to reload those tabs together or move them together into a
newly created workspace.
When multiple tabs are selected, Cmd/Ctrl+W closes the selected tabs and the
right-click menu exposes the same close-selected action.
Right-clicking the sidebar exposes "Select all tabs", which selects every
regular tab in the active workspace's sidebar list.
Right-clicking the sidebar exposes "Reopen closed tab", which restores the most
recently closed tab through Firefox's recently closed tabs flow.
Right-clicking a single sidebar tab exposes tab actions, including creating a
new tab immediately below the clicked tab, unloading an inactive loaded tab,
and muting or unmuting the tab. Tabs can also be closed individually, or closed
in groups with Close tabs above, Close tabs below, and Close other tabs. Close
other tabs preserves pinned tabs and the clicked tab. Inactive tabs can be
renamed or converted into side panels from the same menu.
The current tab is highlighted with the active workspace accent color and its
contrast foreground so it stands apart from neutral hover and multi-selection
states.
When a regular sidebar tab is playing audio, the row shows a speaker button
before the favicon. Clicking it mutes the tab; muted media tabs keep the button
so the user can unmute them from the sidebar.
When a side panel is playing audio, its panel header shows the same mute control
after the refresh button and before the address field.
Audible side panels also emit small music-note particles from their panel
navigator favicon buttons; multiple panel buttons can show this at once.
When a workspace contains pinned regular tabs, the sidebar separates that group
from the New menu and regular tabs with a divider instead of a text
subheading.
Recently closed regular tabs should reopen with Firefox's standard
`Cmd+Shift+T` flow or the sidebar "Reopen closed tab" menu item.
Bento replaces Firefox's native horizontal tab strip with its workspace/sidebar
tab UI, while retaining the operating system's native window controls in the
top chrome.

The workspace switcher should behave like a lightweight anchored menu. Opening
it should leave the current browser content visible behind the menu rather than
covering the window with an opaque overlay.
Editing a single workspace lets the user rename it, set or clear its icon with
the same searchable full emoji picker used by the all-workspaces manager, and
choose a theme with the same compact searchable theme picker used there.
It also exposes "Edit all workspaces", which opens an "Edit workspaces" dialog
where every workspace can be renamed, re-iconed from the first column with a
searchable full emoji picker with icon category tabs and subgroup sections,
cleared with the icon control's overlaid close button, re-themed, activated,
added with the Add workspace button at the bottom of the workspace list, or
deleted from one view. The dialog uses the standard corner close affordance and
also closes from the footer Close button. Workspace name edits stay in the row
while typing and apply after the name field loses focus. Workspace rows use
unframed controls with visible gaps between rows and do not duplicate the icon
beside the workspace name. Workspace re-theming uses a compact searchable theme
picker. Workspace avatars that display emoji icons keep a white avatar
background in both light and dark modes. Deleting a non-empty workspace uses
Bento's confirmation dialog before closing its tabs.

Chrome-level menus and modals should preserve visual context. A command palette,
workspace editor, confirmation, or welcome dialog may draw its intended modal
scrim, but the overlay page itself should not cover the browser with an opaque
surface. Bento modal scrims cover the full chrome window, including the toolbar
and address bar. Stacked modals add matching stacked toolbar scrim layers, so a
confirmation opened over the workspace editor dims the native address bar by the
same amount as the content behind it. The floating address/search bar is not a
modal scrim; it leaves the native toolbar visible while blurring only the content
behind its palette surface.

The command palette separates normal tabs from side panels. Choosing a tab opens
that tab in the main content slot, switching to its workspace first when needed.
Choosing a panel switches to the panel's workspace, scrolls the panel strip to
that panel, and focuses the panel without moving it into the main content slot.
The command palette search field and command rows show clear hover, focus, and
active states so mouse and keyboard navigation both have visible feedback. Rows
include command titles, supporting descriptions, icons, and contextual metadata
such as current/active markers or workspace shortcut hints where applicable.
Command-palette search fields use a visible "Clear" button instead of an
icon-only clear affordance.

In expanded sidebar mode, the main address/search entry is a persistent row
below the workspace switcher and above the tab list. It mirrors the active main
tab's URL, loading state, Firefox security identity state, and regular Firefox
bookmark state, with one-click actions to copy the current URL or toggle the
regular bookmark state. Clicking the row opens Bento's address entry below the row. Its
suggestions can extend beyond the sidebar over the panel strip and main content
slot. `Cmd/Ctrl+L`, `Cmd/Ctrl+E`, `Cmd/Ctrl+T`, `New tab`, and any fallback path
that reaches Firefox's hidden native top address field open the centered
address/search overlay instead of showing Firefox's native suggestion dropdown.
The field uses the sidebar tab row text size on a neutral-5 surface. The native
top URL/search field is hidden in normal Bento windows while toolbar buttons and
native window controls remain visible. In collapsed sidebar mode, those same
actions open the existing floating address/search fallback.

In new-tab mode, if the clipboard contains a web URL, the first result offers to
open that URL from the clipboard. Saved panels also appear by default and open
as side panels. Typing hides these default clipboard and saved-panel rows. After
the user types, results include capped matches for open normal tabs and panels
from the active workspace by title or URL, plus history, bookmarks, and a final
search/open row. The address entry includes a one-shot search-engine picker
initialized from Firefox's current default engine each time editing starts.
The closed picker shows the provider icon; opening it shows the full provider
names. Choosing another engine affects only the submitted non-URL search and
does not change Bento Settings or Firefox's default search engine. Submitting a
URL-like value ignores the one-shot picker and continues through Firefox URL
fixup, including internal browser pages such as `about:preferences`.
Successful address or search submissions reveal the main content slot if the
panel strip was scrolled over side panels, because the submitted load targets
the main tab surface.
Submitting in new-tab mode creates the tab only after the user commits, so Esc
does not leave an empty tab behind. Sidebar suggestions render in a
sidebar-anchored neutral popover that can overhang the sidebar; the collapsed
fallback uses the same opaque floating command-palette surface as before and
does not dim the browser content behind it.
The floating fallback address/search field uses a visible "Clear" button.
If an empty workspace created from the workspace manager triggers the new-tab
address/search bar, the workspace manager remains above it and keeps focus.
History and bookmark rows use generic icons when no favicon source is
available.

### Main content

The main content area is the normal browser surface. It behaves like a regular
Firefox tab view and remains the user's primary page for the active task.
When page content in the main slot or any panel enters fullscreen, Bento
chrome, panel headers, panel loading overlays, and panel focus rings hide so
the fullscreen element owns the whole browser window. Normal rounded content
frames are also removed during fullscreen so videos reach the window edges
without clipped corners.

Panels sit alongside this main content instead of replacing it. This keeps Bento
compatible with normal browsing habits while adding a richer workspace layout
around the page.

### Panels

Panels are persistent browsing surfaces that live next to the main content. A
workspace can have as many panels as the user needs.

Panels support the core Bento workflow:

- promote an existing tab into a panel;
- open a link or URL directly into a new panel and focus it without snapping it
  to the left edge when it fits in the visible strip;
- create a blank panel from the sidebar tab list;
- create a blank panel from the trailer at the end of the panel strip, move
  focus to it, and reveal it from the right when it fits in the visible strip;
- click into a partially visible panel or panel trailer and have the strip
  reveal the whole panel or trailer section;
- bookmark the current panel URL from the panel header;
- right-click the panel header Back or Forward buttons to show that panel's
  previous, current, and next page-history entries;
- save a useful panel target for reuse later;
- pin important panels so they are reachable across workspace changes; their
  backing Firefox tabs are also pinned while the panel pin exists, so idle-tab
  sleep keeps them loaded. Visible panels in active workspaces are also kept
  awake so the sleep sweep does not reload the page under the user.
- resize panels without disturbing the entire layout;
- close or remove a panel without losing the rest of the workspace; closing
  panels fade out without resizing neighboring panels during the exit animation,
  then plain top-level panel slots glide closed when the panel is removed.
- close the last regular tab in a workspace while panels remain; Bento promotes
  the leftmost panel into the main content slot instead of leaving the workspace
  blank.
- restore a recently closed panel with `Cmd+Shift+T` as a panel, not as a
  regular tab, using the configured default new-panel width.
- choose custom panel width presets in Settings and drag those presets to set
  the order shown in each side-panel header's custom widths menu.

Side-panel and sub-panel headers can be hidden per panel from the header's
`...` menu. Hidden headers are restored from a small grey handle at the panel's
top center. This state persists across workspace switches and restarts. The main
content slot does not expose this header action.

Right-clicking page content in the main slot or in a side panel exposes
`Inspect in Panel` and, when Firefox exposes the matching stock item,
`Inspect Accessibility Properties in Panel`. These commands open Firefox
DevTools in a new Bento panel immediately adjacent to the inspected surface. The
DevTools panel stays paired with its caller: moving the caller moves the
DevTools panel back beside it, the splitter between them is always highlighted,
and focusing either side shows the focus ring and active header styling on both.
When the caller is inside a subdivided panel, the connector sits at that
sub-panel's vertical midpoint rather than at the midpoint of the containing root
panel. Reusing the command for the same caller and inspected tab focuses the
existing DevTools panel instead of creating another one. DevTools panels are
ephemeral: they are closed when the caller panel is removed, when the inspected
tab is closed, or across browser restart, and they are not saved in workspace
panel persistence or the pinned panels rail.

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
When the browser window is resized or the bookmarks toolbar is toggled, panels
resize to the visible workspace height instead of retaining stale dimensions
from the previous chrome size.
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
- pinned panels reachable from a favicon rail beside the sidebar tabs, reopening
  at their remembered width after they have been closed.

The browser should handle panel placement, persistence, and traversal so the
operating system window manager is not the main productivity tool.

### Traverse panels efficiently

Panel traversal is a core accessibility and productivity requirement. A user
should be able to move between the main content, side panels, saved panel
targets, and pinned panels without relying only on precise pointer movement.

The intended behavior is:

- visible panel controls are keyboard reachable;
- focused panels have clear visual state through a persistent ring and active
  header colour;
- the sidebar's New menu remains reachable when the sidebar is collapsed;
- panel navigator controls use the same compact sizing and bottom-edge rhythm as
  the sidebar footer controls;
- sidebar footer icon buttons show Tale UI tooltips on hover;
- the fixed main content slot button in the panel navigator is separated from
  draggable side-panel buttons by a divider;
- grouped panel navigator icons show and refresh the favicons for visible
  panels inside a vertical or 2x2 group;
- sleeping inactive-workspace panels appear dimmed in the panel strip and their
  panel navigator buttons are dimmed until the backing tab wakes;
- panel cycling with `Cmd/Ctrl+Shift+Left` and `Cmd/Ctrl+Shift+Right` is predictable;
- saved panels and pinned-panel rail buttons are reachable from compact controls;
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

### Privacy And Search

Bento exposes privacy as a first-class browser setting instead of hiding it
behind `about:config`. The selectable protection levels are:

- Standard: compatibility-first Bento defaults with strict Firefox tracking
  protection, tracker-cookie partitioning, Global Privacy Control, query
  stripping, remote search suggestions off, speculative networking off, local
  Safe Browsing checks on, remote download checks off, uBlock Origin enabled,
  and DuckDuckGo as the fresh-profile search default.
- Enhanced: Standard plus HTTPS-only mode, resist fingerprinting, and tighter
  WebRTC IP handling.
- Hardened: Enhanced plus letterboxing, WebRTC peer connections off, DRM off,
  disk cache off, WebGL/WebGPU off, password/form saving off, local Safe
  Browsing off, and cookies/site data/cache cleared on shutdown.

Custom is a detected state, not a selectable preset. Bento shows Custom when
the live browser settings no longer exactly match Standard, Enhanced, or
Hardened.

Settings includes a privacy level selector, default search engine selector, and
advanced privacy controls for the main browser-level levers. Settings displays
the current protection level in the Privacy card header and shows the benefits
and caveats for Standard, Enhanced, and Hardened so users can compare
compatibility impact before switching. The first-run onboarding privacy step
shows a compact benefit/caveat explanation for the selected level. The search
choices shown in onboarding and Settings are Firefox's currently visible search
engines, with DuckDuckGo as Bento's fresh-profile default. The onboarding search
step adds supporting text that calls out visible privacy-oriented search engines
when Firefox exposes them. Settings also includes a searchable keyboard
shortcuts command palette whose results are grouped by category and show command
titles, supporting descriptions, and key tokens. Bento bundles uBlock Origin
enabled by default and leaves it removable/disableable by the user.

## Design principles

### Workspace state is first-class

Tabs, panels, layout, saved panel affordances, and theme selection belong to the
workspace. Bento should treat that state as the user's working environment, not
as incidental UI state.

### Panels should stay browser-compatible

Panel content should behave like normal browser content. Extensions, page state,
keyboard behavior, history, media, and developer tools should work as close to
regular tabs as possible. When focus is inside panel content, `Cmd/Ctrl+Left`
and `Cmd/Ctrl+Right` navigate backward and forward in that panel's own page
history unless focus is inside an editable field. Plain Left/Right arrow keys
remain available to page content, including video scrubbing.

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
