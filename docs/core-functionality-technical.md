# Bento Browser core functionality technical notes

This document is the technical companion to
[core-functionality.md](core-functionality.md). It records how Bento's working
workspace, panel, layout, traversal, and theme behavior is achieved today, and
the implementation pitfalls that have already caused regressions.

Keep this document factual. If a future implementation changes the behavior,
update this file in the same change.

## How these notes are organized

The notes live in topic files under [technical/](technical/). This file is the
index: "this file" in the rules above means the topic file that covers the
behavior you changed. Update this index only when a topic file is added,
renamed, or removed.

## Topics

- [Architecture summary](technical/architecture.md): The shell and tools extensions, the chrome bridge, state ownership, and how the pieces fit.
- [Native Tabs And Titlebar Controls](technical/native-tabs-titlebar.md): Hiding Firefox's native tab strip, the titlebar, and window controls.
- [DevTools In Panel Implementation](technical/devtools-in-panel.md): Opening DevTools toolboxes in Bento panels and their pairing with the inspected page.
- [Address Entry Implementation](technical/address-entry.md): Address entry, navigation, search-engine resolution, and autocomplete.
- [Privacy And Search Implementation](technical/privacy-search.md): Privacy defaults, the privacy experiment, and search engine management.
- [Workspace implementation](technical/workspaces.md): Workspace state, activation, tabs, folders, pinned tabs, and the workspace UI.
- [Panel state and layout model](technical/panel-state.md): The tools-side panel store, layout tree, persistence, panel actions, session markers, and panel state pitfalls.
- [First-run import and onboarding](technical/first-run-import.md): The welcome flow, first-run browser-data import and startup migration, the dev-profile marker, and the toolbar scrim.
- [Sidebar Native Firefox Surfaces](technical/sidebar-native-surfaces.md): The sidebar footer buttons that open native Firefox menus and panels.
- [Manual Browser Session Merge](technical/session-merge-backups.md): Manual browser-session merge, session readers, and Settings backups.
- [Shell to chrome bridge](technical/shell-chrome-bridge.md): Title IPC, the shell bus, bridge bootstrap, and the title channel pitfalls.
- [Overlay documents](technical/overlay-documents.md): Lifecycle and readiness, window scoping of the overlay buses, the tooltip document, measuring, and overlay transparency.
- [Palettes and the floating address bar](technical/palettes-and-address-bar.md): The command palette, sidebar tab and panel search, and the floating address bar.
- [Chrome panel rendering](technical/chrome-panel-rendering.md): How chrome renders panels through Firefox split view, the compatibility shims, and rendering pitfalls.
- [Flat panel layout and subdivisions](technical/flat-panel-layout.md): Flat layout geometry, subdivisions and choosers, splitters, and flat layout pitfalls.
- [Panel traversal and focus](technical/panel-traversal-focus.md): Keyboard and wheel traversal, the favicon navigator, and focus indicators.
- [Panel widgets, saved panels, and pinned panels](technical/panel-widgets.md): Pinned panels, saved panels, and the add-panel trailer.
- [Theming and color mode](technical/theming.md): Color mode, themes, tokens, the shell stylesheet bundle, and theme pitfalls.
- [Manual regression areas](technical/manual-regression-areas.md): The manual checklist of regression areas, with submenu placement and palette search notes.
