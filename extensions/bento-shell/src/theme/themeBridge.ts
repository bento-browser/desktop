// Cross-process bridge that pushes the active workspace's themeId from
// the shell sidebar to the chrome window. Mirrors the BENTO_OPEN_* /
// BENTO_PANELS title-IPC pattern used by every other shell→chrome
// signal (palette reveal, panel reconcile, side-panel reveal, etc.):
// the shell stamps a sentinel onto document.title and chrome's
// bento-shell-mount.js polls DOMTitleChanged for it.
//
// Title shape: `BENTO_THEME:<ts>:<themeId>`. The timestamp guarantees
// successive switches with the same themeId still fire DOMTitleChanged
// (same string twice = no event).
//
// Only the sidebar entry calls this — secondary entries (palette,
// confirm, edit-workspace, settings) all share document.title for
// their OWN sentinels and must not stomp this one.

export const THEME_TITLE_PREFIX = 'BENTO_THEME:';

export function pushChromeTheme(themeId: string): void {
  document.title = `${THEME_TITLE_PREFIX}${Date.now()}:${themeId}`;
}
