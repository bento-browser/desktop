Warning: truncated output (original token count: 209479)
Total output lines: 20039

/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Mounts two chrome <browser> elements that host bento-shell extension
// pages:
//   - bento-shell-frame   — the always-visible vertical sidebar (index.html)
//   - bento-palette-frame — the on-demand command palette overlay
//                           (palette.html), shown via Cmd/Ctrl+Alt+P
//
// extensions.webextensions.uuids is not honored for built-in addons, so we
// can't pin URLs at build time — WebExtensionPolicy.getByID resolves the
// per-profile UUID at runtime. Loaded via
//   <script src="chrome://browser/content/bento-shell-mount.js"/>
// from browser-box.inc.xhtml (external file because the chrome doc's meta
// CSP forbids inline scripts).

(function () {
  // Guard against double-initialization. Chrome scripts included from a
  // patched .inc.xhtml can sometimes execute more than once per window
  // (browser.xhtml include processing, addon-reload re-eval, etc.).
  // Attaching the keydown listener twice = each press toggles palette
  // open then immediately closed.
  if (window.__bentoShellMountInitialized) return;
  window.__bentoShellMountInitialized = true;

  const ADDON_ID = 'bento-shell@bento.app';
  const BENTO_PANEL_NEWTAB_PATH = '/dist/panel-newtab.html';
  const BENTO_WELCOME_STEP_ENV = 'BENTO_WELCOME_STEP';
  // Current post-import onboarding step. The welcome page also includes the
  // exact next step in its title signal; this is only a compatibility fallback.
  const BENTO_WELCOME_POST_IMPORT_STEP = '2';
  const BENTO_WELCOME_RESUME_HASH_KEY = 'bentoWelcomeStep';
  const PROMOTED_PANEL_CONTENT_PRESERVE_MS = 3000;
  const BENTO_DEFAULT_UI_COLOR_MODE = 'light';
  const CHROME_DARK_QUERY = '(prefers-color-scheme: dark)';
  const STARTUP_VEIL_TIMEOUT_MS = 3000;
  const BENTO_DOM_FULLSCREEN_PANEL_ATTR = 'bento-dom-fullscreen-panel';
  const BENTO_DOM_FULLSCREEN_REQUESTER_ATTR = 'data-bento-dom-fullscreen-requester';
  const BENTO_PANEL_CORNER_RADIUS_MIN = 0;
  const BENTO_PANEL_CORNER_RADIUS_MAX = 36;
  const BENTO_PANEL_SPLITTER_SIZE_MIN = 6;
  const BENTO_PANEL_SPLITTER_SIZE_MAX = 36;
  const BENTO_CONTENT_LOAD_FLAGS =
    Ci.nsIWebNavigation.LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL;

  function seedChromeColorMode() {
    const root = document.documentElement;
    if (!root) return;
    // Match bento-shell/public/boot.js's fresh-profile default before
    // chrome token/theme stylesheets load. The persisted setting still
    // arrives through BENTO_PANELS and can flip this to dark/system, but
    // seeding prevents new windows from painting OS-dark chrome while the
    // sidebar iframe has already booted into Bento's default light mode.
    if (!root.hasAttribute('data-color-mode')) {
      root.setAttribute('data-color-mode', BENTO_DEFAULT_UI_COLOR_MODE);
    }
    if (!root.hasAttribute('data-theme')) {
      root.setAttribute('data-theme', BENTO_DEFAULT_UI_COLOR_MODE);
    }
    if (!root.hasAttribute('data-bento-color-mode-pref')) {
      root.setAttribute('data-bento-color-mode-pref', BENTO_DEFAULT_UI_COLOR_MODE);
    }
  }
  seedChromeColorMode();
  document.documentElement.setAttribute('bento-startup-loading', 'true');

  function isStaleWebProgressRemoveError(err) {
    const message = String(err?.message || err || '');
    return (
      message.includes('removeProgressListener') &&
      (message.includes('NS_ERROR_FAILURE') ||
        message.includes('0x80004005') ||
        (typeof Cr !== 'undefined' && err?.result === Cr.NS_ERROR_FAILURE))
    );
  }

  window.addEventListener(
    'error',
    (event) => {
      if (!isStaleWebProgressRemoveError(event.error || event.message)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );

  // Mirror the synced/unsynced flag from BrowserWindowTracker.openWindow
  // (set on `window._bentoStartupSyncFlag` by patches/window-sync/01-...)
  // onto documentElement as a chrome-attribute so it's:
  //   1. Observable in the Browser Toolbox (Phase B verification step).
  //   2. Available to CSS for chrome differentiation if needed later.
  //   3. Read by Phase C's BentoWindowSync to decide whether to attach
  //      its event listeners to this window.
  // Default to "synced" when the flag is missing (e.g. the very first
  // window opened at startup before BrowserWindowTracker's openWindow has
  // run — Firefox itself creates that one) so the master pref's "synced
  // by default" stance still applies.
  (() => {
    const flag = window._bentoStartupSyncFlag === 'unsynced' ? 'unsynced' : 'synced';
    if (flag === 'synced') {
      document.documentElement.setAttribute('bento-synced-window', 'true');
    } else {
      document.documentElement.setAttribute('bento-unsynced-window', 'true');
    }
  })();

  // Cmd+Shift+Alt+N (macOS) / Ctrl+Shift+Alt+N (others) → open a new
  // UNSYNCED window. Bound via capture-phase listener on window so we
  // intercept the event BEFORE Firefox's XUL <key> element bindings get
  // a chance — XUL <key> matching is sometimes lax about extra
  // modifiers, so Cmd+Shift+Alt+N can accidentally trigger
  // key_privatebrowsing (Cmd+Shift+N) or even key_newNavigator (Cmd+N)
  // depending on the Firefox version's matching rules. preventDefault +
  // stopImmediatePropagation in the capture phase aborts the chain
  // before chrome <key>-derived handlers fire. The default Cmd+N path
  // continues to go through OpenBrowserWindow() with no explicit
  // bentoSyncedWindow option (→ synced via the openWindow default).
  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.altKey || !e.shiftKey) return;
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.code !== 'KeyN') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      try {
        if (typeof window.OpenBrowserWindow === 'function') {
          window.OpenBrowserWindow({ bentoSyncedWindow: false });
        } else {
          console.warn(
            '[bento-shell-mount] OpenBrowserWindow not defined — cannot open unsynced window',
          );
        }
      } catch (err) {
        console.warn('[bento-shell-mount] cmd_bentoNewNavigatorUnsynced failed:', err);
      }
    },
    true /* capture */,
  );

  // Tale UI design tokens for chrome. The token CSS is generated from
  // tale-ui source by scripts/generate-chrome-tokens.mjs (runs as part
  // of `pnpm run import`) and registered in chrome via patches/chrome-
  // layout/01-bento-shell-mount.patch's jar.mn entry. Loading it as a
  // <link> stylesheet exposes Tale UI's variable cascade on the chrome
  // <window>'s :root, so chrome inline styles can use `var(--color-60)`,
  // `var(--neutral-90)`, `var(--radius-m)`, etc. — auto-themable via
  // future Scale-app-driven theme files, auto-flipping with the OS
  // color scheme via Tale UI's _color-modes.css cascade.
  //
  // We keep `var()` references (no manual hex constants) so any change
  // to Tale UI's primitives flows in on the next import without anyone
  // touching this file.
  function injectChromeTokens() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome://browser/content/bento-chrome-tokens.css';
    document.documentElement.appendChild(link);
  }
  injectChromeTokens();

  // Map Firefox's chrome color variables (--toolbar-bgcolor,
  // --toolbar-field-background-color, --toolbox-textcolor, etc.) to
  // Tale UI tokens so the visible chrome (toolbar, URL bar, titlebar)
  // re-themes from the same source as the rest of Bento. Loaded AFTER
  // tokens so the var() references it makes resolve. See the file
  // header at chrome://browser/content/bento-chrome-theme.css for the
  // coverage list. Scrollbars and devtools chrome stay on Firefox
  // defaults until iterated.
  function injectChromeTheme() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome://browser/content/bento-chrome-theme.css';
    document.documentElement.appendChild(link);
  }
  injectChromeTheme();

  const BENTO_CHROME_THEME_ATTRS = [
    'data-color-mode',
    'data-theme',
    'data-bento-color-mode-pref',
    'data-bento-theme',
  ];
  const BENTO_CHROME_STYLESHEET_HREFS = [
    'chrome://browser/content/bento-chrome-tokens.css',
    'chrome://browser/content/bento-chrome-theme.css',
  ];
  const BENTO_CHROME_SHADOW_THEME_HOST_SELECTOR = [
    'sidebar-main',
    'sidebar-history',
    'sidebar-syncedtabs',
    'sidebar-bookmarks',
    'sidebar-bookmark-list',
    'sidebar-panel-header',
    'sidebar-customize',
    'moz-input-search',
  ].join(',');

  function isBentoThemeableChromeDocument(doc) {
    const href = String(doc?.location?.href || '');
    return (
      href.startsWith('chrome://browser/content/sidebar/') ||
      href.startsWith('chrome://browser/content/places/')
    );
  }

  function hasChromeStylesheet(doc, href) {
    return Array.from(doc.documentElement.querySelectorAll('link[rel="stylesheet"]')).some(
      (link) => link.getAttribute('href') === href,
    );
  }

  function hasRootChromeStylesheet(root, href) {
    return Array.from(root.querySelectorAll?.('link[rel="stylesheet"]') || []).some(
      (link) => link.getAttribute('href') === href,
    );
  }

  function syncBentoChromeThemeRoot(root, doc) {
    for (const href of BENTO_CHROME_STYLESHEET_HREFS) {
      if (hasRootChromeStylesheet(root, href)) continue;
      const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', href);
      link.setAttribute('data-bento-chrome-theme', 'true');
      root.appendChild(link);
    }
  }

  function syncBentoChromeThemeShadowRoots(doc, attempt = 0) {
    const href = String(doc?.location?.href || '');
    if (!href.startsWith('chrome://browser/content/sidebar/')) return;

    const roots = new Set();
    let hostCount = 0;
    let missingShadowRoot = false;

    const collectRoots = (root) => {
      for (const host of root.querySelectorAll?.(BENTO_CHROME_SHADOW_THEME_HOST_SELECTOR) || []) {
        hostCount += 1;
        if (!host.shadowRoot) {
          missingShadowRoot = true;
          continue;
        }
        if (roots.has(host.shadowRoot)) continue;
        roots.add(host.shadowRoot);
        collectRoots(host.shadowRoot);
      }
    };

    collectRoots(doc);

    for (const root of roots) {
      syncBentoChromeThemeRoot(root, doc);
    }

    if (attempt >= 20 || (hostCount > 0 && !missingShadowRoot)) return;
    doc.defaultView?.setTimeout(() => syncBentoChromeThemeShadowRoots(doc, attempt + 1), 50);
  }

  function syncChromeThemeAttributes(targetRoot) {
    const sourceRoot = document.documentElement;
    for (const attr of BENTO_CHROME_THEME_ATTRS) {
      const value = sourceRoot.getAttribute(attr);
      if (value === null) targetRoot.removeAttribute(attr);
      else targetRoot.setAttribute(attr, value);
    }
  }

  function runNativeBookmarksSearch(doc, input) {
    const win = doc?.defaultView;
    if (typeof win?.searchBookmarks === 'function') {
      win.searchBookmarks({ currentTarget: input });
      return;
    }

    const tree = doc?.getElementById('bookmarks-view');
    if (!tree) return;
    const value = input.value;
    if (!value) {
      tree.place = tree.place;
      return;
    }

    try {
      win?.Glean?.sidebar?.search?.bookmarks?.add(1);
      win?.Glean?.browserUiInteraction?.sidebarBookmarks?.search?.add(1);
      if (win && typeof win.gCumulativeSearches === 'number') win.gCumulativeSearches += 1;
    } catch {
      // Telemetry is best-effort here; the filter itself must keep working.
    }

    const roots = win?.PlacesUtils?.bookmarks?.userContentRoots;
    if (roots) tree.applyFilter(value, roots);
  }

  function syncNativeBookmarksSearchInput(doc, attempt = 0) {
    const href = String(doc?.location?.href || '');
    if (!href.startsWith('chrome://browser/content/places/bookmarksSidebar.xhtml')) return;
    const search = doc.getElementById('search-box');
    if (!search) return;
    if (search.classList?.contains('bento-bookmarks-search-input')) return;

    const scheduleRetry = () => {
      if (attempt >= 20) return;
      doc.defaultView?.setTimeout(() => syncNativeBookmarksSearchInput(doc, attempt + 1), 50);
    };

    const container = doc.getElementById('sidebar-search-container');
    if (!container) {
      scheduleRetry();
      return;
    }

    const input = doc.createElementNS('http://www.w3.org/1999/xhtml', 'input');
    input.id = 'search-box';
    input.className = 'bento-bookmarks-search-input';
    input.type = 'search';
    input.autocomplete = 'off';
    input.setAttribute('aria-controls', 'bookmarks-view');
    input.setAttribute('data-l10n-id', 'places-bookmarks-search');
    input.setAttribute('data-l10n-attrs', 'placeholder');

    const placeholder = search.getAttribute('placeholder') || search.placeholder;
    if (placeholder) input.setAttribute('placeholder', placeholder);
    if ('value' in search && search.value) input.value = search.value;

    let searchTimeout = 0;
    const queueSearch = () => {
      doc.defaultView?.clearTimeout(searchTimeout);
      searchTimeout = doc.defaultView?.setTimeout(
        () => runNativeBookmarksSearch(doc, input),
        250,
      );
    };
    input.addEventListener('input', queueSearch);
    input.addEventListener('search', () => {
      doc.defaultView?.clearTimeout(searchTimeout);
      runNativeBookmarksSearch(doc, input);
    });

    search.replaceWith(input);
    doc.l10n?.translateElements?.([input]);
  }

  function syncBentoChromeThemeDocument(doc) {
    if (!doc?.documentElement || !isBentoThemeableChromeDocument(doc)) return false;
    const root = doc.documentElement;
    syncChromeThemeAttributes(root);
    for (const href of BENTO_CHROME_STYLESHEET_HREFS) {
      if (hasChromeStylesheet(doc, href)) continue;
      const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
      link.setAttribute('rel', 'stylesheet');
      link.setAttribute('href', href);
      link.setAttribute('data-bento-chrome-theme', 'true');
      root.appendChild(link);
    }
    syncBentoChromeThemeShadowRoots(doc);
    syncNativeBookmarksSearchInput(doc);
    return true;
  }

  let nativeSidebarThemeSyncQueued = false;
  function syncNativeSidebarChromeTheme() {
    nativeSidebarThemeSyncQueued = false;
    const sidebar = document.getElementById('sidebar');
    let doc = null;
    try {
      doc = sidebar?.contentDocument || sidebar?.contentWindow?.document;
    } catch {
      doc = null;
    }
    syncBentoChromeThemeDocument(doc);
  }

  function scheduleNativeSidebarChromeThemeSync() {
    if (nativeSidebarThemeSyncQueued) return;
    nativeSidebarThemeSyncQueued = true;
    window.requestAnimationFrame(syncNativeSidebarChromeTheme);
  }

  function attachNativeSidebarChromeThemeSync() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && !sidebar.__bentoChromeThemeSyncAttached) {
      sidebar.__bentoChromeThemeSyncAttached = true;
      sidebar.addEventListener('load', scheduleNativeSidebarChromeThemeSync, true);
    }
    scheduleNativeSidebarChromeThemeSync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachNativeSidebarChromeThemeSync, {
      once: true,
    });
  } else {
    attachNativeSidebarChromeThemeSync();
  }
  window.addEventListener('load', attachNativeSidebarChromeThemeSync, { once: true });
  new MutationObserver(scheduleNativeSidebarChromeThemeSync).observe(document.documentElement, {
    attributes: true,
    attributeFilter: BENTO_CHROME_THEME_ATTRS,
  });

  function resolveChromeToken(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function syncArrowPanelTheme(panel) {
    if (!panel || panel.localName !== 'panel' || panel.getAttribute('type') !== 'arrow') return;

    const background = resolveChromeToken('--neutral-10');
    const color = resolveChromeToken('--neutral-90');
    const borderColor = resolveChromeToken('--neutral-20');
    const radius = resolveChromeToken('--radius-l');

    if (background) panel.style.setProperty('--panel-background', background, 'important');
    if (color) panel.style.setProperty('--panel-color', color, 'important');
    if (borderColor) panel.style.setProperty('--panel-border-color', borderColor, 'important');
    if (radius) panel.style.setProperty('--panel-border-radius', radius, 'important');
  }

  function syncArrowPanelsTheme() {
    for (const panel of document.querySelectorAll('panel[type="arrow"]')) {
      syncArrowPanelTheme(panel);
    }
  }

  document.addEventListener(
    'popupshowing',
    (event) => {
      syncArrowPanelTheme(event.target);
    },
    true,
  );
  requestAnimationFrame(syncArrowPanelsTheme);

  // Inject layout-shape CSS that depends on the tokens above. Kept in
  // a runtime-injected <style> rather than a static file because the
  // .browserContainer class only exists on per-tab elements created
  // dynamically by tabbrowser — a CSS rule applies forever, no need to
  // hook tab creation.
  function injectChromeStyles() {
    const style = document.createElement('style');
    style.textContent = `
      /* Consistent chrome gaps and splitter slots. Panel boundaries all
         reserve --bento-splitter-hit-size; the visible indicator is a
         centered half-length capsule inside that hit target. */
      :root {
        --bento-panel-frame-outline-shadow: 0 0 0 var(--bento-border-hairline) var(--neutral-20);
        --bento-panel-frame-shadow: var(--bento-panel-frame-outline-shadow), var(--shadow-l);
        --bento-panel-corner-radius: var(--radius-m);
        --bento-splitter-hit-size: 14px;
        --bento-splitter-hit-half: calc(var(--bento-splitter-hit-size) / 2);
        --bento-splitter-indicator-radius: 3px;
        --bento-panel-gap: var(--bento-splitter-hit-size);
        --bento-scrollbar-thickness: calc(
          var(--bento-splitter-indicator-radius) + var(--bento-splitter-indicator-radius)
        );
        --bento-scrollbar-radius: var(--bento-splitter-indicator-radius);
        --bento-strip-scrollbar-gap: var(--space-2xs);
        /* Match Firefox toolbar-button hit targets at every density and
           narrow-window breakpoint. The navigator is plain HTML, so it does
           not inherit the native toolbarbutton sizing rules automatically. */
        --bento-panel-nav-button-size: calc(16px + (var(--toolbarbutton-padding-inner) * 2));
        --bento-panel-nav-favicon-size: var(--bento-icon-size-sm);
        --bento-panel-nav-height: calc(
          var(--bento-panel-nav-button-size) + var(--space-xs)
        );
        /* The macOS titlebar controls are copied into #nav-bar while the
           native tab strip is hidden. Keep that shared control row clear of
           the window edge without introducing a second titlebar surface. */
        --bento-toolbar-top-inset: 4px;
        --bento-toolbar-sidebar-bg: var(--neutral-5);
        --bento-toolbar-main-bg: var(--neutral-14);
        --bento-toolbar-divider-x: 100vw;
        --bento-panel-strip-bg: var(--bento-toolbar-main-bg);
        --bento-strip-scrollbar-row-height: calc(
          var(--bento-scrollbar-thickness) + var(--bento-strip-scrollbar-gap)
        );
        --bento-strip-controls-height: var(--bento-strip-scrollbar-row-height);
      }
      :root[bento-no-side-panels='true'] {
        --bento-toolbar-main-bg: var(--neutral-5);
      }
      #tabbrowser-tabpanels.bento-panel-shadows-disabled,
      #bento-strip-container.bento-panel-shadows-disabled {
        --bento-panel-frame-shadow: var(--bento-panel-frame-outline-shadow);
      }

      /* Inline sidebar: no padding around the frame, no rounded
         corners on the frame. Edges flush with the window so the
         sidebar reads as part of the chrome rather than a floating
         card. Keep it in normal paint order so real panel content and
         direct panel shadows clip together at the sidebar/strip
         boundary. */
      #bento-shell-host {
        padding: 0;
        position: relative;
      }
      #bento-shell-host > #bento-shell-frame {
        border-radius: 0;
      }
      /* Sidebar splitter: the native XUL splitter owns persistence and
         baseline layout, but its own painting stays invisible. The
         visible hover/drag affordance is #bento-shell-splitter-
         affordance, an HTML overlay positioned from actual sidebar and
         content rects so it sits in the gap instead of on the sidebar
         edge.
         !important needed for width + min-width because XUL chrome
         CSS sets defaults for <splitter> that win otherwise. */
      /* Remove Firefox's top-toolbar/content separator so the toolbar
         reads as one continuous surface with the sidebar. Firefox's
         content-area.css applies a tiny border-bottom on
         #navigator-toolbox, and upstream toolbar rules may paint on
         #nav-bar, so this must be explicit. */
      #navigator-toolbox,
      #nav-bar {
        border-bottom: 0 !important;
        box-shadow: none !important;
        outline: none !important;
      }
      #navigator-toolbox {
        position: relative !important;
      }
      #toolbar-menubar,
      #TabsToolbar,
      #nav-bar,
      #PersonalToolbar {
        position: relative !important;
        z-index: 1 !important;
      }
      @media (-moz-platform: macos) {
        /* The titlebar controls, native navigation controls, and Bento's
           panel navigator all live in this toolbar. Padding its top edge
           moves the complete row together and preserves its toolbar layout. */
        #nav-bar {
          padding-block-start: var(--bento-toolbar-top-inset) !important;
        }
      }
      #bento-toolbar-main-backdrop {
        position: fixed;
        top: 0;
        left: var(--bento-toolbar-divider-x);
        width: calc(100vw - var(--bento-toolbar-divider-x));
        height: var(--bento-toolbar-backdrop-height, 0px);
        background-color: var(--bento-toolbar-main-bg);
        pointer-events: none;
        z-index: 0;
      }
      #navigator-toolbox,
      #TabsToolbar,
      #nav-bar {
        background-color: var(--bento-toolbar-main-bg) !important;
        background-image: linear-gradient(
          to right,
          var(--bento-toolbar-sidebar-bg) 0,
          var(--bento-toolbar-sidebar-bg) var(--bento-toolbar-divider-x),
          var(--bento-toolbar-main-bg) var(--bento-toolbar-divider-x),
          var(--bento-toolbar-main-bg) 100%
        ) !important;
        background-repeat: no-repeat !important;
      }
      :root[bento-sidebar-addressbar='true'] body,
      :root[bento-sidebar-addressbar='true'] body::after,
      :root[bento-sidebar-addressbar='true'] #browser,
      :root[bento-sidebar-addressbar='true'] #appcontent {
        background-color: var(--bento-toolbar-main-bg) !important;
        background-image: linear-gradient(
          to right,
          var(--bento-toolbar-sidebar-bg) 0,
          var(--bento-toolbar-sidebar-bg) var(--bento-toolbar-divider-x),
          var(--bento-toolbar-main-bg) var(--bento-toolbar-divider-x),
          var(--bento-toolbar-main-bg) 100%
        ) !important;
        background-repeat: no-repeat !important;
        background-size: 100% 100% !important;
      }
      :root[bento-sidebar-addressbar='true'] body::after {
        appearance: none !important;
        -moz-default-appearance: none !important;
      }
      /* bento-chrome-theme.css paints core chrome containers neutral-5 with
         layered !important rules. Keep these in the same layer so the panel
         path cannot leak that sidebar colour behind the main-side strip. */
      @layer bento.chrome-theme {
        :root[bento-sidebar-addressbar='true'] body,
        :root[bento-sidebar-addressbar='true'] body::after,
        :root[bento-sidebar-addressbar='true'] #browser,
        :root[bento-sidebar-addressbar='true'] #appcontent {
          background-color: var(--bento-toolbar-main-bg) !important;
          background-image: linear-gradient(
            to right,
            var(--bento-toolbar-sidebar-bg) 0,
            var(--bento-toolbar-sidebar-bg) var(--bento-toolbar-divider-x),
            var(--bento-toolbar-main-bg) var(--bento-toolbar-divider-x),
            var(--bento-toolbar-main-bg) 100%
          ) !important;
          background-repeat: no-repeat !important;
          background-size: 100% 100% !important;
        }
        :root[bento-sidebar-addressbar='true'] body::after {
          appearance: none !important;
          -moz-default-appearance: none !important;
        }
        :root[bento-sidebar-addressbar='true'] #bento-strip-container,
        :root[bento-sidebar-addressbar='true'] #bento-side-panel-host,
        :root[bento-sidebar-addressbar='true'] #tabbrowser-tabpanels.bento-split-active,
        :root[bento-sidebar-addressbar='true'] #tabbrowser-tabbox:has(> #tabbrowser-tabpanels.bento-split-active),
        :root[bento-sidebar-addressbar='true'] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel],
        :root[bento-sidebar-addressbar='true'] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels,
        :root[bento-sidebar-addressbar='true'] #bento-add-panel-trailer,
        :root[bento-sidebar-addressbar='true'] #bento-flat-layout-extent {
          background-color: var(--bento-panel-strip-bg) !important;
          background-image: none !important;
        }
      }
      :root {
        --bento-toolbar-nav-offset: 0px;
        --bento-bookmarks-toolbar-offset: 0px;
        --bento-bookmarks-toolbar-height: 0px;
        --bento-tab-strip-width-min-effective: var(--bento-tab-strip-width-min);
      }
      :root[bento-sidebar-addressbar='true'] #nav-bar-customization-target > #back-button {
        margin-inline-start: var(--bento-toolbar-nav-offset, 0px) !important;
      }
      :root[bento-sidebar-addressbar='true'] #bento-shell-host,
      :root[bento-sidebar-addressbar='true'] #bento-shell-splitter,
      :root[bento-sidebar-addressbar='true'] #bento-sidebar-hidden-hover-zone,
      :root[bento-sidebar-addressbar='true'] #sidebar-main,
      :root[bento-sidebar-addressbar='true'] #sidebar-launcher-splitter,
      :root[bento-sidebar-addressbar='true'] #sidebar-box,
      :root[bento-sidebar-addressbar='true'] #sidebar-splitter {
        margin-block-start: calc(-1 * var(--bento-bookmarks-toolbar-height, 0px)) !important;
        height: calc(100% + var(--bento-bookmarks-toolbar-height, 0px)) !important;
      }
      :root[bento-sidebar-addressbar='true'] #bento-shell-splitter-affordance {
        top: calc(-1 * var(--bento-bookmarks-toolbar-height, 0px)) !important;
      }
      :root[bento-sidebar-addressbar='true'] #PersonalToolbar {
        margin-inline-start: var(--bento-bookmarks-toolbar-offset, 0px) !important;
        width: calc(100% - var(--bento-bookmarks-toolbar-offset, 0px)) !important;
        max-width: calc(100% - var(--bento-bookmarks-toolbar-offset, 0px)) !important;
        min-width: 0 !important;
        box-sizing: border-box !important;
        transition: none !important;
        animation: none !important;
      }
      :root[bento-sidebar-addressbar='true'] #PersonalToolbar[collapsed] {
        visibility: collapse !important;
        transition: none !important;
      }
      :root[bento-sidebar-addressbar='true'] #nav-bar-customization-target > toolbarspring {
        display: none !important;
        visibility: collapse !important;
      }
      :root[bento-sidebar-addressbar='true'] #nav-bar-customization-target > [data-bento-extension-toolbar-anchor='true'] {
        margin-inline-start: auto !important;
      }
      :root[bento-sidebar-addressbar='true'] #nav-bar > .titlebar-spacer[type='post-tabs'] {
        display: none !important;
        visibility: collapse !important;
      }
      :root[bento-sidebar-addressbar='true'] #fxa-toolbar-menu-button,
      :root[bento-sidebar-addressbar='true'] #wrapper-fxa-toolbar-menu-button {
        display: none !important;
        visibility: collapse !important;
      }
      :root[bento-sidebar-resizing='true'][bento-sidebar-addressbar='true'] #nav-bar-customization-target > #back-button,
      :root[bento-sidebar-resizing='true'][bento-sidebar-addressbar='true'] #nav-bar-customization-target > #forward-button,
      :root[bento-sidebar-resizing='true'][bento-sidebar-addressbar='true'] #nav-bar-customization-target > #stop-reload-button,
      :root[bento-sidebar-resizing='true'][bento-sidebar-addressbar='true'] #nav-bar-customization-target > #bento-panel-nav {
        transform: translateX(var(--bento-toolbar-nav-offset, 0px));
        will-change: transform;
      }
      :root[bento-sidebar-resizing='true'][bento-sidebar-addressbar='true'] #nav-bar-customization-target > #back-button {
        margin-inline-start: 0 !important;
      }
      :root[bento-startup-loading='true'] #navigator-toolbox {
        opacity: 0;
        pointer-events: none;
      }
      #bento-startup-veil {
        position: absolute;
        inset: 0;
        z-index: 2147483000;
        display: grid;
        grid-template-columns:
          minmax(48px, var(--bento-tab-strip-width-min-effective, var(--bento-tab-strip-width-min, 220px)))
          1fr;
        min-width: 0;
        min-height: 0;
        background-color: var(--neutral-5);
        color: var(--neutral-90);
        pointer-events: auto;
        opacity: 1;
        transition: opacity 140ms var(--bento-easing-standard, ease);
      }
      #bento-startup-veil[hidden],
      :root:not([bento-startup-loading='true']) #bento-startup-veil {
        opacity: 0;
        pointer-events: none;
      }
      .bento-startup-veil__sidebar,
      .bento-startup-veil__main {
        box-sizing: border-box;
        min-width: 0;
        min-height: 0;
        background-color: var(--neutral-5);
      }
      .bento-startup-veil__sidebar {
        border-inline-end: 1px solid var(--bento-sidebar-divider-color);
        padding: var(--space-xs);
      }
      .bento-startup-veil__main {
        display: flex;
        flex-direction: column;
        gap: var(--space-l);
        padding: var(--space-s);
      }
      .bento-startup-veil__toolbar {
        height: 32px;
        border-radius: var(--radius-s);
        background-color: var(--neutral-12);
      }
      .bento-startup-veil__content {
        flex: 1 1 auto;
        min-height: 0;
        border-radius: var(--radius-m);
        background-color: var(--neutral-8);
        overflow: hidden;
        position: relative;
      }
      .bento-startup-veil__content::before {
        content: '';
        position: absolute;
        left: 50%;
        top: 42%;
        width: min(21.25rem, 46%);
        height: 2.5rem;
        border-radius: var(--radius-s);
        background-color: var(--neutral-14);
        transform: translate(-50%, -50%);
      }
      .bento-startup-veil__content::after {
        content: '';
        position: absolute;
        left: 50%;
        top: calc(42% + 4.0625rem);
        width: min(17.5rem, 38%);
        height: 1.75rem;
        border-radius: var(--radius-s);
        background-color: var(--neutral-12);
        transform: translateX(-50%);
      }
      .bento-startup-veil__workspace,
      .bento-startup-veil__row {
        display: flex;
        align-items: center;
        gap: var(--space-xs);
      }
      .bento-startup-veil__workspace {
        height: 2.25rem;
        margin-block-end: var(--space-s);
      }
      .bento-startup-veil__rows {
        display: flex;
        flex-direction: column;
        gap: var(--space-xs);
      }
      .bento-startup-veil__dot {
        width: 1rem;
        height: 1rem;
        border-radius: var(--radius-s);
        background-color: var(--neutral-14);
        flex: 0 0 auto;
      }
      .bento-startup-veil__row .bento-startup-veil__dot {
        width: 0.625rem;
        height: 0.625rem;
      }
      .bento-startup-veil__bar {
        height: 0.625rem;
        border-radius: var(--radius-xs);
        background-color: var(--neutral-14);
      }
      .bento-startup-veil__workspace .bento-startup-veil__bar {
        width: 4.375rem;
      }
      .bento-startup-veil__row .bento-startup-veil__bar {
        width: min(7.5rem, 68%);
      }
      @media (prefers-reduced-motion: no-preference) {
        .bento-startup-veil__bar,
        .bento-startup-veil__dot,
        .bento-startup-veil__toolbar,
        .bento-startup-veil__content::before,
        .bento-startup-veil__content::after {
          animation: bento-startup-veil-pulse 1.2s var(--bento-easing-in-out, ease-in-out) infinite;
        }
      }
      @keyframes bento-startup-veil-pulse {
        0%, 100% { opacity: 0.58; }
        50% { opacity: 1; }
      }
      #bento-shell-splitter {
        width: var(--bento-splitter-hit-size) !important;
        min-width: var(--bento-splitter-hit-size) !important;
        max-width: var(--bento-splitter-hit-size) !important;
        margin-inline: calc(-1 * var(--bento-splitter-hit-half));
        cursor: col-resize;
        border: 0 !important;
        padding: 0 !important;
        appearance: none;
        background-color: transparent;
        background-image: none;
        position: relative;
        z-index: 3;
      }
      #bento-shell-splitter-affordance {
        position: absolute;
        top: 0;
        bottom: 0;
        width: var(--bento-splitter-hit-size);
        cursor: col-resize;
        pointer-events: auto;
        z-index: 4;
        background-image:
          radial-gradient(circle at 50% 25%, var(--color-60) 0, var(--color-60) var(--bento-splitter-indicator-radius), transparent var(--bento-splitter-indicator-radius)),
          linear-gradient(
            to right,
            transparent calc(50% - var(--bento-splitter-indicator-radius)),
            var(--color-60) calc(50% - var(--bento-splitter-indicator-radius)),
            var(--color-60) calc(50% + var(--bento-splitter-indicator-radius)),
            transparent calc(50% + var(--bento-splitter-indicator-radius))
          ),
          radial-gradient(circle at 50% 75%, var(--color-60) 0, var(--color-60) var(--bento-splitter-indicator-radius), transparent var(--bento-splitter-indicator-radius));
        background-position: center;
        background-repeat: no-repeat;
        background-size:
          100% 100%,
          100% 50%,
          100% 100%;
        opacity: 0;
        transition: opacity var(--bento-duration-base) var(--bento-easing-standard);
      }
      #bento-shell-splitter-affordance:hover,
      #bento-shell-splitter-affordance.bento-shell-splitter--dragging {
        opacity: 1;
      }
      #bento-shell-splitter-affordance.bento-sidebar-collapsed {
        display: none;
      }
      :root[bento-sidebar-addressbar='true'] #sidebar-splitter {
        width: var(--bento-splitter-hit-size) !important;
        min-width: var(--bento-splitter-hit-size) !important;
        max-width: var(--bento-splitter-hit-size) !important;
        margin-inline: calc(-1 * var(--bento-splitter-hit-half)) !important;
        cursor: col-resize;
        border: 0 !important;
        padding: 0 !important;
        appearance: none;
        background-color: transparent !important;
        background-image:
          radial-gradient(circle at 50% 25%, var(--color-60) 0, var(--color-60) var(--bento-splitter-indicator-radius), transparent var(--bento-splitter-indicator-radius)),
          linear-gradient(
            to right,
            transparent calc(50% - var(--bento-splitter-indicator-radius)),
            var(--color-60) calc(50% - var(--bento-splitter-indicator-radius)),
            var(--color-60) calc(50% + var(--bento-splitter-indicator-radius)),
            transparent calc(50% + var(--bento-splitter-indicator-radius))
          ),
          radial-gradient(circle at 50% 75%, var(--color-60) 0, var(--color-60) var(--bento-splitter-indicator-radius), transparent var(--bento-splitter-indicator-radius));
        background-position: center;
        background-repeat: no-repeat;
        background-size:
          100% 100%,
          100% 50%,
          100% 100%;
        opacity: 0;
        transition: opacity var(--bento-duration-base) var(--bento-easing-standard);
        z-index: 4;
      }
      :root[bento-sidebar-addressbar='true'] #sidebar-splitter:hover,
      :root[bento-sidebar-addressbar='true'] #sidebar-splitter:focus-visible,
      :root[bento-sidebar-addressbar='true'] #sidebar-splitter.bento-native-sidebar-splitter--dragging {
        opacity: 1;
      }
      #bento-sidebar-chrome-divider {
        position: fixed;
        top: 0;
        bottom: 0;
        width: 1px;
        background-color: var(--bento-sidebar-divider-color);
        pointer-events: none;
        z-index: 3;
      }
      :root[bento-no-side-panels='true'] #bento-sidebar-chrome-divider {
        display: none;
      }

      /* Sidebar dimensions. The chrome patch ships inline width/min/max
         on #bento-shell-host (so the sidebar still renders sensibly if
         our stylesheet hasn't loaded yet); we override the bounds via
         !important here from --bento-tab-strip-width-min/-max so they
         become tunable from bento-tokens.css without a patch rebuild.
         Collapsed pins width/min/max to --bento-tab-strip-width-
         collapsed, which already reserves the collapsed control plus
         symmetric rail padding. Keep the chrome host on this single token
         so live sidebar/window resize does not get an extra calc/max()
         width path; the transition is disabled below while resizing. */
      #bento-shell-host {
        min-width: var(--bento-tab-strip-width-min-effective, var(--bento-tab-strip-width-min)) !important;
        max-width: var(--bento-tab-strip-width-max) !important;
        transition:
          width 200ms var(--bento-easing-standard, ease),
          min-width 200ms var(--bento-easing-standard, ease),
          max-width 200ms var(--bento-easing-standard, ease);
      }
      :root[bento-window-resizing='true'] #bento-shell-host,
      :root[bento-sidebar-resizing='true'] #bento-shell-host,
      #bento-shell-host.bento-shell-sidebar-resizing {
        transition: none !important;
      }
      #bento-shell-host.bento-shell-sidebar-resizing > #bento-shell-frame {
        pointer-events: none;
      }
      #bento-shell-host.bento-sidebar-collapsed {
        min-width: var(--bento-tab-strip-width-collapsed) !important;
        max-width: var(--bento-tab-strip-width-collapsed) !important;
        width: var(--bento-tab-strip-width-collapsed) !important;
      }
      #bento-shell-host.bento-sidebar-hidden {
        position: relative;
        z-index: 5;
        min-width: var(--bento-tab-strip-width-collapsed) !important;
        max-width: var(--bento-tab-strip-width-collapsed) !important;
        width: var(--bento-tab-strip-width-collapsed) !important;
        margin-right: calc(-1 * var(--bento-tab-strip-width-collapsed)) !important;
        overflow: hidden;
        pointer-events: none;
        transform: translateX(-100%);
        transition: transform 160ms var(--bento-easing-standard, ease);
      }
      #bento-shell-host.bento-sidebar-hidden.bento-sidebar-hidden-revealed {
        z-index: 7;
        pointer-events: auto;
        transform: translateX(0);
      }
      #bento-shell-splitter.bento-sidebar-collapsed {
        /* visibility:hidden (NOT display:none) so the splitter still
           occupies its --bento-splitter-hit-size slot — that's what creates
           the visible gap between the sidebar and the main content
           slot. Without the reserved width, the gap collapses to 0
           and the rail looks pasted against the panel area. The
           hidden splitter remains non-interactive (can't be dragged
           — there's nothing to resize when the rail is at its
           minimum) which is the same behaviour display:none gave us
           on the interaction front. */
        visibility: hidden;
      }
      #bento-shell-splitter.bento-sidebar-hidden {
        display: none !important;
        width: 0 !important;
        min-width: 0 !important;
        max-width: 0 !important;
        margin-inline: 0 !important;
      }
      #bento-shell-splitter-affordance.bento-sidebar-hidden {
        display: none;
      }
      #bento-sidebar-hidden-hover-zone {
        display: none;
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 12px;
        z-index: 6;
        pointer-events: none;
      }
      :root[bento-sidebar-hidden='true'] #bento-sidebar-hidden-hover-zone {
        display: block;
        pointer-events: auto;
      }

      /* Bento panel rounded corners. The real panel frame owns outer
         shadow/radius; clipping belongs to the inner browser surfaces
         so direct box-shadows are not cut off by the panel itself.
         - .browserContainer = the per-tab content area inside the main
           tab panel (one per browser tab in tabbrowser-tabbox).
         - [data-bento-panel-tab-id] = each side-panel vbox in the strip.
         - [data-bento-main-panel] = #tabbrowser-tabbox after we move
           it into the strip. */
      .browserContainer {
        border-radius: var(--bento-panel-corner-radius);
        overflow: clip;
      }

      /* Strip layout. Once unifyMainWithStrip() has moved
         #tabbrowser-tabbox in, the strip IS the entire content area
         right of the sidebar — main panel + side panels + Add-panel
         trailer in one horizontal scroll context. The container itself
         carries the sidebar-to-main gap. In split-view mode the real
         scrollport is #tabbrowser-tabpanels, which owns its own
         internal padding so panel content and direct shadows clip
         together at the scrollport edge. */
      /* The strip is wrapped in a vbox container by setupPanelNavigator
         so the custom bottom scrollbar can be overlaid in a stable
         position. The favicon navigator itself is mounted in the top
         toolbar after Reload, while browser extension buttons are pushed
         to the far side of the same top bar. */
      #bento-strip-container {
        display: flex;
        flex-direction: column;
        flex: 1 1 0%;
        min-width: 0;
        position: relative;
        z-index: 1;
        overflow: visible;
        background-color: var(--bento-panel-strip-bg) !important;
        background-image: none !important;
      }
      /* Workspace-switch fade. Applied as a class toggle to BOTH the
         split-view panel deck (#tabbrowser-tabpanels — Firefox-native,
         holds the main browser AND the side-panel browsers) AND the
         strip container (favicon navigator + custom scrollbar). They
         live in separate parts of the chrome tree so the only way to
         crossfade everything visible in one motion is to drive both
         with the same class. The visible transition is opacity-only;
         layout transitions on strip descendants are suppressed during
         the swap so reconcile writes land without visible motion.
         performWorkspaceSwitchFade also sets a swapping flag that
         suppresses in-reconcile animations (main-width transition,
         scroll-to-main smooth scroll, favicon nav enter/leave width
         transitions) so the user sees a STATIC fade — no panel
         sliding into place during fade-in. */
      #tabbrowser-tabpanels,
      #bento-strip-container,
      #bento-panel-nav {
        transition: opacity var(--bento-duration-fast, 140ms)
          var(--bento-easing-snappy, cubic-bezier(0.32, 0.72, 0, 1));
      }
      #tabbrowser-tabpanels.bento-workspace-switching,
      #bento-strip-container.bento-workspace-switching,
      #bento-panel-nav.bento-workspace-switching {
        opacity: 0;
      }
      /* Suppress layout transitions while the workspace strip is being
         swapped and while it fades back in. The opacity transition is
         our only workspace-switch animation; width/flex/transform
         transitions on panel containers or the favicon nav can restart
         when the fade class is removed, which reads as panels sliding
         behind the fade-in. Keep this scoped to Bento-owned strip
         structure rather than all descendants: broad animation
         suppression can break Firefox's internal browser painting. */
      #tabbrowser-tabpanels.bento-workspace-stabilizing > .split-view-panel-active,
      #tabbrowser-tabpanels.bento-workspace-stabilizing > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-workspace-stabilizing > [data-bento-panel-tab-id],
      #tabbrowser-tabpanels.bento-workspace-stabilizing > .split-view-splitter,
      #tabbrowser-tabpanels.bento-workspace-switching > .split-view-panel-active,
      #tabbrowser-tabpanels.bento-workspace-switching > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-workspace-switching > [data-bento-panel-tab-id],
      #tabbrowser-tabpanels.bento-workspace-switching > .split-view-splitter,
      #bento-panel-nav.bento-workspace-stabilizing .bento-panel-nav__icon,
      #bento-panel-nav.bento-workspace-stabilizing .bento-panel-nav__list,
      #bento-panel-nav.bento-workspace-switching .bento-panel-nav__icon,
      #bento-panel-nav.bento-workspace-switching .bento-panel-nav__list {
        transition: none !important;
      }
      @media (prefers-reduced-motion: reduce) {
        #tabbrowser-tabpanels,
        #bento-strip-container,
        #bento-panel-nav {
          transition: none;
        }
      }
      #bento-side-panel-host {
        display: flex;
        flex-direction: row;
        align-items: stretch;
        overflow: visible;
        border-radius: var(--bento-panel-corner-radius);
        gap: 0;
        flex: 1 1 auto;
        min-height: 0;
        /* position: relative so the absolute-positioned inter-panel
           splitters (children of this host — see syncInterPanelSplitters)
           anchor to the strip rather than scroll out of sync with some
           non-static ancestor. */
        position: relative;
        /* Native scrollbar hidden — replaced by the custom always-on
           scrollbar below. macOS auto-hides native scrollbars after a
           moment regardless of CSS, which conflicts with the user's
           "always visible" requirement. */
        scrollbar-width: none;
        background-color: var(--bento-panel-strip-bg) !important;
        background-image: none !important;
      }
      #bento-side-panel-host::-webkit-scrollbar {
        display: none;
      }
      #bento-strip-container.bento-no-side-panels > #bento-strip-scrollbar {
        display: none !important;
      }
      #bento-panel-nav.bento-panel-nav--hidden {
        display: none !important;
        visibility: collapse !important;
      }
      #bento-strip-container.bento-no-side-panels > #bento-side-panel-host {
        overflow: visible;
        padding: 0;
      }
      #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] {
        margin-block-start: var(--space-3xs);
        margin-block-end: var(--space-2xs);
        margin-inline-start: var(--space-2xs);
        margin-inline-end: var(--space-2xs);
        border-radius: 0;
        background-color: var(--bento-panel-strip-bg) !important;
        background-image: none !important;
        box-shadow: none;
        overflow: visible;
        position: relative;
        z-index: 1;
      }
      #bento-strip-container.bento-no-side-panels.bento-panel-shadows-disabled > #bento-side-panel-host > [data-bento-main-panel] {
        box-shadow: none;
      }
      /* No-panel frame uses Firefox's native structure: the
         tabbox wrapper creates the gutter, while browserSidebarContainer
         owns the rounded clip and frame paint. This keeps macOS live
         window resize smooth. */
      #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels > .browserSidebarContainer {
        border-radius: var(--radius-xl);
        background-color: var(--neutral-5);
        box-shadow: var(--bento-panel-frame-shadow);
        overflow: clip;
      }
      #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels > .browserSidebarContainer > .browserContainer {
        border-radius: 0;
        overflow: visible;
      }
      #bento-strip-container.bento-no-side-panels.bento-panel-shadows-disabled > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels > .browserSidebarContainer {
        box-shadow: var(--bento-panel-frame-outline-shadow);
      }
      :root[bento-window-resizing='true'] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels > .browserSidebarContainer,
      :root[bento-sidebar-resizing='true'] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels > .browserSidebarContainer {
        box-shadow: var(--bento-panel-frame-outline-shadow);
      }

      /* Custom always-visible horizontal scrollbar. Stays in the
         bottom strip position while the favicon navigator lives in the
         top toolbar. A divider-colored rail sits behind the thumb so it
         lines up visually with the sidebar footer divider. */
      #bento-strip-scrollbar {
        position: absolute;
        left: var(--space-2xs);
        right: var(--space-2xs);
        bottom: var(--bento-strip-scrollbar-gap);
        z-index: 20;
        height: var(--bento-scrollbar-thickness);
        margin: 0;
        border-radius: var(--bento-scrollbar-radius);
        cursor: pointer;
      }
      #bento-strip-scrollbar::before {
        content: '';
        position: absolute;
        left: 0;
        right: 0;
        top: 50%;
        height: 1px;
        background-color: var(--bento-sidebar-divider-color);
        transform: translateY(-50%);
        pointer-events: none;
      }
      .bento-strip-scrollbar__thumb {
        position: absolute;
        top: 0;
        left: 0;
        z-index: 1;
        height: 100%;
        min-width: var(--bento-scrollbar-thumb-min-width);
        background-color: var(--neutral-80);
        border-radius: var(--bento-scrollbar-radius);
        cursor: grab;
        transition: background-color var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-strip-scrollbar__thumb:hover {
        background-color: var(--neutral-80);
      }
      .bento-strip-scrollbar__thumb--dragging,
      .bento-strip-scrollbar__thumb--dragging:hover {
        background-color: var(--color-60);
        cursor: grabbing;
      }

      /* Panel navigator bar. Mounted in the top toolbar after the
         native Reload/Stop control.
         [◀] [favicon] [favicon] [favicon] [▶]
         Active item gets a subtle tinted background. */
      #bento-panel-nav {
        position: relative;
        z-index: 20;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: var(--space-2xs);
        align-self: center;
        flex: 0 1 auto;
        min-width: 0;
        max-width: 42vw;
        margin-inline-start: var(--space-2xs);
        margin-inline-end: 0;
        padding-block: var(--space-4xs);
        padding-inline: var(--space-2xs);
        box-sizing: border-box;
        min-height: var(--bento-panel-nav-height);
      }
      .bento-panel-nav__btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--bento-panel-nav-button-size);
        height: var(--bento-panel-nav-button-size);
        padding: 0;
        background: transparent;
        border: none;
        border-radius: var(--radius-s);
        color: var(--neutral-70);
        cursor: pointer;
        flex: 0 0 auto;
        transition:
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          color var(--bento-duration-fast) var(--bento-easing-standard);
        /* The navigator sits in Firefox's titlebar-capable nav bar. These
           controls must not participate in the native titlebar drag or
           double-click-to-maximize region. */
        -moz-window-dragging: no-drag;
      }
      .bento-panel-nav__btn:hover {
        background-color: color-mix(in srgb, var(--neutral-100) 10%, transparent);
        color: var(--neutral-90);
      }
      .bento-panel-nav__btn:active {
        background-color: color-mix(in srgb, var(--neutral-100) 5%, transparent);
      }
      .bento-panel-nav__btn > svg {
        width: var(--bento-icon-size-sm);
        height: var(--bento-icon-size-sm);
        pointer-events: none;
      }
      .bento-panel-nav__list {
        /* flex: 0 1 auto — only take as much width as the favicons
           need. The next button then sits immediately after the last
           favicon instead of being pushed to the right edge of the
           strip by a flex-grow on the list. With many panels the list
           shrinks to fit (min-width: 0) and scrolls internally. */
        flex: 0 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: var(--space-3xs);
        overflow-x: auto;
        padding-block-start: 0;
        margin-block-start: 0;
        scrollbar-width: none;
      }
      .bento-panel-nav__list::-webkit-scrollbar {
        display: none;
      }
      .bento-panel-nav__icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: var(--bento-panel-nav-button-size);
        height: var(--bento-panel-nav-button-size);
        padding: var(--space-3xs);
        box-sizing: border-box;
        background: transparent;
        border: var(--bento-border-hairline) solid transparent;
        border-radius: var(--radius-s);
        cursor: pointer;
        flex: 0 0 auto;
        position: relative;
        overflow: hidden;
        /* Active-marker and structural transitions use a fixed-size
           button. Split/subdivide/remove operations can rebuild nav
           icons, so enter/leave must fade only; animating width,
           padding, or margin makes the navigator row jump while the
           panel layout itself is changing. */
        transition:
          opacity var(--bento-duration-base) var(--bento-easing-standard),
          background-color var(--bento-duration-base) var(--bento-easing-standard),
          border-color var(--bento-duration-base) var(--bento-easing-standard);
      }
      .bento-panel-nav__icon:hover {
        background-color: color-mix(in srgb, var(--neutral-100) 5%, transparent);
        border-color: transparent;
      }
      .bento-panel-nav__icon--main {
        overflow: visible;
        margin-inline-end: var(--space-xs);
        /* The list's flex gap follows this margin. Keep the divider
           centered in their combined space so it has equal clearance from
           the fixed main slot and the first draggable panel button. */
        --bento-panel-nav-main-divider-gap: calc(var(--space-xs) + var(--space-3xs));
      }
      .bento-panel-nav__icon--main::after {
        content: '';
        position: absolute;
        inset-block-start: 50%;
        inset-inline-end: calc(
          -1 *
            (
              ((var(--bento-panel-nav-main-divider-gap) - 1px) / 2) +
                var(--bento-border-hairline)
            )
        );
        width: 1px;
        height: 16px;
        border-radius: var(--radius-pill);
        background-color: var(--neutral-30);
        transform: translateY(-50%);
        pointer-events: none;
      }
      .bento-panel-nav__icon--main:hover {
        background-color: color-mix(in srgb, var(--neutral-100) 5%, transparent);
      }
      .bento-panel-nav__icon--active {
        border-color: transparent;
        background-color: color-mix(in srgb, var(--neutral-100) 10%, transparent);
      }
      .bento-panel-nav__icon--discarded {
        opacity: 0.55;
        filter: grayscale(0.55);
      }
      .bento-panel-nav__icon--discarded.bento-panel-nav__icon--active,
      .bento-panel-nav__icon--discarded:hover {
        opacity: 0.75;
      }
      .bento-panel-nav__icon--audible,
      .bento-panel-nav__icon--has-audio-particles {
        overflow: visible;
      }
      .bento-panel-nav__audio-particles {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: visible;
        z-index: 30;
      }
      .bento-panel-nav__audio-particle {
        position: absolute;
        left: 0;
        top: 0;
        width: 10px;
        height: 10px;
        color: var(--color-70);
        opacity: 0;
        pointer-events: none;
        transform: translate(-50%, -50%) translate(0, 0) scale(0.54);
        animation: bento-panel-nav-music-particle 1500ms linear forwards;
        will-change: opacity, transform;
      }
      .bento-panel-nav__audio-particle--1 {
        width: 9px;
        height: 9px;
        --bento-panel-nav-music-x: -6px;
        --bento-panel-nav-music-y: -7px;
        --bento-panel-nav-music-rotation: -12deg;
      }
      .bento-panel-nav__audio-particle--2 {
        width: 8px;
        height: 8px;
        --bento-panel-nav-music-x: 5px;
        --bento-panel-nav-music-y: -8px;
        --bento-panel-nav-music-rotation: 10deg;
      }
      .bento-panel-nav__audio-particle--3 {
        width: 10px;
        height: 10px;
        --bento-panel-nav-music-x: 8px;
        --bento-panel-nav-music-y: -5px;
        --bento-panel-nav-music-rotation: 16deg;
      }
      @keyframes bento-panel-nav-music-particle {
        0% {
          opacity: 0;
          transform: translate(-50%, -50%) translate(0, 0) scale(0.54) rotate(0deg);
        }
        12% {
          opacity: 0.9;
        }
        68% {
          opacity: 0.55;
        }
        100% {
          opacity: 0;
          transform:
            translate(-50%, -50%)
            translate(var(--bento-panel-nav-music-x), var(--bento-panel-nav-music-y))
            scale(1)
            rotate(var(--bento-panel-nav-music-rotation));
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .bento-panel-nav__audio-particle {
          animation-duration: 1100ms;
        }
      }
      .bento-panel-nav__icon--main.bento-panel-nav__icon--active::after {
        background-color: var(--neutral-30);
      }
      /* Enter / leave states are opacity-only so structural updates
         never animate navigator button dimensions. */
      .bento-panel-nav__icon--entering,
      .bento-panel-nav__icon--leaving {
        opacity: 0;
      }
      .bento-panel-nav__icon > img {
        width: var(--bento-panel-nav-favicon-size);
        height: var(--bento-panel-nav-favicon-size);
        display: block;
        /* Make the favicon image pointer-transparent so pointerdown is
           always reported with the button as the target — keeps the
           drag-handler's setPointerCapture(btn) coherent regardless of
           whether the user pressed on the favicon or the button padding. */
        pointer-events: none;
      }
      .bento-panel-nav__icon--placeholder::before {
        content: '';
        position: absolute;
        inset-block-start: 50%;
        inset-inline-start: 50%;
        width: var(--bento-panel-nav-favicon-size);
        height: var(--bento-panel-nav-favicon-size);
        transform: translate(-50%, -50%);
        border-radius: 50%;
        background-color: var(--neutral-30);
      }
      /* Drag-to-reorder states. Side-panel buttons (those with a tabId)
         show grab cursor on idle. While a drag is active the source
         button dims + scales down, the body cursor switches to grabbing
         (set on the list element so it covers the whole strip), and a
         drop indicator marks the prospective insertion point. */
      .bento-panel-nav__icon[data-bento-nav-draggable] {
        cursor: grab;
        /* The navigator now lives in Firefox's titlebar-capable nav bar.
           Explicitly opt favicon controls out of that drag region so their
           pointer sequence reaches setupNavDrag(); unoccupied toolbar space
           remains available for native window dragging. */
        -moz-window-dragging: no-drag;
      }
      .bento-panel-nav__list--dragging {
        cursor: grabbing;
      }
      .bento-panel-nav__list--dragging .bento-panel-nav__icon[data-bento-nav-draggable] {
        cursor: grabbing;
      }
      .bento-panel-nav__icon--dragging {
        opacity: 0.45;
        transform: scale(0.92);
        transition:
          opacity var(--bento-duration-fast) var(--bento-easing-standard),
          transform var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-nav__icon--dragging:hover {
        background-color: transparent;
        border-color: transparent;
        transform: scale(0.92);
      }
      /* Insertion indicator. Absolutely positioned overlay over the list
         (NOT a flex child) so painting it never reflows siblings — that
         would shift their bounding rects, which would feed back into the
         next pointermove's slot calculation and oscillate. Top/bottom
         pinned to span the full nav row height; X is set imperatively
         per pointermove. */
      .bento-panel-nav__list {
        position: relative;
      }
      .bento-panel-nav__drop-indicator {
        position: absolute;
        top: 0;
        bottom: 0;
        width: var(--bento-focus-ring-width);
        background-color: var(--color-60);
        border-radius: var(--bento-focus-ring-width);
        pointer-events: none;
        z-index: 1;
        animation: bento-nav-drop-fade-in var(--bento-duration-fast)
          var(--bento-easing-standard);
      }
      @keyframes bento-nav-drop-fade-in {
        from {
          opacity: 0;
        }
        to {
          opacity: 1;
        }
      }
      .bento-panel-nav-menu {
        position: fixed;
        z-index: 100000;
        min-width: max-content;
        padding: var(--space-4xs);
        background-color: var(--neutral-5);
        border: var(--bento-border-hairline) solid var(--neutral-20);
        border-radius: var(--radius-s);
        box-shadow: var(--shadow-lg);
      }
      .bento-panel-nav-menu__item {
        display: flex;
        align-items: center;
        width: 100%;
        min-height: var(--bento-control-size-sm);
        padding: 0 var(--space-2xs);
        background-color: var(--neutral-5);
        border: none;
        border-radius: var(--radius-s);
        color: var(--neutral-90);
        cursor: pointer;
        font: inherit;
        font-size: var(--font-s);
        text-align: left;
      }
      .bento-panel-nav-menu__item:focus,
      .bento-panel-nav-menu__item:focus-visible {
        outline: none;
      }
      .bento-panel-nav-menu__item::-moz-focus-inner {
        border: 0;
      }
      .bento-panel-nav-menu__item:hover {
        background-color: var(--neutral-10);
      }
      /* Hide the kebab 'more' button on the main panel — the menu's
         current contents (custom panel sizes) only apply to side
         panels, which use panel/setWidth. The main slot has its own
         per-workspace width (panel/setMainWidth) and gets resized via
         the main splitter instead.

         CRITICAL: scope via direct-child > to the panel header,
         because BOTH #tabbrowser-tabbox (the deck, marked by
         unifyMainWithStrip) AND the active-tab notificationbox carry
         data-bento-main-panel. A bare descendant selector matches
         the deck and hides the kebab on EVERY panel header,
         including side panels. The header is a direct child of its
         notificationbox; the deck has notificationboxes (not
         headers) as direct children, so '> .bento-panel-header'
         only matches when the marked element IS the main panel
         notificationbox. */
      [data-bento-main-panel] > .bento-panel-header .bento-panel-header-button--more {
        display: none;
      }

      /* The main panel (moved tabbrowser-tabbox). flex-grow:1 so it
         fills remaining space when no side panels exist; flex-basis:
         0 + min-width keeps it from collapsing under the panels.
         Inside, the existing tabbox renders the active tab's browser
         as before — moving the host element doesn't change its
         internal layout. */
      #bento-side-panel-host > [data-bento-main-panel] {
        display: flex;
        flex-direction: column;
        flex: 1 1 0%;
        min-width: var(--bento-main-panel-min-width);
      }

      /* Each side panel: column-flex of [header, browser]. flex stays
         at 0 0 auto so Firefox's native split-view splitter resize
         updates take effect against the sibling width. */
      #bento-side-panel-host > [data-bento-panel-tab-id] {
        display: flex;
        flex-direction: column;
        flex: 0 0 auto;
        min-width: var(--bento-panel-min-width);
        background-color: var(--neutral-5);
      }
      .bento-panel--discarded {
        opacity: 0.68;
        transition: opacity var(--bento-duration-base) var(--bento-easing-standard);
      }
      /* Close-panel animation. Fade only: keep the panel's current
         layout size while it exits, then let the post-close reconcile
         remove its slot. Do not animate width/flex/margins here; that
         makes neighbouring panels resize during the fade. */
      .bento-panel--removing {
        pointer-events: none;
        opacity: 0;
        transition: opacity 120ms var(--bento-easing-standard);
      }

      /* Legacy host-owned panel containers are positioned for
         drag/focus bookkeeping. Native split-view panels get their
         direct frame/shadow rules under #tabbrowser-tabpanels below. */
      #bento-side-panel-host > [data-bento-main-panel],
      #bento-side-panel-host > [data-bento-panel-tab-id] {
        position: relative;
      }
      /* Suppress Firefox's default :focus outline on the panel
         containers. They have tabindex="-1" so they're focusable;
         when the user clicks into content the chrome focus path
         walks through the container and Firefox would otherwise
         paint a persistent default focus outline (rgb(251,251,254)
         3px, reads as a cool/cyan ring against dark backgrounds)
         that we don't own. !important is required because
         Firefox's chrome stylesheet sets the outline at high
         specificity. The cycle ring (.bento-panel--cycle-focused
         ::after below) is the only focus indicator we want. */
      [data-bento-main-panel],
      [data-bento-main-panel]:focus,
      [data-bento-main-panel]:focus-within,
      [data-bento-panel-tab-id],
      [data-bento-panel-tab-id]:focus,
      [data-bento-panel-tab-id]:focus-within,
      [data-bento-subpanel],
      [data-bento-subpanel]:focus,
      [data-bento-subpanel]:focus-within,
      .bento-subdivision-chooser,
      .bento-subdivision-chooser:focus,
      .bento-subdivision-chooser:focus-within {
        outline: none !important;
      }
      /* Firefox's content-area.css paints "outline: var(--focus-outline)"
         on the ".deck-selected > .browserContainer" of every split-view
         panel — that's where the cyan focus ring around the active tab's
         main slot was actually coming from (NOT the tabbrowser-tabbox
         itself, which we already neutralised above). Suppress it across
         all split-view panel browserContainers; the .bento-panel--cycle-
         focused ::after ring is the only focus indicator we want. */
      #tabbrowser-tabpanels[splitview] .browserContainer {
        outline: none !important;
      }
      #bento-side-panel-host > [data-bento-main-panel]::after,
      #bento-side-panel-host > [data-bento-panel-tab-id]::after {
        content: '';
        position: absolute;
        inset: 0;
        border: var(--bento-focus-ring-width) solid transparent;
        border-radius: var(--bento-panel-corner-radius);
        pointer-events: none;
        z-index: 10;
        box-sizing: border-box;
        transition: border-color var(--bento-duration-slow) var(--bento-easing-standard);
      }
      #bento-side-panel-host > .bento-panel--focused::after,
      #bento-side-panel-host > .bento-panel--cycle-focused::after {
        border-color: var(--color-60);
      }
      .bento-panel--focused > .bento-panel-header,
      .bento-panel--cycle-focused > .bento-panel-header {
        background-color: var(--neutral-5);
        border-bottom-color: var(--neutral-5);
      }
      .bento-panel--focused > .bento-panel-header .tale-icon-button.tale-button,
      .bento-panel--cycle-focused > .bento-panel-header .tale-icon-button.tale-button {
        color: var(--neutral-80);
      }
      .bento-panel--focused > .bento-panel-header .tale-icon-button.tale-button:hover:not([disabled], [data-disabled], [data-pending]),
      .bento-panel--focused > .bento-panel-header .tale-icon-button.tale-button[data-hovered]:not([disabled], [data-disabled], [data-pending]),
      .bento-panel--cycle-focused > .bento-panel-header .tale-icon-button.tale-button:hover:not([disabled], [data-disabled], [data-pending]),
      .bento-panel--cycle-focused > .bento-panel-header .tale-icon-button.tale-button[data-hovered]:not([disabled], [data-disabled], [data-pending]) {
        background-color: color-mix(in srgb, var(--neutral-100) 10%, transparent);
        color: var(--neutral-90);
      }
      .bento-panel--focused > .bento-panel-header .tale-icon-button.tale-button:active:not([disabled], [data-disabled], [data-pending]),
      .bento-panel--focused > .bento-panel-header .tale-icon-button.tale-button[data-pressed]:not([disabled], [data-disabled], [data-pending]),
      .bento-panel--cycle-focused > .bento-panel-header .tale-icon-button.tale-button:active:not([disabled], [data-disabled], [data-pending]),
      .bento-panel--cycle-focused > .bento-panel-header .tale-icon-button.tale-button[data-pressed]:not([disabled], [data-disabled], [data-pending]) {
        background-color: color-mix(in srgb, var(--neutral-100) 5%, transparent);
        color: var(--neutral-90);
      }
      #bento-side-panel-host > [data-bento-panel-tab-id] > browser {
        flex: 1 1 auto;
        min-height: 0;
      }

      /* Per-panel header: compact urlbar (back/fwd/reload, URL input,
         bookmark / pin). All sizing via Bento/Tale UI tokens — no raw values. */
      .bento-panel-header {
        display: flex;
        flex-direction: row;
        align-items: center;
        gap: var(--space-3xs);
        padding: var(--space-3xs) var(--space-2xs);
        background-color: var(--neutral-5);
        border-bottom: var(--bento-border-hairline) solid var(--neutral-5);
        flex: 0 0 auto;
        max-height: var(--bento-panel-header-height);
        min-height: var(--bento-panel-header-height);
        overflow: hidden;
        box-sizing: border-box;
        transition:
          background-color var(--bento-duration-base) var(--bento-easing-standard),
          max-height var(--bento-duration-base) var(--bento-easing-snappy),
          min-height var(--bento-duration-base) var(--bento-easing-snappy),
          padding var(--bento-duration-base) var(--bento-easing-snappy),
          border-bottom-color var(--bento-duration-base) var(--bento-easing-standard),
          border-bottom-width var(--bento-duration-base) var(--bento-easing-snappy);
      }
      /* Header hiding uses height collapse, not opacity/visibility:
         forcePanelHeaderInteractiveState stamps inline-important values
         for those properties. No !important here so subdivision top-
         closed rules keep precedence when both states apply. */
      [data-bento-header-hidden] > .bento-panel-header {
        max-height: 0;
        min-height: 0;
        padding-block: 0;
        border-bottom-width: 0;
        overflow: hidden;
      }
      @media (prefers-reduced-motion: reduce) {
        .bento-panel-header {
          transition: none;
        }
      }
      /* Chrome-side translation of Tale UI IconButton
         variant="ghost" size="sm". These controls cannot render the
         React component because they live in browser chrome, but they
         carry the same BEM classes and mirror the same interactive
         states with native pseudo-classes plus React-Aria-compatible
         data-state selectors. */
      .bento-panel-header .tale-icon-button.tale-button {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-3xs);
        width: var(--bento-control-size-sm);
        height: var(--bento-control-size-sm);
        min-width: var(--bento-control-size-sm);
        min-height: var(--bento-control-size-sm);
        box-sizing: border-box;
        padding: 0;
        margin: 0;
        appearance: none;
        background-color: transparent;
        border: 1px solid transparent;
        border-radius: var(--radius-s);
        color: var(--neutral-80);
        cursor: pointer;
        flex: 0 0 auto;
        line-height: 1;
        outline: none;
        user-select: none;
        transition:
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          border-color var(--bento-duration-fast) var(--bento-easing-standard),
          color var(--bento-duration-fast) var(--bento-easing-standard),
          box-shadow var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-header .tale-icon-button.tale-button:hover:not([disabled], [data-disabled], [data-pending]),
      .bento-panel-header .tale-icon-button.tale-button[data-hovered]:not([disabled], [data-disabled], [data-pending]) {
        background-color: color-mix(in srgb, var(--neutral-100) 10%, transparent);
        color: var(--neutral-90);
      }
      .bento-panel-header .tale-icon-button.tale-button:active:not([disabled], [data-disabled], [data-pending]),
      .bento-panel-header .tale-icon-button.tale-button[data-pressed]:not([disabled], [data-disabled], [data-pending]) {
        background-color: color-mix(in srgb, var(--neutral-100) 5%, transparent);
      }
      .bento-panel-header .tale-icon-button.tale-button:focus-visible,
      .bento-panel-header .tale-icon-button.tale-button[data-focus-visible] {
        box-shadow:
          0 0 0 2px var(--neutral-100),
          0 0 0 4px var(--focus-ring-color);
      }
      .bento-panel-header .tale-icon-button.tale-button[disabled],
      .bento-panel-header .tale-icon-button.tale-button[data-disabled] {
        opacity: 0.45;
        cursor: not-allowed;
      }
      .bento-panel-header .tale-icon-button.tale-button[data-pending] {
        cursor: default;
      }
      .bento-panel-header .tale-icon-button > svg {
        width: var(--bento-icon-size-sm);
        height: var(--bento-icon-size-sm);
        pointer-events: none;
      }
      /* Dot-pattern icons (grip-vertical on the drag handle,
         more-vertical on the kebab) render each dot as the round
         cap of a zero-length stroke segment, so the dot diameter
         equals stroke-width. At stroke-width 2 in a 24-unit
         viewBox displayed at 14px, each dot is only ~1.17px —
         a fraction of the ink the continuous-stroke icons put
         on screen (chevrons, refresh, bookmark, pin, close), so the dot
         icons read as "disabled" even at the same currentColor.
         Bumping the stroke compensates so all header icons hit
         the same optical weight. */
      .bento-panel-header-drag-handle > svg,
      .bento-panel-header-button--more > svg {
        stroke-width: 3.5;
      }
      /* Drag handle: behaves as a button (role='button') but is
         operated by pointer drag, not click — override the default
         pointer cursor with grab / grabbing. */
      .bento-panel-header-drag-handle {
        cursor: grab;
        touch-action: none;
      }
      .bento-panel-header-drag-handle--dragging {
        cursor: grabbing;
        background-color: color-mix(in srgb, var(--neutral-100) 10%, transparent);
        color: var(--color-60);
      }
      /* Bookmark and pin buttons: filled outline when active. Bookmark state
         tracks whether the current URL is in
         the bookmarks DB. Fill uses currentColor so the icon picks
         up whatever default / hover colour the shared rule sets. */
      .bento-panel-header-button--active > svg {
        fill: currentColor;
      }
      /* Dragging state for the panel container — slight opacity
         dip + subtle shadow so the floating panel reads as
         'lifted off the strip'. */
      .bento-panel--dragging {
        opacity: 0.85;
      }
      .bento-panel-drop-indicator {
        background-color: var(--color-60);
        border-radius: 1.5px;
        pointer-events: none;
      }
      .bento-panel-header-url {
        flex: 1 1 auto;
        min-width: 0;
        height: var(--bento-control-size-sm);
        padding: 0 var(--space-2xs);
        background-color: var(--neutral-5);
        border: var(--bento-border-hairline) solid transparent;
        border-radius: var(--radius-s);
        color: var(--neutral-90);
        font-size: var(--font-s);
        font-family: inherit;
        outline: none;
        box-sizing: border-box;
      }
      .bento-panel-header-url:focus {
        background-color: var(--neutral-5);
        border-color: var(--color-60);
      }
      .bento-panel-header-url::placeholder {
        color: var(--neutral-50);
      }
      .bento-panel-loading-overlay {
        position: absolute;
        inset-block-start: var(--bento-panel-header-height);
        inset-inline: 0;
        inset-block-end: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background-color: var(--neutral-5);
        border-end-start-radius: var(--bento-panel-corner-radius);
        border-end-end-radius: var(--bento-panel-corner-radius);
        color: var(--color-60);
        pointer-events: none;
        z-index: 9;
      }
      .bento-panel-loading-overlay[hidden] {
        display: none !important;
      }
      [data-bento-subpanel] > .bento-panel-loading-overlay {
        inset-block-start: var(--bento-panel-header-height);
      }
      [data-bento-header-hidden] > .bento-panel-loading-overlay {
        inset-block-start: 0;
      }
      .bento-panel-header-restore {
        display: none;
        position: absolute;
        top: var(--space-3xs);
        left: 50%;
        transform: translateX(-50%);
        z-index: 12;
        width: 64px;
        height: 16px;
        align-items: center;
        justify-content: center;
        padding: 0;
        margin: 0;
        appearance: none;
        background: transparent;
        border: 0;
        cursor: pointer;
      }
      [data-bento-header-hidden] > .bento-panel-header-restore {
        display: flex;
      }
      [data-bento-subdivision-top-closed] > .bento-panel-header-restore {
        display: none !important;
      }
      .bento-panel-header-restore__pill {
        display: block;
        width: 44px;
        height: 3px;
        border-radius: 3px;
        /* Fixed mid-dark grey is intentional: neutral tokens flip with
           color mode, but this handle must stay legible on black and
           white page content as well as light and dark chrome themes. */
        background-color: rgba(92, 92, 98, 0.3);
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.28),
          0 1px 4px rgba(0, 0, 0, 0.45);
        transition:
          width var(--bento-duration-fast) var(--bento-easing-standard),
          height var(--bento-duration-fast) var(--bento-easing-standard),
          background-color var(--bento-duration-fast) var(--bento-easing-standard),
          box-shadow var(--bento-duration-fast) var(--bento-easing-standard);
      }
      .bento-panel-header-restore:hover > .bento-panel-header-restore__pill {
        width: 56px;
        height: 4px;
        background-color: rgba(128, 128, 136, 1);
      }
      .bento-panel-header-restore:focus-visible {
        outline: none;
      }
      .bento-panel-header-restore:focus-visible > .bento-panel-header-restore__pill {
        box-shadow:
          0 0 0 1px rgba(255, 255, 255, 0.28),
          0 1px 4px rgba(0, 0, 0, 0.45),
          0 0 0 3px var(--focus-ring-color);
      }
      .bento-panel-loading-overlay .tale-spinner {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        --_spinner-size: 2.25rem;
      }
      .bento-panel-loading-overlay .tale-spinner__svg {
        width: var(--_spinner-size);
        height: var(--_spinner-size);
        animation: tale-spinner-rotate 1s linear infinite;
      }
      .bento-panel-loading-overlay .tale-spinner__track {
        stroke: var(--neutral-20);
      }
      .bento-panel-loading-overlay .tale-spinner__arc {
        stroke: var(--color-60);
        stroke-dasharray: 44, 63;
        animation: tale-spinner-dash 1.2s ease-in-out infinite;
      }
      @keyframes tale-spinner-rotate {
        100% { transform: rotate(360deg); }
      }
      @keyframes tale-spinner-dash {
        0% { stroke-dasharray: 1, 63; stroke-dashoffset: 0; }
        50% { stroke-dasharray: 44, 63; stroke-dashoffset: -16; }
        100% { stroke-dasharray: 44, 63; stroke-dashoffset: -62; }
      }

      /* ─── Native split-view panel layout ──────────────────────────────
         Activated when reconcilePanelsSplitView adds .bento-split-active
         to #tabbrowser-tabpanels and sets the [splitview] attribute via
         the BENTO_SPLIT_SENTINEL → setSplitViewActive() chain.

         Each active panel is a <hbox class="browserSidebarContainer
         split-view-panel split-view-panel-active">. By default that
         hbox lays out children horizontally — which makes our injected
         per-panel header sit to the LEFT of the <browser>, splitting
         the panel's width in half. Override flex-direction so children
         stack vertically: header on top, browser fills the rest. */
      /* When the combined min-width of all panels exceeds the viewport
         width (typical at 4+ panels on a narrow window), the deck must
         scroll horizontally instead of overflowing off-screen. flex-
         shrink: 0 on each panel keeps them at their min-width — without
         it, flex would shrink them past min-width and squash content
         until the panels are unusable. */
      #tabbrowser-tabpanels.bento-split-active {
        /* The strip backdrop intentionally matches the main side of the
           top toolbar while panel frames remain on the chrome card surface.
           display:flex + gap:var(--bento-panel-gap) is the single source of
           truth for inter-panel spacing — Firefox's content-area.css
           sets margin-left: 5px on .split-view-panel-active children
           with higher specificity than our previous margin attempt,
           so flex gap (which the spec explicitly says doesn't
           collide with margin) is the cleaner override.
           Padding belongs to the real scrollport so panel content and
           direct shadows clip together at the left/right edges. */
        display: flex;
        flex-direction: row;
        align-items: stretch;
        gap: var(--bento-panel-gap);
        padding-block-start: var(--space-3xs);
        padding-block-end: calc(
          var(--bento-strip-controls-height) + var(--bento-strip-scrollbar-gap)
        );
        padding-inline-start: var(--space-3xs);
        padding-inline-end: var(--space-2xs);
        overflow-x: scroll;
        overflow-y: hidden;
        box-sizing: border-box;
        background-color: var(--bento-panel-strip-bg) !important;
        background-image: none !important;
        /* Hide tabpanels' native horizontal scrollbar — the custom
           always-visible #bento-strip-scrollbar in the sidebar drives
           tabpanels.scrollLeft and is positioned next to the favicon
           nav. macOS's overlay scrollbar floats over panel content and
           auto-hides; the custom one stays put. */
        scrollbar-width: none;
      }
      #tabbrowser-tabbox:has(> #tabbrowser-tabpanels.bento-split-active) {
        background-color: var(--bento-panel-strip-bg) !important;
        background-image: none !important;
      }
      #tabbrowser-tabpanels.bento-split-active.bento-flat-panel-layout {
        display: block;
        position: relative;
        /* display:block ignores gap for layout, but the flat-layout
           geometry code reads the computed gap as the authoritative
           inter-panel spacing value. */
        gap: var(--bento-panel-gap);
      }
      #tabbrowser-tabpanels.bento-split-active::-webkit-scrollbar {
        display: none;
      }
      #tabbrowser-tabpanels.bento-split-active split-view-footer {
        display: none !important;
      }
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active {
        flex-direction: column;
        min-width: var(--bento-panel-min-width, 380px);
        flex-shrink: 0;
        /* Firefox's content-area.css applies margin: var(--space-xsmall)
           to active split-view panels — pushes the first panel away
           from the top URL bar and from the sidebar (and double-spaces
           against the inter-panel gap). Bento controls all spacing via
           tabpanels' gap + strip padding, so zero out the upstream
           margin. !important required because the upstream rule wins
           the specificity tie on source order otherwise. */
        margin: 0 !important;
      }
      #tabbrowser-tabpanels.bento-split-active.bento-flat-panel-layout > .split-view-panel-active {
        position: absolute !important;
        flex: 0 0 auto !important;
        min-width: 0 !important;
        max-width: none !important;
      }
      #bento-flat-layout-extent {
        position: absolute !important;
        inset-block-start: 0;
        inset-inline-start: 0;
        block-size: 1px !important;
        pointer-events: none;
        opacity: 0;
      }
      /* The real split-view panels are the visual frames. Shadows live
         on the same elements as content, so both clip together at the
         horizontal scrollport edge. */
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] {
        border-radius: var(--bento-panel-corner-radius);
        background-color: var(--bento-panel-strip-bg) !important;
        box-shadow: var(--bento-panel-frame-shadow);
        box-sizing: border-box;
        border: 0;
        overflow: visible;
        position: relative;
      }
      #tabbrowser-tabpanels.bento-split-active.bento-panel-shadows-disabled > [data-bento-main-panel],
      #tabbrowser-tabpanels.bento-split-active.bento-panel-shadows-disabled > [data-bento-panel-tab-id] {
        box-shadow: var(--bento-panel-frame-outline-shadow);
      }
      /* The browser fills whatever vertical space the header doesn't. */
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > browser,
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > .browserContainer,
      #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active > .browserStack {
        flex: 1 1 auto;
        min-height: 0;
      }
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel] > browser,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel] > .browserContainer,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel] > .browserStack {
        border-radius: var(--bento-panel-corner-radius);
        overflow: clip;
      }
      /* Side-panel content sits directly under the injected panel header.
         Keep the content's bottom corners rounded, but square off the
         top corners so it joins flush to the header's square bottom
         edge. The main content slot keeps all four rounded corners. */
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] > browser,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] > .browserContainer,
      #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id] > .browserStack {
        border-end-start-radius: var(--bento-panel-corner-radius);
        border-end-end-radius: var(--bento-panel-corner-radius);
        border-start-start-radius: 0 !important;
        border-start-end-radius: 0 !important;
        overflow: clip;
      }
      /* DOM fullscreen. Firefox's stock fullscreen stylesheet only
         hides Firefox-owned chrome. Bento's sidebar, splitters, panel
         navigator, scrollbar, and flat-layout geometry live outside
         those selectors, so they must yield here or page fullscreen
         stays trapped inside the main content slot. Side-panel fullscreen
         is marked from Firefox's exact requesting browser so the actual
         requesting slot, not necessarily the deck-selected main slot,
         expands to the window. */
      :root[inDOMFullscreen] #bento-shell-host,
      :root[inDOMFullscreen] #bento-shell-splitter,
      :root[inDOMFullscreen] #bento-shell-splitter-affordance,
      :root[inDOMFullscreen] #bento-sidebar-chrome-divider,
      :root[inDOMFullscreen] #bento-panel-nav,
      :root[inDOMFullscreen] #bento-strip-scrollbar,
      :root[inDOMFullscreen] #bento-add-panel-trailer,
      :root[inDOMFullscreen] .bento-panel-header,
      :root[inDOMFullscreen] .bento-panel-header-restore,
      :root[inDOMFullscreen] .bento-panel-loading-overlay,
      :root[inDOMFullscreen] .bento-subdivision-vsplitter,
      :root[inDOMFullscreen] .bento-subdivision-hsplitter,
      :root[inDOMFullscreen] .bento-subdivision-chooser,
      :root[inDOMFullscreen] #bento-side-panel-host > .bento-panel-splitter,
      :root[inDOMFullscreen] #bento-side-panel-host > .bento-layout-vsplitter,
      :root[inDOMFullscreen] #bento-side-panel-host > .bento-layout-hsplitter,
      :root[inDOMFullscreen] #bento-side-panel-host > .bento-layout-chooser {
        display: none !important;
        visibility: collapse !important;
      }
      :root[inDOMFullscreen] #bento-strip-container,
      :root[inDOMFullscreen] #bento-side-panel-host {
        border-radius: 0 !important;
        min-width: 0 !important;
        overflow: hidden !important;
      }
      :root[inDOMFullscreen] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host {
        padding: 0 !important;
      }
      :root[inDOMFullscreen] #bento-side-panel-host > [data-bento-main-panel]::after,
      :root[inDOMFullscreen] #bento-side-panel-host > [data-bento-panel-tab-id]::after,
      :root[inDOMFullscreen] #tabbrowser-tabpanels.bento-split-active > [data-bento-main-panel]::after,
      :root[inDOMFullscreen] #tabbrowser-tabpanels.bento-split-active > [data-bento-panel-tab-id]::after,
      :root[inDOMFullscreen] #tabbrowser-tabpanels.bento-split-active > [data-bento-subdivided]::after,
      :root[inDOMFullscreen] [data-bento-subpanel]::after,
      :root[inDOMFullscreen] [data-bento-subdivided]::before,
      :root[inDOMFullscreen] .bento-subdivision-chooser::after {
        content: none !important;
        display: none !important;
        border: 0 !important;
      }
      :root[inDOMFullscreen] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel],
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] {
        left: 0 !important;
        top: 0 !important;
        width: 100% !important;
        min-width: 0 !important;
        max-width: none !important;
        height: 100% !important;
        min-height: 0 !important;
        max-height: none !important;
        display: flex !important;
        position: absolute !important;
        flex: 1 1 auto !important;
        margin: 0 !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: hidden !important;
        -moz-subtree-hidden-only-visually: 0 !important;
        visibility: inherit !important;
        opacity: 1 !important;
      }
      :root[inDOMFullscreen] #tabbrowser-tabpanels.bento-split-active {
        gap: 0 !important;
        padding: 0 !important;
        overflow: hidden !important;
        scrollbar-width: none !important;
      }
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active:not(.deck-selected),
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active:not([data-bento-dom-fullscreen-requester]) {
        display: none !important;
      }
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected > .browserContainer,
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected .browserContainer,
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected > .browserStack,
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected .browserStack,
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected > browser,
      :root[inDOMFullscreen]:not([bento-dom-fullscreen-panel]) #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active.deck-selected browser,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] > .browserContainer,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] .browserContainer,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] > .browserStack,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] .browserStack,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] > browser,
      :root[inDOMFullscreen][bento-dom-fullscreen-panel] #tabbrowser-tabpanels.bento-split-active > .split-view-panel-active[data-bento-dom-fullscreen-requester] browser,
      :root[inDOMFullscreen] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] > #tabbrowser-tabpanels,
      :root[inDOMFullscreen] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] .browserContainer,
      :root[inDOMFullscreen] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] .browserStack,
      :root[inDOMFullscreen] #bento-strip-container.bento-no-side-panels > #bento-side-panel-host > [data-bento-main-panel] browser {
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: hidden !important;
        -moz-subtree-hidden-only-visually: 0 !important;
        visibility: inherit !important;
        opacity: 1 !important;
      }
      /* Injected per-panel header — sits above the browser, takes its
         natural height, doesn't flex. */
      .bento-panel-header[data-bento-injected="1"] {
        flex: 0 0 auto;
        border-radius: var(--bento-panel-corner-radius) var(--bento-panel-corner-radius) 0 0;
        position: relative;
        z-index: 5;
      }

      /* ─── Add-panel trailer ────────────────────────────────────────
       * Slim flex item appended to the end of the split-view strip
       * (last child of #tabbrowser-tabpanels.bento-split-active).
       * The outer XUL host is only a layout/focus/cycle target; the
       * actual interactive controls are the "+" and saved-panel buttons
       * rendered inside the panel-trailer iframe. Inline order:999
       * keeps it visually after every panel regardless of the per-panel
       * order:N inline styles the reconciler stamps. */
      /* Trailer is a flex sibling of the panels inside tabpanels (NOT
         an absolute overlay) so it scrolls with the strip and the
         last panel's splitter sits between the last panel and the
         trailer naturally. Critical: needs .split-view-panel-active
         class to opt into Firefox's split-view paint pipeline —
         non-panel children of the deck render invisibly otherwise.
         The ID rule overrides the .split-view-panel-active rule's
         min-width (which would force 380px, way wider than we want
         for a slim trailer slot).
         Colours: --neutral-* tokens flip with Tale UI's color-mode
         cascade (data-color-mode on the chrome window), so the
         trailer adapts to light + dark mode automatically. SVG
         currentColor inherits from the trailer's color property so
         the icon tracks the same token. */
      /* Trailer width reserves a 3x3 button grid. If more than eight
         saved panels exist, React adds a native select underneath the
         grid and applyTrailerWidth() flips --bento-saved-panel-overflow
         to 1 so the host widens just enough for the select. */
      #bento-add-panel-trailer {
        --bento-panel-trailer-button-size: max(
          var(--space-l),
          calc(var(--bento-control-size-sm) + (var(--space-4xs) * 2))
        );
        --bento-panel-trailer-grid-width: calc(
          (var(--bento-panel-trailer-button-size) * 3) + (var(--space-3xs) * 2)
        );
        --bento-panel-trailer-base-width: max(
          16rem,
          calc(var(--bento-panel-trailer-grid-width) + (var(--space-xs) * 2))
        );
        --bento-panel-trailer-wide-width: 16rem;
        --bento-panel-trailer-width: max(
          var(--bento-panel-trailer-base-width),
          calc(
            var(--bento-panel-trailer-grid-width) +
              (var(--space-xs) * 2) +
              (
                var(--bento-saved-panel-overflow, 0) *
                  (var(--bento-panel-trailer-wide-width) - var(--bento-panel-trailer-grid-width))
              )
          )
       …159479 tokens truncated…  1. Current-workspace sidebar tab (excludes both panels
          //      and foreign/unassigned). Matches what the user sees
          //      in the sidebar — the natural "next" tab.
          //   2. Any non-panel tab (excludes panels only). Avoids the
          //      strip-shift symptom; tolerates landing on a foreign
          //      tab if no current-workspace sidebar tab exists.
          //   3. Unfiltered original. Last-resort so selectedTab isn't
          //      stranded at null when every other tab is a panel.
          if (panelExtras.length > 0 || foreignExtras.length > 0) {
            const tier1 = original(aTab, aExcludeTabs.concat(panelExtras, foreignExtras));
            if (tier1) return tier1;
          }
          if (panelExtras.length > 0) {
            const tier2 = original(aTab, aExcludeTabs.concat(panelExtras));
            if (tier2) return tier2;
          }
        }
        return original(aTab, aExcludeTabs);
      };
      window.gBrowser.__bentoFindTabOverride = true;
    }

    let lastReconciledFor = null;
    const reconcile = (_source) => {
      const sel = window.gBrowser.selectedTab;
      if (sel === lastReconciledFor) return;
      lastReconciledFor = sel;
      if (shouldDeferReconcileForWorkspaceSwitch(sel)) {
        armWorkspaceSwitchFade();
        return;
      }
      reconcilePanelsSplitView(__lastPanelsPayload);
    };

    // Signal 1: TabSelect on the tabContainer / gBrowser / window. This is
    // the canonical Mozilla event but in practice doesn't always reach our
    // listener for new-tab-creation flows (Cmd+T, sidebar +) — observed
    // empirically: the reconciler never fires even though selectedTab
    // demonstrably changes. Keep the listener registered as a fast path
    // for the cases it does fire (sidebar tab clicks).
    const onTabSelect = () => reconcile('TabSelect');
    window.gBrowser.tabContainer?.addEventListener('TabSelect', onTabSelect);
    window.gBrowser.addEventListener?.('TabSelect', onTabSelect);
    window.addEventListener('TabSelect', onTabSelect, true);

    // Signal 2: TabOpen. Catches new-tab creation regardless of whether
    // the new tab becomes selected synchronously. The reconciler reads
    // gBrowser.selectedTab when it runs, so if the new tab IS now the
    // selected one (the typical case for Cmd+T), this picks it up.
    // If TabOpen fires before selection settles, the dedup on
    // lastReconciledFor turns the second pass into a no-op.
    const onTabOpen = () => reconcile('TabOpen');
    window.gBrowser.tabContainer?.addEventListener('TabOpen', onTabOpen);

    // Signal 3: 'select' event on tabpanels. MozDeck's selectedIndex
    // setter dispatches this event whenever the selected panel changes
    // (toolkit/content/widgets/tabbox.js:237-239). It's the canonical
    // signal for "the visible content area changed" and catches every
    // selection mechanism — including ones where TabSelect/TabOpen
    // don't reach our handler. The class the deck toggles is
    // `.deck-selected` (line 218), not the `[selected]` attribute, so
    // the earlier MutationObserver attempt with attributeFilter:
    // ['selected'] never fired.
    window.gBrowser.tabpanels?.addEventListener('select', () => reconcile('tp.select'));

    // Wire the custom always-visible scrollbar (#bento-strip-scrollbar
    // in the sidebar) to track tabpanels' horizontal scroll. The
    // scrollbar's drag/click handlers already resolve their target via
    // getStripScrollTarget(), but they only react to user interaction
    // — the thumb position needs separate scroll + resize listeners
    // to update when panels are added, scrollLeft changes via wheel,
    // or the window resizes. Same pattern as the legacy host wiring
    // (see setupPanelNavigator). One-time setup.
    const tp = window.gBrowser.tabpanels;
    if (tp && !tp.__bentoStripScrollWired) {
      const syncStripViewportLayout = () => {
        try {
          if (!refreshFlatPanelLayoutFromLiveState()) {
            syncInterPanelSplitters();
            syncFlatLayoutOverlays(tp, currentPanelLayoutGeometry);
          }
        } catch (err) {
          console.warn('[bento-shell-mount] strip viewport layout sync failed:', err);
        }
      };
      const onStripChange = () => {
        updateStripScrollbar();
        // Re-position inter-panel splitters — scroll shifts the
        // panel boundaries in viewport space, so the absolute-
        // positioned splitters need to follow. Cheap (just style
        // writes against bounding rects).
        try {
          syncInterPanelSplitters();
          syncFlatLayoutOverlays(tp, currentPanelLayoutGeometry);
        } catch (err) {
          console.warn('[bento-shell-mount] strip scroll splitter sync failed:', err);
        }
        // Persist the user's scroll position for the active workspace.
        // Skip programmatic writes (workspace-switch restore) so we
        // don't echo restored values back to tools. Skip when we
        // don't know our workspace yet (boot before first panels/sync)
        // — the next genuine scroll after boot will capture it.
        if (__suppressStripScrollDispatch) return;
        if (!currentWorkspaceId) return;
        const left = tp.scrollLeft;
        // Capture workspaceId at scroll time, not dispatch time. The
        // debounce can outlive a workspace switch; binding the id
        // here ensures the dispatched value targets the workspace
        // the user was scrolling, not whatever's active when the
        // setTimeout fires.
        const capturedWorkspaceId = currentWorkspaceId;
        // Update the local mirror eagerly so a workspace-switch round-
        // trip (leave + return quickly) picks up the latest position
        // even if the title-IPC echo from tools hasn't landed yet.
        stripScrollByWorkspace.set(capturedWorkspaceId, left);
        if (__stripScrollDispatchTimer) clearTimeout(__stripScrollDispatchTimer);
        __stripScrollDispatchTimer = setTimeout(() => {
          __stripScrollDispatchTimer = null;
          dispatchShellAction({
            type: 'panel/setStripScroll',
            workspaceId: capturedWorkspaceId,
            scrollLeft: left,
          });
        }, STRIP_SCROLL_DEBOUNCE_MS);
      };
      tp.addEventListener('scroll', onStripChange, { passive: true });
      if (window.ResizeObserver) {
        const ro = new ResizeObserver(() => {
          syncStripViewportLayout();
          updateStripScrollbar();
        });
        ro.observe(tp);
      }
      tp.__bentoStripScrollWired = true;
    }
  }

  function reconcilePanels(panels, options = {}) {
    reconcilePanelsSplitView(panels, options);
  }

  function handlePanelsTitle(rawTitle) {
    // Format: BENTO_PANELS:<ts>:<base64-of-json-array>
    // Skip the prefix and the timestamp segment.
    const tail = rawTitle.slice(PANELS_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const b64 = tail.slice(colonAfterTs + 1);
    let decoded;
    try {
      // Counterpart of the sidebar's btoa(unescape(encodeURIComponent(json))).
      decoded = JSON.parse(decodeURIComponent(escape(atob(b64))));
    } catch (e) {
      console.warn('[bento-shell-mount] failed to decode BENTO_PANELS payload:', e);
      return;
    }
    // Payload shape: { workspaceId, panels, windowId?, ... }.
    // workspaceId is the currently-active Bento workspace for THIS WINDOW
    // (phase A.4 — per-window active workspace); chrome stores it so the
    // Cmd+1..9 handler can scope tab activation. The panels array drives
    // the side-panel strip reconcile. windowId is informational — each
    // chrome window reads its own document.title intrinsically, but the
    // shell stamps the originating window for cross-window debugging /
    // future validation. We don't strictly need to act on windowId (the
    // per-window-ness is already implicit in document.title scope) but
    // we log it so a mismatched payload would be visible.
    let panels;
    let allPanelPayloads = [];
    // Hoisted to outer scope so the fade-routing branch BELOW the
    // if/else can read it. A `const` inside the else-if would be
    // out-of-scope at the read site and throw ReferenceError on every
    // payload, silently aborting the reconcile.
    let isWorkspaceTransition = false;
    let scrollToPanelTabId = null;
    let scrollToPanelReveal = 'full';
	    if (Array.isArray(decoded)) {
	      allPanelPayloads = decoded;
	      currentPanelLayout = {
	        root: decoded
	          .map((panel) => Number(panel?.tabId))
	          .filter((tabId) => Number.isFinite(tabId))
	          .map((tabId) => ({ kind: 'panel', tabId })),
	      };
	      panels = decoratePanelsForLayout(currentPanelLayout, allPanelPayloads);
	      currentDevtoolsLinkByTabId = new Map();
	      currentDevtoolsTabIdByPairKey = new Map();
	      currentMainDevtoolsLink = null;
	      currentPanelAudioByTabId = new Map();
	      for (const panel of allPanelPayloads) {
	        const tabId = Number(panel?.tabId);
	        if (!Number.isFinite(tabId)) continue;
	        currentPanelAudioByTabId.set(tabId, {
	          audible: panel?.audible === true,
	          muted: panel?.muted === true,
	        });
	      }
	      updatePanelHeaderAudioButtons();
	      currentHeaderHiddenTabIds = new Set();
	      hideStartupVeil();
	    } else if (decoded && Array.isArray(decoded.panels)) {
      allPanelPayloads = decoded.panels;
      const sanitizedLayout = sanitizePanelLayoutPayload(decoded.layout, allPanelPayloads);
      currentPanelLayout = sanitizedLayout;
      panels = decoratePanelsForLayout(sanitizedLayout, allPanelPayloads);
      const incomingWorkspaceId =
        typeof decoded.workspaceId === 'string' ? decoded.workspaceId : null;
      if (typeof decoded.windowId === 'number') {
        // No window-ID validation against gBrowser here yet — chrome
        // can't trivially resolve "my own WebExtension windowId" without
        // a hop through ExtensionParent.windowTracker. Phase F's
        // workspace mirroring will revisit this when per-window
        // routing becomes load-bearing. For now, the per-window
        // selector in useToolsPort already ensures each shell only
        // writes its own window's title.

        decoded.windowId; // documented presence; informational only
      }
      // Workspace just changed — flag the next reconcile so the main
      // panel gets a one-shot CSS width transition. Without this the
      // sequence is: TabSelect fires immediately (new tab content swaps
      // in), then up to 200ms later the title-IPC poll picks up the new
      // mainWidthPx and the panel snaps to the new width. The snap
      // reads as two-stage. The transition makes it feel synchronized
      // even though the underlying messages aren't.
      const wsChanged =
        currentWorkspaceId !== null &&
        incomingWorkspaceId !== null &&
        currentWorkspaceId !== incomingWorkspaceId;
      // Broader transition test (boot included) — used below to decide
      // both panel-strip scroll restore AND the workspace-switch fade.
      // Computed BEFORE the currentWorkspaceId mutation so the
      // comparison actually sees the previous value. Assigned (not
      // re-declared) so the outer-scope `let` from the top of
      // handlePanelsTitle is the binding the fade router below reads.
      const isBootHydration = currentWorkspaceId === null && incomingWorkspaceId !== null;
      isWorkspaceTransition =
        incomingWorkspaceId !== null && currentWorkspaceId !== incomingWorkspaceId;
      currentWorkspaceId = incomingWorkspaceId;
      currentPanelTabIds = new Set(panels.map((p) => p.tabId));
      currentDevtoolsLinkByTabId = new Map();
      currentDevtoolsTabIdByPairKey = new Map();
      currentMainDevtoolsLink = null;
      if (Array.isArray(decoded.devtoolsPairs)) {
        for (const rawLink of decoded.devtoolsPairs) {
          const devtoolsTabId = Number(rawLink?.devtoolsTabId);
          const inspectedTabId = Number(rawLink?.inspectedTabId);
          const callerTabId =
            rawLink?.callerTabId === null ? null : Number(rawLink?.callerTabId);
          if (!Number.isFinite(devtoolsTabId) || !Number.isFinite(inspectedTabId)) continue;
          if (callerTabId !== null && !Number.isFinite(callerTabId)) continue;
          const link = { devtoolsTabId, callerTabId, inspectedTabId };
          currentDevtoolsLinkByTabId.set(devtoolsTabId, link);
          currentDevtoolsTabIdByPairKey.set(
            `${callerTabId === null ? 'main' : callerTabId}:${inspectedTabId}`,
            devtoolsTabId,
          );
          if (callerTabId === null) currentMainDevtoolsLink = link;
        }
      }
      currentPanelAudioByTabId = new Map();
      currentHeaderHiddenTabIds = new Set();
      for (const panel of allPanelPayloads) {
        const tabId = Number(panel?.tabId);
        if (!Number.isFinite(tabId)) continue;
        currentPanelAudioByTabId.set(tabId, {
          audible: panel?.audible === true,
          muted: panel?.muted === true,
        });
        if (panel?.headerHidden === true) currentHeaderHiddenTabIds.add(tabId);
      }
      updatePanelHeaderAudioButtons();
      currentPanelStatusByTabId = new Map();
      if (decoded.panelStatusByTabId && typeof decoded.panelStatusByTabId === 'object') {
        for (const [tabId, status] of Object.entries(decoded.panelStatusByTabId)) {
          const n = Number(tabId);
          if (Number.isFinite(n) && typeof status === 'string') {
            currentPanelStatusByTabId.set(n, status);
          }
        }
      }
      // Update mainPanelWidth from persisted tools state for the active
      // workspace. Missing mainWidthPx is authoritative for that workspace:
      // it means the user has not resized the main slot there yet, so clear
      // any width carried over from the previous workspace.
      if (typeof decoded.mainWidthPx === 'number' && decoded.mainWidthPx > 0) {
        mainPanelWidth = decoded.mainWidthPx;
      } else {
        mainPanelWidth = null;
      }
      __mainWidthTransitionForNextReconcile = wsChanged;
      // Self-correcting backstop for the dedicated BENTO_COLOR_MODE
      // path: if a panels/sync raced with a color-mode change and
      // overwrote the title before chrome polled it, the next reconcile
      // re-applies. Idempotent — applyChromeColorMode short-circuits
      // when the attribute already matches.
      if (typeof decoded.uiColorMode === 'string') {
        applyChromeColorMode(decoded.uiColorMode.trim());
      }
      if (typeof decoded.themeId === 'string' && decoded.themeId.trim().length > 0) {
        const themeId = decoded.themeId.trim();
        document.documentElement.setAttribute('data-bento-theme', themeId);
      }
      // Sidebar collapsed state — toggle a class on the chrome host so
      // CSS narrows the sidebar to a rail showing only favicons and the
      // workspace avatar.
      if (typeof decoded.sidebarCollapsed === 'boolean') {
        applyChromeSidebarCollapsed(decoded.sidebarCollapsed);
      }
      if (
        decoded.sidebarShortcutBehavior === 'collapse' ||
        decoded.sidebarShortcutBehavior === 'hide'
      ) {
        currentSidebarShortcutBehavior = decoded.sidebarShortcutBehavior;
      }
      if (typeof decoded.sidebarHidden === 'boolean') {
        applyChromeSidebarHidden(decoded.sidebarHidden);
      }
      // Default panel width also drives the unresized main slot's minimum
      // width. This keeps fresh workspaces with many spawned panels from
      // squeezing tab content below the user's normal panel size.
      if (typeof decoded.defaultPanelWidthPx === 'number') {
        applyChromeDefaultPanelWidth(decoded.defaultPanelWidthPx);
      }
      // Custom panel sizes (kebab menu presets). Filter to finite
      // positive integers up front so the menu doesn't have to defend
      // against malformed entries on every open. Missing key leaves
      // the list untouched — earlier payloads might have carried it.
      if (Array.isArray(decoded.customPanelSizes)) {
        currentCustomPanelSizes = decoded.customPanelSizes
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
          .map((n) => Math.round(n));
      }
      if (typeof decoded.panelCycleWraparound === 'boolean') {
        currentPanelCycleWraparound = decoded.panelCycleWraparound;
      }
      if (typeof decoded.panelShadowsEnabled === 'boolean') {
        applyChromePanelShadowsEnabled(decoded.panelShadowsEnabled);
      }
      if (typeof decoded.panelCornerRadiusPx === 'number') {
        applyChromePanelCornerRadius(decoded.panelCornerRadiusPx);
      }
      if (typeof decoded.panelSplitterSizePx === 'number') {
        applyChromePanelSplitterSize(decoded.panelSplitterSizePx);
      }
      hideStartupVeil();
      if (
        typeof decoded.scrollToPanelTabId === 'number' &&
        Number.isInteger(decoded.scrollToPanelTabId)
      ) {
        scrollToPanelTabId = decoded.scrollToPanelTabId;
        scrollToPanelReveal =
          decoded.scrollToPanelReveal === 'right-edge' ? 'right-edge' : 'full';
      }
      // Pinned-panel tabIds for the incoming workspace. Workspace-
      // filtered upstream so a Set.has(tabId) is enough to sync each
      // panel header pin button. Missing key means the
      // workspace has no pins (tools omits the field when the array
      // is empty); reset the local mirror accordingly so a workspace
      // switch from a pinned workspace into an unpinned one doesn't
      // carry stale state forward.
      if (Array.isArray(decoded.pinnedTabIdsInWorkspace)) {
        currentPinnedTabIdsInWorkspace = new Set(
          decoded.pinnedTabIdsInWorkspace.map((n) => Number(n)).filter((n) => Number.isFinite(n)),
        );
      } else {
        currentPinnedTabIdsInWorkspace = new Set();
      }
      updatePanelHeaderPinButtons();
      // Saved-panel count drives the Add-panel trailer's flex-basis
      // so the inline favicon row has room to render. Global (not
      // workspace-scoped) but rides on this payload because chrome
      // already polls BENTO_PANELS — see SavedPanelsStore in
      // bento-tools. Missing key resets to 0 (legacy tools builds
      // that haven't been rebuilt with the bookmarks permission).
      if (typeof decoded.savedPanelCount === 'number' && decoded.savedPanelCount >= 0) {
        currentSavedPanelCount = Math.round(decoded.savedPanelCount);
      } else {
        currentSavedPanelCount = 0;
      }
      if (Array.isArray(decoded.savedPanelItems)) {
        currentSavedPanelItems = decoded.savedPanelItems
          .map((item) => ({
            id: String(item?.id ?? item?.url ?? ''),
            title: String(item?.title ?? ''),
            url: String(item?.url ?? ''),
            favIconUrl:
              typeof item?.favIconUrl === 'string' && item.favIconUrl.length > 0
                ? item.favIconUrl
                : undefined,
          }))
          .filter((item) => item.url.length > 0);
      } else {
        currentSavedPanelItems = [];
      }
      applyTrailerWidth(currentSavedPanelCount);
      currentSubdivisions = new Map();
      // Per-workspace panel-strip scroll position. Capture into the
      // module-level map keyed by workspaceId so:
      //   - Same-workspace reconciles (panel add/remove, width change)
      //     don't clobber a fresh in-flight user scroll.
      //   - Workspace-switch reconciles can look up the destination
      //     workspace's stored scrollLeft and apply it after the
      //     reconcile has finished laying out the new panel set.
      // Missing field on the payload leaves the current map entry
      // untouched (older tools, or no scroll recorded yet).
      if (typeof decoded.stripScrollLeft === 'number' && decoded.stripScrollLeft >= 0) {
        stripScrollByWorkspace.set(incomingWorkspaceId, decoded.stripScrollLeft);
      }
      // Workspace transition: apply the destination workspace's
      // stored scroll AFTER the reconcile commits layout. Without
      // this the chrome strip always lands at scrollLeft=0 (rebuilding
      // the tabpanels children resets scroll), so the user always
      // sees the main slot regardless of where the strip was before.
      //
      // Triggers on BOTH boot (null → X) AND inter-workspace switches
      // (X → Y) — see isWorkspaceTransition computation above.
      if (isWorkspaceTransition) {
        const targetScroll = stripScrollByWorkspace.get(incomingWorkspaceId);
        __pendingStripScrollRestore = typeof targetScroll === 'number' ? targetScroll : null;
        if (isBootHydration && typeof targetScroll === 'number' && targetScroll > 0) {
          __suppressNextMainAutoScrollForWorkspace = incomingWorkspaceId;
        }
      }
    } else {
      return;
    }
    // OS-level reduced-motion: skip the fade (and the 140ms
    // pre-reconcile delay it implies) so the swap is instant for
    // users who've opted out of animation. Matches the React
    // sidebar's TabList.css behaviour.
    const reduceMotion = prefersReducedWorkspaceMotion();
    if (isWorkspaceTransition && !reduceMotion) {
      // Crossfade-then-swap: fade the visible workspace contents out,
      // perform the reconcile DOM swap behind the opacity-0 curtain,
      // then fade back in. Without this, the panel strip / favicon
      // navigator / main content all swap instantly while only the
      // React sidebar slides — the asymmetric motion reads as a
      // visual glitch even though each individual swap is correct.
      performWorkspaceSwitchFade(panels, { scrollToPanelTabId, scrollToPanelReveal });
    } else if (!isWorkspaceTransition && canFastPathTopClosedSubdivision(panels)) {
      fastPathTopClosedSubdivision(panels);
      applyPendingStripScrollRestore();
    } else {
      reconcilePanels(panels, { scrollToPanelTabId, scrollToPanelReveal });
      applyPendingStripScrollRestore();
    }
  }

  // Apply any pending strip-scroll restore after the reconciler has
  // committed the new panel DOM. Two rAFs because the first commits
  // the layout style writes and the second is the first frame where
  // scrollWidth reflects the final panel widths — applying earlier
  // gets clamped to the (pre-reconcile) scrollWidth and lands short.
  // NOT used during the fade path — that branch applies scroll
  // restore synchronously, under the opacity-0 curtain, so the user
  // never sees the scroll position settle.
  function applyPendingStripScrollRestore() {
    if (__pendingStripScrollRestore === null) return;
    const target = __pendingStripScrollRestore;
    __pendingStripScrollRestore = null;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const host = getStripScrollTarget();
        if (!host) return;
        // Suppress the dispatch the scroll listener would otherwise
        // fire: this is a programmatic restore, not a user gesture,
        // and dispatching here would write the restored value back
        // to tools as if it were a fresh user action (harmless but
        // noisy in the log + persistence layer).
        __suppressStripScrollDispatch = true;
        try {
          host.scrollLeft = Math.max(0, target);
        } finally {
          // Clear the suppression on the next frame so any user
          // scroll that lands AFTER the programmatic write is
          // captured normally.
          requestAnimationFrame(() => {
            __suppressStripScrollDispatch = false;
          });
        }
      });
    });
  }

  // Workspace-switch fade coordinator. Adds the fade-out class
  // immediately, defers the reconcile until the fade-out CSS
  // transition has visually completed, then queues a single rAF to
  // remove the class and let the CSS transition handle fade-in.
  //
  // Key invariant: NOTHING moves during the fade. The reconcile runs
  // at opacity 0, with main-width transition suppressed and the
  // auto-scroll-to-main path gated off; scroll restore happens
  // synchronously under the curtain. By the time the fade class is
  // removed, all layout is at its final destination — the user sees
  // a STATIC fade-in, no sliding.
  //
  // Belt-and-suspenders cleanup: each fragile step has its own
  // try/catch, the rAF that removes the class lives in `finally`
  // (always runs), and a watchdog timer force-clears the class if
  // it's still present after WORKSPACE_FADE_WATCHDOG_MS. Without
  // these guards a single failed reconcile would strand opacity at
  // 0 — chrome would go blank until process restart.
  let __workspaceSwitchTimer = null;
  let __workspaceFadeWatchdog = null;
  let __workspaceFadeCleanupTimer = null;
  const WORKSPACE_FADE_WATCHDOG_MS = 1500;
  const WORKSPACE_FADE_MS = 140;
  const WORKSPACE_STABILIZE_MS = 260;
  function clearWorkspaceFadeClasses() {
    const sc = document.getElementById('bento-strip-container');
    const nav = document.getElementById('bento-panel-nav');
    const tp = window.gBrowser?.tabpanels;
    if (sc) sc.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (nav) nav.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (tp) tp.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (__workspaceFadeCleanupTimer) {
      clearTimeout(__workspaceFadeCleanupTimer);
      __workspaceFadeCleanupTimer = null;
    }
  }
  function cancelWorkspaceFadeForMainOnly() {
    const sc = document.getElementById('bento-strip-container');
    const nav = document.getElementById('bento-panel-nav');
    const tp = window.gBrowser?.tabpanels;
    const hadFadeClass =
      sc?.classList.contains('bento-workspace-switching') ||
      sc?.classList.contains('bento-workspace-stabilizing') ||
      nav?.classList.contains('bento-workspace-switching') ||
      nav?.classList.contains('bento-workspace-stabilizing') ||
      tp?.classList.contains('bento-workspace-switching') ||
      tp?.classList.contains('bento-workspace-stabilizing');
    const hadTimer =
      __workspaceSwitchTimer !== null ||
      __workspaceFadeWatchdog !== null ||
      __workspaceFadeCleanupTimer !== null;
    if (!hadFadeClass && !hadTimer) return;

    if (__workspaceSwitchTimer) {
      clearTimeout(__workspaceSwitchTimer);
      __workspaceSwitchTimer = null;
    }
    if (__workspaceFadeWatchdog) {
      clearTimeout(__workspaceFadeWatchdog);
      __workspaceFadeWatchdog = null;
    }
    clearWorkspaceFadeClasses();
    __workspaceSwitchSwapping = false;
  }
  function setWorkspaceFadeClasses(enabled) {
    const stripContainer = document.getElementById('bento-strip-container');
    const nav = document.getElementById('bento-panel-nav');
    const tp = window.gBrowser?.tabpanels;
    for (const el of [stripContainer, nav, tp]) {
      if (!el) continue;
      el.classList.toggle('bento-workspace-switching', enabled);
      el.classList.toggle('bento-workspace-stabilizing', enabled);
    }
  }
  function cancelStripScrollMotion() {
    const host = getStripScrollTarget();
    if (!host) return;
    // Assigning the current value cancels an in-flight native smooth
    // scroll without changing the final position.
    host.scrollLeft = host.scrollLeft;
  }
  function armWorkspaceSwitchFade() {
    cancelStripScrollMotion();
    setWorkspaceFadeClasses(true);
  }
  function selectedTabWorkspaceId(tab) {
    if (!tab) return null;
    const SessionStore = getSessionStore();
    if (!SessionStore) return null;
    try {
      const raw = SessionStore.getCustomTabValue(tab, WORKSPACE_SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function shouldDeferReconcileForWorkspaceSwitch(tab) {
    if (prefersReducedWorkspaceMotion()) return false;
    if (!currentWorkspaceId) return false;
    const tabWorkspaceId = selectedTabWorkspaceId(tab);
    return tabWorkspaceId !== null && tabWorkspaceId !== currentWorkspaceId;
  }
  function prefersReducedWorkspaceMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }
  function performWorkspaceSwitchFade(panels, options = {}) {
    const hasExplicitScrollTarget = Number.isInteger(options.scrollToPanelTabId);
    const stripContainer = document.getElementById('bento-strip-container');
    const tp = window.gBrowser?.tabpanels;
    if (__workspaceSwitchTimer) clearTimeout(__workspaceSwitchTimer);
    if (__workspaceFadeWatchdog) clearTimeout(__workspaceFadeWatchdog);
    if (__workspaceFadeCleanupTimer) {
      clearTimeout(__workspaceFadeCleanupTimer);
      __workspaceFadeCleanupTimer = null;
    }
    // Watchdog armed BEFORE we add the class so any throw between
    // here and the cleanup rAF still gets a chance to clear the
    // class and restore visibility.
    __workspaceFadeWatchdog = setTimeout(() => {
      __workspaceFadeWatchdog = null;
      if (
        (stripContainer && stripContainer.classList.contains('bento-workspace-switching')) ||
        (document
          .getElementById('bento-panel-nav')
          ?.classList.contains('bento-workspace-switching')) ||
        (tp && tp.classList.contains('bento-workspace-switching'))
      ) {
        console.warn(
          '[bento-shell-mount] workspace-switch watchdog fired — fade class lingered, force-clearing',
        );
        clearWorkspaceFadeClasses();
      }
    }, WORKSPACE_FADE_WATCHDOG_MS);
    armWorkspaceSwitchFade();
    __workspaceSwitchTimer = setTimeout(() => {
      __workspaceSwitchTimer = null;
      // Suppress every in-reconcile animation. The fade IS our
      // transition; any layout animation here would tail past the
      // fade-in and the user would see panels sliding into place.
      //  - Clear __mainWidthTransitionForNextReconcile (set above on
      //    wsChanged) so reconcile snaps the main-panel width
      //    instead of running a 200ms width transition.
      //  - Set __workspaceSwitchSwapping so reconcilePanelsSplitView
      //    skips its smooth scrollPanelToLeftmost auto-scroll-to-main.
      __mainWidthTransitionForNextReconcile = false;
      __workspaceSwitchSwapping = true;
      try {
        try {
          reconcilePanels(panels, options);
          if (!hasExplicitScrollTarget) {
            cancelStripScrollMotion();
          }
        } catch (err) {
          console.warn('[bento-shell-mount] workspace-switch reconcile threw:', err);
        }
        // Apply scroll restore SYNCHRONOUSLY, not via
        // applyPendingStripScrollRestore's double-rAF (which would
        // defer past fade-in). Setting scrollLeft directly is
        // instant — no smooth animation — so the user can't see
        // the strip moving. Happens under the opacity-0 curtain
        // because the class-removal rAF hasn't fired yet.
        if (!hasExplicitScrollTarget && __pendingStripScrollRestore !== null) {
          try {
            const target = __pendingStripScrollRestore;
            __pendingStripScrollRestore = null;
            const host = getStripScrollTarget();
            if (host) {
              __suppressStripScrollDispatch = true;
              try {
                host.scrollLeft = Math.max(0, target);
              } finally {
                requestAnimationFrame(() => {
                  __suppressStripScrollDispatch = false;
                });
              }
            }
          } catch (err) {
            console.warn('[bento-shell-mount] workspace-switch scroll restore threw:', err);
          }
        }
      } finally {
        __workspaceSwitchSwapping = false;
        // Class removal MUST run even if reconcile/scroll-restore
        // threw — otherwise the chrome stays at opacity 0 forever.
        // The watchdog above is the belt; this `finally` is the
        // suspenders.
        requestAnimationFrame(() => {
          const nav = document.getElementById('bento-panel-nav');
          if (stripContainer) stripContainer.classList.remove('bento-workspace-switching');
          if (nav) nav.classList.remove('bento-workspace-switching');
          if (tp) tp.classList.remove('bento-workspace-switching');
          // Keep layout-transition suppression through the fade-in. If
          // we remove it in the same frame as the opacity class, pending
          // width/flex changes can begin animating under the fade-in and
          // look like the strip is sliding to the destination workspace.
          __workspaceFadeCleanupTimer = setTimeout(() => {
            __workspaceFadeCleanupTimer = null;
            if (stripContainer) {
              stripContainer.classList.remove('bento-workspace-stabilizing');
            }
            const nav = document.getElementById('bento-panel-nav');
            if (nav) nav.classList.remove('bento-workspace-stabilizing');
            if (tp) tp.classList.remove('bento-workspace-stabilizing');
          }, WORKSPACE_STABILIZE_MS);
          if (__workspaceFadeWatchdog) {
            clearTimeout(__workspaceFadeWatchdog);
            __workspaceFadeWatchdog = null;
          }
        });
      }
    }, WORKSPACE_FADE_MS);
  }
  // True while the deferred reconcile inside performWorkspaceSwitchFade
  // is running. Read by reconcilePanelsSplitView to skip the smooth
  // scrollPanelToLeftmost auto-scroll-to-main that would otherwise
  // tail past the fade-in window as visible sliding.
  let __workspaceSwitchSwapping = false;

  // Module-level mirror of bento-tools' per-workspace strip-scroll map.
  // Populated from BENTO_PANELS payloads (which carry stripScrollLeft).
  // Read on workspace switch to decide which scroll position to restore.
  const stripScrollByWorkspace = new Map();
  // Single-shot scroll value the next reconcile should apply after
  // layout commits (workspace-switch path). Null when no restore is
  // pending. Cleared after consumption so subsequent same-workspace
  // reconciles don't re-apply it.
  let __pendingStripScrollRestore = null;
  // True while a programmatic scrollLeft write is in flight. The
  // scroll listener that dispatches panel/setStripScroll checks this
  // and skips the dispatch so we don't echo restored values back to
  // tools.
  let __suppressStripScrollDispatch = false;
  let __liveLayoutScrollPreserveToken = 0;
  // Debounce handle for outbound panel/setStripScroll dispatches.
  // Scroll events fire continuously during a drag; coalesce to one
  // dispatch per rest. Matches the persistence DEBOUNCE_MS pattern.
  let __stripScrollDispatchTimer = null;
  const STRIP_SCROLL_DEBOUNCE_MS = 250;

  function applyChromeSidebarCollapsed(collapsed) {
    const host = document.getElementById('bento-shell-host');
    if (!host) return;
    // First apply at boot: skip the CSS width transition so the
    // persisted state paints at its target width immediately. Without
    // this the user sees the sidebar mount at 300px (the patch's inline
    // width) and animate to 4rem once the title-IPC arrives — reads as
    // a flash. Subsequent toggles get the transition for the smooth
    // collapse/expand UX.
    if (!host.__bentoSidebarApplied) {
      host.__bentoSidebarApplied = true;
      const wasCollapsed = host.classList.contains('bento-sidebar-collapsed');
      if (wasCollapsed !== collapsed) {
        host.style.transition = 'none';
        host.classList.toggle('bento-sidebar-collapsed', collapsed);
        // Force layout commit so the next style change is treated as a
        // new transition, not a continuation of the suppressed one.

        host.offsetWidth;
        host.style.removeProperty('transition');
      }
    } else {
      host.classList.toggle('bento-sidebar-collapsed', collapsed);
    }
    // Hide the resize splitter when collapsed — there's nothing to drag
    // when the rail is at its minimum width.
    const splitter = document.getElementById('bento-shell-splitter');
    if (splitter) splitter.classList.toggle('bento-sidebar-collapsed', collapsed);
    const affordance = document.getElementById('bento-shell-splitter-affordance');
    if (affordance) affordance.classList.toggle('bento-sidebar-collapsed', collapsed);
  }

  function applyChromeSidebarHidden(hidden) {
    currentSidebarHidden = hidden === true;
    const host = document.getElementById('bento-shell-host');
    if (!host) return;
    document.documentElement.toggleAttribute('bento-sidebar-hidden', currentSidebarHidden);
    if (!currentSidebarHidden) {
      host.classList.remove('bento-sidebar-hidden-revealed');
      document.documentElement.removeAttribute('bento-sidebar-hidden-revealed');
    }
    if (!host.__bentoSidebarHiddenApplied) {
      host.__bentoSidebarHiddenApplied = true;
      const wasHidden = host.classList.contains('bento-sidebar-hidden');
      if (wasHidden !== currentSidebarHidden) {
        host.style.transition = 'none';
        host.classList.toggle('bento-sidebar-hidden', currentSidebarHidden);
        host.offsetWidth;
        host.style.removeProperty('transition');
      }
    } else {
      host.classList.toggle('bento-sidebar-hidden', currentSidebarHidden);
      host.offsetWidth;
    }
    const splitter = document.getElementById('bento-shell-splitter');
    if (splitter) splitter.classList.toggle('bento-sidebar-hidden', currentSidebarHidden);
    const affordance = document.getElementById('bento-shell-splitter-affordance');
    if (affordance) affordance.classList.toggle('bento-sidebar-hidden', currentSidebarHidden);
    window.dispatchEvent(new CustomEvent(BENTO_RESIZE_SETTLED_EVENT));
  }

  // One-shot flag set by handlePanelsTitle when the workspace changed.
  // The reconciler reads + clears it before applying the main-panel
  // width so the change animates from old to new width instead of
  // snapping. Cleared after the first reconcile so subsequent same-
  // workspace reconciles (TabSelect within a workspace) don't transition.
  let __mainWidthTransitionForNextReconcile = false;

  // Active workspace state mirrored from the shell via BENTO_PANELS payload.
  // Cmd+1..9 reads these to scope tab activation to the current workspace
  // (so Cmd+3 picks the 3rd tab in the active workspace, not the 3rd tab
  // in Firefox's flat tab list which would jump across workspaces).
  let currentWorkspaceId = null;
  let currentPanelTabIds = new Set();
  let currentPanelStatusByTabId = new Map();
  let currentPanelAudioByTabId = new Map();
  let currentHeaderHiddenTabIds = new Set();
  let currentDevtoolsLinkByTabId = new Map();
  let currentDevtoolsTabIdByPairKey = new Map();
  let currentMainDevtoolsLink = null;
  let currentPanelLayout = { root: [] };
  let currentPanelLayoutGeometry = null;
  function applyChromeDefaultPanelWidth(widthPx) {
    const n = Number(widthPx);
    if (!Number.isFinite(n) || n <= 0) return;
    document.documentElement?.style.setProperty(
      '--bento-main-panel-min-width',
      Math.round(n) + 'px',
    );
  }
  function applyChromePanelCornerRadius(radiusPx) {
    const n = Number(radiusPx);
    if (!Number.isFinite(n)) return;
    const rounded = Math.round(n);
    const clamped = Math.min(
      BENTO_PANEL_CORNER_RADIUS_MAX,
      Math.max(BENTO_PANEL_CORNER_RADIUS_MIN, rounded),
    );
    document.documentElement?.style.setProperty('--bento-panel-corner-radius', clamped + 'px');
  }
  function applyChromePanelSplitterSize(sizePx) {
    const n = Number(sizePx);
    if (!Number.isFinite(n)) return;
    const rounded = Math.round(n);
    const clamped = Math.min(
      BENTO_PANEL_SPLITTER_SIZE_MAX,
      Math.max(BENTO_PANEL_SPLITTER_SIZE_MIN, rounded),
    );
    document.documentElement?.style.setProperty('--bento-splitter-hit-size', clamped + 'px');
  }
  // Preset side-panel widths surfaced in each panel header's kebab menu.
  // Mirrored from BentoSettings.customPanelSizes via the BENTO_PANELS
  // payload — same single-channel-no-race rationale as uiColorMode /
  // sidebarCollapsed (see useToolsPort.ts). Read on-demand when the
  // user opens a kebab menu; stays empty until the first payload that
  // includes it (settings store default is [320, 480, 768, 1280]).
  let currentCustomPanelSizes = [];
  // BentoSettings.panelCycleWraparound mirrored via the same payload.
  // When true, Cmd/Ctrl+Shift+Left/Right cycling wraps past the Add-panel
  // trailer back to the main panel (and vice versa). Default false:
  // cycling clamps at the endpoints.
  let currentPanelCycleWraparound = false;
  // Pinned-panel tabIds for THIS WINDOW's active workspace, mirrored
  // from BENTO_PANELS payload's `pinnedTabIdsInWorkspace` field. The
  // panel header pin button reads this to pick its filled state without having
  // to round-trip a fresh query through bento-tools. Workspace-
  // filtered upstream (tools only includes the active workspace's
  // pin subset) so a Set.has(tabId) lookup is enough — no global pin
  // map needed chrome-side.
  let currentPinnedTabIdsInWorkspace = new Set();
  // Number of bookmarks in the "Saved panels" folder. Mirrored from
  // BENTO_PANELS payload's `savedPanelCount` field. Drives the
  // Add-panel trailer's flex-basis via applyTrailerWidth so the
  // inline favicon row has room to grow.
  let currentSavedPanelCount = 0;
  let currentSavedPanelItems = [];
  let currentSubdivisions = new Map();
  const pendingPromotedSubPanelEnterSkips = new Set();
  const pendingPromotedSubPanelContentPreserves = new Set();
  const pendingPromotedSubdivisionParentCloses = new Map();

  function applyChromePanelShadowsEnabled(enabled) {
    window.gBrowser?.tabpanels?.classList.toggle('bento-panel-shadows-disabled', !enabled);
    document
      .getElementById('bento-strip-container')
      ?.classList.toggle('bento-panel-shadows-disabled', !enabled);
  }

  function attachPaletteCloseListener() {
    const paletteFrame = document.getElementById('bento-palette-frame');
    // Both frames use polling for title-based IPC. DOMTitleChanged is
    // unreliable for our remote=true moz-extension content — the event
    // doesn't fire for either the persistent shell frame or the
    // reload-on-show palette frame in our setup. A 200ms poll loop is
    // cheap (one string comparison per tick), reliable across all
    // mount/reload states, and adds at most 200ms perceived latency
    // to palette open/close (which is fine for a manually-triggered UI).
    if (paletteFrame) {
      let lastSeenPaletteTitle = '';
      setInterval(() => {
        const title = paletteFrame.contentTitle || '';
        if (title === lastSeenPaletteTitle) return;
        lastSeenPaletteTitle = title;
        if (title.startsWith(PALETTE_CLOSE_PREFIX)) hidePalette();
      }, 200);
    }

    const mergePaletteFrame = document.getElementById('bento-merge-palette-frame');
    if (mergePaletteFrame) {
      let lastSeenMergePaletteTitle = '';
      setInterval(() => {
        const title = mergePaletteFrame.contentTitle || '';
        if (title === lastSeenMergePaletteTitle) return;
        lastSeenMergePaletteTitle = title;
        if (title.startsWith(MERGE_PALETTE_CLOSE_PREFIX)) hideMergePalette();
      }, 200);
    }

    const workspacePaletteFrame = document.getElementById('bento-workspace-palette-frame');
    if (workspacePaletteFrame) {
      let lastSeenWorkspacePaletteTitle = '';
      setInterval(() => {
        const title = workspacePaletteFrame.contentTitle || '';
        if (title === lastSeenWorkspacePaletteTitle) return;
        lastSeenWorkspacePaletteTitle = title;
        if (title.startsWith(WORKSPACE_PALETTE_CLOSE_PREFIX)) {
          hideWorkspacePalette();
        } else if (title.startsWith(CONFIRM_OPEN_PREFIX)) {
          showConfirm();
        }
      }, 200);
    }

    const addrbarFrame = document.getElementById('bento-addrbar-frame');
    if (addrbarFrame) {
      let lastSeenAddrbarTitle = '';
      setInterval(() => {
        const title = addrbarFrame.contentTitle || '';
        if (title === lastSeenAddrbarTitle) return;
        lastSeenAddrbarTitle = title;
        if (title.startsWith(ADDRBAR_CLOSE_PREFIX)) hideAddrbar();
        else if (title.startsWith(ADDRBAR_READY_PREFIX)) handleAddrbarReadyTitle(title);
        else if (title.startsWith(ADDRBAR_NAVIGATE_PREFIX)) handleAddrbarNavigateTitle(title);
      }, 60);
    }

    const confirmFrame = document.getElementById('bento-confirm-frame');
    if (confirmFrame) {
      let lastSeenConfirmTitle = '';
      setInterval(() => {
        const title = confirmFrame.contentTitle || '';
        if (title === lastSeenConfirmTitle) return;
        lastSeenConfirmTitle = title;
        if (title.startsWith(CONFIRM_CLOSE_PREFIX)) hideConfirm();
      }, 200);
    }

    const editWorkspaceFrame = document.getElementById('bento-edit-workspace-frame');
    if (editWorkspaceFrame) {
      let lastSeenEditTitle = '';
      setInterval(() => {
        const title = editWorkspaceFrame.contentTitle || '';
        if (title === lastSeenEditTitle) return;
        lastSeenEditTitle = title;
        if (title.startsWith(EDIT_WORKSPACE_CLOSE_PREFIX)) hideEditWorkspace();
      }, 200);
    }

    const welcomeFrame = document.getElementById('bento-welcome-frame');
    if (welcomeFrame) {
      let lastSeenWelcomeTitle = '';
      setInterval(() => {
        const title = welcomeFrame.contentTitle || '';
        if (title === lastSeenWelcomeTitle) return;
        lastSeenWelcomeTitle = title;
        if (title.startsWith(WELCOME_OPEN_PREFIX)) showWelcome();
        else if (title.startsWith(WELCOME_CLOSE_PREFIX)) hideWelcome();
        else if (title.startsWith(WELCOME_IMPORT_BROWSER_DATA_PREFIX)) {
          __bentoPendingWelcomeResumeStep = parseWelcomeImportResumeStep(title);
          showEmbeddedBrowserImportFromWelcome();
        }
      }, 200);
    }

    const embeddedImportFrame = document.getElementById('bento-embedded-import-frame');
    if (embeddedImportFrame) {
      let lastSeenEmbeddedImportTitle = '';
      setInterval(() => {
        const title = embeddedImportFrame.contentTitle || '';
        if (title === lastSeenEmbeddedImportTitle) return;
        lastSeenEmbeddedImportTitle = title;
        if (title.startsWith(EMBEDDED_IMPORT_CLOSE_PREFIX)) hideEmbeddedBrowserImport();
        else if (title.startsWith(EMBEDDED_IMPORT_RESTART_PREFIX)) {
          restartToBrowserImportFromWelcome(true);
        }
      }, 200);
    }

    // Menu overlay: SELECT routes the chosen itemId back to the chrome
    // onSelect handler registered when showChromeMenu was called; CLOSE
    // just hides the overlay (Esc / outside-click in the React menu).
    // Faster poll than the modal overlays (60ms vs 200ms) — a menu
    // selection should feel immediate. Body is still cheap (string
    // startsWith + small map lookup) so the higher frequency is fine.
    const menuFrame = document.getElementById('bento-menu-frame');
    if (menuFrame) {
      let lastSeenMenuTitle = '';
      setInterval(() => {
        const title = menuFrame.contentTitle || '';
        if (title === lastSeenMenuTitle) return;
        lastSeenMenuTitle = title;
        if (title.startsWith(MENU_SELECT_PREFIX)) {
          const rest = title.slice(MENU_SELECT_PREFIX.length);
          const firstColon = rest.indexOf(':');
          if (firstColon < 0) {
            hideChromeMenu();
            return;
          }
          const contextId = rest.slice(0, firstColon);
          const itemId = rest.slice(firstColon + 1);
          const handler = menuOnSelectByContext.get(contextId);
          menuOnSelectByContext.delete(contextId);
          hideChromeMenu();
          if (handler) {
            try {
              handler(itemId);
            } catch (err) {
              console.warn('[bento-shell-mount] chrome menu select handler threw:', err);
            }
          }
        } else if (title.startsWith(MENU_CLOSE_PREFIX)) {
          const contextId = title.slice(MENU_CLOSE_PREFIX.length);
          menuOnSelectByContext.delete(contextId);
          hideChromeMenu();
        }
      }, 60);
    }

    const wsSwitcherFrame = document.getElementById('bento-workspace-switcher-frame');
    if (wsSwitcherFrame) {
      let lastSeenWsSwitcherTitle = '';
      setInterval(() => {
        const title = wsSwitcherFrame.contentTitle || '';
        if (title === lastSeenWsSwitcherTitle) return;
        lastSeenWsSwitcherTitle = title;
        if (title.startsWith(WORKSPACE_SWITCHER_CLOSE_PREFIX)) {
          hideWorkspaceSwitcher();
        } else if (title.startsWith(EDIT_WORKSPACE_OPEN_PREFIX)) {
          // "Edit <workspace>" menu item: the overlay set this title
          // when forwarding to the edit-workspace modal. The payload
          // already reached the edit overlay via BroadcastChannel;
          // we just need to swap the visible host here.
          hideWorkspaceSwitcher();
          showEditWorkspace();
        } else if (title.startsWith(CONFIRM_OPEN_PREFIX)) {
          // "Delete <workspace>" menu item with tabs: forwards to the
          // destructive-confirm modal. Same swap as edit above.
          hideWorkspaceSwitcher();
          showConfirm();
        } else if (title.startsWith(WORKSPACE_PALETTE_OPEN_PREFIX)) {
          hideWorkspaceSwitcher();
          showWorkspacePalette();
        }
      }, 200);
    }

    let lastSeenPanelTrailerTitle = '';
    setInterval(() => {
      const panelTrailerFrame = document.getElementById('bento-panel-trailer-frame');
      const title = panelTrailerFrame?.contentTitle || '';
      if (title === lastSeenPanelTrailerTitle) return;
      lastSeenPanelTrailerTitle = title;
      if (title.startsWith(PANEL_TRAILER_CONTEXT_MENU_PREFIX)) {
        handlePanelTrailerContextMenuTitle(title);
      } else if (title.startsWith(PANEL_TRAILER_ADD_BLANK_PREFIX)) {
        addNewPanel();
      }
    }, 60);

    const shellFrame = document.getElementById('bento-shell-frame');
    if (shellFrame) {
      let lastSeenShellTitle = '';
      // requestAnimationFrame loop (~60Hz, paint-aligned). setInterval
      // at 200ms (or even 32ms) leaves a visible lag between the
      // sidebar flipping color modes locally and the chrome catching
      // up via the title-IPC channel — users perceive sidebar
      // changing first. rAF guarantees the chrome's data-color-mode
      // mutation lands in the SAME paint frame as the sidebar's, so
      // the entire chrome flips in one visual transition. The poll
      // body (a property read + string compare) is well within a
      // frame budget. Other modal frames stay on setInterval at 200ms
      // — they're user-triggered open/close, no sync requirement.
      const pollShellFrame = () => {
        const title = shellFrame.contentTitle || '';
        if (title !== lastSeenShellTitle) {
          lastSeenShellTitle = title;
          if (title.startsWith(PALETTE_OPEN_PREFIX)) showPalette();
          else if (title.startsWith(WORKSPACE_PALETTE_OPEN_PREFIX)) showWorkspacePalette();
          else if (title.startsWith(MERGE_PALETTE_OPEN_PREFIX)) showMergePalette();
          else if (title.startsWith(APP_MENU_OPEN_PREFIX)) handleAppMenuOpenTitle(title);
          else if (title.startsWith(DOWNLOADS_OPEN_PREFIX)) handleDownloadsOpenTitle(title);
          else if (title.startsWith(ADDRBAR_OPEN_PREFIX)) handleAddrbarOpenTitle(title);
          else if (title.startsWith(SIDEBAR_ADDRESS_SUBMIT_PREFIX)) {
            handleSidebarAddressSubmitTitle(title);
          } else if (title.startsWith(SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX)) {
            handleSidebarAddressBookmarkToggleTitle(title);
          } else if (title.startsWith(SIDEBAR_ADDRESS_IDENTITY_PREFIX)) {
            handleSidebarAddressIdentityTitle(title);
          } else if (title.startsWith(SIDEBAR_ADDRESS_COPY_PREFIX)) {
            handleSidebarAddressCopyTitle(title);
          } else if (title.startsWith(CONFIRM_OPEN_PREFIX)) showConfirm();
          else if (title.startsWith(EDIT_WORKSPACE_OPEN_PREFIX)) showEditWorkspace();
          else if (title.startsWith(WELCOME_OPEN_PREFIX)) showWelcome();
          else if (title.startsWith(WORKSPACE_SWITCHER_OPEN_PREFIX)) showWorkspaceSwitcher();
          else if (title.startsWith(SCROLL_TO_MAIN_PREFIX)) handleScrollToMainTitle();
          else if (title.startsWith(SELECTED_TABS_PREFIX)) handleSelectedTabsTitle(title);
          else if (title.startsWith(SIDEBAR_CONTEXT_MENU_PREFIX)) {
            handleSidebarContextMenuTitle(title);
          } else if (title.startsWith(FOCUS_PANEL_PREFIX)) handleFocusPanelTitle(title);
          else if (title.startsWith(TAB_MOVE_PREFIX)) handleTabMoveTitle(title);
          else if (title.startsWith(COLOR_MODE_PREFIX)) handleColorModeTitle(title);
          else if (title.startsWith(THEME_PREFIX)) handleThemeTitle(title);
          else if (title.startsWith(PANELS_PREFIX)) handlePanelsTitle(title);
        }
        window.requestAnimationFrame(pollShellFrame);
      };
      window.requestAnimationFrame(pollShellFrame);
    }
  }

  // Chrome-side Esc handler — fires regardless of whether focus is in
  // palette content or anywhere else in the chrome window. Capture phase
  // so it wins over any default handler.
  function attachPaletteEscListener() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        // Stack precedence (top = highest): confirm > edit-workspace >
        // workspace palette > welcome > workspace-switcher > palette.
        // Welcome is mandatory
        // onboarding: consume Esc there without hiding it. Other overlays
        // keep their normal Esc dismissal.
        const confirmHost = document.getElementById('bento-confirm-host');
        if (confirmHost && isConfirmVisible(confirmHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideConfirm();
          return;
        }
        const editHost = document.getElementById('bento-edit-workspace-host');
        if (editHost && isEditWorkspaceVisible(editHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideEditWorkspace();
          return;
        }
        const workspacePaletteHost = document.getElementById('bento-workspace-palette-host');
        if (workspacePaletteHost && isWorkspacePaletteVisible(workspacePaletteHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideWorkspacePalette();
          return;
        }
        const embeddedImportHost = document.getElementById('bento-embedded-import-host');
        if (embeddedImportHost && isEmbeddedImportVisible(embeddedImportHost)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        const welcomeHost = document.getElementById('bento-welcome-host');
        if (welcomeHost && isWelcomeVisible(welcomeHost)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        const wsSwitcherHost = document.getElementById('bento-workspace-switcher-host');
        if (wsSwitcherHost && isWorkspaceSwitcherVisible(wsSwitcherHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideWorkspaceSwitcher();
          return;
        }
        const addrbarHost = document.getElementById('bento-addrbar-host');
        if (addrbarHost && isAddrbarVisible(addrbarHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideAddrbar();
          return;
        }
        const mergeHost = document.getElementById('bento-merge-palette-host');
        if (mergeHost && isMergePaletteVisible(mergeHost)) {
          e.preventDefault();
          e.stopPropagation();
          hideMergePalette();
          return;
        }
        const host = document.getElementById('bento-palette-host');
        if (!host || !isPaletteVisible(host)) return;
        e.preventDefault();
        e.stopPropagation();
        hidePalette();
      },
      true,
    );
  }

  function attachPaletteKeybinding() {
    // Listen on the chrome window for Cmd/Ctrl+Alt+P. Capture phase so we
    // win against any later-attached handlers; preventDefault to suppress
    // any default Firefox behavior bound to the same combo.
    //
    // Match on `e.code` (physical key, e.g. 'KeyP'), not `e.key` (typed
    // character). On macOS, Option+P produces the Greek letter π; key.toLowerCase()
    // would be 'π' and the match would silently fail. e.code is keyboard-
    // layout-independent and is the right way to spell shortcuts that
    // include modifiers like Alt/Option.
    window.addEventListener(
      'keydown',
      (e) => {
        const accel = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey;
        if (!accel || !e.altKey || e.shiftKey) return;
        if (e.code !== 'KeyP') return;
        e.preventDefault();
        e.stopPropagation();
        togglePalette();
      },
      true,
    );
  }

  function attachAddrbarKeybinding() {
    window.addEventListener(
      'keydown',
      (e) => {
        const accel = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey;
        if (!accel || e.altKey || e.shiftKey) return;
        if (e.code !== 'KeyE' && e.code !== 'KeyL' && e.code !== 'KeyT') return;
        e.preventDefault();
        e.stopPropagation();
        if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
        openAddressEntry(e.code === 'KeyT' ? 'newTab' : 'current');
      },
      true,
    );
  }

  function attachAddrbarOutsideDismissListener() {
    window.addEventListener(
      'pointerdown',
      (e) => {
        const host = document.getElementById('bento-addrbar-host');
        if (!host || !isAddrbarVisible(host)) return;
        const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
        if (path.includes(host)) return;
        hideAddrbar();
      },
      true,
    );
  }

  function closeNativeUrlbarPopup() {
    try {
      window.gURLBar?.view?.close?.();
    } catch {
      /* best effort: Firefox urlbar internals vary across versions */
    }
  }

  function attachTopUrlbarModalListener() {
    const urlbar = document.getElementById('urlbar');
    const input = document.getElementById('urlbar-input');
    if (!urlbar || !input) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, attachTopUrlbarModalListener, { once: true });
      }
      return;
    }
    if (input.getAttribute('data-bento-addrbar-modal-attached') === '1') return;
    input.setAttribute('data-bento-addrbar-modal-attached', '1');

    let lastOpenAt = 0;
    let suppressTimer = 0;
    const suppressNativeUrlbarView = () => {
      const root = document.documentElement;
      root.setAttribute('bento-native-urlbar-intercepting', 'true');
      closeNativeUrlbarPopup();
      requestAnimationFrame(closeNativeUrlbarPopup);
      window.clearTimeout(suppressTimer);
      suppressTimer = window.setTimeout(() => {
        root.removeAttribute('bento-native-urlbar-intercepting');
      }, 650);
    };
    const isNativeUrlbarTarget = (event) => {
      const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
      if (path.includes(urlbar) || path.includes(input)) return true;
      const target = event.target;
      return !!target?.closest?.('#urlbar, #urlbar-container');
    };
    const openFromNativeUrlbar = (event) => {
      if (!isNativeUrlbarTarget(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();
      suppressNativeUrlbarView();
      input.blur?.();

      const now = Date.now();
      if (now - lastOpenAt < 180) return;
      lastOpenAt = now;
      openAddressEntry('current');
    };

    window.addEventListener('pointerdown', openFromNativeUrlbar, true);
    window.addEventListener('mousedown', openFromNativeUrlbar, true);
    window.addEventListener('click', openFromNativeUrlbar, true);
    window.addEventListener('focusin', openFromNativeUrlbar, true);
    input.addEventListener('focus', openFromNativeUrlbar, true);
  }

  // ─── Cmd/Ctrl+1..9 → activate Nth tab in active workspace ──────────────
  //
  // Firefox's default Cmd+1..9 picks the Nth tab in gBrowser.tabs (a flat
  // list across workspaces). In Bento that lands the user on a tab from
  // a different workspace — Cmd+3 in workspace "Work" might activate the
  // 3rd tab in workspace "Personal". We override to pick the Nth tab
  // *within the active workspace*, matching what the sidebar shows.
  //
  // Tab → workspace lookup uses SessionStore.getCustomTabValue with the
  // key WebExtensions persists at: `extension:<addon-id>:<key>`. That's
  // documented behaviour of toolkit/components/extensions/parent/ext-
  // sessions.js — getEncodedKey returns `extension:${extensionId}:${key}`
  // and the value is JSON-encoded. Stable API; we read the same store
  // bento-tools writes via browser.sessions.setTabValue.
  //
  // Panel exclusion uses ExtensionParent.apiManager.global.tabTracker to
  // map gBrowser tabs → WebExtension tab IDs. Panels are still gBrowser
  // tabs (separate from the panel's <browser>), so without exclusion
  // Cmd+N would count them and the indices would drift from the sidebar
  // list. tabTracker is the canonical mapping used by every WebExtension
  // tabs.* API; importing it is supported via ExtensionParent.
  let __sessionStoreModule = null;
  let __tabTrackerModule = null;
  function getSessionStore() {
    if (__sessionStoreModule) return __sessionStoreModule;
    try {
      const mod = ChromeUtils.importESModule(
        'resource:///modules/sessionstore/SessionStore.sys.mjs',
      );
      __sessionStoreModule = mod.SessionStore;
    } catch (err) {
      console.warn('[bento-shell-mount] SessionStore import failed:', err);
    }
    return __sessionStoreModule;
  }
  function getTabTracker() {
    if (__tabTrackerModule) return __tabTrackerModule;
    try {
      const mod = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      __tabTrackerModule = mod.ExtensionParent?.apiManager?.global?.tabTracker || null;
    } catch (err) {
      console.warn('[bento-shell-mount] ExtensionParent import failed:', err);
    }
    return __tabTrackerModule;
  }

  const WORKSPACE_SESSION_KEY = 'extension:bento-tools@bento.app:bento.workspaceId';

  let sidebarAddressSnapshotToken = 0;
  let sidebarAddressLatestPostedToken = 0;
  let sidebarAddressSnapshotScheduled = false;
  const sidebarAddressBookmarkTogglesInFlight = new Set();

  function readSidebarAddressDisplayUrl(browserEl) {
    try {
      if (window.gURLBar?.untrimmedValue) return String(window.gURLBar.untrimmedValue);
    } catch {
      /* fall through */
    }
    try {
      if (window.gURLBar?.value) return String(window.gURLBar.value);
    } catch {
      /* fall through */
    }
    try {
      return browserEl?.currentURI?.displaySpec || browserEl?.currentURI?.spec || '';
    } catch {
      return '';
    }
  }

  function readSidebarAddressTitle(browserEl) {
    try {
      return browserEl?.contentTitle || window.gBrowser?.selectedTab?.label || '';
    } catch {
      return '';
    }
  }

  function readSidebarAddressSecurity(browserEl) {
    const identityBox = document.getElementById('identity-box');
    const identityIcon = document.getElementById('identity-icon');
    const identityLabel = document.getElementById('identity-icon-label');
    const identityClass = String(identityBox?.className || '');
    const tooltip =
      identityBox?.getAttribute?.('tooltiptext') ||
      identityIcon?.getAttribute?.('tooltiptext') ||
      identityBox?.getAttribute?.('title') ||
      '';
    let label = (identityLabel?.textContent || '').trim();
    let kind = 'unknown';

    if (/verifiedIdentity|verifiedDomain|secure/i.test(identityClass)) {
      kind = /verifiedIdentity/i.test(identityClass) ? 'verified' : 'secure';
      if (!label) label = 'Secure';
    } else if (/mixed|broken/i.test(identityClass)) {
      kind = 'mixed';
      if (!label) label = 'Mixed content';
    } else if (/notSecure|insecure|certError/i.test(identityClass)) {
      kind = 'insecure';
      if (!label) label = 'Not secure';
    }

    if (kind === 'unknown') {
      try {
        const uri = browserEl?.currentURI;
        if (uri?.scheme === 'about' || uri?.scheme === 'chrome') kind = 'internal';
        else if (uri?.scheme === 'moz-extension') kind = 'extension';
        else if (uri?.scheme === 'file') kind = 'local';
      } catch {
        /* keep unknown */
      }
    }

    if (kind === 'unknown') {
      try {
        const state = browserEl?.securityUI?.state || 0;
        if (state & Ci.nsIWebProgressListener.STATE_IS_SECURE) {
          kind = 'secure';
          if (!label) label = 'Secure';
        } else if (state & Ci.nsIWebProgressListener.STATE_IS_BROKEN) {
          kind = 'mixed';
          if (!label) label = 'Mixed content';
        } else if (state & Ci.nsIWebProgressListener.STATE_IS_INSECURE) {
          kind = 'insecure';
          if (!label) label = 'Not secure';
        }
      } catch {
        /* keep unknown */
      }
    }

    if (!label) {
      if (kind === 'internal') label = 'Browser page';
      else if (kind === 'extension') label = 'Extension page';
      else if (kind === 'local') label = 'Local file';
      else label = 'Site information';
    }

    return {
      kind,
      label,
      tooltip: tooltip || label,
      canOpenIdentity: !!window.gIdentityHandler,
    };
  }

  function sidebarAddressPayloadMatchesScope(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const bridgeToken = getBentoSidebarAddressBridgeToken();
    if (!bridgeToken || payload.bridgeToken !== bridgeToken) return false;
    const windowId = getChromeWindowId();
    if (typeof windowId === 'number') return payload.windowId === windowId;
    return payload.windowId === null || payload.windowId === undefined;
  }

  function sidebarAddressPayloadMatchesSelectedTab(payload) {
    if (!sidebarAddressPayloadMatchesScope(payload)) return false;
    if (Number(payload.snapshotToken) !== sidebarAddressLatestPostedToken) return false;
    const activeTabId = getSelectedWebExtensionTabId();
    if (activeTabId !== null && payload.tabId !== activeTabId) return false;
    return sidebarAddressUrlMatchesActiveMain(payload.url);
  }

  async function buildSidebarAddressSnapshot(token, browserEl, tabId, spec) {
    const bookmark = await getRegularBookmarkStateForUrl(spec);
    if (token !== sidebarAddressSnapshotToken) return null;
    if (browserEl !== getActiveMainBrowser()) return null;
    if (normalizeBookmarkUrlSpec(activeMainBrowserSpec()) !== spec) return null;
    return {
      kind: 'snapshot',
      windowId: getChromeWindowId(),
      bridgeToken: getBentoSidebarAddressBridgeToken(),
      messageId: Date.now(),
      snapshotToken: token,
      tabId,
      url: spec,
      displayUrl: readSidebarAddressDisplayUrl(browserEl),
      title: readSidebarAddressTitle(browserEl),
      security: readSidebarAddressSecurity(browserEl),
      bookmark,
      loading: !!window.gBrowser?.selectedTab?.hasAttribute?.('busy'),
    };
  }

  async function emitSidebarAddressSnapshot() {
    const browserEl = getActiveMainBrowser();
    const spec = normalizeBookmarkUrlSpec(activeMainBrowserSpec());
    const token = ++sidebarAddressSnapshotToken;
    if (!browserEl || !spec) {
      sidebarAddressLatestPostedToken = token;
      dispatchSidebarAddressMessage({
        kind: 'snapshot',
        windowId: getChromeWindowId(),
        bridgeToken: getBentoSidebarAddressBridgeToken(),
        messageId: Date.now(),
        snapshotToken: token,
        tabId: getSelectedWebExtensionTabId(),
        url: '',
        displayUrl: '',
        title: '',
        security: readSidebarAddressSecurity(browserEl),
        bookmark: { isBookmarked: false, canBookmark: false },
        loading: false,
      });
      return;
    }
    const snapshot = await buildSidebarAddressSnapshot(
      token,
      browserEl,
      getSelectedWebExtensionTabId(),
      spec,
    );
    if (!snapshot) return;
    sidebarAddressLatestPostedToken = token;
    dispatchSidebarAddressMessage(snapshot);
  }

  function scheduleSidebarAddressSnapshot() {
    if (sidebarAddressSnapshotScheduled) return;
    sidebarAddressSnapshotScheduled = true;
    requestAnimationFrame(() => {
      sidebarAddressSnapshotScheduled = false;
      emitSidebarAddressSnapshot().catch((err) => {
        console.warn('[bento-shell-mount] sidebar address snapshot failed:', err);
      });
    });
  }

  function parseSidebarAddressTitlePayload(rawTitle, prefix) {
    const tail = rawTitle.slice(prefix.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return null;
    try {
      return JSON.parse(decodeAddrbarPayload(tail.slice(colon + 1)));
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address payload parse failed:', err);
      return null;
    }
  }

  async function handleSidebarAddressSubmitTitle(rawTitle) {
    const payload = parseSidebarAddressTitlePayload(rawTitle, SIDEBAR_ADDRESS_SUBMIT_PREFIX);
    if (!sidebarAddressPayloadMatchesScope(payload)) return;
    const value = typeof payload.value === 'string' ? payload.value.trim() : '';
    if (!value) return;
    try {
      await navigateAddressEntry(
        value,
        payload.mode === 'newTab' ? 'newTab' : 'current',
        typeof payload.searchEngineId === 'string' ? payload.searchEngineId : undefined,
      );
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address submit failed:', err);
    } finally {
      scheduleSidebarAddressSnapshot();
    }
  }

  async function handleSidebarAddressBookmarkToggleTitle(rawTitle) {
    const payload = parseSidebarAddressTitlePayload(
      rawTitle,
      SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX,
    );
    const spec = normalizeBookmarkUrlSpec(payload?.url);
    if (
      !spec ||
      !isBookmarkableUrlSpec(spec) ||
      !sidebarAddressPayloadMatchesSelectedTab(payload)
    ) {
      scheduleSidebarAddressSnapshot();
      return;
    }
    const tabId = getSelectedWebExtensionTabId();
    const inflightKey = `${tabId ?? 'unknown'}:${spec}`;
    if (sidebarAddressBookmarkTogglesInFlight.has(inflightKey)) {
      scheduleSidebarAddressSnapshot();
      return;
    }
    sidebarAddressBookmarkTogglesInFlight.add(inflightKey);
    try {
      const PlacesUtils = getPlacesUtils();
      const bookmarks = await getBookmarksForUrl(PlacesUtils, spec);
      const savedPanelsFolderGuid = await getSavedPanelsFolderGuid(PlacesUtils);
      if (!sidebarAddressPayloadMatchesSelectedTab(payload)) return;
      const removableBookmarks = classifyRegularBookmarks(bookmarks, savedPanelsFolderGuid);
      if (removableBookmarks.length > 0) {
        await Promise.all(
          removableBookmarks.map((bookmark) => PlacesUtils.bookmarks.remove(bookmark.guid)),
        );
      } else {
        const browserEl = getActiveMainBrowser();
        let title =
          typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : spec;
        try {
          title = browserEl?.contentTitle || title;
        } catch {
          /* keep payload title */
        }
        if (!sidebarAddressPayloadMatchesSelectedTab(payload)) return;
        await PlacesUtils.bookmarks.insert({
          parentGuid: PlacesUtils.bookmarks.unfiledGuid,
          url: spec,
          title,
        });
      }
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address bookmark toggle failed:', err);
    } finally {
      sidebarAddressBookmarkTogglesInFlight.delete(inflightKey);
      scheduleSidebarAddressSnapshot();
    }
  }

  function writeTextToGlobalClipboard(value) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return false;
    try {
      Cc['@mozilla.org/widget/clipboardhelper;1']
        .getService(Ci.nsIClipboardHelper)
        .copyString(text);
      return true;
    } catch {
      /* fall back to transferable clipboard write */
    }

    const supportsString = Cc['@mozilla.org/supports-string;1'].createInstance(
      Ci.nsISupportsString,
    );
    supportsString.data = text;
    const transferable = Cc['@mozilla.org/widget/transferable;1'].createInstance(
      Ci.nsITransferable,
    );
    transferable.init(window.docShell.QueryInterface(Ci.nsILoadContext));
    transferable.addDataFlavor('text/plain');
    transferable.setTransferData('text/plain', supportsString);
    Services.clipboard.setData(transferable, null, Services.clipboard.kGlobalClipboard);
    return true;
  }

  function handleSidebarAddressCopyTitle(rawTitle) {
    const payload = parseSidebarAddressTitlePayload(rawTitle, SIDEBAR_ADDRESS_COPY_PREFIX);
    if (!sidebarAddressPayloadMatchesSelectedTab(payload)) return;
    const spec = normalizeBookmarkUrlSpec(payload?.url);
    if (!spec) return;
    try {
      if (!writeTextToGlobalClipboard(spec)) return;
      dispatchSidebarAddressMessage({
        kind: 'copy-result',
        windowId: getChromeWindowId(),
        bridgeToken: getBentoSidebarAddressBridgeToken(),
        messageId: Date.now(),
        tabId: typeof payload.tabId === 'number' ? payload.tabId : null,
        url: spec,
        snapshotToken: Number(payload.snapshotToken),
        success: true,
      });
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address copy failed:', err);
    }
  }

  function ensureSidebarIdentityAnchor(anchorRect) {
    const shellFrame = document.getElementById('bento-shell-frame');
    const shellRect = shellFrame?.getBoundingClientRect();
    if (!shellRect || !anchorRect) return null;
    let anchor = document.getElementById('bento-sidebar-address-identity-anchor');
    if (!anchor) {
      anchor = document.createElementNS(HTML_NS, 'span');
      anchor.id = 'bento-sidebar-address-identity-anchor';
      anchor.setAttribute('aria-hidden', 'true');
      document.documentElement.appendChild(anchor);
    }
    const left = shellRect.left + Number(anchorRect.left || 0);
    const top = shellRect.top + Number(anchorRect.top || 0);
    const width = Math.max(1, Number(anchorRect.width || 1));
    const height = Math.max(1, Number(anchorRect.height || 1));
    anchor.style.cssText =
      'position: fixed; pointer-events: none; z-index: 2147483647; left: ' +
      Math.round(left) +
      'px; top: ' +
      Math.round(top) +
      'px; width: ' +
      Math.round(width) +
      'px; height: ' +
      Math.round(height) +
      'px;';
    return anchor;
  }

  function openNativeIdentityPopupForSidebar(anchorRect) {
    const handler = window.gIdentityHandler;
    if (!handler || typeof window.PanelMultiView?.openPopup !== 'function') return false;
    const anchor = ensureSidebarIdentityAnchor(anchorRect);
    if (!anchor) return false;
    try {
      handler._initializePopup?.();
      handler.refreshIdentityPopup?.();
      for (const panel of Array.from(document.querySelectorAll('panel[openpanel]'))) {
        PanelMultiView.hidePopup(panel);
      }
      const popup = handler._identityPopup || document.getElementById('identity-popup');
      if (!popup) return false;
      popup.addEventListener('popuphidden', () => anchor.remove(), { once: true });
      PanelMultiView.openPopup(popup, anchor, {
        position: 'bottomleft topleft',
        triggerEvent: null,
      }).catch(console.error);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar identity popup failed:', err);
      anchor.remove();
      return false;
    }
  }

  function handleSidebarAddressIdentityTitle(rawTitle) {
    const payload = parseSidebarAddressTitlePayload(rawTitle, SIDEBAR_ADDRESS_IDENTITY_PREFIX);
    if (!sidebarAddressPayloadMatchesSelectedTab(payload)) return;
    openNativeIdentityPopupForSidebar(payload.anchorRect);
  }

  function attachSidebarAddressSnapshotListeners() {
    document.documentElement.setAttribute('bento-sidebar-addressbar', 'true');
    scheduleSidebarAddressSnapshot();

    window.addEventListener('TabSelect', scheduleSidebarAddressSnapshot, true);
    window.addEventListener('TabAttrModified', scheduleSidebarAddressSnapshot, true);
    window.addEventListener('SSTabRestored', scheduleSidebarAddressSnapshot, true);

    try {
      window.gBrowser?.addTabsProgressListener?.({
        onLocationChange(browser) {
          if (browser === window.gBrowser?.selectedBrowser) scheduleSidebarAddressSnapshot();
        },
        onSecurityChange(browser) {
          if (browser === window.gBrowser?.selectedBrowser) scheduleSidebarAddressSnapshot();
        },
        onStateChange(browser) {
          if (browser === window.gBrowser?.selectedBrowser) scheduleSidebarAddressSnapshot();
        },
      });
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address progress listener failed:', err);
    }

    try {
      const PlacesUtils = getPlacesUtils();
      PlacesUtils.observers.addListener(
        ['bookmark-added', 'bookmark-removed', 'bookmark-moved', 'bookmark-url-changed'],
        scheduleSidebarAddressSnapshot,
      );
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address Places listener failed:', err);
    }
  }

  function workspaceTabsInOrder() {
    if (!window.gBrowser || !currentWorkspaceId) return [];
    const SessionStore = getSessionStore();
    if (!SessionStore) return [];
    const tabTracker = getTabTracker();
    const out = [];
    for (const tab of window.gBrowser.tabs) {
      if (tab.hidden || tab.closing) continue;
      let wsValue = null;
      try {
        const raw = SessionStore.getCustomTabValue(tab, WORKSPACE_SESSION_KEY);
        if (raw) wsValue = JSON.parse(raw);
      } catch {
        /* tab without value, treat as null */
      }
      if (wsValue !== currentWorkspaceId) continue;
      // Exclude tabs that are pinned as side panels — they don't appear
      // in the sidebar's tab list, so Cmd+N shouldn't index them either.
      if (tabTracker && currentPanelTabIds.size > 0) {
        let webExtId = null;
        try {
          webExtId = tabTracker.getId(tab);
        } catch {
          /* tabTracker may transiently not know about a tab; treat as not-a-panel */
        }
        if (webExtId !== null && currentPanelTabIds.has(webExtId)) continue;
      }
      out.push(tab);
    }
    return out;
  }

  function attachWorkspaceTabSwitchKeybinding() {
    window.addEventListener(
      'keydown',
      (e) => {
        const accel = navigator.platform.toLowerCase().includes('mac') ? e.metaKey : e.ctrlKey;
        if (!accel || e.altKey || e.shiftKey) return;
        // Match physical Digit1..Digit9 (not Digit0). e.code is layout-
        // independent so this works with non-QWERTY layouts.
        if (!e.code.startsWith('Digit')) return;
        const n = parseInt(e.code.slice(5), 10);
        if (!Number.isInteger(n) || n < 1 || n > 9) return;
        // No active workspace yet — let Firefox's default Cmd+N tab
        // switch fire so the user isn't stranded with a no-op shortcut
        // before bento-tools has connected.
        if (!currentWorkspaceId) return;
        const tabs = workspaceTabsInOrder();
        const target = tabs[n - 1];
        if (!target) {
          // Workspace has fewer than N visible tabs. Suppress the
          // default to avoid jumping into a different workspace's tab,
          // which is the behaviour the user complained about.
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        try {
          window.gBrowser.selectedTab = target;
        } catch (err) {
          console.warn('[bento-shell-mount] workspace Cmd+N: selectedTab assign failed:', err);
        }
      },
      true,
    );
  }

  // ─── Dev-reload glue ────────────────────────────────────────────────────

  // browser.runtime.reload() (Alt+Shift+R) restarts the addon but the
  // ─── Per-panel accelerator retargeting (Phase 4a) ─────────────────────
  // When DOM focus is on a Bento panel container (or an element inside
  // one), redirect Cmd+R / Cmd+Shift+R / Cmd+L to act on that panel's
  // browser instead of gBrowser.selectedTab. Falls through to Firefox's
  // default behaviour when focus is not on a panel.
  //
  // Known limitation: works for chrome-side focus only (cycle-focused
  // panel container, panel header buttons, panel URL input). When the
  // user has clicked into a panel's web content, focus is in the child
  // process and our chrome window keydown listener doesn't see Cmd+R
  // — Firefox's XUL keyset binds Cmd+R to Browser:Reload, which acts
  // on selectedTab. Fixing this needs the JSWindowActor bridge queued
  // for Phase 4c (see plans/bento-spaces-split-view-panels.md
  // "Content-key bridge"). Cmd+F / Cmd+G also deferred to that phase
  // because the existing find toolbar is per-tabbox and switching
  // selectedTab to invoke it would defeat the cycle-focus model.
  //
  // panelEl is found by walking up from document.activeElement to the
  // closest element with data-bento-main-panel, data-bento-panel-tab-id,
  // or data-bento-subpanel (stamped on each panel container by the
  // reconciler/subdivision wrapper).
  function getFocusedPanelInfo() {
    const active = document.activeElement;
    if (!active || typeof active.closest !== 'function') return null;
    const panelEl = active.closest(
      '[data-bento-main-panel], [data-bento-panel-tab-id], [data-bento-subpanel]',
    );
    if (!panelEl) return null;
    const browserEl = panelEl.querySelector('browser');
    if (!browserEl) return null;
    const urlInput = panelEl.querySelector('.bento-panel-header-url');
    return { panelEl, browserEl, urlInput };
  }

  function attachPanelAcceleratorListener() {
    window.addEventListener(
      'keydown',
      (e) => {
        // Match macOS-only for now (Cmd). Linux/Windows would use Ctrl;
        // can extend when Bento ships there. Skip if any other modifier
        // is held that would change semantics.
        if (!e.metaKey || e.altKey || e.ctrlKey) return;

        const key = e.key.toLowerCase();

        // Cmd+R / Cmd+Shift+R: reload focused panel
        if (key === 'r') {
          const info = getFocusedPanelInfo();
          if (!info) return;
          try {
            if (e.shiftKey) {
              const flags =
                Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE |
                Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY;
              reloadPanelBrowser(info.browserEl, info.panelEl, null, flags);
            } else {
              reloadPanelBrowser(info.browserEl, info.panelEl, null);
            }
            e.preventDefault();
            e.stopPropagation();
          } catch (err) {
            console.warn('[bento-shell-mount] panel Cmd+R retarget failed:', err);
          }
          return;
        }

        // Cmd+L: focus + select the focused panel's URL input. Cmd+
        // Shift+L is a different shortcut (downloads / library) — let
        // it fall through.
        if (key === 'l' && !e.shiftKey) {
          const info = getFocusedPanelInfo();
          if (!info?.urlInput) return;
          try {
            info.urlInput.focus();
            info.urlInput.select();
            e.preventDefault();
            e.stopPropagation();
          } catch (err) {
            console.warn('[bento-shell-mount] panel Cmd+L retarget failed:', err);
          }
        }
      },
      { capture: true },
    );
  }

  // chrome-mounted <browser> elements keep their old contentDocuments —
  // Firefox auto-reloads moz-extension:// in normal tabs but not in chrome-
  // hosted browser elements. Listen for reload events and reload both
  // frames against the new policy.
  function attachReloadListener() {
    const { AddonManager } = ChromeUtils.importESModule(
      'resource://gre/modules/AddonManager.sys.mjs',
    );
    AddonManager.addAddonListener({
      onEnabled(addon) {
        if (addon.id !== ADDON_ID) return;
        reloadFrames();
      },
    });

    function reloadFrames() {
      // Brief delay so the new addon's WebExtensionPolicy is registered
      // before we ask the <browser>s to refetch. setAttribute with the same
      // URL is a no-op for chrome <browser>, so we use reloadWithFlags to
      // force a fresh fetch and bypass any cached dist/ assets.
      setTimeout(() => {
        const ids = [
          'bento-shell-frame',
          'bento-palette-frame',
          'bento-workspace-palette-frame',
          'bento-merge-palette-frame',
          'bento-addrbar-frame',
          'bento-confirm-frame',
          'bento-edit-workspace-frame',
          'bento-welcome-frame',
          'bento-workspace-switcher-frame',
          'bento-menu-frame',
          'bento-panel-navigator-tooltip-frame',
          'bento-panel-trailer-frame',
        ];
        for (const id of ids) {
          const frame = document.getElementById(id);
          if (!frame) continue;
          try {
            frame.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
          } catch (e) {
            console.warn('[bento-shell-mount] reloadWithFlags failed for', id, e);
            frame.removeAttribute('src');
            if (id === 'bento-shell-frame') setBentoShellSrc();
            else if (id === 'bento-palette-frame') setBentoPaletteSrc();
            else if (id === 'bento-workspace-palette-frame') setBentoWorkspacePaletteSrc();
            else if (id === 'bento-merge-palette-frame') setBentoMergePaletteSrc();
            else if (id === 'bento-addrbar-frame') setBentoAddrbarSrc();
            else if (id === 'bento-confirm-frame') setBentoConfirmSrc();
            else if (id === 'bento-edit-workspace-frame') setBentoEditWorkspaceSrc();
            else if (id === 'bento-welcome-frame') setBentoWelcomeSrc();
            else if (id === 'bento-workspace-switcher-frame') setBentoWorkspaceSwitcherSrc();
            else if (id === 'bento-menu-frame') setBentoMenuSrc();
            else if (id === 'bento-panel-navigator-tooltip-frame')
              setBentoPanelNavigatorTooltipSrc();
            else if (id === 'bento-panel-trailer-frame') setBentoPanelTrailerSrc();
          }
        }
      }, 100);
    }
  }

  // The previous "side panel URL bar binding" (chrome URL bar mirrors +
  // navigates the focused side panel) has been replaced by per-panel
  // headers — each panel's compact urlbar is the canonical place to
  // navigate that panel. The chrome's main URL bar always reflects the
  // active main tab as Firefox normally would.

  setBentoShellSrc();
  setBentoPaletteSrc();
  setBentoWorkspacePaletteSrc();
  setBentoMergePaletteSrc();
  setBentoAddrbarSrc();
  setBentoConfirmSrc();
  setBentoEditWorkspaceSrc();
  setBentoWelcomeSrc();
  setBentoWorkspaceSwitcherSrc();
  setBentoMenuSrc();
  setBentoPanelNavigatorTooltipSrc();
  // Strip the patch's pre-baked single panel browser and configure the
  // host as a horizontal flex strip. Done at script execution time so
  // the strip is ready by the first reconcilePanels(). Wrapped in
  // DOMContentLoaded fallback for the same reason as the URL bar
  // binding — the side panel host is in a patch that inserts after
  // the script tag.
  function configureSidePanelOnce() {
    const host = document.getElementById('bento-side-panel-host');
    const main = document.getElementById('tabbrowser-tabbox');
    if (!host || !main) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, configureSidePanelOnce, { once: true });
      }
      return;
    }
    configureSidePanelStrip();
    normalizeInitialSidebarWidth();
    unifyMainWithStrip();
    setupPanelNavigator();
    attachSidebarSplitterFeedback();
    attachHiddenSidebarHoverZone();
    attachNativeSidebarSplitterFeedback();
    attachSidebarChromeDivider();
    attachToolbarNavigationAlignment();
    attachBookmarksToolbarAlignment();
    // Initial reconcile with no side panels — primes the strip into
    // a clean baseline state so the first panels/sync from bento-tools
    // can replace it with the real panel list. refreshPanelNav inside
    // reconcilePanels also populates the navigator with the main-panel
    // favicon.
    reconcilePanels([]);
  }

  // After macOS live resize, some content pages can keep the pre-resize
  // layout viewport until the browser is deactivated/reactivated. Run the
  // poke only after the resize gesture settles, so live resize stays cheap.
  function repaintSelectedBrowserAfterWindowResize() {
    try {
      if (!refreshFlatPanelLayoutFromLiveState()) {
        syncInterPanelSplitters();
        updateFlatLayoutOverlayPositions(window.gBrowser?.tabpanels, currentPanelLayoutGeometry);
        updateStripScrollbar();
      }
    } catch (err) {
      console.warn('[bento-shell-mount] settled resize layout sync failed:', err);
    }

    const browserEl = window.gBrowser?.selectedTab?.linkedBrowser;
    if (!browserEl) return;
    try {
      browserEl.preserveLayers?.(true);
      browserEl.renderLayers = true;
      browserEl.docShellIsActive = false;
      browserEl.docShellIsActive = true;
    } catch (err) {
      console.warn('[bento-shell-mount] settled resize repaint failed:', err);
    }
  }

  function attachWindowResizePerfMode() {
    const root = document.documentElement;
    let timer = null;
    window.addEventListener('resize', () => {
      if (root.getAttribute('bento-window-resizing') !== 'true') {
        root.setAttribute('bento-window-resizing', 'true');
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        root.removeAttribute('bento-window-resizing');
        window.dispatchEvent(new CustomEvent(BENTO_RESIZE_SETTLED_EVENT));
        requestAnimationFrame(() => requestAnimationFrame(repaintSelectedBrowserAfterWindowResize));
      }, 300);
    });
  }

  // Content-key bridge — register the BentoKey JSWindowActor pair
  // (BentoKeyChild + BentoKeyParent in the same content directory)
  // ONCE per process. Without this, panel cycling
  // (Cmd/Ctrl+Shift+Left/Right) only
  // works while focus is on the chrome panel container, which keeps
  // content from receiving any keys — breaking page-bound keyboard
  // extensions (Vimium j/k, Surfingkeys, etc.) inside panels.
  //
  // The child listens for keydowns inside content, forwards Bento-
  // bound keys to the parent (which dispatches a CustomEvent on this
  // chrome window — see attachContentKeyBridgeListener below). All
  // other keys pass through naturally so extensions still work.
  //
  // registerWindowActor is process-wide — the second window's
  // bento-shell-mount.js boot would throw NS_ERROR_NOT_AVAILABLE
  // because the actor is already registered. Guard idempotently.
  function registerContentKeyActor() {
    try {
      ChromeUtils.registerWindowActor('BentoKey', {
        parent: { esModuleURI: 'resource:///actors/BentoKeyParent.sys.mjs' },
        child: {
          esModuleURI: 'resource:///actors/BentoKeyChild.sys.mjs',
          events: { keydown: { capture: true } },
        },
        allFrames: true,
        // *://*/* covers http(s)/ws(s); file:/// covers local files;
        // moz-extension://*/* covers Bento's own in-panel pages (settings,
        // privacy dashboard); about:newtab is where new panels land (see
        // addNewPanel); about:blank is the transient marker URL panels sit
        // at before the navigate-away setTimeout fires. Without these the
        // actor doesn't attach inside the panel's <browser>, and since the
        // chrome-side keydown handler bails when activeElement is <browser>
        // (delegating to the actor), shortcut cycling appears to "stop"
        // whenever the focused panel is on one of these URLs.
        matches: ['*://*/*', 'file:///*', 'moz-extension://*/*', 'about:newtab', 'about:blank'],
      });
    } catch (err) {
      // NS_ERROR_NOT_AVAILABLE = already registered (second window).
      if (!String(err).includes('NS_ERROR_NOT_AVAILABLE')) {
        console.warn('[bento-shell-mount] registerContentKeyActor failed:', err);
      }
    }
  }

  // Listen for the CustomEvent dispatched by BentoKeyParent.
  // navigatePanels is closure-private, so the actor can't call it
  // directly — the event is the bridge.
  function attachContentKeyBridgeListener() {
    window.addEventListener('BentoKey:Cycle', (e) => {
      const dir = e?.detail?.direction;
      if (dir !== 1 && dir !== -1) return;
      navigatePanels(dir);
    });
    window.addEventListener('BentoKey:PanelHistory', (e) => {
      const dir = e?.detail?.direction;
      if (dir !== 1 && dir !== -1) return;
      navigateFocusedPanelHistory(dir);
    });
    window.addEventListener('BentoKey:AddrbarOpen', (e) => {
      openAddressEntry(e?.detail?.mode === 'newTab' ? 'newTab' : 'current');
    });
  }

  // Click-into-panel needs to update currentActiveIdx so a subsequent
  // ←/→ arrow advances from the clicked panel, not from the last
  // explicitly-cycled one. Without this, the cycle index drifts away
  // from the user's actual focus and the next arrow press lands at
  // an unexpected slot.
  //
  // Capture-phase focus listener at the chrome window picks up focus
  // changes on the panel's <browser> element (when content gains
  // focus the chrome activeElement is the browser, whose closest()
  // walks up to the panel container). The cycle focus indicator
  // moves to the clicked panel too, so a fast click during the
  // previous panel's fade-out doesn't leave the ring stranded on
  // the wrong slot.
  function attachPanelFocusTracker() {
    window.addEventListener(
      'focus',
      (e) => {
        const target = e.target;
        if (!target || typeof target.closest !== 'function') return;
        if (target.closest('#bento-add-panel-trailer')) return;
        const container = target.closest(
          '.bento-subdivision-chooser, [data-bento-subpanel], [data-bento-panel-tab-id], [data-bento-main-panel]',
        );
        if (!container) return;
        const idx = getCycleIndexForPanelElement(container);
        if (idx < 0) return;
        if (idx !== currentActiveIdx) {
          currentActiveIdx = idx;
          applyPanelFocusIndicator(idx);
        }
        applyFocusedPanelIndicator(container);
      },
      true,
    );
  }

  // PopupNotifications gates "show this popup right now" on
  // _isActiveBrowser, which compares the popup's browser against
  // gBrowser.selectedBrowser. For Bento panels the panel's tab is
  // never the selected tab — the main tab is — so popups
  // originating in a panel (e.g. AMO's "Add to Firefox"
  // permissions confirmation) get queued and never shown.
  //
  // Extend _isActiveBrowser to also accept any browser whose tab
  // is in gBrowser.activeSplitView.tabs (the same set that
  // splitViewBrowsers / shouldDeactivateDocShell respects), so
  // panel-originated popups display immediately. Anchor follows
  // the standard unified-extensions-button on the navbar — the
  // popup hangs off there, visible to the user even when the
  // origin tab isn't selectedTab.
  function patchPopupNotificationsForSplitView() {
    // window.PopupNotifications is a lazy getter — touching it
    // before browser.js has wired up gBrowser (and the PopupNotifications
    // constructor's tabbrowser argument) throws "Invalid tabbrowser".
    // Defer until window load, when browser.js has finished init
    // and the lazy getter resolves to a real instance.
    const apply = () => {
      const pn = window.PopupNotifications;
      if (!pn || pn.__bentoSplitViewPatched) return;
      pn.__bentoSplitViewPatched = true;
      const original = pn._isActiveBrowser;
      pn._isActiveBrowser = function (browser) {
        if (original.call(this, browser)) return true;
        const split = window.gBrowser?.activeSplitView;
        if (split?.tabs) {
          for (const tab of split.tabs) {
            if (tab?.linkedBrowser?.frameLoader === browser?.frameLoader) {
              return true;
            }
          }
        }
        return false;
      };
    };
    if (document.readyState === 'complete') {
      apply();
    } else {
      window.addEventListener('load', apply, { once: true });
    }
  }

  // ExtensionsUI subscribes to webextension-permission-prompt and
  // related topics in its init() method (called by BrowserGlue at
  // window startup). In some persistent-dev-profile situations
  // those subscriptions don't get registered — observed
  // empirically: enumerateObservers('webextension-permission-prompt')
  // returns 0 entries even though ExtensionsUI is loaded.
  // Symptom: AMO "Add to Firefox" downloads the addon, the install
  // reaches STATE_DOWNLOADED, then hangs forever because no one's
  // listening to dispatch the permissions popup.
  //
  // Defensively re-subscribe at chrome boot. Identity-checks each
  // topic's observer list before adding so we don't double-subscribe
  // (which would fire ExtensionsUI.observe twice per event) in
  // profiles where the wiring is already correct.
  function ensureExtensionsUIObservers() {
    const apply = () => {
      try {
        const { ExtensionsUI } = ChromeUtils.importESModule(
          'resource:///modules/ExtensionsUI.sys.mjs',
        );
        const topics = [
          'webextension-permission-prompt',
          'webextension-update-permission-prompt',
          'webextension-optional-permission-prompt',
          'webextension-defaultsearch-prompt',
        ];
        for (const topic of topics) {
          let already = false;
          const enums = Services.obs.enumerateObservers(topic);
          while (enums.hasMoreElements()) {
            if (enums.getNext() === ExtensionsUI) {
              already = true;
              break;
            }
          }
          if (!already) {
            Services.obs.addObserver(ExtensionsUI, topic);
          }
        }
      } catch (err) {
        console.warn('[bento-shell-mount] ensureExtensionsUIObservers failed:', err);
      }
    };
    if (document.readyState === 'complete') {
      apply();
    } else {
      window.addEventListener('load', apply, { once: true });
    }
  }

  configureSidePanelOnce();
  attachReloadListener();
  attachAddrbarKeybinding();
  attachAddrbarOutsideDismissListener();
  attachTopUrlbarModalListener();
  attachSidebarAddressSnapshotListeners();
  attachPaletteKeybinding();
  attachPaletteEscListener();
  attachPaletteCloseListener();
  attachWorkspaceTabSwitchKeybinding();
  attachTabSelectListener();
  attachPanelAcceleratorListener();
  attachWindowResizePerfMode();
  registerContentKeyActor();
  attachContentKeyBridgeListener();
  attachPanelFocusTracker();
  patchPopupNotificationsForSplitView();
  ensureExtensionsUIObservers();
})();
