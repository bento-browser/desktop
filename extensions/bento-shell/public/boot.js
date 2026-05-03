/* eslint-env browser */
// Color-mode boot — sets data-color-mode and data-theme on <html> from
// localStorage (or OS prefers-color-scheme as fallback) BEFORE any CSS or
// JS so Tale UI's color-mode rules apply immediately, with no flash of
// wrong theme during hydration. Tale UI consumer-snippet step 7.
//
// Lives in /public/ so Vite copies it as-is to dist/boot.js. Loaded as an
// external script (not inline) because extension page CSP blocks inline
// <script> by default.
(function () {
  try {
    var mode =
      localStorage.getItem('color-mode') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.setAttribute('data-color-mode', mode);
    document.documentElement.setAttribute('data-theme', mode);
  } catch {
    /* localStorage / matchMedia may not be available in some chrome contexts */
  }
})();
