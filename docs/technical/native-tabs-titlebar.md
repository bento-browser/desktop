# Native Tabs And Titlebar Controls

Part of the [technical notes index](../core-functionality-technical.md).

Bento hides Firefox's native horizontal tab strip through Firefox's own
hidden-tabs titlebar state. `prefs/bento.js` defaults
`bento.chrome.hideNativeTabs` to `true`, and
`patches/core-ui/02-hide-native-tabs.patch` makes
`TabBarVisibility.update()` include that pref in `hideTabsToolbar` for normal
browser windows. The patch does not enable `sidebar.verticalTabs`. It also marks
Firefox's `browserLayout` setting group hidden and hidden from Settings search,
so neither the horizontal/vertical picker nor the native Show sidebar toggle is
offered in Bento.

`bento-chrome-theme.css` also suppresses Firefox's revamp `#sidebar-container`,
`#sidebar-launcher-splitter`, `#sidebar-button`, and
`#wrapper-sidebar-button` whenever `bento-sidebar-addressbar` is active. The
static `hidden="true"` markup is not sufficient because `SidebarController`
can restore `launcherVisible: true` asynchronously from `sidebar.backupState`
after startup. Keep this suppression scoped to the launcher and its generic
toggle: native panel content in `#sidebar-box` and its `#sidebar-splitter` must
remain available for explicit Bookmarks, History, Synced Tabs, Passwords, and
extension-sidebar commands. `pnpm run chrome:resize-check` guards this selector
set so a persisted Firefox profile cannot reintroduce a second rail beside
Bento's sidebar.

When the pref-driven branch is active, Firefox sets
`#navigator-toolbox[tabs-hidden]`, toggles `#nav-bar.browser-titlebar`, and
collapses `#TabsToolbar`. That keeps the native horizontal tab strip hidden
while reusing Firefox's existing titlebar/control markup and platform window
commands from the nav-bar titlebar copy. On macOS, `bento-shell-mount.js` adds
a 4px top inset to `#nav-bar`; this moves that titlebar copy, the native
navigation controls, and the mounted panel navigator as one row. Bento shell
owns the visible tab UI;
it does not render custom minimize, maximize, restore, or close controls.

Popup and taskbar-tab windows stay on Firefox's existing single-tab path because
the Bento condition is guarded by `!isSingleTabWindow`. If
`bento.chrome.hideNativeTabs` is set to `false` in a profile, Firefox falls back
to its default tabbar/titlebar behavior for that profile.

## Native Tabs And Titlebar Pitfalls

- Do not restore a CSS-only global `#TabsToolbar` collapse. It hides the
  tab-toolbar control copy without putting the nav bar into Firefox's native
  titlebar state.
- Do not enable or depend on `sidebar.verticalTabs`; Bento's visible tab UI is
  the `bento-shell` sidebar, not Firefox's native vertical-tabs/sidebar UI.
- Do not add window controls in `bento-shell`. The controls must remain
  Firefox's native titlebar controls and commands.
