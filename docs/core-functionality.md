# Bento Browser core functionality

Bento Browser is a workspace-first Firefox fork built around personalised
browsing layouts. Its main difference from conventional browsers is that a
workspace is not just a tab list: it is a reusable arrangement of the main tab
content plus any number of side panels.

Bento is currently built for macOS on Apple silicon; Intel Macs, Windows and
Linux are planned.

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
   restart icon in place of a logo) takes the columns left in its row, or two
   columns of a new row when the row is full. The
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
Only Start browsing and Open Settings end onboarding; until then it reopens on the next launch
at the step the user last reached.
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

The expanded sidebar footer holds Collapse sidebar, Open command palette, a
colour-mode button that cycles through Light, Dark and Auto, Firefox's native app
menu and Firefox's native downloads panel, in that order; it has no Bookmarks,
Settings or merge button. The app menu lists
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
percentage inside while progress is between 1% and 99%), "Importing from" the
source browser, the space being imported with how many tabs are done, and the site
last opened. Before the tab totals arrive the card reads "Preparing import" with the
browser's name, and at the end of the run "Finishing import". The card is drawn in the opposite colour scheme to the sidebar, a dark card
on a light sidebar and a light card on a dark one, and follows light, dark and Auto
as they change. The rows, and the search results while searching, keep scrolling
underneath it and the list leaves room so the last row or result can scroll clear.
Clicking the card opens the merge picker: while a merge runs it shows the progress
view, and after the merge has ended it shows a freshly scanned list of sessions.
When the merge ends the card stays, as "Imported N tabs" (with a line such as
"From Chrome, 3 spaces" beneath it), "Import cancelled" ("N tabs added", counting only tabs that
were actually added) or "Import failed" with a short reason, until it is dismissed
with its close button or the next merge replaces it. In the narrow rail
the card is a round ring button above the footer; hovering or keyboard-focusing it
shows its title and detail in a tooltip beside it, and clicking it opens the merge
picker and, once the merge has ended, also clears the card. The card appears in the
window the merge was started from. The
merge action is a runtime, additive, one-way merge from another browser
profile's latest persisted session snapshot. It reads Firefox, Zen Browser,
Chrome, Chromium, Brave, Microsoft Edge, Opera and Vivaldi profiles; Safari is not
a merge source. Bento does not sync with or write
to the external profile. It
imports mergeable open tabs into new Bento workspaces (HTTP, HTTPS, file and FTP
addresses; browser new-tab pages and unsupported internal pages are skipped),
maps source tab groups or
tab folders to Bento tab folders when the source format exposes them, creates
those imported folders collapsed, preserves pinned tabs as pinned tabs, skips
URLs already open in Bento and every repeat of an address after its first
occurrence in the import, and creates imported tabs asleep without activating
an imported workspace. Imported sites do not load until the user explicitly
opens their space or selects their tab.
Imported workspaces are one per source space or window, named "Browser: space
name" (or "Browser: window title", and for a window without a title the browser,
profile and window number), with " (imported)" added when the name is taken, then
" (2)", " (3)" and so on when that is taken too; a workspace that ends up with no tabs is dropped.
Imported
workspaces use
Bento's normal restart persistence, so their tabs remain assigned to those
workspaces after relaunch. If Bento finds a browser profile but cannot read or
import its session snapshot, the profile remains in the merge picker as an
unavailable row instead of disappearing, including when other browser sessions
are mergeable. The merge picker includes a refresh button so the user can
rescan browser session snapshots without closing and reopening the picker.
A search field filters the sources, spaces and windows by name, and matches tab titles
and URLs within the first ten preview tabs of each space or window.
Each source row shows its browser and profile, how long ago the session was saved, and
an Import all button. Readable sources also show their window, tab and group counts;
an unavailable source shows the reason instead, and its Import all button is disabled.
Readable sources can be expanded to show importable spaces or windows. Each
space/window starts with its tab preview collapsed; expanding it shows up to 10
tab titles and URLs plus an "X more tabs" count, and it has its own Import button
to import it instead of the whole browser session. If no tab can be imported
from a selected source, space, or window, the picker says why, for example "All
tabs from Chrome are already open in Bento.", and the sidebar card ends as Import
failed with that reason, instead of silently doing nothing. While an import is
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
Cancel buttons are the visible actions. After progress completes, the picker shows
"Created N workspaces, added N sleeping tabs, skipped N duplicates" and the user can
dismiss it with the Close button, backdrop, or chrome close control.

## Core model

### Workspaces

A workspace is a named browsing context for a current mode of work: research,
writing, operations, planning, personal browsing, or any other persona the user
wants to preserve.

Each workspace owns:

- its regular tabs;
- its panel layout;
- pinned-panel references;
- its selected visual theme;
- persisted layout state such as panel order, widths, subdivisions, and scroll
  position.

Saved panels are reusable targets shared across regular workspaces. They are
separate from workspace-owned pinned panels and from Bento's Bookmarks collection.

The main content slot width is also workspace-specific. Resizing the main
content area in one workspace should not resize the main content area in another
workspace. Until a workspace has its own resized main width, the main content
slot keeps at least the configured default new-panel width while side panels are
added.

Each regular window shows a different workspace. Choosing a workspace that is
already open in another window brings that window forward. A new window takes an
available workspace, preferring the saved last-active one and then the oldest
available workspace; if every workspace is already open, Bento creates a new one
for the window.

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
workspace or its tabs. When every other workspace is open in another window,
deleting a workspace that has tabs closes its window with those tabs; deleting an
empty one gives that window a new workspace.
When the last regular tab of a window's workspace closes and no panel remains to
take its place (see Panels), Bento deletes the empty workspace and switches the
window to another available workspace. If every other workspace is already shown in
another window, Bento closes the window and keeps the empty workspace available for
a later window.
The Bento sidebar has no Move to New Window item and no drag-out gesture. A tab that
reaches another window some other way (with Firefox's native tab strip turned on, or
through an extension) takes its page with it and joins the workspace shown in the
destination window; a panel moved that way becomes a regular tab there, and a new
window opens with only the moved tab or tabs, not an extra blank tab.
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

Workspace export and automatic backups save the workspaces' available tabs and
panel layouts (panel order, panel and main content widths, subdivisions and
split-panel ratios), open pinned panel references and their remembered widths,
saved panels, settings, and the panel-strip scroll position. They are not a
complete copy of restart state: tab folders, hidden panel headers, closed
pinned-panel targets, tabs and panels waiting to be restored, and Bento's
Bookmarks collection are not included.
Import adds the file's workspaces alongside the existing ones, and also applies
any settings and saved panels the file includes. Restoring a stored backup adds
its workspaces but leaves the current settings and saved panels unchanged. The
Settings palette does not offer a replacement import. Opening a stored backup
shows Restore and Delete actions, and both ask for confirmation before they run.

Backup creation never serializes private-window tabs, panels, layouts, pins, or
derived counts. Backup actions are unavailable from private Settings windows.
New backups exclude private-window data; older stored backups remain readable but
show "This backup predates private-data filtering. Its privacy safety is
unknown." rather than being silently treated as verified.

The sidebar tab list supports multi-selection for workspace organization.
The tab list exposes a New button that opens a menu with New tab and New panel, in
the expanded sidebar and the collapsed rail. New tab opens the centered
address/search overlay in new-tab mode, creating the tab only after the user
commits. New panel opens a blank panel in the active workspace. A
search icon beside those controls widens on hover or keyboard focus to show its
"Search tabs" label, and expands into a sidebar search field over the action row. The creation and search controls stay fixed immediately below the
sidebar address row while tabs, pinned tabs, and folders scroll beneath them,
so the actions remain available anywhere in a long tab list. Typing searches
open tabs and side panels across all regular
workspaces by title or web address, and a pasted full address such as
`https://github.com/andrew` finds its tab. Results follow workspace order and then
tab order, with at most 50 shown, and Enter opens the first result. The field has a clear
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
tint the workspace marker with that workspace's theme, and carry a Tab or Panel tag
and a close button; selecting a result
switches to that tab or focuses that panel. When pinned
tabs exist, those tabs remain part of the scrolling list below the fixed controls.
Workspace tabs can be grouped into collapsible tab folders from the sidebar
context menu. Folders live below pinned tabs and above the regular tab section,
can be renamed, deleted, collapsed, expanded, and reordered among themselves,
can be moved to another workspace from their context menu, and persist across
restarts. Tabs inside folders remain normal unpinned Firefox tabs. Folder names
are not directly editable by clicking the row; rename starts from the folder
context menu and opens an inline field that is immediately ready for typing.
Each folder row shows its tab count at the right in muted text.
Deleting a folder returns its member tabs to the regular section.
Dragging a normal tab into the pinned run pins it; dragging a pinned tab below
that run unpins it. Dragging a tab onto a folder places it in that folder; pinned
tabs dragged onto folders are first converted back into normal tabs.
When the active tab is inside a collapsed folder, Bento shows that active tab as
a single peek row beneath the folder.
Users can Cmd/Ctrl-click individual tabs or Shift-click a range, then right-click
the selected group to reload those tabs together, move them to a new or existing
workspace or to a folder, or close them (the menus are listed under Keyboard and
menu reference).
When multiple tabs are selected, Cmd/Ctrl+W closes the selected tabs and the
right-click menu exposes the same close-selected action. The selected rows leave
the sidebar together. A tab that asks to confirm leaving (a page with unsaved
changes) and is kept stays in its workspace while the others close.
Right-clicking the sidebar exposes "Select all tabs", which selects every tab row
shown in the list, pinned tabs included; tabs inside a collapsed folder are not
selected, except the current tab shown beneath its folder.
Right-clicking the sidebar exposes "Reopen closed tab", which restores the most
recently closed tab through Firefox's recently closed tabs flow.
Right-clicking a single sidebar tab exposes tab actions, including creating a
new tab immediately below the clicked tab, unloading an inactive loaded tab,
pinning or unpinning the tab, and muting or unmuting it. Tabs can also be closed
individually, or closed in groups with Close tabs above, Close tabs below, and
Close other tabs. Close tabs above and below act on the rows shown, pinned rows
included; Close other tabs preserves pinned tabs and the clicked tab. Any tab,
including the current one, can be renamed from its menu or by double-clicking its
row; clearing the name restores the page's title. An inactive tab can also be
converted into a side panel from the menu. Hovering a row shows Convert to panel
(not on the current tab) and Close tab buttons, and middle-clicking a row closes
it.
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
When a side panel is playing audio, its panel header shows a mute control after the
address, bookmark and pin controls and before Close and Panel options.
Audible side panels also emit small music-note particles from their panel
navigator favicon buttons; multiple panel buttons can show this at once.
Automatic tab sleep is on by default after 30 minutes of inactivity and keeps the
three most recently used tabs per workspace awake. Active tabs, pinned tabs and
visible panels in active workspaces stay awake. Tabs playing audio or sharing the
camera, microphone, or screen also stay awake, so background music and calls keep
running; once it goes quiet, the normal idle rules apply to it again. Performance
settings can turn sleep off, set the delay from 1 to 1,440 minutes, and keep
between 1 and 50 recent tabs per workspace awake.
When a workspace has pinned tabs or folders, they sit on a filled band at the top
of the list, above the regular tabs. There is no text subheading.
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
warning, Blocked (a site blocked by Safe Browsing, parental controls or an organization's
policy), Crashed (the tab has crashed or Firefox requires a browser restart, until it
is reloaded or restored) and
Internal settings (`about:config` and `about:preferences`,
whatever the section). Unavailable, Certificate warning, Blocked, Crashed and Internal
settings tint the row; Default and Sleeping do not, and the current and selected
tab fills cover a tint. A loading tab normally keeps the progress circle and has no
tint; Crashed takes precedence even if the tab still reports loading. These
states describe the page Firefox is actually showing, so a website that happens to use a
Firefox warning icon as its favicon still shows its own favicon, and a crashed tab keeps
its Crashed state when it is moved to another window.
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
The switcher menu lists the workspaces with a check on the current one, then New
workspace, Edit all workspaces, Edit this workspace and, when more than one
workspace exists, Delete followed by the current workspace's name.
Editing a single workspace lets the user rename it, set or clear its icon with
the same searchable full emoji picker used by the all-workspaces manager, and
choose a theme with the same compact searchable theme picker used there; the
editor has Cancel and Save.
"Edit all workspaces" opens an "Edit workspaces" dialog
where every workspace can be renamed, re-iconed from the first column with a
searchable full emoji picker with icon category tabs and subgroup sections,
cleared with the icon control's overlaid close button, re-themed, activated,
added with the Add workspace button at the bottom of the workspace list, or
deleted from one view. The dialog uses the standard corner close affordance and
also closes from the footer Close button. Workspace name edits stay in the row
while typing and apply after the name field loses focus. Workspace rows use
unframed controls with visible gaps between rows and do not duplicate the icon
beside the workspace name. Workspace re-theming uses a compact searchable theme
picker. In the workspace switcher, an avatar that shows an emoji icon uses the
neutral surface colour instead of the workspace colour, near white in light mode and
near black in dark mode. Deleting a non-empty workspace uses
Bento's confirmation dialog before closing its tabs.

Chrome-level menus and modals should preserve visual context. A command palette,
workspace editor, confirmation, or welcome dialog may draw its intended modal
scrim, but the overlay page itself should not cover the browser with an opaque
surface. Bento modal scrims cover the full chrome window, including the toolbar
and address bar. Stacked modals add matching stacked toolbar scrim layers, so a
confirmation opened over the workspace editor dims the native address bar by the
same amount as the content behind it. The floating address/search bar is not a
modal scrim; it leaves the native toolbar visible and does not dim or blur the
content behind it.

Open the command palette from the footer or with `Cmd/Ctrl+Alt+P`. It separates
normal tabs from side panels and lists the tabs and panels held by the current
window; sidebar search finds them across regular workspaces, including those held by
other windows. Choosing a tab opens
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
that match by name, category or search words (not in the empty palette, and without
their values); choosing one opens the Settings palette at that setting: on its own
list for a number, choice, search engine, privacy, panel size, backup or shortcuts
setting, and on the category with its name typed in for a switch or Manage search
engines. A private window's results also leave out the backup settings and the
Bookmarks manager setting.

In expanded sidebar mode, the main address/search entry is a persistent row
at the top of the sidebar above the tab list. It mirrors the active main
tab's URL, loading state, Firefox security identity state, and bookmark state,
with one-click actions to copy the current URL or bookmark the page. In a regular
window the bookmark star works on Bento's bookmarks (see "Saving pages and the
bookmarks toolbar"); in a private window, or with the Bookmarks manager off, it
toggles the regular Firefox bookmark instead. The copy action shows a `Copied` tooltip after the URL
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
`Cmd/Ctrl+T`, the New menu's `New tab`, a collapsed or hidden sidebar, and any
other path that would focus the browser's own address field open the centered
address/search overlay instead of showing Firefox's native suggestion dropdown.
The sidebar address row uses the tab row text size on a neutral surface and keeps
its neutral border when clicked or focused. The fixed creation/search row sits
directly below the address field with the same resting gap used above the
address field below the workspace switcher. Only the tab and folder rows scroll;
the address and action rows remain visible. The native
top URL/search field, stock toolbar app-menu button, stock toolbar downloads
button, and stock toolbar Account menu are hidden in normal Bento windows while
the remaining toolbar buttons and native window controls remain visible without
a bottom separator line. On macOS, that native control row has a small top inset
from the window edge. With no side panels visible, the main background and
toolbar share the sidebar's neutral background and the sidebar's right divider is
hidden. When side
panels are visible, the toolbar segment over the sidebar keeps the sidebar's
neutral background while the toolbar segment over the main content and panel
strip uses the same backdrop as the panel strip, with the sidebar's
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
to their addresses. Recently Closed and Recent History rows show how long ago they
happened (now, Nm, Nh or Nd), and a Recently Closed row shows Reopen while it is
hovered or focused. Reopening an ordinary closed tab or pinned panel preserves
its workspace, folder and custom title while they still exist. If its workspace
was deleted, it joins the current window's workspace; deleted or moved folders
are dropped. Closed panels return as panels when their workspace still exists.
Empty or unavailable groups are omitted. A closed tab that
is no longer available reports that status and refreshes the suggestions.
In new-tab mode, if the clipboard contains a web URL, a result below these groups
offers to open that URL from the clipboard. This follows Firefox's "Clipboard" address bar
suggestion setting (`browser.urlbar.suggest.clipboard`): when that setting is
off, Bento does not read the clipboard when the address entry opens. In new-tab mode
the list also has one row per saved panel, whatever the clipboard setting, and each
opens as a side panel. Typing hides these default clipboard and saved-panel rows. After
the user types, results include up to eight matching open tabs and panels from the
active workspace by title or URL, plus capped history and Firefox bookmark matches
and a final search/open row. Bento's separate Bookmarks collection is searched inside
the Bookmarks view, not by the address entry. The address entry includes a one-shot search-engine picker
initialized from Firefox's current default engine each time editing starts.
The closed picker shows the provider icon; opening it shows the full provider
names. Choosing another engine affects only the submitted non-URL search and
does not change Bento Settings or Firefox's default search engine. Submitting a
URL-like value ignores the one-shot picker and continues through Firefox URL
fixup, including internal browser pages such as `about:preferences`.
Successful address or search submissions reveal the main content slot if the
panel strip was scrolled over side panels, because the submitted load targets
the main tab surface. Pasting text that starts with `javascript:` removes that
prefix, and a `javascript:` address is never opened.
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
History, Recent History and bookmark rows show a generic clock or bookmark icon;
open tab, panel, Recently Closed, Top Sites and saved panel rows show the page's
favicon when it has one.

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
  sleep keeps them loaded.
- resize panels without disturbing the entire layout;
- close or remove a panel without losing the rest of the workspace; closing
  panels fade out without resizing neighboring panels during the exit animation,
  then plain top-level panel slots glide closed when the panel is removed.
- close the last regular tab in a workspace while panels remain; Bento promotes
  the leftmost panel into the main content slot instead of leaving the workspace
  blank.
- restore a recently closed panel with `Cmd+Shift+T` as a panel, not as a
  regular tab, at the top level in the slot it closed from, at the configured
  default new-panel width.
- choose the default width of a new panel in Settings (200 to 2,400 px, initially
  640 px);
- manage custom panel width presets in Settings, which appear in each panel's
  options menu: they start as 320, 480, 768 and 1,280 px and can hold up to 64
  sizes of 120 to 2,400 px each; open a size to edit it, move it up or down, or
  remove it;
- turn panel shadows on or off (on by default);
- adjust Bento corner roundedness with a labelled slider in Settings (0 to 36 px,
  default 12 px); it rounds the main content, with or without side panels, and
  every panel the same amount;
- adjust Panel gap and splitter size from 6 to 36 px, with a default of 14 px; this
  controls both the visible gap between panels and the draggable splitter.

Side-panel and sub-panel headers sit on a neutral surface and can be hidden
per panel from the header's `...` menu. Hidden headers are restored from a small
grey handle at the panel's top center. This state persists across workspace
switches and restarts. The main content slot does not expose this header action.

Right-clicking page content in the main slot or in a side panel exposes
`Inspect in Panel` when Firefox shows its stock Inspect item and
`Inspect Accessibility Properties in Panel` when it shows the matching accessibility
item; neither appears inside a DevTools panel. These commands open Firefox
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

### Saved and pinned panels

Save panel in a panel's options menu adds its address to the shared saved-panel
collection; it is not offered in private windows. Saving the same address again does
not add a duplicate. Saved panels can be renamed, reordered or deleted in Firefox's
Library under Other Bookmarks, Saved panels; only links directly in that folder
appear. The add-panel control at the end of the panel strip shows the first eight
saved panels and puts the rest in More saved panels, and a subdivision chooser shows
up to the first twelve. In new-tab mode the address entry also lists them.

Pinned-panel buttons can be dragged to reorder the rail. Their right-click menu
distinguishes Remove pinned panel, which removes the shortcut but leaves the page
open, from Close pinned panel, which closes the page and keeps the shortcut for
reopening it. Middle-clicking a pinned-panel button closes its page in the same way.

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
A subdivision has two rows of one or two panels, so a column holds at most four
panels. A panel inside a subdivision cannot be subdivided again, and the main
content slot cannot be subdivided. When the single top panel of a subdivision is
closed or dragged out, the panels below become top-level panels and an unused
chooser disappears. A DevTools panel can only be dragged to a top-level slot.
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
live in a workspace. No separate widget type has shipped. Saved panels and pinned
panels are the current forms: they open as ordinary panels and follow the same
layout, traversal and theming rules. Built-in tools are not part of the product yet.

The important product rule is that widgets should not become a separate mode of
window management. They should inherit the same workspace, layout, traversal,
and theming behavior as panels.

### Bookmarks view

Bento keeps its own collection of links, separate from Firefox's bookmarks, in a
full-window Bookmarks view. It opens from the command palette's "Open Bookmarks"
command or Cmd/Ctrl+Shift+O, and replaces the
browser content while the toolbar strip stays in place. Back, Forward, Reload, the panel navigator and the
extension buttons slide up out of the toolbar and fade as the view opens, and slide back when it
closes; with reduced motion they change at once. The top-left button reads "Back to browser" and shrinks to an arrow in a narrow
window. Right-clicking in the view opens Bento's own menu for whatever is under the pointer: a link
(open in a panel or new tab, copy the link, edit, move, delete), a note (edit, move, delete) or a
to-do (edit, mark done or not done, move, delete), a group column (open all in panels, rename, colour, reorder, delete), a space
(rename, colour, delete), an open tab in the drawer (save to a group), or the board background (new
group, save all open tabs). Text fields keep the normal cut, copy and paste menu, and Firefox's page
menu no longer appears. The Menu key or Shift+F10 opens the same menu for the focused item. It is not available in private
windows: the command is hidden there and the shortcut opens Firefox's Library instead.
The view does not open over a page prompt or dialog, and closes when one appears; its
search field has focus when it opens. The Back button or the shortcut again returns to the
browser, with focus back where it was, and so does Esc, after any active menu, dialog or
inline edit has handled it. From a nonempty search field the first Esc clears the search,
and in a narrow window Esc closes an overlaid Open tabs drawer before closing the view.

The Bookmarks manager can be turned off in Settings (Workspaces, "Bookmarks manager", On by
default, saved for the whole profile and included in backups). Off hides the "Open Bookmarks"
command, gives Cmd/Ctrl+Shift+O back to Firefox's Library and closes the view if it is open;
the bookmarks you saved are kept, and turning it back on brings them back as they were. The
switch is not shown in private windows, where the view is never available.

The view has three parts:

- **Spaces.** A column on the left lists the spaces, each with a colour dot, its name
  and its link count. Selecting one shows it; the view reopens on the space last used.
  "+ Space" adds one, and a space's menu (also on right-click) renames it, sets its
  colour, or deletes it with its groups. Below about 1200 px wide the column folds to
  the colour dots.
- **Groups and rows.** The selected space's groups are columns that scroll sideways. Each
  column holds links (favicon, title, host), notes and to-dos (with a checkbox). Clicking a
  link opens it in a new panel. Hovering or focusing a row shows a "More actions" button with
  the same menu as right-click, which leaves the row's text readable: links have Open in
  panel, Open in new tab, Copy link, Edit, Move and Delete; notes have Edit, Move and
  Delete; to-dos also have Mark done or Mark not done. Clicking a link, or choosing Open in
  panel, Open in new tab or Open all in panels, opens it (a panel opens at the end of the strip)
  and returns to the browser.
  Rows edit in place; Enter or moving focus away saves and Esc cancels, Shift+Enter adds a
  line break when editing a note (a to-do edits on a single line), and after Enter or Esc the focus goes back to the
  row (or to the button that began the edit). A full-width "+" under a column's
  last row, shown while the pointer is over the column or the focus is inside it, adds a link,
  note or to-do by typing: a web address or bare domain becomes a link, text
  starting with `[]` and a space becomes a to-do, anything else a note. A group's menu renames it,
  sets its colour, moves it left or right, opens all its links in panels, or deletes it.
  "+ Group" adds a column; a space with no groups has the same "Group" button in its
  first-steps box. Space and group names allow 1,024 characters, link titles 4,096, and note
  or to-do text 32,768; some characters, such as many emoji, count as two toward these limits.
- **Open tabs.** The header's "Open tabs" toggle opens a drawer on the right with this
  window's tabs and panels in the active workspace, except Firefox's own pages. A tab
  dragged into a column is saved at the
  spot where it is dropped, a tab's menu has "Save to group" (a list of the space's
  groups and "New group"), and "Save all to new group" saves the drawer's eligible tabs
  together: it skips internal browser pages, privileged pages, and private or already
  closed tabs, and creates no empty group if nothing can be saved. In a
  narrow window the drawer floats over the board.

The header shows the space's name and "N groups, M links", with a search field that finds
links, notes and to-dos in every space, listed by space and group. Rows and columns reorder
by dragging: a line shows where the item will land, nothing shifts while dragging, and the
dropped item glides into place; Esc cancels, and letting go afterwards does not open the link
that was grabbed. Everything dragging does also has a menu for the keyboard: a row's
"More actions" menu (Move to group, Move up, Move down under Move), a column's Move left and
Move right, and an open tab's Save to group; each is reached by Tab and keeps the focus on what
moved. Deleting an
item removes it at once and offers Undo for a few seconds (the countdown waits while the
pointer is over the toast or the focus is on it); deleting a group or space asks first. A space with no groups says
"Drop tabs here" and offers a new group or saving the open tabs; until the import offer
has been used or declined once, it also offers a one-time copy of up to 2,000 HTTP and HTTPS
links from Firefox bookmarks into a new space named "Firefox bookmarks", which is then
selected. Folders with imported links become groups, and nested folders carry their parent's
name in the group label.
The Firefox originals remain unchanged, and later changes are not synchronized.
If the stored bookmarks cannot be read, the view says "Bookmarks couldn't load" with a
Retry button instead of showing a board that could not save; nothing is changed meanwhile.

### Saving pages and the bookmarks toolbar

With the Bookmarks manager on, in a regular window, saving a page and the bookmarks toolbar use
Bento's bookmarks rather than Firefox's. Private windows, and any window while the manager is off in
Settings, keep Firefox's own bookmark star, Cmd/Ctrl+D and bookmarks toolbar, unchanged.

- **Saving.** The star in the sidebar address row, Cmd/Ctrl+D, and the Bookmark Page entries of
  the menu bar, the app menu and the page's context menu all save the page at once and open a small
  popover under the star (or, when the sidebar row is not on screen, at the top right of the active
  panel) with Name, Space and Group, Remove and Done. A page goes into the group of the most
  recently saved link in the current space (the one the toolbar shows); in a space whose groups
  hold no links yet, into its first group; in a space with no group, into a group called
  "Unsorted".
  Name saves on Enter or when the field loses focus. Choosing another Space moves the link to that
  space's first group (making "Unsorted" if it has none), and choosing a Group moves it there.
  Done, a click outside and Esc close the popover and keep the save; Esc also drops a name that
  was typed but not saved. The popover also closes, keeping a typed name, when the window is
  resized, the tab changes, the sidebar collapses, hides or slides, or a page prompt or
  another overlay opens. Remove deletes the link. If the stored
  bookmarks could not be read, the popover says the page was not saved and offers Retry.
- **The star.** It is filled for any page that is saved in any group. Pressing it, or Cmd/Ctrl+D,
  on a saved page opens the popover on the most recent copy rather than saving again, and the star
  shows as pressed while the popover is open. A page Bento does not save (Firefox's own pages and
  other internal pages) leaves the star disabled, and Cmd/Ctrl+D does nothing there. The panel header
  star follows the same rules.
- **Bookmarks toolbar.** In place of Firefox's toolbar (it starts hidden and shows and
  hides with Cmd/Ctrl+Shift+B) a rounded strip, lined up with the top of the workspace switcher and the edges
  of the panels, slides in while the panels shrink to make room (and out again; the sidebar stays
  still). The row lists the groups of the space the Bookmarks view last showed, each a
  button with its colour dot, name and a chevron. A group's menu lists its links (favicon and
  title; choosing one opens it as a new panel), then "Open all in panels" and "Open in
  Bookmarks". The space button at the right shows the current space; its menu lists every space
  with a check on the current one (choosing one switches the toolbar, the Bookmarks view and
  every other window to it) and "Open Bookmarks". Groups that do not fit move behind an overflow
  button at the end of the groups, each a submenu with that group's links, "Open all in panels"
  and "Open in Bookmarks". A space with no links shows "No
  bookmarks in" and its name, and the row shows nothing until the stored bookmarks have loaded (or
  if they could not be read). The button whose menu is open shows as pressed. Esc, a click
  outside or choosing an item closes a menu.

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

- visible panel controls are keyboard reachable, except that dragging panels by
  their handles and resizing them with splitters need a pointer;
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
  match the panel strip on the main-content side of the divider when panels are
  open and match the sidebar without a divider when no panels are open, while
  browser extension
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
- footer icon buttons show Bento tooltips while the sidebar is expanded; these
  footer tooltips are disabled in the collapsed rail;
- the divider between the fixed main content slot button and draggable
  side-panel buttons is centered in their shared gap;
- panel navigator buttons show Bento tooltips with their panel names; the
  main content slot uses the current page title;
- grouped panel navigator icons show and refresh the favicons for visible
  panels inside a vertical or 2x2 group;
- sleeping inactive-workspace panels appear dimmed in the panel strip and their
  panel navigator buttons are dimmed until the backing tab wakes;
- panel cycling with `Cmd/Ctrl+Shift+Left` and `Cmd/Ctrl+Shift+Right` works
  while ordinary page content has focus, and editable fields keep those keys for
  editing; cycling stops at either end by default, and "Wrap panel shortcuts at
  the ends" in Settings turns wrapping on for keyboard and navigator cycling;
- with the panel container focused, Up and Down scroll its page, Space scrolls
  down a page and Shift+Space scrolls up, and Esc from a panel-header control
  returns focus to the container when no overlay handles it;
- Shift+wheel over the panel strip or navigator cycles panels and stops at either
  end even when wraparound is on; horizontal scrolling over browser chrome scrolls
  the panel strip, while scrolling inside a web page stays the page's own;
- on macOS, `Cmd+R` and `Cmd+Shift+R` reload or force-reload a panel when focus is
  on its container or header (with focus inside the page content they are not
  retargeted to the panel), and Firefox's native two-finger swipe back and
  forward gestures are off by default;
- saved panels and pinned-panel rail buttons are reachable from compact controls;
- workspace switching preserves enough layout state that returning to a
  workspace feels immediate;
- restored panel-strip scroll position remains stable until the user explicitly
  navigates the strip or selects another target.

### Personalise the workspace

Bento's theming engine gives each workspace an identity while staying accessible.

The theme system should support:

- curated accessible presets;
- a grouped selector containing Bento's Default palette, eight standard palettes
  and seven monochromatic palettes;
- per-workspace theme selection;
- light, dark, and Auto UI modes; switching presents the sidebar, toolbar,
  Settings, menus and palettes together on the theme's state motion. A rapid
  reversal continues from the current progress. Reduced motion switches the
  surfaces together without playing a fade. Web pages keep live
  visuals, execution and input; native OS menus and window controls remain
  system-owned;
- UI colour mode is separate from website colour preference. Fresh profiles
  request light website colours; Bento Settings currently has no separate
  website-colour control;
- workspace customization by choosing a curated preset; creating or importing a
  custom theme is not currently available.

The goal is not decorative skinning alone. Themes should help users recognize
the active workspace quickly and make long-lived browsing contexts comfortable
to use.

### Privacy And Search

Bento exposes privacy as a first-class browser setting instead of hiding it
behind `about:config`. The selectable protection levels are:

- Standard: balanced Bento defaults with strict Firefox tracking
  protection, tracker-cookie partitioning, Global Privacy Control, query
  stripping, remote search suggestions off, speculative networking off, DNS over
  HTTPS off, Firefox AI features off, sponsored new tab content and Bento
  Suggest off, local Safe Browsing checks on, HTTPS-only mode, and DuckDuckGo as the
  fresh-profile search default (a profile that already finished onboarding
  keeps its current engine).
- Enhanced: Standard plus resist fingerprinting and tighter WebRTC IP handling
  (your local network address is hidden during calls).
- Hardened: Enhanced plus letterboxing, WebRTC peer connections off, DRM off,
  disk cache off, WebGL/WebGPU off, password/form saving off, local Safe
  Browsing retained, the Referer header sent only when the hostname matches exactly, and
  cookies, site data and cache cleared when Bento quits (history, downloads and
  form data are kept).

A fresh profile starts on Standard: Bento applies it at the first launch, before
onboarding finishes, so Settings marks Standard as the current level and the
onboarding privacy step can change it. A saved Enhanced or Hardened choice is
applied again at each launch. Changing a setting that level controls under
Advanced privacy leaves the level: Settings shows Custom (or the level the result
matches), the change stays after a restart, and the level is no longer applied at
launch. If the settings later match a level exactly again, Settings shows that
level, but it is applied at launch only after it is chosen again. Changing remote
download reputation does not leave the level, because no level controls it. Changes made outside Settings, for example in
`about:config`, to settings a saved level controls are still reset at the next
launch, until the level is left through Advanced privacy. When no preset choice is
saved, later launches, and profiles that already existed, leave the browser's
current privacy settings in place. A profile that turned "Clear cookies and cache on
shutdown" on before the clearing was narrowed to cookies, site data and cache keeps
Firefox's broader clearing (history, downloads and form data too) until the switch
is turned off and on once.

Custom is a detected state, not a selectable preset. Bento shows Custom when
any setting a level controls differs from all three levels, including settings
with no Advanced privacy row such as DNS over HTTPS, address-bar search
suggestions, Firefox AI features and the cross-site Referer policy. Remote
download reputation never affects it.

Remote download reputation is a separate advanced toggle rather than a preset
value, and it is off by default. Its Settings description says that Google Safe
Browsing is asked about downloads it cannot judge locally, and that this sends the
download's address, file name, size and checksum to Google. Firefox's request
itself also includes redirect URLs, the original referrer when available, the
locale and signing or certificate metadata. Switching presets does
not reset the toggle or make an otherwise matching preset appear as Custom.
Firefox's HTTPS exception UI remains available for HTTP-only sites and local
devices.

Bento's shipped defaults turn off telemetry submission, automatic crash-report
submission, studies, Pocket, sponsored new tab content and Bento Suggest. Firefox
account and Sync support stays on, and the stock toolbar Account button is hidden.
DNS over HTTPS is off. Built-in AI chat, Smart Window AI tabs and mini windows are
off. Bento's user agent advertises Firefox compatibility. These are browser preference
defaults, not a guarantee that the browser makes no network requests, and they can
be changed in Firefox's preferences.

Bento Settings is a quick-pick palette over the window, not a page. The app menu's
"Bento Settings" item, the command palette's Open Settings command, and the
onboarding dialog's Open Settings button open it; the command palette's
Privacy command opens it on the protection level list, and a matching setting
in the command palette's results opens it at that setting inside its category. The first
list contains categories with short descriptions: Appearance, Tab appearance, Performance,
Workspaces (the sidebar collapse type and the Bookmarks manager switch),
Panels, Privacy and search, Backup and data, Keyboard shortcuts, and Reset Bento.
Each category opens its controls with their current values; Keyboard shortcuts opens its
reference directly. Search settings finds individual controls, advanced privacy settings
and shortcuts across categories; a category's filter searches only its children. Opening
a search result keeps the category in the path. Enter flips a switch (the row shows the new state at
once and returns to the old one if the change cannot be saved) or opens a short
list of choices, which opens on the current choice. A number with a wide range
(Sleep tabs after, Backup interval, Default new panel width, a custom size) opens a value
field with preset rows (Min, Default and Max sit beside the number); the value applies live
while typing and while arrowing over the presets, Enter
keeps it, clicking a preset keeps it and returns to the list, and Back or Esc puts the
previous value back. A number with a small range (Keep alive per workspace, Panel corner
radius, Panel gap and splitter size, Backups to retain; at most 50 steps wide) opens a
slider instead, with the thumb focused: the value and its unit show above the track, and
"Default N" and the range show under it. Dragging, a click on the track or the arrow keys apply
the value live (the panel corners follow the thumb, which glides between values on a key press
or a click on the track and follows the pointer exactly while dragged), Page keys move it by a tenth of the range, Home and End jump to the ends, Enter keeps
it, and Back or Esc puts the previous value back, as on the field pages. A screen reader
announces the value with its unit.

Appearance holds Bento color mode and Interface scale. Interface scale (1.00x by default,
1.25x, 1.50x, 1.75x, 2.00x) makes the whole Bento window larger: the sidebar, panels,
Settings, palettes and web pages, in every window at once, as soon as it is picked, and it is
kept across restarts. It is relative to the display's own size, so 1.25x looks a quarter larger
than 1.00x on the same display. Web pages get less room, as with browser zoom, and parts drawn
by macOS, such as the window buttons, keep their size. Choosing 1.00x restores the display's
own size. It is one setting for the whole profile, private windows included; with displays
of different pixel density, the window you are using sets the size, and windows on another
display look larger or smaller until you use them.

The Bookmarks manager switch is the one switch that carries a second, always visible line (it
names the Cmd/Ctrl+Shift+O shortcut, says the star, Cmd/Ctrl+D and the bookmarks toolbar use the
manager too, and says that Off keeps the saved bookmarks); search results show it on one line. Tab appearance comes after Appearance. Show tab state tints and Use custom tab state icons
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
own search settings to add more. Advanced privacy offers Local Safe Browsing,
Remote download reputation, Resist fingerprinting, Letterboxing, Network
prediction, WebRTC peer connections, WebRTC IP handling, HTTPS-only mode, DRM
protected content, Disk cache, WebGL, WebGPU, Password saving, Form history, and
Clear cookies and cache on shutdown. WebRTC IP handling and HTTPS-only mode open
lists of choices; the other controls are switches. The shutdown switch clears
cookies, site data and cache when Bento quits and keeps history, downloads and
form data, and HTTPS-only mode's Off and Always apply to normal and private
windows. When a
privacy change is saved but Firefox could
not apply it, the palette says so. The first-run onboarding privacy step lists
each level with a one-line summary and marks Standard as recommended, and its
search step shows each visible engine's icon and tags privacy-oriented ones as
Private when Firefox exposes them. The Keyboard shortcuts list is searchable
and shows each command's title and key tokens (a shorter list than the Keyboard
and menu reference below), and the Sidebar collapse type
setting chooses whether `Cmd/Ctrl+S` collapses the sidebar to the rail or hides it with
left-edge hover access. Bento bundles uBlock Origin, enabled by default. It is not
listed in `about:addons` and cannot be removed: Remove Extension is disabled on its
toolbar button's menu. Manage Extension on that menu opens its page, where it can be
switched off.

Backup and data contains automatic backups, enabled by default every 30 minutes with
the latest five retained; the interval can be set from 5 to 1,440 minutes and
retention from 1 to 20 backups. The category also contains an Export, import and stored
backups list, and Merge browser session. The backups list offers Export (a file download),
Import (choose a file, review what it holds, then confirm; the file's workspaces are added
alongside the existing ones, and any settings and saved panels it includes apply), stored
backups (restore and delete, each with a
confirmation) and Merge browser session, which opens the merge palette. The Reset Bento
category contains Reset Bento settings, which asks for confirmation, restores Bento settings, the protection
level and the search engine to their defaults, keeps workspaces, tabs and backups, leaves
Remote download reputation as it is, and closes the palette so the
onboarding dialog can open again. Operations that take time keep running if the
palette is closed, and reopening Settings reports how an operation ended if it
finished (or was cut short by Bento restarting) while the palette was closed or
reloading. Backup files, exported or imported, are limited to 10 MiB. Import rejects
files that are too large or are not Bento backups. If its file check expires, it asks the
user to choose the file again. Settings also reports when the window is not ready, Bento
is busy, or a request cannot be completed in time, with a prompt to retry. If an
operation is interrupted or its result is uncertain, the message asks the user to check
what changed before retrying. A number being edited is put
back if the palette is hidden before the edit is kept. A private window's Settings palette has no backup, merge,
reset or Bookmarks manager rows; its Bento color mode is that window's own and is not saved, and any
other setting changed there is saved for the whole profile as usual.

Firefox's own Settings page (`about:preferences`) has no Bento category; the
Settings palette is the only place Bento's settings live.

Bento has no automatic updater yet, so the About page shows no Updates section
(no heading, description, or status message); it keeps the support links. Native
surfaces use Bento branding (Bento Home, Bento View, Bento Labs), and `about:logo`
shows the Bento logo.

## Keyboard and menu reference

Keys use Cmd on macOS and Ctrl elsewhere unless noted. The Settings Keyboard shortcuts
list is a separate, shorter list.

### Keyboard shortcuts

| Keys | What they do |
| --- | --- |
| `Cmd/Ctrl+Alt+P` | Open the command palette. |
| `Cmd/Ctrl+L`, `Cmd/Ctrl+E` | Open address entry for the current tab. |
| `Cmd/Ctrl+T` | Open address entry in new-tab mode. |
| `Cmd/Ctrl+S` | Minimize the sidebar: collapse it or hide it, per Settings. |
| `Cmd/Ctrl+W` | Close the selected sidebar tabs when several are selected; otherwise the focused side panel; otherwise the current tab. |
| `Cmd/Ctrl+Shift+T` | Reopen the last closed tab or panel. |
| `Cmd/Ctrl+1` to `9` | Select that regular tab in the current workspace, side panels excluded. `9` means the ninth tab, not the last. Pinned tabs and tabs inside folders count, in the browser's tab order, which can differ from the sidebar's order when folders are used. An index past the last tab does nothing. |
| `Cmd/Ctrl+Shift+Left`, `Cmd/Ctrl+Shift+Right` | Previous or next panel, except while an editable field has focus. |
| `Cmd/Ctrl+Left`, `Cmd/Ctrl+Right` | Back or forward in the focused panel's history, except while an editable field has focus. |
| `Cmd/Ctrl+Shift+Alt+N` | Open a new window. |
| `Cmd/Ctrl+D` | Save the page. |
| `Cmd/Ctrl+Shift+O` | Open the Bookmarks view. |
| `Cmd/Ctrl+Shift+B` | Show or hide the bookmarks toolbar. |
| `Cmd+R`, `Cmd+Shift+R` (macOS) | Reload or force-reload a panel when focus is on its container or header. |
| Up, Down, Space, Shift+Space | With a panel container focused, scroll its page. |
| Esc | From a panel header control, return focus to the panel container. |

Pointer gestures:

- Shift+wheel over the panel strip or navigator cycles panels and stops at either end.
- Horizontal scrolling over browser chrome scrolls the panel strip.
- Middle-click closes a sidebar tab or a pinned panel.
- Double-click renames a tab.
- Cmd/Ctrl-click and Shift-click select tabs.
- Two-finger swipe back and forward is off.

### Command palette

The palette lists these commands by group:

- Navigation: Open Settings, Open Bookmarks (while the Bookmarks manager is on, in a
  regular window) and Open Bento Privacy Settings.
- Settings: the settings that match the query, only while typing.
- Workspaces (regular windows only): Switch to the name of each other workspace, shown
  as Current workspace for the current one, and New workspace.
- Tabs and Panels: the current window's tabs and side panels.
- Actions: New tab, Close current tab, Reload current tab, Pin or Unpin current tab,
  Add current tab to side panels, Merge browser session (regular windows only) and
  Close all side panels.

New tab opens a blank tab at once, unlike the New menu's New tab, which opens address
entry. Close all side panels removes every side panel from the active workspace:
ordinary panels return to the tab list, while child panels removed with their parent
and DevTools panels are closed.

### Menus

- Sidebar background: New tab, Reopen closed tab, Select all tabs. These three also head
  the tab and folder menus.
- Tab: New tab below, Rename tab, Reload tab, Unload tab (disabled for the current or an
  unloaded tab), Mute tab or Unmute tab, Pin tab or Unpin tab, Convert to panel (not
  the current tab), Move to workspace, Move to folder (the existing folders, New
  folder, and Remove from folder when it applies; left out when the tab is pinned),
  Close multiple tabs (Close tabs above, Close tabs below, Close other tabs) and Close
  tab. A private window's menu has no Move to workspace or Move to folder.
- Selected tabs: Reload N tabs, Move N tabs to new workspace, Move selected tabs to
  workspace, Move selected tabs to folder (left out when all are pinned) and Close N
  selected tabs.
- Folder: Rename folder, Move folder to workspace, Delete folder.
- Pinned panel button: Remove pinned panel, Close pinned panel.
- Panel header, left to right: drag handle, Back, Forward, Reload, address field,
  bookmark star, pin, mute (shown when the panel is audible or muted), Close, Panel
  options. DevTools panels and private windows have no pin button.
- Panel options: Custom panel widths (the sizes set in Settings, or "No panel sizes set
  in Bento Settings" when there are none), Subdivide panel (top-level panels), Split
  this panel (the single panel of a subdivision row), Break out this panel (the bottom
  panel, or either panel of a split row), Hide header, then Save panel (not in private
  windows). DevTools panels have none of the layout items. The main content slot has no
  Panel options button.
- Panel Back and Forward buttons: right-click shows up to 15 history entries around the
  current page.
- Panel navigator button: Remove panel. Splitter: Insert panel here. Empty strip space
  and the trailer: Add new panel.
- Page links: Open in new panel. Firefox bookmarks: Open in New Panel.

## Design principles

### Workspace state is first-class

Tabs, panels, layout, pinned-panel references, and theme selection belong to the
workspace. Saved panel targets are shared across regular workspaces. Bento should
treat both as parts of the user's working environment, not as incidental UI state.

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
creating low-contrast or hard-to-navigate states. Curated presets are the current
customization path. Deeper theme customization remains a future direction.

### Window count should go down

The core product test is simple: a user who previously needed several browser
windows for one task should be able to express that task as one Bento workspace.
