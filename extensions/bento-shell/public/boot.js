/* eslint-env browser */
// Bento sidebar pins to dark mode (matches the brand background). The shell
// document doesn't follow OS prefers-color-scheme — that's a separate axis
// from the main browser's content theme. M2+ may add per-workspace theming
// via data-workspace-color, but the base mode stays dark.
(function () {
  document.documentElement.setAttribute('data-color-mode', 'dark');
  document.documentElement.setAttribute('data-theme', 'dark');
})();
