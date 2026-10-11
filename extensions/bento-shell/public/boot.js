/* eslint-env browser */
// Initial color-mode set BEFORE any CSS loads — eliminates flash of wrong
// theme. Source order: explicit light/dark choice > Auto/OS preference >
// fresh-profile Light default.
// useFirefoxTheme hook subscribes to subsequent OS-pref changes at runtime.
//
// Also starts the request for the active workspace theme's stylesheet so it loads while the
// bundle and the workspace snapshot are still on their way. The hint is the resolved theme id
// that useWorkspaceTheme last applied (localStorage 'workspace-theme'; bento-tools stays the
// source of truth). The root theme attributes stay Default here: the sheet may not have
// loaded by first paint, so src/theme/themeSheets.ts adopts the link and the theme is
// applied once it has. A hint that names no sheet only costs one failed request.
//
// External file (not inline) because the chrome-mounted extension page's
// CSP forbids inline <script>.
(function () {
  var stored = localStorage.getItem('color-mode');
  var storedResolved = localStorage.getItem('resolved-color-mode');
  var hasStoredResolved = storedResolved === 'light' || storedResolved === 'dark';
  var mode = 'light';
  if (stored === 'light' || stored === 'dark') {
    mode = stored;
  } else if (stored === 'system') {
    mode = hasStoredResolved
      ? storedResolved
      : matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
  }
  document.documentElement.setAttribute('data-color-mode', mode);
  document.documentElement.setAttribute('data-theme', mode);
  // Mux consumes explicit scheme/contrast attributes on the same element as
  // its theme. Default is the measured Bento baseline until the workspace
  // store resolves the active workspace after React mounts.
  document.documentElement.setAttribute('data-bento-theme', 'default');
  document.documentElement.setAttribute('data-muxui-theme', 'default');
  document.documentElement.setAttribute('data-muxui-color-scheme', mode);
  document.documentElement.setAttribute('data-muxui-contrast', 'standard');
  document.documentElement.setAttribute(
    'data-bento-color-mode-pref',
    stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'light',
  );

  // Lowercase words joined by single hyphens: no dots, slashes, or other path syntax.
  var themeId = localStorage.getItem('workspace-theme');
  var optOut =
    document.currentScript && document.currentScript.hasAttribute('data-bento-no-theme-sheet');
  if (
    document.head &&
    !optOut &&
    themeId &&
    themeId !== 'default' &&
    themeId.length <= 64 &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(themeId)
  ) {
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = './themes/' + themeId + '.css';
    link.setAttribute('data-bento-theme-sheet', themeId);
    // themeSheets.ts reads this marker, since load or error may fire before it adopts the link.
    link.setAttribute('data-bento-boot-sheet', 'loading');
    link.addEventListener('load', function () {
      link.setAttribute('data-bento-boot-sheet', 'loaded');
    });
    link.addEventListener('error', function () {
      link.setAttribute('data-bento-boot-sheet', 'failed');
    });
    document.head.appendChild(link);
  }
})();
