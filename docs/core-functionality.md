# Bento Browser core functionality

Bento Browser is a workspace-first Firefox fork built around personalised
browsing layouts. Its main difference from conventional browsers is that a
workspace is not just a tab list: it is a reusable arrangement of the main tab
content plus any number of side panels and panel-hosted widgets.

The product goal is to reduce browser-window sprawl. Instead of opening several
windows and manually arranging them with the operating system, a user can keep a
task-specific "bento box" inside one browser window and switch to another box
when their context changes.

On first run with a fresh Bento profile, Bento shows an eight-step onboarding
dialog centered over the browser window, one topic per step. Every step shows a
row of progress dots, and every step after Welcome shows a "Step N of 7" count at
the top left of the dialog. Every step after Welcome has a Back action, so
earlier choices can be revisited. The steps are:

1. Welcome: a short introduction to Bento as a workspace-first browser built on
   Firefox, with a Get started action.
2. Appearance: Light, Dark, and Auto tiles, each with a small window preview
   (Auto shows a light and a dark half). The choice is applied to the dialog and
   the browser immediately, not when the user continues. Fresh profiles start on
   Light; Auto follows the operating system's appearance.
3. Theme: "Pick a colour theme", with one compact, low-fidelity preview of a Bento
   window drawn in a theme's own colours, from shapes only and no text: a
   titlebar of dots, a sidebar (a workspace circle, an address field, a short
   row and three tabs with the first active, then toolbar squares) and a content
   panel (a heading bar, a few lines and an accent button), in the dialog's
   current Light or Dark. The theme shows through the workspace circle, the
   active tab and the button; the rest is neutral. Below it are two rows
   of round colour swatches: Default and the eight standard themes, then the
   seven monochrome themes. Hovering or keyboard-focusing a swatch shows that
   theme in the preview and, under the swatches, its name and a one-line
   description, without changing anything; moving away shows the selected theme
   again. Clicking a swatch (or Space or Enter on it) sets the theme of the
   window's current workspace right away, and the dialog repaints in it; every
   workspace can have its own theme later. On narrow windows the preview gets
   shorter and the swatches wrap.
4. Import: one button per browser Bento found on this Mac among Chrome, Safari,
   Edge, Brave, Vivaldi, and Opera, each with the browser's logo, its name, and
   a chevron, in a grid of four columns. Choosing one opens the browser-data
   importer with that browser already selected. When a Mozilla Firefox or Zen
   profile exists, a "Firefox or Zen" button (marked "Restarts Bento", with a
   restart icon in place of a logo) takes the extra columns left in its row. The
   footer has Back, Skip, and Other sources, which opens the importer with its
   own first choice selected and is the way in to importing from files. While
   Bento is still looking the grid shows plain placeholders; with nothing found,
   the grid gives way to "No other browsers found on this Mac." and a file
   import line, and Other sources becomes the primary action; if the search
   fails or takes too long, the step offers a single Import browser data action
   instead of tiles. Opening the importer is one card: the onboarding dialog
   reshapes into the importer, and back when it closes, where onboarding
   continues at the Privacy step (with reduced motion, or when the window is
   resized meanwhile, the two cross-fade instead). Skipping goes straight to
   Privacy.
5. Privacy: Standard, Enhanced, and Hardened protection levels, each with a
   one-line summary. Standard is marked Recommended and is the default for fresh
   profiles. The choice is applied immediately, and a note under the levels
   says "Protection levels can be fine-tuned in Settings".
6. Search: Firefox's currently visible search engines, listed in two columns and
   scrolling inside the list when there are many. Each engine shows its icon
   (a search glyph when it has none). DuckDuckGo is already the default, and so
   preselected, on a fresh profile; a profile that has finished onboarding keeps
   whatever engine it has. Engines Bento recognises as privacy-oriented carry a
   Private tag. The choice is applied immediately, and a note under the list says
   "Add more search engines in Firefox's search settings".
7. Tour: a short introduction to workspaces, panels, and the command palette,
   each with a free-standing 3D illustration, one line of explanation, and its
   keyboard shortcut: switching workspaces, cycling between panels, and opening
   the command palette.
8. Ready: "You are set", a line saying Bento Browser can be customised any time
   in Settings, and an Open Settings button that closes the dialog and opens
   Settings. Start browsing closes the dialog.

The onboarding dialog is not dismissed by clicking the scrim or pressing Esc.
Only Start browsing and Open Settings end onboarding; until then it reopens on the next launch.
If Bento's settings are reset afterwards, onboarding opens again from Welcome.
On narrow windows the tile grids collapse to fewer columns and the dialog is
sized to the window minus a small margin.

Regular browser imports stay in-window. Full Mozilla Firefox or Zen Browser
profile imports use an explicit startup handoff because Firefox's profile-copy
migrator runs before the new profile is initialized. The Firefox or Zen button
says Bento restarts, and Bento returns to onboarding afterwards. Choosing it (or the
Firefox/Zen action inside the importer) restarts into the startup
migration wizard scoped to the detected Firefox and Zen profiles and preselected
on them, rather than a generic picker defaulted to another browser, and
onboarding resumes at the Privacy step after the restart. Empty Firefox/Zen
profile entries with no migratable resources are not offered. Zen imports also
translate Zen spaces into Bento workspaces and restore Zen tabs through Bento's
workspace-aware session restore as the import completes. Zen pinned tabs become
pinned Bento tabs. Zen essential tabs become pinned Bento panels. Chrome and
other regular browser imports in this flow use Firefox's native migration wizard
and are separate from the additive Bento backup import flow.

The sidebar footer exposes Firefox's native app menu and Firefox's native
downloads panel; it has no separate Settings or merge button. The app menu lists
"Bento Settings" directly above Firefox's own Settings item, and the command
palette has an Open Settings command; both open the Settings palette. Native footer panels are left-edge
anchored to their trigger buttons so they grow rightward when screen space
permits, and they open without Firefox's arrow-panel slide animation. The
native Bookmarks sidebar uses Bento-scaled title styling, matches the Bento
sidebar address field for bookmark search, and has its own resizable edge
separate from the main Bento sidebar. The manual "Merge browser session" action
opens from the command palette's "Merge browser session" command or from the
"Merge browser session" row in the Backup and data category of the Settings palette
(not shown in private windows); from Settings it opens over the same window. While a merge is running, a progress card floats over the
bottom of the sidebar's tab list, above the footer: a progress ring (with the
percentage inside once the tab totals are known), "Importing from" the source
browser, the space being imported with how many tabs are done, and the site last
opened. The card is drawn in the opposite colour scheme to the sidebar, a dark card
on a light sidebar and a light card on a dark one, and follows light, dark and Auto
as they change. The rows, and the search results while searching, keep scrolling
underneath it and the list leaves room so the last row or result can scroll clear.
Clicking the card reopens the merge progress view. When the merge ends the card
stays, as "Imported N tabs", "Import cancelled" ("N tabs added", counting only tabs
that were actually added) or "Import failed" with a short reason, until it is
dismissed with its close button or the next merge replaces it. In the narrow rail
the card is a round ring button above the footer; hovering or keyboard-focusing it
shows its title and detail in a tooltip beside it, and clicking it opens the merge
view and, once the merge has ended, also clears it. The card appears in the window
the merge was started from. The
merge action is a runtime, additive, one-way merge from another browser
profile's latest persisted session snapshot. Bento does not sync with or write
to the external profile. It
imports mergeable open tabs into new Bento workspaces, maps source tab groups or
tab folders to Bento tab folders when the source format exposes them, creates
those imported folders collapsed, preserves pinned tabs as pinned tabs, skips
URLs already open in Bento, and creates imported tabs asleep without activating
an imported workspace. Imported sites do not load until the user explicitly
opens their space or selects their tab.
Imported
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
progress view naming the source being imported. It starts with an indeterminate
loader while Bento reads the session, then shows the actual percentage plus
completed/total space and site counts. A scrolling activity log reports each
space as it starts and finishes and lists the title and hostname of each site as
it is added, including sites that could not be opened. The progress view also
has a Cancel button and a Close button that hides the picker without cancelling
the active import.
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
While another regular window stays open, closing a window keeps its tabs alive
there: the workspace's tabs and panels, and the hidden tabs of other workspaces
the window was holding, move to that window as hidden tabs of their workspaces, in
the order they had, so their pages keep their state, history, form text, and
playing media, and the workspace's pinned tabs stay pinned when a later window
shows it. Tabs with
nothing to keep (blank pages), pages that run in the browser's main process (such
as Settings), a private window, and a popup are not moved, and a popup or private
window never receives tabs. A page that closes its own tab closes only that tab.
When no other regular window is open, or the app is quitting, nothing is moved: the
tabs are kept as addresses and reopen when their workspace is next shown, and the
next launch restores each window as it was.
Deleting the workspace a window is showing moves that window to a workspace no
other window is showing, so one window never takes over another window's
workspace or its tabs. When every other workspace is open in another window, the
window closes with the deleted workspace's tabs.
A tab moved to another window, by dragging it out or choosing Move to New Window,
takes its page with it and joins the workspace shown in the destination window; a
panel moved that way becomes a regular tab there, and a new window opens with only
the moved tab or tabs, not an extra blank tab.
Closing a tab or panel whose page asks to stay (a leave-page prompt) and choosing
to stay keeps it in its workspace, folder, and panel slot. A sub-panel or
subdivision comes back as a regular panel at the top level of the layout. If the
window holding the tab switched to another workspace while the prompt was open,
the tab joins the workspace that window shows, as a regular tab even if it was a
panel. When the prompt blocks closing the tabs of a workspace that is being
deleted, the tab stays open without a workspace and is closed at the next launch;
deleting a workspace has nothing to roll back to.
In a single-window session, relaunch should reopen on the workspace that was
visible when Bento was quit. Tabs come back once, in the order they had, and a
window keeps the tab that was selected at quit when that tab belongs to the
workspace the window opens on (a sidebar tab or one of its panels); if it belongs
to another workspace, the window selects that workspace's first tab instead.
Relaunching does not open a second copy of a tab Firefox restored. Panels and
pinned panels come back in their slots, each with its own width and page, without
an extra tab or a second copy of the panel. The one exception is the first launch
after upgrading from a build that saved panel markers without a panel key: a
pinned panel can come back twice, and the extra copy stays on every later launch
until it is closed. A workspace whose window was closed before quitting reopens
its tabs and panels the next time it is shown.
Panels, pinned panels, and tabs from private windows are never written to the
saved panel layout, the pinned panel rail, or the tabs kept when a window closes.
Their URLs, titles, favicons, and panel slots do not come back after relaunch,
matching Firefox private-browsing behavior.

A private window has its own temporary workspace named "Private". Its sidebar,
command palette and address bar work as in a regular window, and its tabs and panels
belong to that workspace. The Private workspace is never saved, never appears in
another window's workspace list, switcher or palette results, and is discarded when
the window closes; a private window lists no other workspace. It cannot switch to or
create workspaces, create folders or pin panels, move tabs between workspaces, or use
backups and session merge. Opening a private window never changes which workspace a
regular window shows.

A private window keeps its own sidebar state. Collapsing or hiding the sidebar
(the collapse button, Cmd+S) and switching the colour mode (the footer colour
control) change that window only, and none of it is saved. A new private window
starts from the saved values at the moment it opens, then changes on its own; a later
change in a regular window does not reach a private window that is already open,
and a private window's change never reaches a regular window, another private
window, or the saved settings. Regular windows keep sharing the saved settings.

A private window's sidebar is marked by an inverted block at the top, in the place of
the workspace switcher: a mask glyph with "Private" over "Nothing here is saved."
Activating it opens a short note ("Private window: Tabs and panels are not saved.
Closing the window discards them."). In the collapsed rail the block is the glyph
alone, and the note shows beside it on hover or keyboard focus. The glyph stays where the
rail centres it, so collapsing or expanding the sidebar does not move it: the text beside
it is clipped away as the sidebar narrows and revealed as it widens, at full strength. The
block starts level with the top of the main panels. The window always uses
the default theme. It has no workspace switcher, no pinned panel rail, no "Edit this
workspace", no theme picker, no "Pin this panel" or "Save panel" item, no workspace or folder
entries in the tab menu, and its command palette lists no workspace commands and no
session merge.

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

Backup creation never serializes private-window tabs, panels, layouts, pins, or
derived counts. Backup actions are unavailable from private Settings windows.
New stored backups carry a `private-filtered-v1` safety marker; older version-one
records remain readable but are shown as `legacy-unknown` rather than being
silently treated as verified.

The sidebar tab list supports multi-selection for workspace organization.
The tab list exposes `New tab` and `New panel` buttons. In expanded sidebar
mode, `New tab` opens the centered address/search overlay in new-tab mode,
creating the tab only after the user commits. In collapsed sidebar mode, it
opens the same centered address/search fallback. `New panel`
opens a blank panel in the active workspace. A
search icon beside those controls widens on hover or keyboard focus to show its
"Search tabs" label, and expands into a sidebar search field over the action row. The creation and search controls stay fixed immediately below the
sidebar address row while tabs, pinned tabs, and folders scroll beneath them,
so the actions remain available anywhere in a long tab list. Typing filters
open tabs and side panels across all
workspaces by title or web address, and a pasted full address such as
`https://github.com/andrew` finds its tab. The field has a clear
button that empties a typed query and keeps the field open; on an empty field
the same button closes search, like Esc. While a query is active, the sidebar shows only the
search field and matching result rows; normal tabs, folders, pinned sections,
and creation controls are hidden until the query is cleared or search closes.
In the collapsed rail, Search is a square directly under New, with the same hover
highlight and no label. The rail's squares (the workspace button, New, Search and the
first tab) sit one equal gap apart. Pressing it expands the sidebar and opens the search field
focused. Collapsing the sidebar with the field open folds it into that square: the
placeholder, query and clear button fade, the results give way to the tab rows,
the field shrinks toward the Search button at the right end of its row, and that
square then glides to its slot under New as the rows shift down one slot, never
passing over New. An empty field is simply closed. A typed query is kept
("parked"): the square then shows a ring and a small dot, and expanding the sidebar
again by any means reopens the field with that query and its results: the square
glides back to the right end of the row and unfolds leftward into the field. Reversing
either move midway carries on from where the field is. Esc, the
clear button and choosing a result clear the query as before, and switching
workspace keeps a parked query. With reduced motion on, none of it moves; the
rail simply shows or drops the ring and dot.
Each result shows the page title with the site's domain beneath it in smaller,
muted text. Pages without a web domain, such as extension pages, show the title
alone in a standard-height row, and built-in `about:` pages show their address.
Results identify each result's workspace with its workspace icon or initial,
tint the workspace marker with that workspace's theme, and selecting a result
switches to that tab or focuses that panel. When pinned
tabs exist, those tabs remain part of the scrolling list below the fixed controls.
Workspace tabs can be grouped into collapsible tab folders from the sidebar
context menu. Folders live below pinned tabs and above the regular tab section,
can be renamed, deleted, collapsed, expanded, and reordered among themselves,
can be moved to another workspace from their context menu, and persist across
restarts. Tabs inside folders remain normal unpinned Firefox tabs. Folder names
are not directly editable by clicking the row; rename starts from the folder
context menu and opens an inline field that is immediately ready for typing.
Each folder row shows its tab count at the right, in neutral-50 text smaller
than the folder name.
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
Hovering a tab or folder row in the sidebar list shows one neutral highlight
that glides from row to row and fades out when the pointer leaves the list. It
is hidden while dragging a row and does not slide when the user has asked the
system to reduce motion. The New and Search buttons above the list share that
look with their own highlight, which glides between the two buttons and stays
inside the action bar (in the rail, between the New and Search squares); moving into
the list fades it out as the row highlight fades in. It is hidden while Search is open.
When a regular sidebar tab is playing audio, the row shows a speaker button
before the favicon. Clicking it mutes the tab; muted media tabs keep the button
so the user can unmute them from the sidebar.
When a side panel is playing audio, its panel header shows the same mute control
after the refresh button and before the address field.
Audible side panels also emit small music-note particles from their panel
navigator favicon buttons; multiple panel buttons can show this at once.
Idle-tab sleep never unloads a tab that is playing audio or sharing the camera,
microphone, or screen, so background music and calls keep running. Once it goes
quiet, the normal idle rules apply to it again.
When a workspace contains pinned regular tabs, the sidebar separates that group
from the New menu and regular tabs with a divider instead of a text
subheading.
After a restart, pinned tabs show as unloaded (sleeping) in the sidebar within a
moment of the restore and stay unloaded until first opened, like other restored
tabs. The same holds for a window restored later, such as a reopened closed window
or a restored session. The pinned tab that was selected at quit and pinned tabs shown
as panels in the workspace load at launch. If Firefox's restore-on-demand
settings for pinned tabs are turned off, pinned tabs load at launch and none is
shown as unloaded.
A sidebar tab keeps its website favicon. When there is none to show, or the tab is
in one of these states, its row shows a state icon instead and, for the failures, a
faint status background: Default (the page has no favicon), Sleeping (unloaded), Unavailable
(a site that cannot be reached, including an HTTPS-Only error page), Certificate
warning, Blocked (a blocked site), Crashed (the tab's content has crashed, until it is
reloaded or restored) and Internal settings (`about:config` and `about:preferences`,
whatever the section). Unavailable, Certificate warning, Blocked, Crashed and Internal
settings tint the row; Default and Sleeping do not, and the current and selected
tab fills cover a tint. A loading tab keeps the progress circle and has no tint.
Settings, under Tab appearance, turns the tints and the icons off separately.
Recently closed regular tabs should reopen with Firefox's standard
`Cmd+Shift+T` flow or the sidebar "Reopen closed tab" menu item.
Bento replaces Firefox's native horizontal tab strip with its workspace/sidebar
tab UI, while retaining the operating system's native window controls in the
top chrome. Firefox's Browser layout and native sidebar choices are omitted from
Tabs and browsing because Bento owns both visible tab layout and sidebar
visibility.

The workspace switcher should behave like a lightweight anchored menu. Opening
it should leave the current browser content visible behind the menu rather than
covering the window with an opaque overlay. Its trigger sits at the top of
the sidebar, immediately above the URL address field. Floating music
notes beside a workspace avatar identify a workspace with audible, unmuted
audio; the animation appears on the current-workspace trigger and on every
matching row in the switcher menu.
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
active states so mouse and keyboard navigation both have visible feedback: one
highlight slides between rows, and the pointer and the arrow keys move that same
highlight, so there is never a second one. The command palette, address bar and Settings
palette use a darker row highlight in both colour modes. Rows
include command titles, supporting descriptions, icons, and contextual metadata
such as current/active markers or workspace shortcut hints where applicable.
Command-palette search fields use a visible "Clear" button instead of an
icon-only clear affordance. While you type, a Settings group lists the settings
that match by name (not in the empty palette, and without their values);
choosing one opens the Settings palette at that setting: on its own list for a
number, choice, search engine, privacy or shortcuts setting, and on the
category with its name typed in for a switch. A private window's results leave
out the backup settings.

In expanded sidebar mode, the main address/search entry is a persistent row
at the top of the sidebar above the tab list. It mirrors the active main
tab's URL, loading state, Firefox security identity state, and regular Firefox
bookmark state, with one-click actions to copy the current URL or toggle the
regular bookmark state. The copy action shows a `Copied` tooltip after the URL
has been written to the clipboard. Clicking the row, or pressing `Cmd/Ctrl+L` or
`Cmd/Ctrl+E` while the expanded row is on screen, opens Bento's address entry as
the row growing: the field sits exactly over the row, with the same height, a
search icon where the lock sits, and the address text starting where the row's
address starts. The row's right and bottom edges grow into the search field's
clear button and engine picker and the suggestion list, which extend beyond the
sidebar over the panel strip and main content slot (with reduced motion on, it
opens at full size). The row's outline fades out as the field's outline fades in, and
back when it closes, so only one outline shows. The current address is selected, so typing
replaces it.
`Cmd/Ctrl+T`, `New tab`, a collapsed or hidden sidebar, and any fallback path
that reaches Firefox's hidden native top address field open the centered
address/search overlay instead of showing Firefox's native suggestion dropdown.
The field uses the sidebar tab row text size on a neutral-5 surface and keeps
its neutral border when clicked or focused. The fixed creation/search row sits
directly below the address field with the same resting gap used above the
address field below the workspace switcher. Only the tab and folder rows scroll;
the address and action rows remain visible. The native
top URL/search field, stock toolbar app-menu button, stock toolbar downloads
button, and stock toolbar Account menu are hidden in normal Bento windows while
the remaining toolbar buttons and native window controls remain visible without
a bottom separator line. On macOS, that native control row has a small top inset
from the window edge. With no side panels visible, the main background and
toolbar are neutral-5 and the sidebar's right divider is hidden. When side
panels are visible, the toolbar segment over the sidebar keeps the sidebar's
neutral-5 background while the toolbar segment over the main content and panel
strip uses the same neutral-14 backdrop as the panel strip, with the sidebar's
right divider extending through the native top toolbar to the top of the
window. The native Back, Forward, and Reload/Stop controls sit on the sidebar
side of that divider when it is visible and track the sidebar edge as the
sidebar is resized. The expanded sidebar cannot be manually resized narrower
than the point where those native controls stop moving left, so the divider
never slides underneath them. In collapsed sidebar
mode, those same actions open the existing floating address/search fallback, as do
`Cmd/Ctrl+L` and `Cmd/Ctrl+E`.
`Cmd/Ctrl+S` minimizes the sidebar. Settings controls whether that shortcut
collapses the sidebar to the narrow rail or hides it from layout. Collapsing,
expanding, hiding and showing slide the sidebar and the page together as one strip,
with the toolbar controls and the divider moving with them; the strip itself does not
fade. With no side panels open, a collapse or expand also resizes the page continuously
with the sidebar's edge, in step with it, instead of sliding it in at its final size. In a window with side panels the collapsed rail takes the toolbar's colour, so the
window controls, the rail and the gap around the page read as one surface with no divider
line on the rail's right edge; the colour fades in and out with a collapse or expand and
stays as it is without side panels. While the
sidebar's edge moves on a collapse or expand, its contents reorganise in place, one
after another from the top: the workspace avatar, the New button's plus and each tab's
favicon move to their rail places, the address bar folds away under the rising tab
list, the Search square travels with the sidebar's edge to its slot under New, names, labels and row buttons fade, the workspace card's fill and outline fade, the active tab's highlight retracts to its
rail square, and the footer buttons gather into the rail's column, toggle first. An
expand plays the same in reverse. With reduced motion on, the change is instant. In hidden
mode, hovering the left edge of the browser window slides the collapsed rail
over the page without pushing content; pressing the shortcut again restores the
expanded sidebar.

Opening the address entry with an empty field refreshes Recently Closed, Recent
History, and Top Sites, in that order, with up to two rows each. Recently Closed
contains tabs closed in the current window and reopens the selected native
session, including its back/forward history. History and top-site rows navigate
to their addresses. Reopening an ordinary closed tab or pinned panel preserves
its workspace, folder and custom title while they still exist. If its workspace
was deleted, it joins the current window's workspace; deleted or moved folders
are dropped. Closed panels return as panels when their workspace still exists.
Empty or unavailable groups are omitted. A closed tab that
is no longer available reports that status and refreshes the suggestions.
In new-tab mode, if the clipboard contains a web URL, a result below these groups
offers to open that URL from the clipboard. This follows Firefox's "Clipboard" address bar
suggestion setting (`browser.urlbar.suggest.clipboard`): when that setting is
off, Bento does not read the clipboard when the address entry opens. Saved panels follow the clipboard suggestion and open as side panels. Typing hides these default clipboard and saved-panel rows. After
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
The address palette matches the command palette's hover, keyboard-focus and pressed
row states, with one moving highlight. Its Clear button is reachable with Tab.
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
- manage labelled custom panel width presets in Settings, reorder them by drag
  or keyboard, and remove individual sizes with a native destructive action;
- adjust Bento corner roundedness with a labelled slider in Settings (0 to 36 px,
  default 12 px); it rounds the main content, with or without side panels, and
  every panel the same amount;
- adjust Bento splitter size with a labelled slider in Settings, which also
  changes the visual gap between panels.

Side-panel and sub-panel headers sit on a neutral-5 surface and can be hidden
per panel from the header's `...` menu. Hidden headers are restored from a small
grey handle at the panel's top center. This state persists across workspace
switches and restarts. The main content slot does not expose this header action.

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
- pinned panels reachable from a favicon rail beside the sidebar tabs, with each
  button using the destination workspace's switcher colour, reopening at their
  remembered width after they have been closed, and drag-reorderable within that
  rail. The rail meets the top workspace-switcher section without an overlapping
  decorative corner.

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
- Firefox's native app menu and downloads panel remain reachable from the
  sidebar footer, and the app menu's "Bento Settings" item opens Bento Settings;
- Firefox's persistent native sidebar launcher and its generic toolbar toggle
  stay hidden because Bento owns that surface; explicit native panels such as
  Bookmarks and History remain available through their dedicated commands;
- panel navigator controls sit in the native top toolbar flush with the sidebar
  divider after the native reload button and track that divider during live
  sidebar resize when panels are visible, match the native toolbar buttons'
  control size, the toolbar and panel-strip backdrops
  switch to neutral-14 on the main-content side of that divider in panel view
  and neutral-5 with no divider in no-panel view, while browser extension
  buttons align to the right side of the top bar without Firefox's native
  post-tabs spacer gap, the native bookmarks
  toolbar starts at the panel-strip edge instead of spanning or pushing down
  Bento or Firefox-native sidebars, Firefox-native sidebars such as Bookmarks
  remain independently resizable, and the panel-strip scrollbar stays in the
  bottom inset of the strip with the same visible thickness as the splitter
  handles and equal top/bottom clearance; side-panel favicon buttons remain
  drag-reorderable from that top toolbar while unused top-bar space remains
  available for moving the browser window, and rapid clicks on previous/next
  cycle panels without changing the window state;
- sidebar footer icon buttons show Bento tooltips on hover;
- the divider between the fixed main content slot button and draggable
  side-panel buttons is centered in their shared gap;
- panel navigator buttons show Bento tooltips with their panel names; the
  main content slot uses the current page title;
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
- a grouped selector containing Bento's Default palette plus the standard and
  monochromatic palettes shipped by `@muxui/react/themes`;
- per-workspace theme selection;
- light, dark, and Auto UI modes; switching presents the sidebar, toolbar,
  Settings, menus and palettes together on the theme's state motion. A rapid
  reversal continues from the current progress. Reduced motion switches after
  the same readiness barrier without playing a fade. Web pages keep live
  visuals, execution and input; native OS menus and window controls remain
  system-owned;
- independent content color-scheme preference where possible;
- user customization through token-based theme presets.

The goal is not decorative skinning alone. Themes should help users recognize
the active workspace quickly and make long-lived browsing contexts comfortable
to use.

### Privacy And Search

Bento exposes privacy as a first-class browser setting instead of hiding it
behind `about:config`. The selectable protection levels are:

- Standard: balanced Bento defaults with strict Firefox tracking
  protection, tracker-cookie partitioning, Global Privacy Control, query
  stripping, remote search suggestions off, speculative networking off, local
  Safe Browsing checks on, HTTPS-only mode, and DuckDuckGo as the
  fresh-profile search default (a profile that already finished onboarding
  keeps its current engine).
- Enhanced: Standard plus resist fingerprinting and tighter WebRTC IP handling
  (your local network address is hidden during calls).
- Hardened: Enhanced plus letterboxing, WebRTC peer connections off, DRM off,
  disk cache off, WebGL/WebGPU off, password/form saving off, local Safe
  Browsing retained, the Referer header sent only when the hostname matches exactly, and
  cookies, site data and cache cleared when Bento quits (history, downloads and
  form data are kept).

A fresh profile starts on Standard: Bento applies it at the first launch only,
before onboarding finishes, so Settings marks Standard as the current level and the
onboarding privacy step can change it. Later launches, and profiles that already
existed, are left as they are. A profile that turned "Clear cookies and cache on
shutdown" on before the clearing was narrowed to cookies, site data and cache keeps
Firefox's broader clearing (history, downloads and form data too) until the switch
is turned off and on once.

Custom is a detected state, not a selectable preset. Bento shows Custom when
the live browser settings no longer exactly match Standard, Enhanced, or
Hardened.

Remote Safe Browsing download reputation is a separate advanced toggle rather
than a preset value. It remains off by default and, when enabled, clearly states
that Firefox may send eligible-download and redirect URLs, the original referrer
when available, file name, size, SHA-256, locale, and signing or certificate
metadata to Google Safe Browsing for an online verdict. Switching presets does
not reset the toggle or make an otherwise matching preset appear as Custom.
Firefox's HTTPS exception UI remains available for HTTP-only sites and local
devices.

Bento Settings is a quick-pick palette over the window, not a page. The app menu's
"Bento Settings" item, the command palette's Open Settings command, and the
onboarding dialog's Open Settings button open it; the command palette's
Privacy command opens it on the protection level list, and a matching setting
in the command palette's results opens it at that setting inside its category. The first
list contains categories with short descriptions: Appearance, Performance, Workspaces,
Panels, Privacy and search, Backup and data, Keyboard shortcuts, and Reset Bento.
Each category opens its controls with their current values; Keyboard shortcuts opens its
reference directly. Search settings finds individual controls, advanced privacy settings
and shortcuts across categories; a category's filter searches only its children. Opening
a search result keeps the category in the path. Enter flips a switch (the row shows the new state at
once and returns to the old one if the change cannot be saved) or opens a short
list of choices, which opens on the current choice. A number with a wide range
(Sleep tabs after, Backup interval, Default new panel width, a custom size) opens a value
field with preset rows (Min, Default and Max sit beside the number); the value applies live
while typing (panel corners move as you type) and while arrowing over the presets, Enter
keeps it, clicking a preset keeps it and returns to the list, and Back or Esc puts the
previous value back. A number with a small range (Keep alive per workspace, Panel corner
radius, Panel gap and splitter size, Backups to retain; at most 50 steps wide) opens a
slider instead, with the thumb focused: the value and its unit show above the track, and
"Default N" and the range show under it. Dragging, a click on the track or the arrow keys apply
the value live (the panel corners follow the thumb, which glides between values on a key press
or a click on the track and follows the pointer exactly while dragged), Page keys move it by a tenth of the range, Home and End jump to the ends, Enter keeps
it, and Back or Esc puts the previous value back, as on the field pages. A screen reader
announces the value with its unit.

Tab appearance comes after Appearance. Show tab state tints and Use custom tab state icons
are independent switches, both On by default and saved for the whole profile. Turning
tints off removes the status backgrounds; turning custom icons off restores Bento's
loading indicator, website favicon or empty placeholder. Sleeping-tab styling and
titles keep following the actual tab state.

Every list where a value or choice changes (each number, the choices,
protection level, default search engine, custom panel sizes and their actions, Advanced
privacy, Backups and a stored backup, and each confirmation) opens with a short plain
description of what the setting does, between the path and the field. It is static text:
it does not scroll with the list and takes no focus, and a screen reader reads it with the
field. The category root, category control lists and keyboard shortcuts have none. Where the options of a list
behave differently (the choices, the protection levels, each Advanced privacy row, the
size actions, the Backups rows and a stored backup's actions) every option carries a
second, always visible line saying what it does, and the highlighted protection level
still adds its benefits and caveats in two columns below that. Search engines and number
presets have no second line. A list of four rows or fewer (including small categories, choices, protection level,
a stored backup, size actions, a confirmation) has no search field: Up and Down move
through it, Enter picks, and Esc and Back work as before. A confirmation puts what it does in that description, above
its Cancel and confirm rows.

Settings is the size of the command palette and keeps it on every list. A bar above
the search field holds Back, the path to the current list (every level before it is
a button that goes straight there) and Close. Esc, Back and Backspace in an empty
field all step back one list; Esc first clears a search, and from the first list Esc
closes the palette, and opening it again starts at the first list. When the command
palette opened Settings (its Open Settings command or a Settings result), the path
starts with "Command palette" and Back from the first list returns there, with the
query it had; from the app menu or onboarding Back is unavailable on the first list.
Going back lands on the row that opened the list, Tab cycles through Back, the path,
Close and the field (and Clear while a search is typed), and the footer says what Esc
does in the current state. A list slides in from the side it was reached from.
Settings changed in one window appear in the Settings palette of every other window.

The protection level list shows the current level and the benefits and caveats
of Standard, Enhanced, and Hardened, so users can compare compatibility impact
before switching; Custom is shown as detected state only. The default search
engine list offers Firefox's currently visible search engines (DuckDuckGo is
Bento's default for a fresh profile; a profile that already finished onboarding
keeps its current engine) and a "Manage search engines" row that opens Firefox's
own search settings to add more. Advanced privacy lists the main browser-level
levers as switches and choices; the shutdown switch clears cookies, site data
and cache when Bento quits and keeps history, downloads and form data, and
HTTPS-only mode's Off and Always apply to normal and private windows. When a
privacy change is saved but Firefox could
not apply it, the palette says so. The first-run onboarding privacy step lists
each level with a one-line summary and marks Standard as recommended, and its
search step shows each visible engine's icon and tags privacy-oriented ones as
Private when Firefox exposes them. The Keyboard shortcuts list is searchable
and shows each command's title and key tokens, and the Sidebar collapse type
setting chooses whether `Cmd/Ctrl+S` collapses the sidebar to the rail or hides it with
left-edge hover access. Bento bundles uBlock Origin enabled by default and
leaves it removable/disableable by the user.

Backup and data contains the automatic backup controls, an Export, import and stored
backups list, and Merge browser session. The backups list offers Export (a file download),
Import (choose a file, review what it holds, then confirm), stored backups (restore and delete, each with a
confirmation) and Merge browser session, which opens the merge palette. The Reset Bento
category contains Reset Bento settings, which asks for confirmation, restores Bento settings, the protection
level and the search engine to their defaults, and closes the palette so the
onboarding dialog can open again. Operations that take time keep running if the
palette is closed, and reopening Settings reports how an operation ended if it
finished (or was cut short by Bento restarting) while the palette was closed or
reloading. Import accepts backup files up to 10 MiB. A number being edited is put
back if the palette is hidden before the edit is kept. A private window's Settings palette has no backup, merge or
reset rows; its Bento color mode is that window's own and is not saved, and any
other setting changed there is saved for the whole profile as usual.

Firefox's own Settings page (`about:preferences`) has no Bento category; the
Settings palette is the only place Bento's settings live.

Bento has no automatic updater yet, so the About page shows no Updates section
(no heading, description, or status message); it keeps the support links.

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
