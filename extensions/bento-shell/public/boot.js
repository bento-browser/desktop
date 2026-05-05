/* eslint-env browser */
// Initial color-mode set BEFORE any CSS loads — eliminates flash of wrong
// theme. Source order: explicit user choice in localStorage > OS preference.
// useFirefoxTheme hook subscribes to subsequent OS-pref changes at runtime.
//
// External file (not inline) because the chrome-mounted extension page's
// CSP forbids inline <script>.
(function () {
  var stored = localStorage.getItem('color-mode');
  var mode =
    stored === 'light' || stored === 'dark'
      ? stored
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  document.documentElement.setAttribute('data-color-mode', mode);
  document.documentElement.setAttribute('data-theme', mode);
})();
