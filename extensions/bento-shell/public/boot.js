/* eslint-env browser */
// Initial color-mode set BEFORE any CSS loads — eliminates flash of wrong
// theme. Source order: explicit light/dark choice > Auto/OS preference >
// fresh-profile Light default.
// useFirefoxTheme hook subscribes to subsequent OS-pref changes at runtime.
//
// External file (not inline) because the chrome-mounted extension page's
// CSP forbids inline <script>.
(function () {
  var stored = localStorage.getItem('color-mode');
  var mode =
    stored === 'light' || stored === 'dark'
      ? stored
      : stored === 'system'
        ? matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : 'light';
  document.documentElement.setAttribute('data-color-mode', mode);
  document.documentElement.setAttribute('data-theme', mode);
  document.documentElement.setAttribute(
    'data-bento-color-mode-pref',
    stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'light',
  );
})();
