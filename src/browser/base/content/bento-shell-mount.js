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
  const { PrivateBrowsingUtils: BentoPrivateBrowsingUtils } = ChromeUtils.importESModule(
    'resource://gre/modules/PrivateBrowsingUtils.sys.mjs',
  );
  const BENTO_PANEL_NEWTAB_PATH = '/dist/panel-newtab.html';
  const BENTO_WELCOME_STEP_ENV = 'BENTO_WELCOME_STEP';
  // Current post-import onboarding step (the Privacy step, index 4 in
  // WELCOME_STEPS). The welcome page also includes the exact next step in its
  // title signal; this is only a compatibility fallback.
  const BENTO_WELCOME_POST_IMPORT_STEP = '4';
  const BENTO_WELCOME_RESUME_HASH_KEY = 'bentoWelcomeStep';
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

  // ─── Motion timing ─────────────────────────────────────────────────────
  // CSS owns every duration (the Mux --muxui-semantic-motion-* tokens). Script that
  // has to act when motion ends reads the time from the element's computed style
  // through measureMotion and afterMotion instead of mirroring a number. The shell has
  // the same pair in extensions/bento-shell/src/motion/afterMotion.ts; keep them in step.
  const MOTION_SLACK_MS = 50; // added to a measured time before the timer fallback fires
  const MOTION_UNAVAILABLE_CEILING_MS = 1000; // wait for an element with no computed style
  const motionWaits = new WeakMap(); // element -> Map<key, cancel>

  function motionList(value) {
    return String(value ?? '')
      .split(',')
      .map((part) => part.trim());
  }

  // Computed times are '<number>s' or '<number>ms'; anything else counts as 0.
  function motionTimeMs(text) {
    const match = /^(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(ms|s)$/i.exec(text ?? '');
    if (!match) return 0;
    return Number(match[1]) * (match[2].toLowerCase() === 's' ? 1000 : 1);
  }

  // Longest time the transitions and animations on 'el' that match 'filter'
  // ({ properties, animations }) take: delay plus duration, times the iteration
  // count for an animation. Repeated duration and delay lists are expanded to the
  // number of properties or names. An infinite animation never ends and is skipped.
  // A requested property takes its timing from the LAST transition-property entry
  // that names it, explicitly or through 'all' (CSS Transitions), so 'all, opacity'
  // with '0.2s, 0s' measures 0 for opacity; without a property filter each entry
  // that no later entry overrides counts on its own.
  // Call it after the styles that start the motion are applied. Returns
  // { ms, ending } with ending the 't:<property>' / 'a:<name>' entries that end
  // last (requested properties only when filtered; ms 0 means nothing runs, which
  // is a valid answer), or null when the element has no computed style
  // (disconnected). display:none still reports its configured times.
  function measureMotion(el, filter = {}) {
    const view = el?.ownerDocument?.defaultView;
    if (!el || el.isConnected === false || !view) return null;
    const style = view.getComputedStyle(el);
    if (!style || (style.transitionDuration === '' && style.animationDuration === '')) {
      return null;
    }
    let ms = 0;
    let ending = new Set();
    const note = (entry, end) => {
      if (end > ms) {
        ms = end;
        ending = new Set([entry]);
      } else if (end === ms && end > 0) {
        ending.add(entry);
      }
    };
    const properties = motionList(style.transitionProperty);
    const durations = motionList(style.transitionDuration);
    const delays = motionList(style.transitionDelay);
    const noteTransition = (property, i) =>
      note(
        't:' + property,
        motionTimeMs(durations[i % durations.length]) + motionTimeMs(delays[i % delays.length]),
      );
    const lastEntryFor = (property) => {
      let last = -1;
      properties.forEach((entry, i) => {
        if (entry === 'all' || entry === property) last = i;
      });
      return last;
    };
    if (filter.properties) {
      for (const property of filter.properties) {
        const i = lastEntryFor(property);
        if (i !== -1) noteTransition(property, i);
      }
    } else {
      properties.forEach((property, i) => {
        if (property === 'none' || property === '' || lastEntryFor(property) !== i) return;
        noteTransition(property, i);
      });
    }
    const names = motionList(style.animationName);
    const animationDurations = motionList(style.animationDuration);
    const animationDelays = motionList(style.animationDelay);
    const counts = motionList(style.animationIterationCount);
    names.forEach((name, i) => {
      if (name === 'none' || name === '') return;
      if (filter.animations && !filter.animations.includes(name)) return;
      const count = counts[i % counts.length];
      if (count === 'infinite') return;
      const iterations = Number(count);
      note(
        'a:' + name,
        motionTimeMs(animationDelays[i % animationDelays.length]) +
          motionTimeMs(animationDurations[i % animationDurations.length]) *
            (Number.isFinite(iterations) ? iterations : 1),
      );
    });
    return { ms, ending };
  }

  // Aborts the wait started for (el, key), with its timer and listeners.
  function cancelMotion(el, key) {
    if (!el) return;
    motionWaits.get(el)?.get(key)?.();
  }

  // Runs 'done' once when the motion on 'el' that matches 'filter' has finished.
  // Nothing to wait for (0 ms) runs it now. Otherwise the wait ends on the end
  // event of whatever finishes last, or on a timer a little after the measured
  // time; an element with no computed style waits for the fallback ceiling. 'done'
  // runs at most once. A later wait with the same 'key' on the same element, and
  // cancelMotion(el, key), drop the earlier one; call it when the element is shown
  // again or the motion is interrupted. Returns the cancel function.
  function afterMotion(el, key, filter, done) {
    cancelMotion(el, key);
    const measured = measureMotion(el, filter);
    if (measured && measured.ms === 0) {
      done();
      return () => {};
    }
    let waits = motionWaits.get(el);
    if (!waits) {
      waits = new Map();
      motionWaits.set(el, waits);
    }
    let finished = false;
    let timer = null;
    const stop = () => {
      clearTimeout(timer);
      el.removeEventListener('transitionend', onEnd);
      el.removeEventListener('animationend', onEnd);
      if (waits.get(key) === cancel) waits.delete(key);
    };
    const cancel = () => {
      finished = true;
      stop();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      stop();
      done();
    };
    const onEnd = (event) => {
      if (event.target !== el || !measured) return;
      // With a property filter 'ending' names requested properties only, so an
      // unrelated property's transitionend never finishes the wait.
      const ends =
        event.type === 'transitionend'
          ? measured.ending.has('t:' + event.propertyName) ||
            (!filter.properties && measured.ending.has('t:all'))
          : measured.ending.has('a:' + event.animationName);
      if (ends) finish();
    };
    waits.set(key, cancel);
    timer = setTimeout(
      finish,
      measured ? measured.ms + MOTION_SLACK_MS : MOTION_UNAVAILABLE_CEILING_MS,
    );
    if (measured) {
      el.addEventListener('transitionend', onEnd);
      el.addEventListener('animationend', onEnd);
    }
    return cancel;
  }

  // The value of a motion token as ms, for a window that has to outlast CSS
  // transitions that are switched off while it runs (so they cannot be measured).
  function motionTokenMs(name) {
    return motionTimeMs(
      window.getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
    );
  }

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

  // @bento-firefox-compat:begin
  // Runtime half of the firefox-compat check; scripts/firefox-compat-registry.mjs
  // holds the use, sites and locators, and a test keeps this list equal to its
  // runtime entries. After delayed startup each window probes the list once and
  // logs '[bento-compat] missing <id>'. The probe is passive: it reads
  // descriptors, never calls an accessor. A member anywhere on the prototype
  // chain is present; a lazy-accessor owner is deferred, and a module is imported
  // only if Cu.isESModuleLoaded. It sits above the patch sites (they call
  // bentoCompatNoteNative); window.BentoFirefoxCompat.check() re-runs it.
  const BENTO_COMPAT_PROBES = {
    // owner: members. 'name()' is a method (a function when a data property);
    // the rest need only exist, accessors included. '' is the window.
    members: {
      gBrowser: [
        'on_visibilitychange()', '_endRemoveTab()', '_findTabToBlurTo()',
        'insertBrowser()', 'showSplitViewPanels()', 'activeSplitView', 'on_TabSplitViewActivate()',
        'on_TabSplitViewDeactivate()', 'warmupTab()', 'tabpanels', 'tabContainer', 'addTrustedTab()',
        'addTab()', 'getTabForBrowser()', 'selectedBrowsers', 'moveTabBefore()', 'moveTabAfter()',
        'replaceTabWithWindow()', 'replaceTabsWithWindow()', 'adoptTab()', 'discardBrowser()',
      ],
      MozTabbrowserTab: ['isEmpty', 'splitview', 'linkedPanel'],
      'MozBrowser.prototype': [
        'removeProgressListener()', 'docShellIsActive', 'renderLayers', 'preserveLayers()',
        'messageManager', 'contentTitle', 'getInPermitUnload()',
      ],
      'gBrowser.tabpanels': ['splitViewPanels', 'removeTabsFromSplitview()', 'handleEvent()'],
      PopupNotifications: ['_isActiveBrowser()'],
      PanelUI: ['ensureReady()', 'panel', 'show()', 'hide()', '_ensureShortcutsShown()'],
      PanelMultiView: ['openPopup()', 'hidePopup()'],
      DownloadsButton: ['getAnchor()', 'releaseAnchor()'],
      DownloadsPanel: ['initialize()', 'panel', 'isPanelShowing', 'showPanel()', '_focusPanel()'],
      DownloadsView: ['loading', '_visibleViewItems'],
      PrivateDownloadsSubview: ['openWhenReady()'],
      gIdentityHandler: ['_initializePopup()', '_identityPopup', 'refreshIdentityPopup()'],
      gDialogBox: ['isOpen'],
      'FrameLoader.prototype': ['requestTabStateFlush()'],
      gURLBar: ['view', 'untrimmedValue', 'value'],
      'gURLBar.view': ['close()'],
      '': ['OpenBrowserWindow()'],
      'Element.prototype': ['moveBefore()'],
      PlacesUIUtils: ['lastContextMenuTriggerNode'],
    },
    // ids Bento shadows on the instance: looked up on the prototype
    proto: ['MozTabbrowserTab.splitview', 'gBrowser.tabpanels.splitViewPanels'],
    // ids in the browser window (identity-popup waits in a template, so no)
    elements: [
      'browser', 'tabbrowser-tabbox', 'sidebar', 'sidebar-box', 'sidebar-splitter', 'navigator-toolbox',
      'nav-bar', 'nav-bar-customization-target', 'urlbar', 'identity-box', 'identity-icon',
      'identity-icon-label', 'PersonalToolbar', 'mainPopupSet', 'contentAreaContextMenu',
      'placesContext',
    ],
    // module URL: the export it must have
    modules: {
      'moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs': 'UrlbarUtils',
      'chrome://browser/content/urlbar/UrlbarShared.mjs': 'UrlbarShared',
      'moz-src:///toolkit/components/search/SearchService.sys.mjs': 'SearchService',
      'moz-src:///toolkit/components/search/SearchUtils.sys.mjs': 'SearchUtils',
      'resource:///modules/MigrationUtils.sys.mjs': 'MigrationUtils',
      'resource:///modules/FirefoxProfileMigrator.sys.mjs': 'FirefoxProfileMigrator',
      'resource:///modules/ExtensionsUI.sys.mjs': 'ExtensionsUI',
      'moz-src:///browser/components/sessionstore/SessionStore.sys.mjs': 'SessionStore',
      'moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs': 'SessionSaver',
      'resource://gre/modules/Extension.sys.mjs': 'Management',
      'resource://gre/modules/ExtensionParent.sys.mjs': 'ExtensionParent',
      'resource://gre/modules/Timer.sys.mjs': 'setTimeout',
      'chrome://devtools-startup/content/DevToolsShim.sys.mjs': 'DevToolsShim',
    },
    // members that need more than the owner path
    custom: {
      delayedStartupPromise: (win) =>
        bentoCompatHas(win, 'delayedStartupPromise', (p) => typeof bentoCompatData(p, 'then') === 'function'),
      'MozBrowser.mIconURL': (win) => bentoCompatHas(win.document?.querySelector('browser'), 'mIconURL'),
    },
    // a global assigned by a script that another global's getter loads
    gate: { PrivateDownloadsSubview: 'DownloadsPanel' },
  };
  // Owners that are not window globals, found by native calls.
  const BENTO_COMPAT_ROOTS = {
    MozBrowser: (win) => win.customElements?.get('browser'),
    MozTabbrowserTab: (win) => win.document?.querySelector('.tabbrowser-tab[selected]'),
  };
  // Patch sites record Firefox's original member here (id -> value) before
  // replacing it, so the probe judges Firefox's member, not Bento's wrapper.
  const BENTO_COMPAT_NATIVE = new Map();

  function bentoCompatNoteNative(id, native) {
    BENTO_COMPAT_NATIVE.set(id, native);
  }

  function bentoCompatEntries() {
    const probes = BENTO_COMPAT_PROBES;
    const entries = [];
    for (const [owner, names] of Object.entries(probes.members)) {
      for (const name of names) {
        const method = name.endsWith('()');
        const member = method ? name.slice(0, -2) : name;
        entries.push({ id: owner ? `${owner}.${member}` : member, kind: method ? 'method' : 'member' });
      }
    }
    probes.elements.forEach((id) => entries.push({ id, kind: 'element' }));
    Object.entries(probes.modules).forEach(([id, exported]) => {
      entries.push({ id, kind: 'module', exported });
    });
    Object.keys(probes.custom).forEach((id) => entries.push({ id, kind: 'custom' }));
    return entries;
  }

  // The descriptor for key along the prototype chain. Unlike a property read it
  // never calls an accessor: 'value' in it means data, else an untriggered getter.
  function bentoCompatPeek(object, key) {
    for (let o = object; o != null; o = Object.getPrototypeOf(o)) {
      const descriptor = Object.getOwnPropertyDescriptor(o, key);
      if (descriptor) return descriptor;
    }
    return undefined;
  }

  const bentoCompatData = (object, key) => bentoCompatPeek(object, key)?.value;

  // Present when a descriptor exists. A data value must also pass check; an
  // accessor's value cannot be read without calling it, so it passes.
  function bentoCompatHas(object, key, check = () => true) {
    const found = bentoCompatPeek(object, key);
    return !!found && (!('value' in found) || check(found.value));
  }

  // 'ok' | 'missing' | 'deferred' (behind an untriggered accessor owner, or a
  // module not loaded yet). A probe that throws counts as missing.
  function bentoCompatProbe(win, { id, kind, exported }) {
    try {
      if (BENTO_COMPAT_NATIVE.has(id)) {
        return typeof BENTO_COMPAT_NATIVE.get(id) === 'function' ? 'ok' : 'missing';
      }
      if (kind === 'module') {
        if (!Cu.isESModuleLoaded(id)) return 'deferred';
        return exported in ChromeUtils.importESModule(id) ? 'ok' : 'missing';
      }
      if (kind === 'element') return win.document.getElementById(id) ? 'ok' : 'missing';
      if (kind === 'custom') return BENTO_COMPAT_PROBES.custom[id](win) ? 'ok' : 'missing';
      const dot = id.lastIndexOf('.');
      const member = id.slice(dot + 1);
      let owner = win;
      for (const [index, key] of (dot === -1 ? [] : id.slice(0, dot).split('.')).entries()) {
        const step =
          index === 0 && Object.hasOwn(BENTO_COMPAT_ROOTS, key)
            ? { value: BENTO_COMPAT_ROOTS[key](win) }
            : bentoCompatPeek(owner, key);
        if (!step) {
          // Absent is missing, unless the global's script is not loaded yet.
          const gate = index === 0 && BENTO_COMPAT_PROBES.gate[key];
          const loader = gate && bentoCompatPeek(win, gate);
          return loader && !('value' in loader) ? 'deferred' : 'missing';
        }
        if (!('value' in step)) return 'deferred';
        owner = step.value;
      }
      const target =
        BENTO_COMPAT_PROBES.proto.includes(id) && owner != null ? Object.getPrototypeOf(owner) : owner;
      // A method behind an accessor cannot be checked without invoking it: present.
      const isFunction = kind === 'method' ? (value) => typeof value === 'function' : undefined;
      return bentoCompatHas(target, member, isFunction) ? 'ok' : 'missing';
    } catch {
      return 'missing';
    }
  }

  // Lists the ids of each outcome; probed = present + missing. Before delayed
  // startup every member is deferred.
  function runBentoFirefoxCompat(win = window, started = true) {
    const present = [];
    const missing = [];
    const deferred = [];
    const lists = { ok: present, missing, deferred };
    for (const entry of bentoCompatEntries()) {
      const state = started ? bentoCompatProbe(win, entry) : 'deferred';
      lists[state].push(entry.id);
      if (state === 'missing') console.error(`[bento-compat] missing ${entry.id}`);
    }
    const probed = present.length + missing.length;
    console.info(
      `[bento-compat] probed ${probed} members on Firefox ${Services.appinfo.platformVersion}: ${missing.length} missing, ${deferred.length} deferred`,
    );
    return { probed, present, missing, deferred };
  }

  function scheduleBentoFirefoxCompatChecks() {
    let started = false;
    window.BentoFirefoxCompat = Object.freeze({
      check: () => runBentoFirefoxCompat(window, started),
    });
    const run = () => {
      started = true;
      runBentoFirefoxCompat(window);
    };
    const ready = bentoCompatData(window, 'delayedStartupPromise');
    if (typeof ready?.then === 'function') ready.then(run);
    else window.addEventListener('load', () => window.setTimeout(run, 0), { once: true });
  }
  // @bento-firefox-compat:end

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

  // Public Mux design tokens for chrome. The token CSS is generated from
  // @muxui/react's public styles and themes by
  // scripts/generate-chrome-tokens.mjs (runs as part of `pnpm run import`)
  // and registered in chrome via the jar.mn entry. Loading it as a <link>
  // stylesheet exposes the generated Bento alias bridge on the chrome
  // <window>'s :root, so chrome inline styles can use `var(--color-60)`,
  // `var(--neutral-90)`, `var(--radius-m)`, etc. The existing data-bento-theme
  // and data-color-mode attributes select the same values as the shell.
  //
  // We keep `var()` references (no manual hex constants) so changes to the
  // public Mux primitives flow in on the next import without touching this
  // hook.
  function injectChromeTokens() {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome://browser/content/bento-chrome-tokens.css';
    document.documentElement.appendChild(link);
    return link;
  }
  const bentoTokensLink = injectChromeTokens();

  // Map Firefox's chrome color variables (--toolbar-bgcolor,
  // --toolbar-field-background-color, --toolbox-textcolor, etc.) to
  // Bento's generated Mux aliases so the visible chrome (toolbar, URL bar, titlebar)
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
    return link;
  }
  const bentoThemeLink = injectChromeTheme();

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
  // bento-chrome-tokens.css carries the shared tokens and the Default theme. Every other
  // workspace theme is its own sheet, generated beside it by
  // scripts/generate-chrome-tokens.mjs and registered in jar.mn by wildcard. A document
  // keeps one theme sheet attached: the one for the theme it shows.
  const BENTO_CHROME_THEME_SHEET_BASE = 'chrome://browser/content/bento-chrome-themes/';
  const BENTO_DEFAULT_THEME_ID = 'default';
  const BENTO_THEME_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
  // document -> { requested: theme id last asked for, link: the attached theme sheet }
  const bentoChromeThemeState = new WeakMap();
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

  // Show `themeId` in `doc`: attach its sheet, then set data-bento-theme once the sheet has
  // loaded, so the previous theme stays up until the new one can paint. Default needs no
  // sheet, and a sheet that cannot load falls back to Default. A null `themeId` clears the
  // attribute. The sheet itself loads from the shared sheet cache across windows.
  function applyChromeThemeToDocument(doc, themeId) {
    const root = doc?.documentElement;
    if (!root) return;
    let state = bentoChromeThemeState.get(doc);
    if (!state) {
      state = { requested: undefined, link: null };
      bentoChromeThemeState.set(doc, state);
    }
    if (state.requested === themeId) return;
    state.requested = themeId;

    const show = (link, shownThemeId) => {
      if (state.requested !== themeId) {
        // A newer theme was requested while this sheet loaded.
        link?.remove();
        return;
      }
      if (shownThemeId === null) root.removeAttribute('data-bento-theme');
      else root.setAttribute('data-bento-theme', shownThemeId);
      if (state.link && state.link !== link) state.link.remove();
      state.link = link;
    };

    if (themeId === null || themeId === undefined) {
      show(null, null);
      return;
    }
    if (themeId === BENTO_DEFAULT_THEME_ID || !BENTO_THEME_ID_PATTERN.test(themeId)) {
      show(null, BENTO_DEFAULT_THEME_ID);
      return;
    }
    const link = doc.createElementNS('http://www.w3.org/1999/xhtml', 'link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', `${BENTO_CHROME_THEME_SHEET_BASE}${themeId}.css`);
    link.setAttribute('data-bento-chrome-theme-sheet', themeId);
    link.addEventListener('load', () => show(link, themeId), { once: true });
    link.addEventListener(
      'error',
      () => {
        link.remove();
        show(null, BENTO_DEFAULT_THEME_ID);
      },
      { once: true },
    );
    root.appendChild(link);
  }

  function syncChromeThemeAttributes(targetRoot) {
    const sourceRoot = document.documentElement;
    for (const attr of BENTO_CHROME_THEME_ATTRS) {
      const value = sourceRoot.getAttribute(attr);
      if (attr === 'data-bento-theme') {
        applyChromeThemeToDocument(targetRoot.ownerDocument, value);
      } else if (value === null) {
        targetRoot.removeAttribute(attr);
      } else {
        targetRoot.setAttribute(attr, value);
      }
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

  // The three Bento chrome sheets (tokens, theme, and the layout sheet below)
  // are <link> elements inserted by this script. Gecko starts a window's
  // initial layout without waiting for such links: only parser-created links
  // count toward the prototype sink's pending sheets. A window that is already
  // visible when browser.xhtml loads (the early blank window,
  // browser.startup.blankWindow, on by default on Windows) can then paint for
  // up to the 5 ms paint suppression delay before a cold sheet arrives, which
  // shows unstyled chrome. A normal first window is hidden until the document
  // load event and the links block that event, so it needs no help.
  //
  // This gate keeps the root invisible while any of the links still has no
  // complete sheet. LinkStyle.sheet is null until the sheet is complete, and a
  // sheet already in the shared sheet cache is complete as soon as its link is
  // inserted, so later windows never hide. A pending link fires load or error
  // before the document load event (the event dispatch itself blocks it), so
  // on the normal path the gate is released before the window is shown and
  // adds no delay. It can only fail to release if no event ever arrives; a
  // timeout then shows the window anyway. visibility hides paint without
  // changing layout and needs no stylesheet. window.__bentoSheetGate records
  // the outcome for the runtime checks.
  const BENTO_SHEET_GATE_TIMEOUT_MS = 2000;
  function gateFirstPaintOnSheets(links) {
    const pending = links.filter((link) => !link.sheet);
    if (pending.length === 0) return;

    const style = document.documentElement.style;
    const previous = style.getPropertyValue('visibility');
    const previousPriority = style.getPropertyPriority('visibility');
    const startedAt = window.performance.now();
    let remaining = pending.length;
    let sawError = false;
    let timer = 0;
    let released = false;
    window.__bentoSheetGate = { pending: pending.length, releasedBy: null, heldMs: null };

    const release = (releasedBy) => {
      if (released) return;
      released = true;
      window.clearTimeout(timer);
      if (previous) style.setProperty('visibility', previous, previousPriority);
      else style.removeProperty('visibility');
      window.__bentoSheetGate.releasedBy = releasedBy;
      window.__bentoSheetGate.heldMs = Math.round(window.performance.now() - startedAt);
    };

    try {
      style.setProperty('visibility', 'hidden', 'important');
      timer = window.setTimeout(() => {
        console.warn(
          `[bento-shell-mount] chrome stylesheets still loading after ${BENTO_SHEET_GATE_TIMEOUT_MS} ms; showing the window anyway`,
        );
        release('timeout');
      }, BENTO_SHEET_GATE_TIMEOUT_MS);
      window.addEventListener('unload', () => release('unload'), { once: true });
      for (const link of pending) {
        let settled = false;
        const settle = (event) => {
          if (settled) return;
          settled = true;
          if (event.type === 'error') sawError = true;
          remaining -= 1;
          if (remaining === 0) release(sawError ? 'error' : 'load');
        };
        link.addEventListener('load', settle, { once: true });
        link.addEventListener('error', settle, { once: true });
      }
    } catch (err) {
      console.error('[bento-shell-mount] chrome sheet gate failed:', err);
      release('exception');
    }
  }

  // Layout-shape CSS that depends on the tokens above lives in
  // bento-shell-mount.css, a static chrome stylesheet registered in jar.mn.
  // Its rules cover per-tab elements such as .browserContainer that tabbrowser
  // creates later, so there is no need to hook tab creation. The link is
  // appended to the root at this point in the script, the position the former
  // inline <style> held, so it stays after the tokens and theme links above
  // and before any bento-chrome-themes/<id>.css link added later. It is a
  // document sheet, so it comes from the shared sheet cache in later windows
  // and DevTools lists it.
  function injectChromeStyles(earlierLinks) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'chrome://browser/content/bento-shell-mount.css';
    document.documentElement.appendChild(link);
    gateFirstPaintOnSheets([...earlierLinks, link]);
  }
  injectChromeStyles([bentoTokensLink, bentoThemeLink]);

	  let __startupVeilHideTimer = null;
	  function setStartupVeilClass(element, className) {
	    element.setAttribute('class', className);
	    return element;
	  }

	  function ensureStartupVeil() {
	    if (document.getElementById('bento-startup-veil')) return;
	    const parent = document.getElementById('browser');
	    if (!parent) return;

    const veil = document.createXULElement('vbox');
    veil.id = 'bento-startup-veil';
    veil.setAttribute('aria-hidden', 'true');

	    const sidebar = setStartupVeilClass(
	      document.createXULElement('vbox'),
	      'bento-startup-veil__sidebar',
	    );
	    const workspace = setStartupVeilClass(
	      document.createXULElement('hbox'),
	      'bento-startup-veil__workspace',
	    );
	    const workspaceDot = setStartupVeilClass(
	      document.createXULElement('box'),
	      'bento-startup-veil__dot',
	    );
	    const workspaceBar = setStartupVeilClass(
	      document.createXULElement('box'),
	      'bento-startup-veil__bar',
	    );
	    workspace.append(workspaceDot, workspaceBar);
	    const rows = setStartupVeilClass(
	      document.createXULElement('vbox'),
	      'bento-startup-veil__rows',
	    );
	    for (let i = 0; i < 4; i += 1) {
	      const row = setStartupVeilClass(
	        document.createXULElement('hbox'),
	        'bento-startup-veil__row',
	      );
	      const dot = setStartupVeilClass(
	        document.createXULElement('box'),
	        'bento-startup-veil__dot',
	      );
	      const bar = setStartupVeilClass(
	        document.createXULElement('box'),
	        'bento-startup-veil__bar',
	      );
	      row.append(dot, bar);
	      rows.appendChild(row);
	    }
	    sidebar.append(workspace, rows);

	    const main = setStartupVeilClass(
	      document.createXULElement('vbox'),
	      'bento-startup-veil__main',
	    );
	    const toolbar = setStartupVeilClass(
	      document.createXULElement('box'),
	      'bento-startup-veil__toolbar',
	    );
	    const content = setStartupVeilClass(
	      document.createXULElement('box'),
	      'bento-startup-veil__content',
	    );
    main.append(toolbar, content);

    veil.append(sidebar, main);
    parent.appendChild(veil);
  }

  function hideStartupVeil() {
    document.documentElement.removeAttribute('bento-startup-loading');
    if (__startupVeilHideTimer) {
      clearTimeout(__startupVeilHideTimer);
      __startupVeilHideTimer = null;
    }
    // The first real content is up: start warming the overlays (first call only).
    overlays.onVeilLifted();
    const veil = document.getElementById('bento-startup-veil');
    if (!veil || veil.hasAttribute('hidden')) return;
    // The veil fades out through its CSS dismiss transition; remove it once that ends.
    afterMotion(veil, 'hide', { properties: ['opacity'] }, () => {
      veil.setAttribute('hidden', 'true');
      veil.remove();
    });
  }

  function armStartupVeilFallback() {
    if (__startupVeilHideTimer) return;
    __startupVeilHideTimer = window.setTimeout(() => {
      __startupVeilHideTimer = null;
      hideStartupVeil();
    }, STARTUP_VEIL_TIMEOUT_MS);
  }

  if (document.readyState === 'loading') {
    document.addEventListener(
      'DOMContentLoaded',
      () => {
        ensureStartupVeil();
        armStartupVeilFallback();
      },
      { once: true },
    );
  } else {
    ensureStartupVeil();
    armStartupVeilFallback();
  }

  // @bento-overlays:begin
  //
  // Overlay documents. Every overlay <browser> except the sidebar shell and the
  // panel trailer is an extension document, and this manager decides when each
  // is created and when an open may reveal it. It owns the state and the rules;
  // the table that wires it to the frames in this file follows it. It touches
  // nothing of Firefox's, so scripts/overlay-manager.test.mjs evaluates exactly
  // this section.
  //
  // Strategies (entry.eager / entry.prewarm in the table):
  //   eager   created by startEager() at window startup, as before documents were
  //           lazy: the overlays a user action can request at once (confirm,
  //           edit workspace, workspace switcher), whose payloads travel
  //           between documents that cannot wait.
  //   idle    created one at a time at idle after the launch veil lifts, so the
  //           first open does not show a load (address bar, palette, menu).
  //   demand  created by the first open (everything else).
  //
  // States: absent (no document requested), loading (navigation started, waiting
  // for the document to announce BENTO_OVERLAY_READY), ready. Nothing a document
  // has not announced for is revealed or sent to it: chrome-to-overlay messages
  // (frame-script relays onto a BroadcastChannel) do not queue, so one sent
  // before the document subscribed is lost. open(id, reason, run) therefore queues
  // `run` until the announcement, and `run` does both the reveal and the sends
  // that belong to the open. The queue is kept until the announcement, cancel(id),
  // or teardown, and a late announcement runs it once. If no announcement comes
  // within OVERLAY_READY_STALL_MS the manager logs one error and keeps waiting;
  // it does not reveal.
  //
  // Keyed: a repeated open replaces the queued one (the welcome requests repeat),
  // and an open that replaces another is the newest request. hasPendingOpen(id)
  // is true while an open waits: dismissal and toggle paths must treat that as
  // open, and cancel(id) is what a hide calls. Code that only hides, resizes or
  // messages an overlay must look the frame up with document.getElementById and
  // treat null (not created yet) as "nothing to do"; only open paths call
  // ensure/open.
  const OVERLAY_READY_STALL_MS = 5000;
  const OVERLAY_PREWARM_IDLE_TIMEOUT_MS = 1500;
  const OVERLAY_PREWARM_READY_WAIT_MS = 2500;

  function createOverlayManager({
    entries,
    now,
    requestIdle,
    setTimer,
    clearTimer,
    warn,
    error,
  }) {
    const records = new Map();
    for (const entry of entries) {
      records.set(entry.id, {
        entry,
        state: 'absent',
        reason: null,
        createdAt: null,
        readyAt: null,
        readyBy: null,
        reveals: new Map(),
        stallTimer: null,
        stalled: false,
        opens: 0,
        firstOpenWaitMs: null,
        maxOpenWaitMs: 0,
      });
    }
    const createdOrder = [];
    let veilLiftedAt = null;
    let prewarmQueue = [];
    let prewarmIdle = false;
    let prewarmWaitId = null;
    let prewarmWaitTimer = null;
    let disposed = false;

    function guarded(id, fn) {
      try {
        fn();
      } catch (err) {
        warn('[bento-shell-mount] overlay ' + id + ' callback threw:', err);
      }
    }

    function clearStallTimer(rec) {
      if (rec.stallTimer === null) return;
      clearTimer(rec.stallTimer);
      rec.stallTimer = null;
    }

    // by: 'signal' (the document announced) or 'no-handshake' (a page that never
    // announces).
    function markReady(id, by) {
      const rec = records.get(id);
      if (!rec || disposed) return;
      clearStallTimer(rec);
      if (rec.state !== 'ready') {
        rec.state = 'ready';
        rec.readyAt = now();
        rec.readyBy = by;
      }
      const queued = [...rec.reveals.values()];
      rec.reveals.clear();
      for (const fn of queued) guarded(id, fn);
      if (by === 'signal' && rec.entry.onReady) guarded(id, rec.entry.onReady);
      if (prewarmWaitId === id) continuePrewarm();
    }

    // Reports a document that does not announce while an open waits for it. The
    // open stays pending: revealing an overlay that cannot receive its message
    // shows an empty one.
    function armStallReport(id, rec) {
      if (rec.stallTimer !== null) return;
      rec.stallTimer = setTimer(() => {
        rec.stallTimer = null;
        if (rec.state === 'ready' || !rec.reveals.has('show')) return;
        rec.stalled = true;
        error(
          '[bento-shell-mount] overlay ' +
            id +
            ' did not announce readiness within ' +
            OVERLAY_READY_STALL_MS +
            ' ms; its open stays pending until it does or is cancelled.',
        );
      }, OVERLAY_READY_STALL_MS);
    }

    // Creates the overlay's <browser> if needed and starts its navigation once.
    // Returns the frame, or null when its host is missing or the navigation
    // failed (the overlay stays absent and a later call retries).
    function ensure(id, reason) {
      const rec = records.get(id);
      if (!rec || disposed) return null;
      const { entry } = rec;
      let frame = entry.frame();
      if (!frame && entry.create) frame = entry.create();
      if (!frame) return null;
      if (rec.state !== 'absent') return frame;
      rec.state = 'loading';
      rec.reason = reason;
      rec.createdAt = now();
      try {
        entry.navigate();
      } catch (err) {
        warn('[bento-shell-mount] overlay ' + id + ' navigation failed:', err);
        rec.state = 'absent';
        return null;
      }
      createdOrder.push(id);
      if (entry.handshake === false) markReady(id, 'no-handshake');
      return frame;
    }

    // Runs `run` once the overlay's document has announced itself: at once for a
    // ready one, else on the announcement. Returns false when the overlay's
    // frame cannot be created.
    function open(id, reason, run) {
      const rec = records.get(id);
      if (!rec) {
        run();
        return true;
      }
      if (!ensure(id, reason)) return false;
      const requestedAt = now();
      const reveal = () => {
        const waited = now() - requestedAt;
        rec.opens += 1;
        if (rec.firstOpenWaitMs === null) rec.firstOpenWaitMs = waited;
        rec.maxOpenWaitMs = Math.max(rec.maxOpenWaitMs, waited);
        run();
      };
      if (rec.state === 'ready') {
        reveal();
        return true;
      }
      rec.reveals.set('show', reveal);
      armStallReport(id, rec);
      return true;
    }

    function hasPendingOpen(id) {
      return records.get(id)?.reveals.has('show') === true;
    }

    // Drops the queued open. A hide calls this first, so a hide that arrives while
    // an open waits wins and a late announcement reveals and sends nothing.
    function cancel(id) {
      const rec = records.get(id);
      if (!rec) return;
      rec.reveals.clear();
      clearStallTimer(rec);
    }

    // A reloaded document announces itself again; hold opens until it does.
    function reset(id) {
      const rec = records.get(id);
      if (!rec || rec.state !== 'ready') return;
      rec.state = 'loading';
      rec.readyAt = null;
      rec.readyBy = null;
    }

    function idForFrame(frameId) {
      for (const [id, rec] of records) {
        if (rec.entry.frameId === frameId) return id;
      }
      return null;
    }

    function markFrameReady(frameId) {
      const id = idForFrame(frameId);
      if (id !== null) markReady(id, 'signal');
    }

    // Window startup: create the eager overlays.
    function startEager() {
      for (const entry of entries) {
        if (entry.eager) ensure(entry.id, 'startup');
      }
    }

    // Prewarm: one document per idle period, the next only after the previous
    // announced (or a timeout), so the shared extension process never loads
    // several React documents at once.
    function scheduleNextPrewarm() {
      if (disposed || prewarmIdle || prewarmQueue.length === 0) return;
      prewarmIdle = true;
      requestIdle(
        () => {
          prewarmIdle = false;
          runPrewarmStep();
        },
        { timeout: OVERLAY_PREWARM_IDLE_TIMEOUT_MS },
      );
    }

    function continuePrewarm() {
      if (prewarmWaitTimer !== null) {
        clearTimer(prewarmWaitTimer);
        prewarmWaitTimer = null;
      }
      prewarmWaitId = null;
      scheduleNextPrewarm();
    }

    function runPrewarmStep() {
      if (disposed) return;
      const id = prewarmQueue.shift();
      if (id === undefined) return;
      const rec = records.get(id);
      // Already opened on demand, or its host is missing: go to the next one.
      if (rec.state !== 'absent' || !ensure(id, 'idle')) {
        scheduleNextPrewarm();
        return;
      }
      if (rec.state === 'ready' || prewarmQueue.length === 0) {
        scheduleNextPrewarm();
        return;
      }
      prewarmWaitId = id;
      prewarmWaitTimer = setTimer(continuePrewarm, OVERLAY_PREWARM_READY_WAIT_MS);
    }

    // The window shows its first real content; start warming the overlays that
    // must open without a visible load. Runs once.
    function onVeilLifted() {
      if (veilLiftedAt !== null || disposed) return;
      veilLiftedAt = now();
      prewarmQueue = entries.filter((entry) => entry.prewarm).map((entry) => entry.id);
      scheduleNextPrewarm();
    }

    function stats() {
      const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
      const sinceVeil = (value) =>
        value === null || veilLiftedAt === null ? null : round(value - veilLiftedAt);
      const result = {};
      for (const [id, rec] of records) {
        result[id] = {
          strategy: rec.entry.eager ? 'eager' : rec.entry.prewarm ? 'idle' : 'demand',
          state: rec.state,
          reason: rec.reason,
          createdMs: round(rec.createdAt),
          createdSinceVeilMs: sinceVeil(rec.createdAt),
          readyMs: round(rec.readyAt),
          readySinceVeilMs: sinceVeil(rec.readyAt),
          loadMs:
            rec.createdAt === null || rec.readyAt === null
              ? null
              : round(rec.readyAt - rec.createdAt),
          readyBy: rec.readyBy,
          pendingOpen: rec.reveals.has('show'),
          stalled: rec.stalled,
          opens: rec.opens,
          firstOpenWaitMs: round(rec.firstOpenWaitMs),
          maxOpenWaitMs: round(rec.maxOpenWaitMs),
        };
      }
      return {
        nowMs: round(now()),
        veilLiftedMs: round(veilLiftedAt),
        created: [...createdOrder],
        overlays: result,
      };
    }

    function dispose() {
      disposed = true;
      for (const rec of records.values()) {
        rec.reveals.clear();
        clearStallTimer(rec);
      }
      if (prewarmWaitTimer !== null) clearTimer(prewarmWaitTimer);
      prewarmWaitTimer = null;
    }

    return {
      ensure,
      open,
      hasPendingOpen,
      cancel,
      reset,
      idForFrame,
      markFrameReady,
      startEager,
      onVeilLifted,
      stats,
      dispose,
      isReady: (id) => records.get(id)?.state === 'ready',
      hasStarted: (id) => (records.get(id)?.state ?? 'absent') !== 'absent',
    };
  }
  // @bento-overlays:end

  // Title an overlay document writes once it can receive an open (the shell side
  // is bridge/overlayReady.ts). Handled for every overlay frame before its own
  // title handler.
  const OVERLAY_READY_PREFIX = 'BENTO_OVERLAY_READY';

  // One row per overlay, in prewarm order. `eager` rows start at window startup
  // (overlays.startEager()), `prewarm` rows at idle after the veil lifts, the rest
  // on first use. `created` rows have a host from ensureOverlayHost and get their
  // <browser> from createOverlayFrame; the rest are the <browser> elements the
  // browser-box patch declares, navigated later.
  function overlayEntry({
    id,
    navigate,
    eager = false,
    prewarm = false,
    created = false,
    remote = true,
    handshake,
    onReady,
  }) {
    const frameId = 'bento-' + id + '-frame';
    return {
      id,
      frameId,
      eager,
      prewarm,
      navigate,
      handshake,
      onReady,
      frame: () => document.getElementById(frameId),
      create: created
        ? () => createOverlayFrame('bento-' + id + '-host', frameId, remote)
        : undefined,
    };
  }

  const overlays = createOverlayManager({
    entries: [
      overlayEntry({ id: 'addrbar', prewarm: true, created: true, navigate: setBentoAddrbarSrc }),
      overlayEntry({ id: 'palette', prewarm: true, navigate: setBentoPaletteSrc }),
      overlayEntry({ id: 'menu', prewarm: true, navigate: setBentoMenuSrc }),
      overlayEntry({ id: 'confirm', eager: true, navigate: setBentoConfirmSrc }),
      overlayEntry({
        id: 'edit-workspace',
        eager: true,
        created: true,
        navigate: setBentoEditWorkspaceSrc,
      }),
      overlayEntry({
        id: 'workspace-switcher',
        eager: true,
        created: true,
        navigate: setBentoWorkspaceSwitcherSrc,
      }),
      overlayEntry({
        id: 'workspace-palette',
        created: true,
        navigate: setBentoWorkspacePaletteSrc,
      }),
      overlayEntry({ id: 'merge-palette', navigate: setBentoMergePaletteSrc }),
      overlayEntry({
        id: 'settings-palette',
        created: true,
        navigate: setBentoSettingsPaletteSrc,
      }),
      overlayEntry({ id: 'welcome', created: true, navigate: setBentoWelcomeSrc }),
      // Chrome-hosted page with no handshake; showEmbeddedBrowserImportFromWelcome
      // sets its src each time it opens.
      overlayEntry({
        id: 'embedded-import',
        created: true,
        remote: false,
        handshake: false,
        navigate: () => {},
      }),
      overlayEntry({
        id: 'panel-navigator-tooltip',
        created: true,
        navigate: setBentoPanelNavigatorTooltipSrc,
        onReady: () =>
          replayPanelNavigatorTooltipPayload(
            document.getElementById('bento-panel-navigator-tooltip-frame'),
          ),
      }),
    ],
    now: () => window.performance.now(),
    requestIdle: (callback, options) =>
      typeof window.requestIdleCallback === 'function'
        ? window.requestIdleCallback(callback, options)
        : window.setTimeout(callback, 0),
    setTimer: (callback, ms) => window.setTimeout(callback, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    warn: (...args) => console.warn(...args),
    error: (...args) => console.error(...args),
  });

  // Dev-visible measurement for the runtime pass: which overlays exist, why and
  // when each was created relative to the veil lift, how long each took to
  // announce, and how long opens waited. A snapshot per read; no timers.
  Object.defineProperty(window, 'BentoOverlayStats', {
    configurable: true,
    get: () => overlays.stats(),
  });
  window.addEventListener('unload', () => overlays.dispose(), { once: true });

  function moz(path) {
    const policy = WebExtensionPolicy.getByID(ADDON_ID);
    if (!policy) return null;
    return 'moz-extension://' + policy.mozExtensionHostname + path;
  }

  // Resolve THIS chrome window's WebExtension windowId. We pass it
  // through to every shell document we host (sidebar, palette, confirm,
  // edit-workspace, etc.) as a `?bentoWindowId=<N>` query param so the
  // shell document can stamp it on its outgoing dispatches via the
  // WireAction `__windowId` envelope.
  //
  // Why not call browser.windows.getCurrent() from the shell document?
  // Bento's chrome-mounted <browser> frames (e.g. #bento-shell-frame)
  // are not regular tabs — they live directly in browser.xhtml, NOT in
  // tabbrowser-tabpanels. From the shell's content process, getCurrent()
  // typically resolves to the most-recently-focused chrome window, NOT
  // the one hosting this <browser>. That's wrong when window A's shell
  // is initializing while window B is focused — both windows then
  // believe they're window B.
  //
  // Chrome-side `windowTracker.getId(window)` reads from the same
  // BrowserWindowTracker the WebExtension API uses internally — same
  // ID space the shell document would otherwise be trying (and failing)
  // to resolve.
  //
  // Computed LAZILY at every setFrameSrc call (not once at module eval)
  // because this script can run before the chrome window has finished
  // registering with BrowserWindowTracker — early eval returns -1, the
  // lazy retry path catches it on the next call after registration.
  // Lazily importing on first call (and caching the result) is important:
  // bento-shell-mount.js evaluates very early during browser.xhtml parse,
  // which can be before `Extension.sys.mjs` has fully initialized the
  // Management.global namespace. Repeated lookups would also be expensive.
  // Sentinel `undefined` = "not yet attempted"; `null` = "attempted, gave up".
  let __bentoWindowTracker /* : object|null|undefined */ = undefined;
  function getChromeWindowId(win = window) {
    if (__bentoWindowTracker === undefined) {
      try {
        const mod = ChromeUtils.importESModule('resource://gre/modules/Extension.sys.mjs');
        __bentoWindowTracker = mod.Management?.global?.windowTracker || null;
      } catch (err) {
        console.warn('[bento-shell-mount] Extension.sys.mjs import failed:', err);
        __bentoWindowTracker = null;
      }
    }
    if (!__bentoWindowTracker) return null;
    try {
      const wid = __bentoWindowTracker.getId(win);
      return typeof wid === 'number' && wid >= 0 ? wid : null;
    } catch (err) {
      console.warn('[bento-shell-mount] windowTracker.getId failed:', err);
      return null;
    }
  }

  // Hard cap on setFrameSrc retries when windowId isn't resolving yet —
  // otherwise the spam can starve other startup work and the chrome
  // window's shell never paints (observed: blank chrome from infinite
  // retry loop). After this many failures, give up and load the URL
  // WITHOUT the windowId param. The shell document then dispatches with
  // __windowId=null and bento-tools falls back to legacy global semantics
  // — degraded but still functional (matches pre-A.1 behaviour).
  const SET_FRAME_SRC_MAX_RETRIES = 20; // ~1s @ 50ms
  // The extension policy can register well after a slow cold start, so that
  // branch backs off (50 ms doubling to a 2 s ceiling) and only gives up after
  // ~30 s in total, rather than using the short windowId cap above.
  const SET_FRAME_SRC_POLICY_RETRY_MIN_MS = 50;
  const SET_FRAME_SRC_POLICY_RETRY_MAX_MS = 2000;
  const SET_FRAME_SRC_POLICY_GIVE_UP_MS = 30000;
  let __bentoSidebarAddressBridgeToken = null;

  function getBentoSidebarAddressBridgeToken() {
    if (__bentoSidebarAddressBridgeToken) return __bentoSidebarAddressBridgeToken;
    try {
      __bentoSidebarAddressBridgeToken = String(Services.uuid.generateUUID()).replace(/[{}]/g, '');
    } catch {
      __bentoSidebarAddressBridgeToken =
        String(Date.now()) + '-' + Math.random().toString(16).slice(2);
    }
    return __bentoSidebarAddressBridgeToken;
  }

  function getBentoSystemPrincipal() {
    try {
      return Services.scriptSecurityManager.getSystemPrincipal();
    } catch {
      return null;
    }
  }

  function navigateChromeFrame(frame, finalUrl) {
    const principal = getBentoSystemPrincipal();
    if (typeof frame.loadURI === 'function' && principal) {
      try {
        frame.loadURI(Services.io.newURI(finalUrl), { triggeringPrincipal: principal });
        return;
      } catch (err) {
        console.warn('[bento-shell-mount] loadURI failed for', frame.id, err);
      }
    }
    // setAttribute('src') works before a chrome <browser>'s webNavigation
    // is initialized. Keep it as the compatibility fallback for early
    // browser.xhtml parse and older Firefox builds.
    frame.setAttribute('src', finalUrl);
  }

  // `attempt` counts windowId retries only. `policyWaitedMs` is the time already
  // spent waiting for the extension policy; it is tracked separately so a slow
  // policy does not use up the windowId retry budget.
  function setFrameSrc(frameId, path, attempt, extraHashParams, policyWaitedMs) {
    const tries = typeof attempt === 'number' ? attempt : 0;
    const waitedMs = typeof policyWaitedMs === 'number' ? policyWaitedMs : 0;
    const url = moz(path);
    if (!url) {
      // Extension hasn't loaded yet; back off and try again. With no delay yet
      // spent this waits 50 ms, then waitedMs + 50 (100, 200, 400, ...) up to
      // the ceiling, and gives up once ~30 s have elapsed.
      if (waitedMs < SET_FRAME_SRC_POLICY_GIVE_UP_MS) {
        const delayMs = Math.min(
          waitedMs + SET_FRAME_SRC_POLICY_RETRY_MIN_MS,
          SET_FRAME_SRC_POLICY_RETRY_MAX_MS,
        );
        setTimeout(
          () => setFrameSrc(frameId, path, tries, extraHashParams, waitedMs + delayMs),
          delayMs,
        );
        return;
      }
      console.warn(
        '[bento-shell-mount] setFrameSrc(' +
          frameId +
          '): giving up after ' +
          waitedMs +
          ' ms; extension policy ' +
          ADDON_ID +
          ' is not registered.',
      );
      return;
    }
    const frame = document.getElementById(frameId);
    if (!frame) return;
    const windowId = getChromeWindowId();
    if (windowId === null && tries < SET_FRAME_SRC_MAX_RETRIES) {
      // Not yet — retry shortly. Capped via SET_FRAME_SRC_MAX_RETRIES so
      // a permanently-missing windowTracker doesn't loop forever.
      setTimeout(() => setFrameSrc(frameId, path, tries + 1, extraHashParams), 50);
      return;
    }
    // Stamp the windowId as a URL HASH (not a query string). Hashes are
    // purely client-side fragments — they don't change the resource path
    // Firefox loads, don't change the document's origin, and crucially
    // don't trigger BrowsingContextGroup re-partitioning. Earlier we
    // tried `?bentoWindowId=N` as a query string and observed that
    // BroadcastChannel('bento-shell-bus') stopped delivering events from
    // the singleton bento-shell background to the per-window shell
    // documents — symptom: shells stuck on "connecting…" with skeleton
    // rendering, because the channel can't cross BCG boundaries even
    // within the same origin. The hash form sidesteps that entirely.
    const hashParams = new URLSearchParams();
    if (windowId !== null) hashParams.set('bentoWindowId', String(windowId));
    // Documents in a private window talk to the shell background through the
    // BentoShellBus actor; BroadcastChannel is partitioned away from it. The
    // shell reads this flag in useToolsPort to pick its transport.
    if (BentoPrivateBrowsingUtils.isWindowPrivate(window)) hashParams.set('bentoPrivate', '1');
    for (const [key, value] of Object.entries(extraHashParams || {})) {
      if (value !== null && value !== undefined && value !== '') {
        hashParams.set(key, String(value));
      }
    }
    const hash = hashParams.toString();
    const finalUrl = hash ? url + '#' + hash : url;
    if (windowId === null) {
      console.warn(
        '[bento-shell-mount] setFrameSrc(' +
          frameId +
          '): giving up on windowId after ' +
          tries +
          ' retries; loading without hash (single-window fallback).',
      );
    }
    navigateChromeFrame(frame, finalUrl);
  }

  // Chrome's root font size in px. Chrome's rem is not the shell's (11px against 16px), so the
  // gutter above the main panels (`--space-3xs`, bento-shell-mount.css) is a different length in
  // each. The sidebar of a private window reads this from its frame URL (#bentoChromeRem,
  // public/boot.js) and scales the same token, so its Private band starts level with the panels.
  function chromeRemPx() {
    const px = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Number.isFinite(px) && px > 0 ? px : null;
  }

  // The root font size comes from a stylesheet (global.css, 'font: message-box'). A window whose
  // sheets are not in the shared cache yet (the first private window of a session) runs this
  // script before any of them applies and would read the 16px default, so the private window's
  // frame waits for the document load event, which every parser-created sheet blocks.
  function chromeSheetsApplied() {
    return Array.from(document.querySelectorAll('link[rel="stylesheet"]')).every(
      (link) => link.sheet,
    );
  }

  function setBentoShellSrc() {
    const isPrivate = BentoPrivateBrowsingUtils.isWindowPrivate(window);
    if (isPrivate && document.readyState !== 'complete' && !chromeSheetsApplied()) {
      window.addEventListener('load', setBentoShellSrc, { once: true });
      return;
    }
    const frame = document.getElementById('bento-shell-frame');
    if (frame) {
      frame.setAttribute('transparent', 'transparent');
      frame.style.backgroundColor = 'transparent';
      frame.style.setProperty('-moz-appearance', 'none');
    }
    setFrameSrc('bento-shell-frame', '/dist/index.html', undefined, {
      bentoSidebarAddressBridgeToken: getBentoSidebarAddressBridgeToken(),
      bentoChromeRem: isPrivate ? chromeRemPx() : null,
    });
  }

  function setBentoPaletteSrc() {
    setFrameSrc('bento-palette-frame', '/dist/palette.html');
  }

  function setBentoWorkspacePaletteSrc() {
    setFrameSrc('bento-workspace-palette-frame', '/dist/workspace-palette.html');
  }

  function setBentoMergePaletteSrc() {
    setFrameSrc('bento-merge-palette-frame', '/dist/merge-palette.html');
  }

  function setBentoSettingsPaletteSrc() {
    setFrameSrc('bento-settings-palette-frame', '/dist/settings-palette.html');
  }

  function setBentoAddrbarSrc() {
    setFrameSrc('bento-addrbar-frame', '/dist/address-bar.html');
  }

  function setBentoConfirmSrc() {
    setFrameSrc('bento-confirm-frame', '/dist/confirm.html');
  }

  function setBentoEditWorkspaceSrc() {
    setFrameSrc('bento-edit-workspace-frame', '/dist/edit-workspace.html');
  }

  let __bentoWelcomeResumeStep;
  let __bentoPendingWelcomeResumeStep = BENTO_WELCOME_POST_IMPORT_STEP;
  function takeBentoWelcomeResumeStep() {
    if (__bentoWelcomeResumeStep !== undefined) return __bentoWelcomeResumeStep;

    __bentoWelcomeResumeStep = null;
    try {
      const raw = Services.env.get(BENTO_WELCOME_STEP_ENV);
      Services.env.set(BENTO_WELCOME_STEP_ENV, '');
      const step = Number.parseInt(raw || '', 10);
      if (Number.isInteger(step) && step >= 0) {
        __bentoWelcomeResumeStep = String(step);
      }
    } catch (err) {
      console.warn('[bento-shell-mount] failed to read Bento welcome resume step:', err);
    }

    return __bentoWelcomeResumeStep;
  }

  // The resume step in 'BENTO_IMPORT_BROWSER_DATA_<step>_...' (or the title of another sentinel with
  // the same shape, named by `prefix`).
  function parseWelcomeImportResumeStep(title, prefix = WELCOME_IMPORT_BROWSER_DATA_PREFIX) {
    if (!title.startsWith(prefix + '_')) {
      return BENTO_WELCOME_POST_IMPORT_STEP;
    }

    const suffix = title.slice(prefix.length + 1);
    const parts = suffix.split('_');
    if (parts.length < 2) return BENTO_WELCOME_POST_IMPORT_STEP;

    const step = Number.parseInt(parts[0] || '', 10);
    return Number.isInteger(step) && step >= 0 ? String(step) : BENTO_WELCOME_POST_IMPORT_STEP;
  }

  function setBentoWelcomeSrc() {
    const resumeStep = takeBentoWelcomeResumeStep();
    setFrameSrc(
      'bento-welcome-frame',
      '/dist/welcome.html',
      undefined,
      resumeStep ? { [BENTO_WELCOME_RESUME_HASH_KEY]: resumeStep } : undefined,
    );
  }

  const BENTO_EMBEDDED_IMPORT_URL = 'chrome://browser/content/bento-migration-host.html';

  // `handoff` (the choreographed open, see importHandoff) adds the dialog's rectangle and the ts
  // the page echoes in its ready title. `migrator` is the key of the browser an onboarding tile
  // chose; the page selects it in the wizard when the wizard lists it.
  function setBentoEmbeddedImportSrc({ handoff = null, migrator = null } = {}) {
    const frame = document.getElementById('bento-embedded-import-frame');
    if (!frame) return;
    const mode = document.documentElement.getAttribute('data-color-mode') === 'dark' ? 'dark' : 'light';
    const params = new URLSearchParams({
      source: 'welcome',
      mode,
      ts: handoff?.hostTs ?? String(Date.now()),
    });
    if (handoff) {
      const { x, y, w, h, r } = handoff.rect;
      params.set('dialog', [x, y, w, h, r].join(','));
    }
    if (migrator) params.set('migrator', migrator);
    frame.setAttribute('src', `${BENTO_EMBEDDED_IMPORT_URL}?${params.toString()}`);
  }

  function setBentoWorkspaceSwitcherSrc() {
    setFrameSrc('bento-workspace-switcher-frame', '/dist/workspace-switcher.html');
  }

  function setBentoMenuSrc() {
    const frame = document.getElementById('bento-menu-frame');
    if (frame) {
      frame.setAttribute('transparent', 'transparent');
      frame.style.backgroundColor = 'transparent';
      frame.style.setProperty('-moz-appearance', 'none');
    }
    setFrameSrc('bento-menu-frame', '/dist/menu.html');
  }

  // Trailer-frame source helper. Mirrors the other overlay-frame helpers
  // but the host is the existing #bento-add-panel-trailer XUL <vbox>
  // (not an ensureOverlayHost overlay) — see ensureAddPanelTrailer.
  function setBentoPanelTrailerSrc() {
    setFrameSrc('bento-panel-trailer-frame', '/dist/panel-trailer.html');
  }

  const PANEL_NAVIGATOR_TOOLTIP_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'if (!globalThis.__bentoPanelNavigatorTooltipRelayInstalled) {' +
    '  globalThis.__bentoPanelNavigatorTooltipRelayInstalled = true;' +
    '  addMessageListener("BentoPanelNavigatorTooltip", function(msg) {' +
    '    try {' +
    '      content.postMessage({ kind: "bento-panel-navigator-tooltip", payload: msg.data || null }, "*");' +
    '    } catch (e) {}' +
    '  });' +
    '}';
  const PANEL_NAVIGATOR_TOOLTIP_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(PANEL_NAVIGATOR_TOOLTIP_FRAME_SCRIPT_SRC);
  let panelNavigatorTooltipPayload = null;

  function installPanelNavigatorTooltipFrameScript(frame) {
    const messageManager = frame?.messageManager;
    const windowGlobal = frame?.browsingContext?.currentWindowGlobal;
    if (!messageManager || typeof messageManager.loadFrameScript !== 'function') return false;
    if (
      frame._bentoPanelNavigatorTooltipFrameScriptManager === messageManager &&
      frame._bentoPanelNavigatorTooltipFrameScriptWindowGlobal === windowGlobal
    ) {
      return true;
    }
    const registerForDelayedLoad =
      frame._bentoPanelNavigatorTooltipFrameScriptDelayedManager !== messageManager;
    messageManager.loadFrameScript(
      PANEL_NAVIGATOR_TOOLTIP_FRAME_SCRIPT_URL,
      registerForDelayedLoad,
    );
    if (registerForDelayedLoad) {
      frame._bentoPanelNavigatorTooltipFrameScriptDelayedManager = messageManager;
    }
    frame._bentoPanelNavigatorTooltipFrameScriptManager = messageManager;
    frame._bentoPanelNavigatorTooltipFrameScriptWindowGlobal = windowGlobal;
    frame._bentoPanelNavigatorTooltipFrameScriptLoaded = true;
    return true;
  }

  function replayPanelNavigatorTooltipPayload(frame) {
    if (!panelNavigatorTooltipPayload) return;
    const messageManager = frame?.messageManager;
    if (!messageManager || typeof messageManager.sendAsyncMessage !== 'function') return;
    try {
      messageManager.sendAsyncMessage('BentoPanelNavigatorTooltip', panelNavigatorTooltipPayload);
    } catch {
      // The remote frame can disappear during a browser-window teardown.
    }
  }

  function ensurePanelNavigatorTooltipFrameScript() {
    const frame = document.getElementById('bento-panel-navigator-tooltip-frame');
    if (!frame) return;
    if (!frame._bentoPanelNavigatorTooltipFrameScriptProgressListenerAttached) {
      const progressListener = {
        QueryInterface: ChromeUtils.generateQI([
          'nsIWebProgressListener',
          'nsISupportsWeakReference',
        ]),
        onStateChange(webProgress, request, stateFlags) {
          if (webProgress && !webProgress.isTopLevel) return;
          if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
            ensurePanelNavigatorTooltipFrameScript();
            replayPanelNavigatorTooltipPayload(frame);
          }
        },
        onLocationChange() {},
        onProgressChange() {},
        onStatusChange() {},
        onSecurityChange() {},
        onContentBlockingEvent() {},
      };
      try {
        frame.addProgressListener(progressListener, Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT);
        frame._bentoPanelNavigatorTooltipFrameScriptProgressListener = progressListener;
        frame._bentoPanelNavigatorTooltipFrameScriptProgressListenerAttached = true;
      } catch (err) {
        console.warn('[bento-shell-mount] panel navigator tooltip progress listener failed:', err);
      }
    }
    try {
      installPanelNavigatorTooltipFrameScript(frame);
    } catch (err) {
      console.warn('[bento-shell-mount] panel navigator tooltip frame setup failed:', err);
    }
  }

  function setBentoPanelNavigatorTooltipSrc() {
    // Attach the progress listener before navigation. Firefox can replace the
    // remote frame's message manager during the first extension load, so the
    // relay is reinstalled when the document reaches STATE_STOP.
    ensurePanelNavigatorTooltipFrameScript();
    setFrameSrc('bento-panel-navigator-tooltip-frame', '/dist/panel-navigator-tooltip.html');
  }

  // Create overlay host elements dynamically rather than in the patch.
  // Why: browser.xhtml is preprocessed by mach at full-build time, so adding
  // a new <vbox> to browser-box.inc.xhtml requires `npm run build` to land
  // in the deployed app. JS-created elements bypass that — they go into the
  // live DOM at script-execution time, which `pnpm run dev` always picks
  // up via the bento-shell-mount.js symlink. Pattern: idempotent (guarded
  // by getElementById check) so the script can run multiple times without
  // duplicating hosts.
  //
  // Existing palette / confirm hosts stay in the patch because they were
  // created during a prior full build and changing them now would require
  // a rebuild anyway. New overlays added in dev should go through this
  // factory.
  function ensureOverlayHost(opts) {
    const { hostId, zIndex, parentId = 'browser' } = opts;
    if (document.getElementById(hostId)) return;
    const parent = parentId ? document.getElementById(parentId) : document.documentElement;
    if (!parent) {
      console.warn('[bento-shell-mount] ensureOverlayHost:', hostId, '— parent missing');
      return;
    }
    const host = document.createXULElement('vbox');
    host.id = hostId;
    host.setAttribute('hidden', 'true');
    host.style.cssText =
      'position: absolute; top: 0; left: 0; width: 100%; height: 100%;' +
      ` z-index: ${zIndex}; background-color: transparent; pointer-events: auto;` +
      ' display: none; opacity: 0;' +
      ' transition: opacity var(--muxui-semantic-motion-modal-transition);';
    parent.appendChild(host);
  }

  // The overlay's <browser>, created on its first open or at idle (see
  // createOverlayManager). The host from ensureOverlayHost stays from window
  // startup; only the heavy part is deferred. Returns null while the host is
  // missing.
  function createOverlayFrame(hostId, frameId, remote = true) {
    const existing = document.getElementById(frameId);
    if (existing) return existing;
    const host = document.getElementById(hostId);
    if (!host) {
      console.warn('[bento-shell-mount] createOverlayFrame:', hostId, '— host missing');
      return null;
    }
    const frame = document.createXULElement('browser');
    frame.id = frameId;
    frame.setAttribute('type', 'content');
    if (remote) {
      frame.setAttribute('remote', 'true');
      frame.setAttribute('remoteType', 'extension');
    }
    frame.setAttribute('primary', 'false');
    frame.setAttribute('flex', '1');
    frame.setAttribute('transparent', 'transparent');
    frame.style.cssText =
      'background-color: transparent; -moz-appearance: none;' +
      ' border: 0; margin: 0; padding: 0;';
    host.appendChild(frame);
    return frame;
  }

  const activeToolbarScrimOwners = new Set();

  function ensureOverlayToolbarScrim() {
    if (document.getElementById('bento-overlay-toolbar-scrim')) return;
    // Cover the toolbar strip (back/forward, urlbar, menu) so modal dims are
    // continuous from the toolbar down through the content area. The overlay
    // frames live under #browser, so their in-document Dialog.Backdrop cannot
    // reach the native toolbar.
    //
    // The scrim MUST be a popover. #urlbar has popover="manual" — the
    // megabar lifts it into the CSS top layer, which paints above ALL
    // normal-flow content regardless of z-index. A plain element (any
    // z-index, in the toolbox or on <body>) therefore dims the rest of
    // the toolbar but leaves the address-bar pill bright on top. Top
    // layer order is by show order, so a popover shown when a Bento modal
    // opens stacks above #urlbar and finally covers it.
    //
    // Not a XUL <panel>: a panel is a native popup window whose macOS
    // vibrancy material stacked with the dim, and whose window `level`
    // floated it over OTHER windows. A popover stays in this window.
    const parent = document.body;
    if (!parent) {
      console.warn('[bento-shell-mount] ensureOverlayToolbarScrim: document.body missing');
      return;
    }
    const scrim = document.createElement('div');
    scrim.id = 'bento-overlay-toolbar-scrim';
    scrim.setAttribute('popover', 'manual');
    // Override the UA popover layout (centered, fit-content) into a
    // top strip. Height is set on show from the live toolbar rect.
    // background = --scrim (neutral-100 @ 48%), the SAME token Mux's
    // Dialog.Backdrop uses (--modal-backdrop-bg: var(--scrim)), so the
    // toolbar dim matches the content dim exactly. Painted once.
    scrim.style.cssText =
      'position: fixed; top: 0; left: 0; right: 0; bottom: auto; width: auto;' +
      ' height: 0; max-width: none; max-height: none; margin: 0; padding: 0;' +
      ' border: 0; overflow: hidden; pointer-events: auto; opacity: 0;' +
      ' background-color: var(--scrim, rgba(0, 0, 0, 0.48));' +
      ' transition: opacity var(--muxui-semantic-motion-modal-transition);';
    parent.appendChild(scrim);
  }

  // Edit-workspace overlay was added in dev — go through the JS factory
  // rather than waiting for a full build to inline its <vbox> into the
  // deployed browser.xhtml.
  ensureOverlayHost({
    hostId: 'bento-merge-palette-host',
    zIndex: 99997,
  });

  ensureOverlayHost({
    hostId: 'bento-workspace-palette-host',
    zIndex: 99997,
  });

  ensureOverlayHost({
    hostId: 'bento-settings-palette-host',
    zIndex: 99997,
  });

  ensureOverlayHost({
    hostId: 'bento-edit-workspace-host',
    zIndex: 99997,
  });

  // Welcome overlay (first-run). Same dev-factory path. zIndex below
  // confirm/edit-workspace so a confirmation popup over a still-visible
  // welcome (theoretical) takes precedence; in practice welcome is the
  // very first overlay a user sees and there's nothing to stack against.
  ensureOverlayHost({
    hostId: 'bento-welcome-host',
    zIndex: 99996,
  });
  ensureOverlayToolbarScrim();

  // Browser-data import shown from onboarding. This frame loads a chrome://
  // Bento host that embeds Firefox's reusable <migration-wizard> component.
  // It must run in-process so the migration JSWindowActor can attach to a
  // built-in chrome document instead of a moz-extension content process.
  ensureOverlayHost({
    hostId: 'bento-embedded-import-host',
    zIndex: 99998,
  });

  // Workspace-switcher overlay. The Mux Menu popover would otherwise
  // be clipped at the sidebar iframe boundary — useless when the rail is
  // collapsed to 4rem. Lifting the menu into a chrome-mounted <browser>
  // lets it render anywhere in the chrome window.
  // zIndex BELOW edit-workspace (99997) so an Edit dialog opened from a
  // menu item correctly overlays the menu while it's still fading out.
  // ABOVE the welcome (99996) since the menu can in principle open while
  // welcome is still mounted (welcome is dismissable but the menu would
  // be the user's natural next action).
  ensureOverlayHost({
    hostId: 'bento-workspace-switcher-host',
    zIndex: 99995,
  });

  ensureOverlayHost({
    hostId: 'bento-panel-navigator-tooltip-host',
    zIndex: 99999,
    // Panel navigator buttons are in #nav-bar, above #browser. Mounting
    // below #browser clips an anchored popup before it reaches the toolbar.
    parentId: null,
  });

  // Floating address/search bar overlay. New overlays use the JS factory
  // so dev reloads pick them up without requiring a browser.xhtml rebuild.
  // Keep this below modal/workspace-management overlays: an empty workspace
  // can auto-focus Firefox's native urlbar, which opens this surface while
  // the workspace palette is still the user's active context.
  ensureOverlayHost({
    hostId: 'bento-addrbar-host',
    zIndex: 99994,
  });

  // Pre-warm: keep the host laid out (display:flex) from chrome init so
  // window.screenLeft inside the overlay frame is accurate from the
  // start. Without this, the first menu open mis-positions: the overlay
  // React app receives the bus payload and re-renders BEFORE chrome's
  // title handler fires showWorkspaceSwitcher(); inside a display:
  // none host, the iframe's content has no laid-out screen position
  // and window.screenLeft returns stale zeros, so the trigger-to-
  // overlay coord translation collapses and the menu ends up at the
  // chrome window's centre.
  // Invisibility + non-interactivity comes from opacity:0 +
  // pointer-events:none — the host stays in the layout tree but
  // intercepts no events and paints nothing visible.
  const wsSwitcherHostInit = document.getElementById('bento-workspace-switcher-host');
  if (wsSwitcherHostInit) {
    wsSwitcherHostInit.style.display = 'flex';
    wsSwitcherHostInit.style.pointerEvents = 'none';
    // opacity:0 and hidden=true already set by ensureOverlayHost defaults.
  }

  const panelNavigatorTooltipHostInit = document.getElementById('bento-panel-navigator-tooltip-host');
  if (panelNavigatorTooltipHostInit) {
    panelNavigatorTooltipHostInit.removeAttribute('hidden');
    panelNavigatorTooltipHostInit.style.display = 'flex';
    panelNavigatorTooltipHostInit.style.pointerEvents = 'none';
    // Unlike modal overlays this host has no backdrop; keep it painted so
    // the transparent frame can show its Mux tooltip popup.
    panelNavigatorTooltipHostInit.style.opacity = '1';
  }

  // ─── Palette overlay show/hide ──────────────────────────────────────────

  // Show/hide toggles the WRAPPER vbox, not the <browser> directly. XUL
  // <browser> ignores CSS sizing properties (width:100% / inset:0) — it
  // expects XUL flex inside a sized parent. The wrapper vbox carries the
  // position:absolute + 100% sizing; the browser inside uses flex="1".
  //
  // Reloading the palette frame on every show resets the React tree so the
  // Dialog re-mounts with isOpen=true. Without this, after a dismiss the
  // next open would show a closed Dialog (transparent overlay).

  function isPaletteVisible(host) {
    return host.style.display !== 'none';
  }

  // Show/hide drives opacity for a smooth fade. We do NOT reload the
  // palette frame on each show — reloading caused a perceptible empty-
  // content flash during the load roundtrip, and the `load` event
  // doesn't fire reliably for our remote=true moz-extension content
  // either. Instead the palette page renders Dialog with isOpen=true
  // permanently; visibility is purely a chrome concern via host
  // display + opacity. The Dialog stays mounted between opens, so
  // subsequent opens have zero React work and only the chrome-side
  // CSS transition runs.

  // Hides a host once its fade-out has finished (its CSS modal transition; no
  // duration is repeated here). Only commits display:none if the host is still
  // hidden: a re-show during the fade cancels the wait (every reveal calls
  // cancelMotion(host, 'hide')), and the opacity check covers a show that
  // raced it. Call right after setting opacity to 0.
  function hideOverlayHostAfterFade(host, afterHide) {
    afterMotion(host, 'hide', { properties: ['opacity'] }, () => {
      if (host.style.opacity !== '0') return;
      host.style.display = 'none';
      host.setAttribute('hidden', 'true');
      afterHide?.();
    });
  }

  // Every show* function reveals its host through this, and sends the messages
  // that belong to the open from inside `reveal`. An overlay whose document does
  // not exist yet or has not announced readiness is not revealed and gets no
  // message: `reveal` waits for the announcement, so the dim, the host fade, the
  // focus and the messages all land on a document that can render and receive
  // them, and it runs at once for a ready overlay. The matching hide* function
  // calls overlays.cancel(id), so a hide that arrives first wins.
  function openOverlay(id, reveal) {
    // The newest open wins: a Cmd+L still waiting for the sidebar row loses to this one.
    cancelAddrbarOpenRequest();
    if (!overlays.open(id, 'show', reveal)) {
      console.warn('[bento-shell-mount] overlay frame unavailable:', id);
    }
  }

  // An overlay is open while its host is shown and also while its open waits for
  // the document. Esc, toggle, outside click, and the stack rules below all go
  // through this, so none of them can miss an open that has not appeared yet and
  // then see it appear.
  function isOverlayOpen(hostId, isVisible, overlayId) {
    const host = document.getElementById(hostId);
    return (!!host && isVisible(host)) || overlays.hasPendingOpen(overlayId);
  }

  // Stack rules close the palette or the merge palette when another overlay
  // opens. They run when that open is requested, not when its document becomes
  // ready, so the newest request wins whichever document loads first. The hide*
  // functions cancel a queued open as well as hiding a shown host.
  function dismissPalette() {
    if (isOverlayOpen('bento-palette-host', isPaletteVisible, 'palette')) hidePalette();
  }

  function dismissMergePalette() {
    if (isOverlayOpen('bento-merge-palette-host', isMergePaletteVisible, 'merge-palette')) {
      hideMergePalette();
    }
  }

  function dismissWorkspacePalette() {
    if (
      isOverlayOpen('bento-workspace-palette-host', isWorkspacePaletteVisible, 'workspace-palette')
    ) {
      hideWorkspacePalette();
    }
  }

  function dismissSettingsPalette() {
    if (isOverlayOpen('bento-settings-palette-host', isSettingsPaletteVisible, 'settings-palette')) {
      hideSettingsPalette();
    }
  }

  function showPalette() {
    const host = document.getElementById('bento-palette-host');
    if (!host) {
      console.warn('[bento-shell-mount] showPalette: bento-palette-host missing');
      return;
    }
    dismissMergePalette();
    dismissSettingsPalette();
    openOverlay('palette', () => {
      showOverlayToolbarScrim('palette');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      // Force a layout pass so the browser registers display:flex BEFORE we
      // set opacity. Without this the opacity change wouldn't transition
      // (CSS doesn't transition from display:none to display:flex).
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-palette-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hidePalette() {
    overlays.cancel('palette');
    const host = document.getElementById('bento-palette-host');
    if (!host) {
      hideOverlayToolbarScrim('palette');
      return;
    }
    hideOverlayToolbarScrim('palette');
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  function togglePalette() {
    const host = document.getElementById('bento-palette-host');
    if (!host) {
      console.warn(
        '[bento-shell-mount] togglePalette: bento-palette-host missing — patch may not be applied',
      );
      return;
    }
    if (isOverlayOpen('bento-palette-host', isPaletteVisible, 'palette')) hidePalette();
    else showPalette();
  }

  // ─── Workspace palette overlay ────────────────────────────────────────
  function isWorkspacePaletteVisible(host) {
    return host.style.display !== 'none';
  }

  function showWorkspacePalette() {
    const host = document.getElementById('bento-workspace-palette-host');
    if (!host) {
      console.warn('[bento-shell-mount] showWorkspacePalette: host missing');
      return;
    }
    dismissPalette();
    dismissSettingsPalette();
    openOverlay('workspace-palette', () => {
      showOverlayToolbarScrim('workspace-palette');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-workspace-palette-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideWorkspacePalette() {
    overlays.cancel('workspace-palette');
    const host = document.getElementById('bento-workspace-palette-host');
    if (!host) {
      hideOverlayToolbarScrim('workspace-palette');
      return;
    }
    hideOverlayToolbarScrim('workspace-palette');
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  // ─── Settings palette overlay ─────────────────────────────────────────
  // The quick-pick Settings surface (extensions/bento-shell/src/settings-palette). One document per
  // window; it talks to bento-tools through the BentoShellBus relay, so it works in private windows.
  function isSettingsPaletteVisible(host) {
    return host.style.display !== 'none';
  }

  // `target` is an optional root row id of the Settings palette ('privacy:level',
  // 'setting:panelCornerRadiusPx'): the document opens there, and on its first list for an unknown id.
  // `origin` is 'palette' when the command palette opened it (a result or its Open Settings command):
  // the document then offers a way back to the command palette. Any other opener passes nothing.
  function showSettingsPalette(target, origin) {
    const host = document.getElementById('bento-settings-palette-host');
    if (!host) {
      console.warn('[bento-shell-mount] showSettingsPalette: host missing');
      return;
    }
    dismissPalette();
    dismissMergePalette();
    dismissWorkspacePalette();
    openOverlay('settings-palette', () => {
      showOverlayToolbarScrim('settings-palette');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      // The show goes out with the reveal, to a document that is listening.
      dispatchSettingsPaletteShow(target, origin);
      const frame = document.getElementById('bento-settings-palette-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideSettingsPalette() {
    overlays.cancel('settings-palette');
    const host = document.getElementById('bento-settings-palette-host');
    hideOverlayToolbarScrim('settings-palette');
    if (!host) return;
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
    // The document stays loaded, so it is told: an unfinished edit is put back and its timer
    // stopped now, not at the next show.
    dispatchSettingsPaletteHide();
  }

  // A command palette result: BENTO_OPEN_SETTING:<id>:<ts>. The id comes from a page's title, so
  // it is checked before it goes on; the Settings document ignores one it does not know.
  // Only the command palette sends it, so Settings opens with that origin.
  function handleSettingsTargetTitle(title) {
    const rest = title.slice(SETTINGS_TARGET_OPEN_PREFIX.length);
    const id = rest.slice(0, Math.max(rest.lastIndexOf(':'), 0));
    showSettingsPalette(SETTINGS_TARGET_ID_PATTERN.test(id) ? id : undefined, 'palette');
  }

  // Firefox's own search settings, for adding engines Bento does not list. A Settings tab that
  // is already open is reused.
  function openFirefoxSearchSettings() {
    const existing = Array.from(window.gBrowser?.browsers || []).find((browser) => {
      const spec = browser.currentURI?.spec || '';
      return spec.startsWith('about:preferences') || spec.startsWith('about:settings');
    });
    if (existing) {
      window.gBrowser.selectedTab = window.gBrowser.getTabForBrowser(existing);
      existing.contentWindow.location.hash = 'search';
    } else {
      window.gBrowser.selectedTab = window.gBrowser.addTrustedTab('about:preferences#search', {
        relatedToCurrent: true,
      });
    }
    window.focus();
  }

  let mergePaletteOpenSeq = 0;

  function nextMergePaletteNonce(kind) {
    mergePaletteOpenSeq += 1;
    return `${kind}-${Date.now()}-${mergePaletteOpenSeq}`;
  }

  function isMergePaletteVisible(host) {
    return host.style.display !== 'none';
  }

  function showMergePalette() {
    const host = document.getElementById('bento-merge-palette-host');
    if (!host) {
      console.warn('[bento-shell-mount] showMergePalette: bento-merge-palette-host missing');
      return;
    }
    dismissPalette();
    dismissSettingsPalette();
    // The rail merge card's tooltip is up when its click opens this; the overlay covers it.
    hidePanelNavigatorTooltip();
    const nonce = nextMergePaletteNonce('open');
    openOverlay('merge-palette', () => {
      showOverlayToolbarScrim('merge-palette');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-merge-palette-frame');
      // The nonce goes out with the reveal, to a document that is listening.
      dispatchMergePaletteLifecycle('open', nonce);
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideMergePalette() {
    overlays.cancel('merge-palette');
    const host = document.getElementById('bento-merge-palette-host');
    const nonce = nextMergePaletteNonce('close');
    dispatchMergePaletteLifecycle('close', nonce);
    if (!host) {
      hideOverlayToolbarScrim('merge-palette');
      return;
    }
    hideOverlayToolbarScrim('merge-palette');
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  function toggleMergePalette() {
    const host = document.getElementById('bento-merge-palette-host');
    if (!host) {
      console.warn(
        '[bento-shell-mount] toggleMergePalette: bento-merge-palette-host missing - patch may not be applied',
      );
      return;
    }
    if (isOverlayOpen('bento-merge-palette-host', isMergePaletteVisible, 'merge-palette')) {
      hideMergePalette();
    } else {
      showMergePalette();
    }
  }

  // ─── Floating address/search bar overlay ──────────────────────────────

  let currentAddrbarMode = 'current';
  let addrbarUrlbarUtils = null;
  let addrbarUrlbarShared = null;
  const ADDRBAR_POPUP_WIDTH_PX = 640;
  const ADDRBAR_POPUP_HEIGHT_PX = 420;
  const ADDRBAR_ANCHORED_POPUP_WIDTH_PX = Math.round(ADDRBAR_POPUP_WIDTH_PX * 0.8);
  const ADDRBAR_ANCHORED_POPUP_HEIGHT_PX = Math.round(ADDRBAR_POPUP_HEIGHT_PX * 0.9);
  const ADDRBAR_FRAME_GUTTER_TOP_PX = 40;
  const ADDRBAR_FRAME_GUTTER_INLINE_PX = 80;
  const ADDRBAR_FRAME_GUTTER_BOTTOM_PX = 140;
  const ADDRBAR_ANCHOR_MARGIN_PX = 12;
  const ADDRBAR_OPEN_RETRY_MS = 120;
  const ADDRBAR_OPEN_RETRY_LIMIT = 8;
  const ADDRBAR_OPEN_FALLBACK_REVEAL_MS = 1400;
  const ADDRBAR_HOST_TRANSITION = 'opacity var(--muxui-semantic-motion-modal-transition)';
  let addrbarOpenSeq = 0;
  let pendingAddrbarReveal = null;
  // The Cmd+L / Cmd+E open waiting for the sidebar row's answer (requestAddrbarOpen).
  let pendingAddrbarOpenRequest = null;
  let addrbarOpenRequestSeq = 0;
  // Whether the anchored palette should be over the sidebar row (the row fades its border out
  // meanwhile), recorded the moment the palette asks, and what the row was last told. A message
  // that cannot be delivered is retried here and every attempt re-reads the wanted value, so only
  // the latest value ever arrives: a retry queued by an open cannot land after the hide that
  // followed it. dispatchSidebarAddressMessage would resend the message it was given, so this
  // kind passes an `attempt` at its retry limit, which sends once and queues no retry.
  const SIDEBAR_ADDRESS_RETRY_LIMIT = 10;
  let addrbarOverSidebarRow = false;
  let addrbarOverSidebarRowSent = false;
  let addrbarOverSidebarRowRetry = null;

  function setAddrbarOverSidebarRow(over) {
    addrbarOverSidebarRow = over;
    syncAddrbarOverSidebarRow();
  }

  function syncAddrbarOverSidebarRow(attempt = 0) {
    if (addrbarOverSidebarRowRetry !== null) clearTimeout(addrbarOverSidebarRowRetry);
    addrbarOverSidebarRowRetry = null;
    const open = addrbarOverSidebarRow;
    if (addrbarOverSidebarRowSent === open) return;
    const sent = dispatchSidebarAddressMessage(
      {
        kind: 'palette-over-row',
        windowId: getChromeWindowId(),
        bridgeToken: getBentoSidebarAddressBridgeToken(),
        messageId: Date.now(),
        open,
      },
      SIDEBAR_ADDRESS_RETRY_LIMIT,
    );
    if (sent) {
      addrbarOverSidebarRowSent = open;
    } else if (attempt < SIDEBAR_ADDRESS_RETRY_LIMIT) {
      addrbarOverSidebarRowRetry = setTimeout(() => syncAddrbarOverSidebarRow(attempt + 1), 100);
    }
  }

  // The sidebar document announces its address channel once per document: a first load, a reload
  // (Alt+Shift+R) or a re-created frame. A new document starts with the row's border showing, so
  // what chrome last sent it is gone with the old one: forget it, and send the wanted state again
  // (true when the palette is open over the row; nothing when it is closed).
  function handleSidebarAddressReadyTitle() {
    addrbarOverSidebarRowSent = false;
    syncAddrbarOverSidebarRow();
  }

  // A Cmd+L / Cmd+E waiting for the sidebar row's answer counts as open, like an open that
  // waits for its document: Esc, an outside click and the other dismissals all ask
  // isOverlayOpen, so they reach hideAddrbar and cancel it instead of missing it and then
  // seeing the palette appear.
  function isAddrbarVisible(host) {
    return host.style.display !== 'none' || pendingAddrbarOpenRequest !== null;
  }

  function nextAddrbarOpenId() {
    addrbarOpenSeq += 1;
    return `${Date.now()}-${addrbarOpenSeq}`;
  }

  function readAddrbarAnchorNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function roundAddrbarPx(value) {
    return Math.round(value * 100) / 100;
  }

  // The popup is the sidebar address row grown: its top-left corner is the row's, so it moves
  // only when the row itself is outside the window. The right and bottom edges keep the margin.
  function computeAddrbarAnchoredPlacement(anchorRect) {
    if (!anchorRect) return null;
    const browser = document.getElementById('browser');
    const shellFrame = document.getElementById('bento-shell-frame');
    const browserRect = browser?.getBoundingClientRect?.();
    const shellRect = shellFrame?.getBoundingClientRect?.();
    if (!browserRect || !shellRect) return null;

    const anchorLeft =
      shellRect.left - browserRect.left + readAddrbarAnchorNumber(anchorRect.left);
    const anchorTop = shellRect.top - browserRect.top + readAddrbarAnchorNumber(anchorRect.top);
    const anchorWidth = Math.max(1, readAddrbarAnchorNumber(anchorRect.width));
    const anchorHeight = Math.max(1, readAddrbarAnchorNumber(anchorRect.height));
    const viewportWidth = Math.max(1, browserRect.width);
    const viewportHeight = Math.max(1, browserRect.height);
    const left = Math.max(0, Math.min(anchorLeft, viewportWidth - anchorWidth));
    const top = Math.max(0, Math.min(anchorTop, viewportHeight - anchorHeight));
    const availableWidth = Math.max(
      anchorWidth,
      viewportWidth - left - ADDRBAR_ANCHOR_MARGIN_PX,
    );
    const width = Math.min(ADDRBAR_ANCHORED_POPUP_WIDTH_PX, availableWidth);
    const height = Math.min(
      ADDRBAR_ANCHORED_POPUP_HEIGHT_PX,
      Math.max(180, viewportHeight - top - ADDRBAR_ANCHOR_MARGIN_PX),
    );
    return {
      left: roundAddrbarPx(left),
      top: roundAddrbarPx(top),
      width: Math.round(width),
      height: Math.round(height),
      anchorWidth: roundAddrbarPx(anchorWidth),
      anchorHeight: roundAddrbarPx(anchorHeight),
    };
  }

  function positionAddrbarHost(host, placement = null) {
    if (placement) {
      host.style.top = '0';
      host.style.left = '0';
      host.style.width = '100%';
      host.style.height = '100%';
      host.style.transform = 'none';
      return;
    }
    const width = ADDRBAR_POPUP_WIDTH_PX + ADDRBAR_FRAME_GUTTER_INLINE_PX * 2;
    const height =
      ADDRBAR_POPUP_HEIGHT_PX + ADDRBAR_FRAME_GUTTER_TOP_PX + ADDRBAR_FRAME_GUTTER_BOTTOM_PX;
    host.style.top = `max(0px, calc(12vh - ${ADDRBAR_FRAME_GUTTER_TOP_PX}px))`;
    host.style.left = '50%';
    host.style.width = `min(${width}px, 100%)`;
    host.style.height = `min(${height}px, 100%)`;
    host.style.transform = 'translateX(-50%)';
  }

  function clearPendingAddrbarReveal() {
    const pending = pendingAddrbarReveal;
    if (!pending) return;
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
    if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
    pendingAddrbarReveal = null;
  }

  function prepareAddrbarHostForOpen(host, placement = null) {
    cancelMotion(host, 'hide');
    const previousTransition = host.style.transition;
    host.style.transition = 'none';
    host.style.pointerEvents = 'none';
    host.style.opacity = '0';
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    void host.getBoundingClientRect();
    positionAddrbarHost(host, placement);
    void host.getBoundingClientRect();
    host.style.transition =
      previousTransition && previousTransition !== 'none'
        ? previousTransition
        : ADDRBAR_HOST_TRANSITION;
  }

  function revealPendingAddrbar(openId) {
    const pending = pendingAddrbarReveal;
    if (!pending || pending.openId !== openId) return;
    if (pending.retryTimer) clearTimeout(pending.retryTimer);
    if (pending.fallbackTimer) clearTimeout(pending.fallbackTimer);
    pendingAddrbarReveal = null;

    const host = document.getElementById('bento-addrbar-host');
    if (!host) return;
    const frame = document.getElementById('bento-addrbar-frame');
    const focusPreservingFrame = pending.focusPreservingFrameId
      ? document.getElementById(pending.focusPreservingFrameId)
      : null;
    host.style.pointerEvents = 'auto';
    host.style.opacity = '1';
    // The row's border fades out as the anchored palette's fades in.
    if (pending.placement) setAddrbarOverSidebarRow(true);
    if (focusPreservingFrame) focusPreservingFrame.focus();
    else frame?.focus();
  }

  function retryPendingAddrbarOpen(openId) {
    const pending = pendingAddrbarReveal;
    if (!pending || pending.openId !== openId) return;
    if (pending.retryCount >= ADDRBAR_OPEN_RETRY_LIMIT) return;
    pending.retryCount += 1;
    dispatchAddrbarOpen(pending.mode, pending.initialQuery, {
      openId: pending.openId,
      suppressFocus: pending.suppressFocus,
      clipboardUrl: pending.clipboardUrl,
      placement: pending.placement,
    });
    pending.retryTimer = setTimeout(
      () => retryPendingAddrbarOpen(openId),
      ADDRBAR_OPEN_RETRY_MS,
    );
  }

  function getAddrbarFocusPreservingFrame() {
    const candidates = [
      ['bento-confirm-host', isConfirmVisible, 'bento-confirm-frame'],
      ['bento-edit-workspace-host', isEditWorkspaceVisible, 'bento-edit-workspace-frame'],
      ['bento-workspace-palette-host', isWorkspacePaletteVisible, 'bento-workspace-palette-frame'],
      ['bento-merge-palette-host', isMergePaletteVisible, 'bento-merge-palette-frame'],
      ['bento-settings-palette-host', isSettingsPaletteVisible, 'bento-settings-palette-frame'],
      ['bento-embedded-import-host', isEmbeddedImportVisible, 'bento-embedded-import-frame'],
      ['bento-welcome-host', isWelcomeVisible, 'bento-welcome-frame'],
      ['bento-workspace-switcher-host', isWorkspaceSwitcherVisible, 'bento-workspace-switcher-frame'],
    ];
    for (const [hostId, isVisible, frameId] of candidates) {
      // An overlay still waiting for its document counts: it will appear over the
      // address bar, so the address bar must not take the focus either.
      const overlayId = overlays.idForFrame(frameId);
      if (overlayId !== null && isOverlayOpen(hostId, isVisible, overlayId)) {
        return document.getElementById(frameId);
      }
    }
    return null;
  }

  function getAddrbarUrlbarUtils() {
    if (addrbarUrlbarUtils) return addrbarUrlbarUtils;
    try {
      const mod = ChromeUtils.importESModule(
        'moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs',
      );
      addrbarUrlbarUtils = mod.UrlbarUtils || null;
    } catch (err) {
      console.warn('[bento-shell-mount] UrlbarUtils import failed:', err);
      addrbarUrlbarUtils = null;
    }
    return addrbarUrlbarUtils;
  }

  function getAddrbarUrlbarShared() {
    if (addrbarUrlbarShared) return addrbarUrlbarShared;
    try {
      const mod = ChromeUtils.importESModule('chrome://browser/content/urlbar/UrlbarShared.mjs');
      addrbarUrlbarShared = mod.UrlbarShared || null;
    } catch (err) {
      console.warn('[bento-shell-mount] UrlbarShared import failed:', err);
      addrbarUrlbarShared = null;
    }
    return addrbarUrlbarShared;
  }

  function readGlobalClipboardText() {
    try {
      const transferable = Cc['@mozilla.org/widget/transferable;1'].createInstance(
        Ci.nsITransferable,
      );
      transferable.init(window.docShell.QueryInterface(Ci.nsILoadContext));
      transferable.addDataFlavor('text/plain');
      Services.clipboard.getData(transferable, Services.clipboard.kGlobalClipboard);

      const data = {};
      transferable.getTransferData('text/plain', data);
      const text = data?.value?.QueryInterface(Ci.nsISupportsString);
      return typeof text?.data === 'string' ? text.data : '';
    } catch {
      return '';
    }
  }

  function sanitizeClipboardUrlText(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > 2048) return '';
    // Firefox 157 moved the sanitizer to UrlbarShared; URI fixup is parent-only,
    // so the caller supplies it from UrlbarUtils.
    const utils = getAddrbarUrlbarUtils();
    const shared = getAddrbarUrlbarShared();
    if (utils && typeof shared?.sanitizeTextFromClipboard === 'function') {
      try {
        const fixupInfo = utils.getFixupPrimitives(raw, BentoPrivateBrowsingUtils.isWindowPrivate(window));
        return String(shared.sanitizeTextFromClipboard(raw, fixupInfo) || '').trim();
      } catch {
        /* fall through to basic line-break sanitizing */
      }
    }
    return raw.replace(/[\r\n]/g, '').trim();
  }

  // Firefox's own clipboard-suggestion setting also governs this Bento
  // suggestion. Read at call time so a pref change applies to the next open,
  // and skip the clipboard read entirely when the setting is off. Only a
  // boolean pref is trusted: getBoolPref(name, default) would return the
  // default for a wrong-typed pref, so check the type first. A missing pref
  // takes Firefox's own default (true, browser/app/profile/firefox.js); any
  // other type, or a failed read, disables the read. Do not gate on
  // browser.urlbar.clipboard.featureGate: that controls Firefox's own
  // provider rollout, not this intentional Bento feature.
  const CLIPBOARD_SUGGEST_PREF = 'browser.urlbar.suggest.clipboard';

  function isClipboardUrlSuggestionEnabled() {
    try {
      switch (Services.prefs.getPrefType(CLIPBOARD_SUGGEST_PREF)) {
        case Services.prefs.PREF_BOOL:
          return Services.prefs.getBoolPref(CLIPBOARD_SUGGEST_PREF);
        case Services.prefs.PREF_INVALID:
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }

  function resolveClipboardUrlSuggestion() {
    if (!isClipboardUrlSuggestionEnabled()) return '';
    const value = sanitizeClipboardUrlText(readGlobalClipboardText());
    if (!value || value.length > 2048 || /\s/.test(value)) return '';
    try {
      const flags =
        Services.uriFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
        Services.uriFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const info = Services.uriFixup.getFixupURIInfo(value, flags);
      if (info.keywordAsSent) return '';
      const uri = info.preferredURI || info.fixedURI;
      if (!uri || (uri.scheme !== 'http' && uri.scheme !== 'https')) return '';
      return uri.spec;
    } catch {
      return '';
    }
  }

  function showAddrbar(mode, initialQuery = '', options = {}) {
    currentAddrbarMode = mode === 'newTab' ? 'newTab' : 'current';
    cancelAddrbarOpenRequest();
    const openId = nextAddrbarOpenId();
    const placement = computeAddrbarAnchoredPlacement(options.anchorRect);
    // A centred open replaces an anchored palette at once, so the row's border returns.
    if (!placement) setAddrbarOverSidebarRow(false);
    let clipboardUrl = '';
    if (typeof options.clipboardUrl === 'string' && options.clipboardUrl) {
      clipboardUrl = options.clipboardUrl;
    } else if (currentAddrbarMode === 'newTab' && !String(initialQuery || '').trim()) {
      clipboardUrl = resolveClipboardUrlSuggestion();
    }
    dismissPalette();
    const host = document.getElementById('bento-addrbar-host');
    if (!host) {
      console.warn('[bento-shell-mount] showAddrbar: bento-addrbar-host missing');
      return;
    }

    const focusPreservingFrame = getAddrbarFocusPreservingFrame();
    clearPendingAddrbarReveal();
    prepareAddrbarHostForOpen(host, placement);
    pendingAddrbarReveal = {
      openId,
      mode: currentAddrbarMode,
      initialQuery,
      suppressFocus: !!focusPreservingFrame,
      clipboardUrl,
      placement,
      focusPreservingFrameId: focusPreservingFrame?.id || '',
      retryCount: 0,
      retryTimer: null,
      fallbackTimer: null,
    };

    // The host is prepared (laid out, invisible, not interactive) at once. The open
    // message goes out on the document's real announcement, since nothing listens
    // before it, and the safety reveal and the resend budget start when it goes
    // out: a timer that started at the request could reveal, and drop, an open
    // whose message was never sent. A prewarmed document is ready, so this runs
    // synchronously; a first open before the prewarm finished waits for the load.
    const sendOpen = () => {
      const pending = pendingAddrbarReveal;
      if (!pending || pending.openId !== openId) return;
      dispatchAddrbarOpen(pending.mode, pending.initialQuery, {
        openId,
        suppressFocus: pending.suppressFocus,
        clipboardUrl: pending.clipboardUrl,
        placement: pending.placement,
      });
      pending.fallbackTimer = setTimeout(
        () => revealPendingAddrbar(openId),
        ADDRBAR_OPEN_FALLBACK_REVEAL_MS,
      );
      pending.retryTimer = setTimeout(
        () => retryPendingAddrbarOpen(openId),
        ADDRBAR_OPEN_RETRY_MS,
      );
    };
    // No frame (its host is gone): send anyway, as it always did.
    if (!overlays.open('addrbar', 'show', sendOpen)) sendOpen();
  }

  function openAddressEntry(mode, initialQuery = '') {
    const nextMode = mode === 'newTab' ? 'newTab' : 'current';
    showAddrbar(nextMode, initialQuery);
  }

  function cancelAddrbarOpenRequest() {
    const pending = pendingAddrbarOpenRequest;
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAddrbarOpenRequest = null;
  }

  // Whether the expanded sidebar's address row can be on screen to open the palette over:
  // not in the rail, hidden (even revealed on edge hover), or mid-push.
  function canAnchorAddrbarToSidebarRow() {
    const host = document.getElementById('bento-shell-host');
    if (!host || isSidebarCollapsedTarget(host) || isSidebarHiddenTarget(host)) return false;
    return !isBentoSidebarPushing();
  }

  // Cmd+L and Cmd+E. Chrome cannot read the row's rect (the shell is a separate frame), so it
  // asks the row over the sidebar address channel; the row answers with the same
  // BENTO_OPEN_ADDRBAR a click sends, plus the request id, anchored when it is shown and
  // without an anchor when it is not. No answer in ADDRBAR_OPEN_RETRY_MS opens the centered
  // palette, and the answer that comes later finds no request and is dropped
  // (takeAddrbarOpenRequest), so an open is neither doubled nor lost. Cmd+T, the New tab
  // action and the native urlbar fallback never ask: they stay centered.
  function requestAddrbarOpen(mode) {
    const nextMode = mode === 'newTab' ? 'newTab' : 'current';
    cancelAddrbarOpenRequest();
    if (nextMode === 'newTab' || !canAnchorAddrbarToSidebarRow()) {
      openAddressEntry(nextMode);
      return;
    }
    addrbarOpenRequestSeq += 1;
    const requestId = `${Date.now()}-${addrbarOpenRequestSeq}`;
    const sent = dispatchSidebarAddressMessage({
      kind: 'open-request',
      windowId: getChromeWindowId(),
      bridgeToken: getBentoSidebarAddressBridgeToken(),
      messageId: Date.now(),
      requestId,
      mode: nextMode,
    });
    if (!sent) {
      openAddressEntry(nextMode);
      return;
    }
    pendingAddrbarOpenRequest = {
      requestId,
      timer: setTimeout(() => {
        if (pendingAddrbarOpenRequest?.requestId !== requestId) return;
        pendingAddrbarOpenRequest = null;
        openAddressEntry(nextMode);
      }, ADDRBAR_OPEN_RETRY_MS),
    };
  }

  // Whether an answer to an open request is still wanted; taking it ends the wait.
  function takeAddrbarOpenRequest(requestId) {
    if (pendingAddrbarOpenRequest?.requestId !== requestId) return false;
    cancelAddrbarOpenRequest();
    return true;
  }

  // An open the sidebar row sent (BENTO_OPEN_ADDRBAR): a click on it, or its answer to
  // requestAddrbarOpen. An answer nobody waits for any more is dropped. An answer is
  // acted on only while the row can still be anchored to: the sidebar may have collapsed or
  // started to hide since the request, and the row's frame-local rect stays positive while
  // it slides away, so the anchor would land on moving or invisible geometry. Then the open
  // is the centered one, with the query the unanswered fallback uses.
  function handleAddrbarOpenAnswer(payload) {
    if (payload.requestId) {
      if (!takeAddrbarOpenRequest(payload.requestId)) return;
      if (payload.anchorRect && !canAnchorAddrbarToSidebarRow()) {
        openAddressEntry(payload.mode);
        return;
      }
    }
    if (payload.anchorRect) {
      showAddrbar(payload.mode, payload.initialQuery, {
        anchorRect: payload.anchorRect,
        clipboardUrl: payload.clipboardUrl,
      });
    } else {
      openAddressEntry(payload.mode, payload.initialQuery);
    }
  }

  function hideAddrbar() {
    overlays.cancel('addrbar');
    cancelAddrbarOpenRequest();
    clearPendingAddrbarReveal();
    setAddrbarOverSidebarRow(false);
    const host = document.getElementById('bento-addrbar-host');
    if (!host) return;
    host.style.pointerEvents = 'none';
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  // ─── Confirm overlay (workspace delete, etc.) ──────────────────────────
  // Same chrome-overlay pattern as the palette: a transparent <browser>
  // sized to fill the window hosts the AlertDialog, so confirm modals are
  // not clipped to the sidebar's bounds. Visibility is driven by sidebar
  // title-IPC (BENTO_OPEN_CONFIRM_*) and confirm-content title-IPC
  // (BENTO_CLOSE_CONFIRM_*). The payload travels independently via the
  // 'bento-confirm-bus' BroadcastChannel.
  function isConfirmVisible(host) {
    return host.style.display !== 'none';
  }

  function showConfirm() {
    const host = document.getElementById('bento-confirm-host');
    if (!host) {
      console.warn('[bento-shell-mount] showConfirm: bento-confirm-host missing');
      return;
    }
    openOverlay('confirm', () => {
      showOverlayToolbarScrim('confirm');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-confirm-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideConfirm() {
    overlays.cancel('confirm');
    const host = document.getElementById('bento-confirm-host');
    if (!host) {
      hideOverlayToolbarScrim('confirm');
      return;
    }
    hideOverlayToolbarScrim('confirm');
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  // ─── Edit-workspace overlay ────────────────────────────────────────────
  // Same chrome-overlay pattern as confirm/palette: a transparent
  // <browser> sized to fill the window hosts the form Dialog. Sidebar
  // never holds modal UI.
  function isEditWorkspaceVisible(host) {
    return host.style.display !== 'none';
  }

  function showEditWorkspace() {
    const host = document.getElementById('bento-edit-workspace-host');
    if (!host) {
      console.warn('[bento-shell-mount] showEditWorkspace: host missing');
      return;
    }
    openOverlay('edit-workspace', () => {
      showOverlayToolbarScrim('edit-workspace');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-edit-workspace-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideEditWorkspace() {
    overlays.cancel('edit-workspace');
    const host = document.getElementById('bento-edit-workspace-host');
    if (!host) {
      hideOverlayToolbarScrim('edit-workspace');
      return;
    }
    hideOverlayToolbarScrim('edit-workspace');
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  // ─── Workspace-switcher overlay ────────────────────────────────────────
  // The Mux Menu popover would otherwise be clipped at the sidebar
  // iframe boundary — useless when the rail is collapsed to 4rem and the
  // menu would render entirely outside the visible sidebar. Lifting it
  // into a chrome-mounted <browser> lets the menu render anywhere in the
  // chrome window. Sidebar's trigger button signals open via title-IPC;
  // the overlay subscribes to the bento-workspace-switcher-bus
  // BroadcastChannel for the trigger's anchor coords.
  //
  // Visibility is opacity-driven (NOT display) — see the prewarm note
  // at the host registration above. No transition timeout to track,
  // because we never flip display.

  function isWorkspaceSwitcherVisible(host) {
    // Visibility is opacity-driven (NOT display) for this overlay so the
    // frame stays laid out from chrome init — see the pre-warm comment
    // at the host registration above.
    return host.style.opacity === '1';
  }

  function showWorkspaceSwitcher() {
    const host = document.getElementById('bento-workspace-switcher-host');
    if (!host) {
      console.warn('[bento-shell-mount] showWorkspaceSwitcher: host missing');
      return;
    }
    openOverlay('workspace-switcher', () => {
      // Display stays 'flex' from the init prewarm — only opacity +
      // pointer-events toggle here. Restoring display:flex would defeat
      // the prewarm's purpose (the frame has to stay laid out so its
      // window.screenLeft is accurate when the React app re-renders).
      host.style.pointerEvents = 'auto';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-workspace-switcher-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideWorkspaceSwitcher() {
    overlays.cancel('workspace-switcher');
    const host = document.getElementById('bento-workspace-switcher-host');
    if (!host) return;
    host.style.opacity = '0';
    host.style.pointerEvents = 'none';
    host.setAttribute('hidden', 'true');
    // No display:none after the transition — see prewarm comment.
  }

  // ─── Welcome overlay (first-run) ───────────────────────────────────────
  // Same chrome-overlay pattern as confirm/palette/edit-workspace. Trigger
  // is one-shot per fresh profile: sidebar inspects settings.welcomeSeen
  // and signals BENTO_OPEN_WELCOME_<ts>; welcome content flips the flag only
  // on final dismiss paths so the import step can show the embedded Firefox
  // migration host without marking onboarding complete.
  // The scrim is a popover strip whose height tracks the toolbar (= the
  // gap above #browser) so it dims exactly the toolbar strip and never
  // overlaps the content backdrop. showPopover()/hidePopover() control
  // top-layer membership; opacity drives the fade.
  function getOverlayToolbarScrimHeight() {
    const browser = document.getElementById('browser');
    const rect = browser?.getBoundingClientRect();
    return Math.max(0, Math.ceil(rect?.top ?? 0));
  }

  function sizeOverlayToolbarScrim(scrim) {
    scrim.style.height = `${getOverlayToolbarScrimHeight()}px`;
  }

  function isOverlayToolbarScrimOpen(scrim) {
    try {
      return scrim.matches(':popover-open');
    } catch {
      return false;
    }
  }

  function createOverlayToolbarScrimLayer() {
    const layer = document.createElement('div');
    layer.setAttribute('data-bento-toolbar-scrim-layer', 'true');
    layer.style.cssText =
      'position: absolute; inset: 0; background-color: var(--scrim, rgba(0, 0, 0, 0.48));' +
      ' opacity: 0; pointer-events: none;' +
      ' transition: opacity var(--muxui-semantic-motion-modal-transition);';
    return layer;
  }

  function syncOverlayToolbarScrimLayers(scrim) {
    // The popover's own background represents the first modal scrim. Extra
    // active modal owners need extra layers so stacked dialogs dim the toolbar
    // by the same amount as their in-document Dialog.Backdrops dim content.
    const targetExtraLayerCount = Math.max(0, activeToolbarScrimOwners.size - 1);
    const layers = Array.from(scrim.querySelectorAll('[data-bento-toolbar-scrim-layer]'));

    while (layers.length < targetExtraLayerCount) {
      const layer = createOverlayToolbarScrimLayer();
      scrim.appendChild(layer);
      layers.push(layer);
    }

    layers.forEach((layer, index) => {
      if (index < targetExtraLayerCount) {
        layer.removeAttribute('data-bento-closing');
        cancelMotion(layer, 'close');
        requestAnimationFrame(() => {
          if (!layer.hasAttribute('data-bento-closing')) layer.style.opacity = '1';
        });
        return;
      }

      if (layer.hasAttribute('data-bento-closing')) return;
      layer.setAttribute('data-bento-closing', 'true');
      layer.style.opacity = '0';
      afterMotion(layer, 'close', { properties: ['opacity'] }, () => {
        if (layer.hasAttribute('data-bento-closing')) layer.remove();
      });
    });
  }

  function showOverlayToolbarScrim(owner) {
    activeToolbarScrimOwners.add(owner);
    const scrim = document.getElementById('bento-overlay-toolbar-scrim');
    if (!scrim) return;
    if (getOverlayToolbarScrimHeight() <= 0) return;
    const wasOpen = isOverlayToolbarScrimOpen(scrim);
    cancelMotion(scrim, 'hide');
    if (!wasOpen) scrim.style.opacity = '0';
    sizeOverlayToolbarScrim(scrim);
    syncOverlayToolbarScrimLayers(scrim);
    if (!wasOpen && typeof scrim.showPopover === 'function') {
      try {
        scrim.showPopover();
      } catch (err) {
        console.warn('[bento-shell-mount] overlay toolbar scrim showPopover failed:', err);
        return;
      }
    }
    void scrim.getBoundingClientRect();
    requestAnimationFrame(() => {
      if (isOverlayToolbarScrimOpen(scrim) && activeToolbarScrimOwners.size > 0) {
        scrim.style.opacity = '1';
      }
    });
  }

  function hideOverlayToolbarScrim(owner) {
    activeToolbarScrimOwners.delete(owner);
    const scrim = document.getElementById('bento-overlay-toolbar-scrim');
    if (!scrim) return;
    if (activeToolbarScrimOwners.size > 0) {
      cancelMotion(scrim, 'hide');
      sizeOverlayToolbarScrim(scrim);
      syncOverlayToolbarScrimLayers(scrim);
      scrim.style.opacity = '1';
      return;
    }
    syncOverlayToolbarScrimLayers(scrim);
    scrim.style.opacity = '0';
    afterMotion(scrim, 'hide', { properties: ['opacity'] }, () => {
      if (
        activeToolbarScrimOwners.size === 0 &&
        scrim.style.opacity === '0' &&
        isOverlayToolbarScrimOpen(scrim)
      ) {
        try {
          scrim.hidePopover();
        } catch (err) {
          console.warn('[bento-shell-mount] overlay toolbar scrim hidePopover failed:', err);
        }
      }
    });
  }

  // Keep the strip aligned to the toolbar while it's visible (window
  // resize / DPI change can shift the toolbar height).
  window.addEventListener('resize', () => {
    const scrim = document.getElementById('bento-overlay-toolbar-scrim');
    if (scrim && isOverlayToolbarScrimOpen(scrim)) {
      sizeOverlayToolbarScrim(scrim);
    }
  });

  function isWelcomeVisible(host) {
    return host.style.display !== 'none';
  }

  // Visible and not fading out: hideWelcome sets opacity 0 at once and hides the host only after
  // the fade, and showWelcome sets it back to 1, so this holds no state of its own.
  function isWelcomeShowing(host) {
    return isWelcomeVisible(host) && host.style.opacity !== '0';
  }

  function showWelcome() {
    const host = document.getElementById('bento-welcome-host');
    if (!host) {
      console.warn('[bento-shell-mount] showWelcome: host missing');
      return;
    }
    openOverlay('welcome', () => {
      showOverlayToolbarScrim('welcome');
      cancelMotion(host, 'hide');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '1';
      const frame = document.getElementById('bento-welcome-frame');
      setTimeout(() => frame?.focus(), 0);
      // The page is subscribed (this runs on its ready signal): start looking for the browsers
      // the Import step offers, so the report is usually there by the time it is reached.
      void sendImportSourcesToWelcome();
    });
  }

  function hideWelcome() {
    overlays.cancel('welcome');
    const host = document.getElementById('bento-welcome-host');
    if (!host) return;
    hideOverlayToolbarScrim('welcome');
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host);
  }

  function isEmbeddedImportVisible(host) {
    return host.style.display !== 'none';
  }

  // ─── Onboarding to import-wizard handoff ───────────────────────────────
  // The wizard runs in #bento-embedded-import-frame, a chrome page in this process; the onboarding
  // dialog is in #bento-welcome-frame, a remote extension page. Both hosts fill #browser, so a
  // rectangle in one is the same rectangle in the other. To read as one card only the import card
  // travels: it appears at the dialog's rectangle with the dialog's surface (the dialog is cut out
  // at that moment) and reshapes to its own; on the way back it returns to the dialog's rectangle
  // and the dialog is cut back in. bento-migration-host.js owns the card (window.bentoImportMorph),
  // the stylesheets own every duration, and afterMotion waits on them. Messages:
  //   welcome page to chrome (titles): BENTO_IMPORT_BROWSER_DATA_<step>_<ts>, with
  //     _<x>_<y>_<w>_<h>_<r>_<vw>_<vh> (dialog rectangle and viewport) when it can morph;
  //     BENTO_WELCOME_HANDOFF_READY_<ts> (dialog content faded out), _HIDDEN_ and _RESTORED_
  //     (acknowledge 'hide' and 'restore' below, once painted).
  //   host page to chrome: BENTO_EMBEDDED_IMPORT_READY_<hostTs> (wizard rendered).
  //   chrome to welcome page (frame script, content.postMessage): { kind: 'bento-welcome-handoff',
  //     phase, token } with phase 'hide' | 'restore' (cut the dialog out | in) | 'reveal' (fade its
  //     content in) | 'fade-out' | 'fade-in' (crossfade: reduced motion, or a window resized
  //     meanwhile) | 'reset' (abandon: the dialog as it was). The same relay carries the Import
  //     step's sources (see "Import sources" below).
  // Out: both pages ready -> card visible over the dialog -> 'hide' -> HIDDEN -> card moves.
  // Back: card moves -> 'restore' -> RESTORED -> host hidden at once -> 'reveal'.
  // Every wait has a ceiling; on timeout, a missing frame script, or a close mid-motion the plain
  // host fade over a restored dialog (the behaviour before the handoff) takes over.
  // A resize at any phase makes the recorded rectangles stale (the dialog recentres, the card's
  // centred rectangle moves): the morph is dropped for the crossfade before either swap.
  const IMPORT_HANDOFF_CEILING_MS = 1500;
  const IMPORT_HANDOFF_HOST_ATTR = 'data-bento-import-handoff';
  const WELCOME_HANDOFF_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'if (!globalThis.__bentoWelcomeHandoffRelayInstalled) {' +
    '  globalThis.__bentoWelcomeHandoffRelayInstalled = true;' +
    '  addMessageListener("BentoWelcomeHandoff", function(msg) {' +
    '    try {' +
    '      content.postMessage(msg.data, "*");' +
    '    } catch (e) {}' +
    '  });' +
    '}';
  const WELCOME_HANDOFF_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(WELCOME_HANDOFF_FRAME_SCRIPT_SRC);
  // The running handoff, or null: { token, hostTs, rect, viewport, mode: 'morph' | 'crossfade',
  // phase: waiting | hiding | opening | open | closing | restoring, hostReady, pageReady, timer,
  // cancels }.
  let importHandoff = null;

  function prefersReducedMotion() {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  // The title's ts and, when the welcome page could measure, the dialog rectangle and viewport.
  // A last part 's-<key>' names the browser to select in the wizard; a key that is not a plain
  // lowercase word is dropped (the wizard page checks it against its own list as well).
  function parseWelcomeImportHandoff(title) {
    const parts = title.slice(WELCOME_IMPORT_BROWSER_DATA_PREFIX.length + 1).split('_');
    const token = /^\d+$/.test(parts[1] ?? '') ? parts[1] : null;
    if (token === null) return null;
    const rest = parts.slice(2);
    const chosen = rest.length > 0 && rest[rest.length - 1].startsWith('s-') ? rest.pop() : '';
    const source = /^s-[a-z0-9-]{1,32}$/.test(chosen) ? chosen.slice(2) : null;
    const valid = rest.length === 7 && rest.every((part) => /^\d+(?:\.\d+)?$/.test(part));
    const [x, y, w, h, r, vw, vh] = valid ? rest.map(Number) : [];
    if (!valid || !(w > 0 && h > 0 && vw > 0 && vh > 0)) {
      return { token, rect: null, viewport: null, source };
    }
    return { token, rect: { x, y, w, h, r }, viewport: { w: vw, h: vh }, source };
  }

  // The host page's card API, or null when that page is not in a handoff.
  function importMorphApi() {
    try {
      const api = document.getElementById('bento-embedded-import-frame')?.contentWindow
        ?.bentoImportMorph;
      return typeof api?.open === 'function' ? api : null;
    } catch {
      return null;
    }
  }

  // Posts `data` to the welcome page as a window message (its 'kind' names it); false when the
  // page cannot be reached. The relay is loaded before each send: it installs once per
  // frame-script global and survives nothing else.
  function postToWelcomePage(data) {
    const messageManager = document.getElementById('bento-welcome-frame')?.messageManager;
    if (!messageManager || typeof messageManager.loadFrameScript !== 'function') return false;
    try {
      messageManager.loadFrameScript(WELCOME_HANDOFF_FRAME_SCRIPT_URL, false);
      messageManager.sendAsyncMessage('BentoWelcomeHandoff', data);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] welcome page message failed:', err);
      return false;
    }
  }

  // Sends a handoff phase to the welcome page; false when it cannot be reached.
  function postWelcomeHandoff(phase, token) {
    return postToWelcomePage({ kind: 'bento-welcome-handoff', phase, token });
  }

  function startImportHandoffTimer(handoff, onTimeout) {
    clearTimeout(handoff.timer);
    handoff.timer = setTimeout(onTimeout, IMPORT_HANDOFF_CEILING_MS);
  }

  // Ends the handoff in chrome and the host page: timers, motion waits, the instant-fade
  // attribute and the card's state. Leaves the welcome page and the host's visibility alone.
  function dropImportHandoff() {
    const handoff = importHandoff;
    if (!handoff) return null;
    importHandoff = null;
    window.removeEventListener('resize', invalidateImportMorph);
    clearTimeout(handoff.timer);
    for (const cancel of handoff.cancels) cancel();
    document
      .getElementById('bento-embedded-import-host')
      ?.removeAttribute(IMPORT_HANDOFF_HOST_ATTR);
    importMorphApi()?.cancel();
    return handoff;
  }
  window.addEventListener('unload', dropImportHandoff, { once: true });

  // Runs `done` when both the card's geometry and its content fade have ended; returns the
  // cancel functions. The content fade can outlast the geometry (it starts partway through).
  function waitForImportMorph(api, done) {
    let pending = 2;
    const finish = () => {
      pending -= 1;
      if (pending === 0) done();
    };
    return [
      afterMotion(api.card, 'import-morph', { properties: ['width'] }, finish),
      afterMotion(api.content, 'import-morph', { properties: ['opacity'] }, finish),
    ];
  }

  // Gives up the choreography: the dialog comes back as it was and the host takes the plain
  // fade (in when the open was waiting, out when the way back was).
  function abandonImportHandoff() {
    const handoff = importHandoff;
    if (!handoff) return;
    if (handoff.phase === 'closing' || handoff.phase === 'restoring') {
      hideEmbeddedBrowserImport();
      return;
    }
    dropImportHandoff();
    postWelcomeHandoff('reset', handoff.token);
    const host = document.getElementById('bento-embedded-import-host');
    if (!host) return;
    host.style.opacity = '1';
    setTimeout(() => document.getElementById('bento-embedded-import-frame')?.focus(), 0);
  }

  // Swaps the running morph for the crossfade, from whatever phase it is in: the card's motion is
  // dropped (it falls back to normal flow, centred in the overlay as it is now) and the dialog
  // fades back in when the wizard closes. In 'waiting' nothing is shown but the dialog with its
  // content faded out, so the crossfade starts here; in 'closing' the dialog is cut out and the
  // way back is the plain crossfade at once. The rest are in the wizard already.
  function takeImportCrossfade(handoff) {
    handoff.mode = 'crossfade';
    clearTimeout(handoff.timer);
    for (const cancel of handoff.cancels) cancel();
    handoff.cancels = [];
    if (handoff.phase === 'closing') {
      hideEmbeddedBrowserImport();
      return;
    }
    const wasWaiting = handoff.phase === 'waiting';
    handoff.phase = 'open';
    importMorphApi()?.cancel();
    const host = document.getElementById('bento-embedded-import-host');
    host?.removeAttribute(IMPORT_HANDOFF_HOST_ATTR);
    if (host) host.style.opacity = '1';
    if (wasWaiting && !postWelcomeHandoff('fade-out', handoff.token)) dropImportHandoff();
  }

  // True when the overlay is no longer the size the dialog was measured in, so the rectangles the
  // morph uses (the dialog's, and the card's centred one) are stale.
  function importViewportChanged(handoff) {
    const view = document.getElementById('bento-embedded-import-frame')?.contentWindow;
    return (
      !!view && (view.innerWidth !== handoff.viewport.w || view.innerHeight !== handoff.viewport.h)
    );
  }

  // Takes the crossfade when the overlay was resized since the click; true when it did. Runs on
  // every resize while a morph is running, and before each swap (a resize event can trail the
  // layout the swap would use). Once the dialog is cut back in ('restoring') it already sits at its
  // new rectangle and the card hides at once, so that phase carries on.
  function invalidateImportMorph() {
    const handoff = importHandoff;
    if (handoff?.mode !== 'morph' || handoff.phase === 'restoring') return false;
    if (!importViewportChanged(handoff)) return false;
    takeImportCrossfade(handoff);
    return true;
  }

  // Both pages are ready: the card goes over the dialog (same rectangle, same surface), then the
  // dialog is cut out. The card's motion waits for the dialog's acknowledgement. A card that cannot
  // take the dialog's rectangle (or a resized overlay) takes the crossfade instead.
  function advanceImportHandoff() {
    const handoff = importHandoff;
    if (!handoff || handoff.phase !== 'waiting' || !handoff.hostReady || !handoff.pageReady) return;
    const host = document.getElementById('bento-embedded-import-host');
    const api = importMorphApi();
    if (!host || !api) {
      abandonImportHandoff();
      return;
    }
    if (invalidateImportMorph()) return;
    if (!api.prepare()) {
      takeImportCrossfade(handoff);
      return;
    }
    handoff.phase = 'hiding';
    host.style.opacity = '1';
    if (!postWelcomeHandoff('hide', handoff.token)) {
      abandonImportHandoff();
      return;
    }
    startImportHandoffTimer(handoff, abandonImportHandoff);
  }

  // The dialog is cut out: the card moves to its own rectangle. The card starts on the host's next
  // frame, so the ceiling timer keeps running until then.
  function openImportMorph() {
    if (invalidateImportMorph()) return;
    const handoff = importHandoff;
    const api = importMorphApi();
    const started = () => {
      if (importHandoff !== handoff) return;
      clearTimeout(handoff.timer);
      handoff.phase = 'opening';
      handoff.cancels = waitForImportMorph(api, () => {
        api.settle();
        document
          .getElementById('bento-embedded-import-host')
          ?.removeAttribute(IMPORT_HANDOFF_HOST_ATTR);
        handoff.phase = 'open';
      });
    };
    if (!handoff || !api?.open(started)) abandonImportHandoff();
  }

  // The wizard closed: the card returns to the dialog's rectangle, then the dialog is cut in.
  function beginImportReturn(handoff, api) {
    const host = document.getElementById('bento-embedded-import-host');
    handoff.phase = 'closing';
    host?.setAttribute(IMPORT_HANDOFF_HOST_ATTR, '');
    startImportHandoffTimer(handoff, abandonImportHandoff);
    const started = () => {
      if (importHandoff !== handoff) return;
      clearTimeout(handoff.timer);
      handoff.cancels = waitForImportMorph(api, () => {
        if (invalidateImportMorph()) return;
        handoff.phase = 'restoring';
        if (!postWelcomeHandoff('restore', handoff.token)) {
          abandonImportHandoff();
          return;
        }
        startImportHandoffTimer(handoff, abandonImportHandoff);
      });
    };
    if (!api.close(started)) abandonImportHandoff();
  }

  // The dialog is showing again under the identical card: hide the host at once, then let the
  // dialog's content fade in.
  function finishImportReturn() {
    const handoff = importHandoff;
    if (!handoff) return;
    hideEmbeddedBrowserImport({ restored: true });
    postWelcomeHandoff('reveal', handoff.token);
  }

  function handleWelcomeHandoffTitle(title) {
    const [kind, token] = title.slice(WELCOME_HANDOFF_PREFIX.length + 1).split('_');
    const handoff = importHandoff;
    if (!handoff || handoff.token !== token) return;
    if (kind === 'READY' && handoff.phase === 'waiting') {
      handoff.pageReady = true;
      advanceImportHandoff();
    } else if (kind === 'HIDDEN' && handoff.phase === 'hiding') {
      openImportMorph();
    } else if (kind === 'RESTORED' && handoff.phase === 'restoring') {
      finishImportReturn();
    }
  }

  function handleEmbeddedImportReadyTitle(title) {
    const handoff = importHandoff;
    if (!handoff || handoff.phase !== 'waiting') return;
    if (title.slice(EMBEDDED_IMPORT_READY_PREFIX.length + 1) !== handoff.hostTs) return;
    handoff.hostReady = true;
    advanceImportHandoff();
  }

  // ─── Import sources ────────────────────────────────────────────────────
  // The onboarding Import step shows a tile for each browser Firefox's migrators can import from,
  // with its logo, and one Firefox or Zen tile when a Mozilla Firefox or Zen profile exists. This
  // finds them: once, when onboarding opens (showWelcome), cached for the window, and sent to the
  // welcome page through the relay above as
  //   { kind: 'bento-import-sources', status: 'ready', browsers: [{ key, logo }], firefoxZen }
  // or { kind: 'bento-import-sources', status: 'failed' } (an error, or no answer within
  // IMPORT_SOURCES_CEILING_MS). `logo` is a PNG data URL, because the page cannot load chrome://
  // images, or null. The page asks again with BENTO_IMPORT_SOURCES_REQUEST_<ts> when it reaches
  // the step without a report (it reloaded, or was not listening yet), and its Firefox or Zen tile
  // sends BENTO_IMPORT_FIREFOX_ZEN_<step>_<ts>, which takes the restart path the wizard's own
  // Firefox or Zen action takes.
  // Availability is the wizard's own test, so a tile is a browser the wizard would list.
  // MigrationUtils.getMigrator(key) is not that test: it returns a migrator whenever the source has
  // data or lacks permissions, but it tests canGetPermissions() without awaiting it (a Promise is
  // always truthy), so it also returns every Chromium browser whose data folder exists without a
  // readable 'Local State' (a native-messaging-host folder left by a password manager is enough).
  // wizardListsMigrator applies what MigrationWizardParent adds: the migrator is enabled
  // (browser.migrate.<key>.enabled), and either it can get permissions (Safari asks after the user
  // picks it) or it has profiles to read. Firefox and Zen are startup-only migrators: getMigrator
  // never returns them in a running window, and their getSourceProfiles needs the startup profile,
  // so they are found by their profile registries (getAllProfiles) instead.
  const IMPORT_SOURCE_BROWSER_KEYS = ['chrome', 'safari', 'chromium-edge', 'brave', 'vivaldi', 'opera'];
  const IMPORT_SOURCES_CEILING_MS = 3000;
  // The tile shows a logo at 20 CSS px; 48 px covers a 2x display.
  const IMPORT_SOURCE_LOGO_PX = 48;
  const IMPORT_SOURCES_FAILED = { kind: 'bento-import-sources', status: 'failed' };
  let importSourcesDetection = null;

  // A migrator's brand image (a chrome:// PNG) as a PNG data URL at the tile's size, or null.
  async function readImportBrandLogo(url) {
    if (typeof url !== 'string') return null;
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = IMPORT_SOURCE_LOGO_PX;
      canvas.height = IMPORT_SOURCE_LOGO_PX;
      const context = canvas.getContext('2d');
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, 0, 0, IMPORT_SOURCE_LOGO_PX, IMPORT_SOURCE_LOGO_PX);
      return canvas.toDataURL('image/png');
    } catch (err) {
      console.warn('[bento-shell-mount] import source logo unreadable:', url, err);
      return null;
    }
  }

  async function wizardListsMigrator(migrator) {
    if (!migrator?.enabled) return false;
    if (!(await migrator.hasPermissions())) return !!(await migrator.canGetPermissions());
    const profiles = await migrator.getSourceProfiles();
    // null is a source without a profile list (Safari, an Opera without profiles): it has data.
    return Array.isArray(profiles) ? profiles.length > 0 : true;
  }

  async function detectImportBrowser(MigrationUtils, key) {
    const migrator = await MigrationUtils.getMigrator(key);
    if (!(await wizardListsMigrator(migrator))) return null;
    return { key, logo: await readImportBrandLogo(migrator.constructor.brandImage) };
  }

  // True when Mozilla Firefox or Zen has a readable profile (Bento's patch adds the Zen migrator).
  async function hasFirefoxZenProfile() {
    const { FirefoxProfileMigrator, ZenProfileMigrator } = ChromeUtils.importESModule(
      'resource:///modules/FirefoxProfileMigrator.sys.mjs',
    );
    // Each registry is checked on its own: one that throws must not hide a profile in the other.
    for (const Migrator of [FirefoxProfileMigrator, ZenProfileMigrator]) {
      try {
        if (Migrator && (await new Migrator().getAllProfiles()).size > 0) return true;
      } catch (err) {
        console.warn('[bento-shell-mount] Firefox or Zen profile check failed:', Migrator?.name, err);
      }
    }
    return false;
  }

  async function detectImportSources() {
    const { MigrationUtils } = ChromeUtils.importESModule(
      'resource:///modules/MigrationUtils.sys.mjs',
    );
    const [browsers, firefoxZen] = await Promise.all([
      Promise.all(IMPORT_SOURCE_BROWSER_KEYS.map((key) => detectImportBrowser(MigrationUtils, key))),
      hasFirefoxZenProfile().catch((err) => {
        console.warn('[bento-shell-mount] Firefox or Zen profile check failed:', err);
        return false;
      }),
    ]);
    return {
      kind: 'bento-import-sources',
      status: 'ready',
      browsers: browsers.filter(Boolean),
      firefoxZen,
    };
  }

  // The cached report, found on the first call; always resolves (to the failed report on an error
  // or when the ceiling passes first).
  function startImportSourceDetection() {
    importSourcesDetection ??= Promise.race([
      detectImportSources().catch((err) => {
        console.warn('[bento-shell-mount] import source detection failed:', err);
        return IMPORT_SOURCES_FAILED;
      }),
      new Promise((resolve) => {
        setTimeout(() => resolve(IMPORT_SOURCES_FAILED), IMPORT_SOURCES_CEILING_MS);
      }),
    ]);
    return importSourcesDetection;
  }

  async function sendImportSourcesToWelcome() {
    postToWelcomePage(await startImportSourceDetection());
  }

  // `request` is parseWelcomeImportHandoff's result: null (an import title without a ts) or
  // without a rectangle means the plain fade; `request.source` is the browser to select.
  function showEmbeddedBrowserImportFromWelcome(request = null) {
    const host = document.getElementById('bento-embedded-import-host');
    // First use creates the chrome-hosted <browser>; it has no readiness
    // handshake, so it is ready as soon as it exists.
    const frame = host ? overlays.ensure('embedded-import', 'show') : null;
    if (!host || !frame) {
      console.warn('[bento-shell-mount] embedded import host missing; falling back to restart');
      restartToBrowserImportFromWelcome();
      return;
    }

    try {
      ChromeUtils.importESModule('resource:///modules/MigrationUtils.sys.mjs');
    } catch (err) {
      console.warn('[bento-shell-mount] MigrationUtils import failed; falling back to restart:', err);
      restartToBrowserImportFromWelcome();
      return;
    }

    // A handoff already owns the host: a repeated request changes nothing.
    if (importHandoff) return;
    cancelMotion(host, 'hide');

    if (request?.rect && !prefersReducedMotion()) {
      const handoff = (importHandoff = {
        token: request.token,
        hostTs: String(Date.now()),
        rect: request.rect,
        viewport: request.viewport,
        mode: 'morph',
        phase: 'waiting',
        hostReady: false,
        pageReady: false,
        timer: null,
        cancels: [],
      });
      window.addEventListener('resize', invalidateImportMorph);
      // Load and lay the host out invisibly; it is shown when both pages are ready.
      setBentoEmbeddedImportSrc({ handoff, migrator: request.source });
      host.setAttribute(IMPORT_HANDOFF_HOST_ATTR, '');
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      void host.getBoundingClientRect();
      host.style.opacity = '0';
      startImportHandoffTimer(handoff, abandonImportHandoff);
      setTimeout(() => frame.focus(), 0);
      return;
    }

    setBentoEmbeddedImportSrc({ migrator: request?.source });
    host.style.display = 'flex';
    host.removeAttribute('hidden');
    void host.getBoundingClientRect();
    host.style.opacity = '1';
    setTimeout(() => frame.focus(), 0);
    // Reduced motion: the dialog crossfades with the host instead of staying under it.
    if (request && prefersReducedMotion() && postWelcomeHandoff('fade-out', request.token)) {
      importHandoff = {
        token: request.token,
        mode: 'crossfade',
        phase: 'open',
        timer: null,
        cancels: [],
      };
    }
  }

  // The wizard closed (Cancel or Done). After a morph the card returns to the dialog's rectangle;
  // after a crossfade, or when the window was resized meanwhile (the recorded rectangle no longer
  // fits), the dialog crossfades back; with no handoff it is the plain fade.
  function closeEmbeddedBrowserImport() {
    const handoff = importHandoff;
    if (handoff?.phase === 'open' && handoff.mode === 'morph' && !invalidateImportMorph()) {
      const api = importMorphApi();
      if (api) {
        beginImportReturn(handoff, api);
        return;
      }
      handoff.mode = 'crossfade';
    }
    hideEmbeddedBrowserImport();
  }

  // Hides the host (a fade, or at once when `restored`: the dialog is showing under the identical
  // card) and returns the dialog to the state it had before the import, unless it already did.
  function hideEmbeddedBrowserImport({ restored = false } = {}) {
    const handoff = dropImportHandoff();
    const host = document.getElementById('bento-embedded-import-host');
    if (!host) return;
    if (handoff && !restored) {
      postWelcomeHandoff(handoff.mode === 'crossfade' ? 'fade-in' : 'reset', handoff.token);
    }
    host.toggleAttribute(IMPORT_HANDOFF_HOST_ATTR, restored);
    host.style.opacity = '0';
    hideOverlayHostAfterFade(host, () => {
      host.removeAttribute(IMPORT_HANDOFF_HOST_ATTR);
      const frame = document.getElementById('bento-embedded-import-frame');
      frame?.removeAttribute('src');
      const welcomeFrame = document.getElementById('bento-welcome-frame');
      setTimeout(() => welcomeFrame?.focus(), 0);
    });
  }

  // scopeFirefoxZen=true is the explicit "Import Firefox or Zen" path: it
  // scopes the post-restart startup wizard to Firefox/Zen so it lands
  // preselected on them instead of defaulting to Chrome and re-listing the
  // runtime browsers. The generic fallback path (embedded runtime wizard
  // unavailable) passes false so the startup wizard still offers every
  // browser, including Chrome.
  function restartToBrowserImportFromWelcome(scopeFirefoxZen = false) {
    hideEmbeddedBrowserImport();
    hideWelcome();
    try {
      Services.env.set('BENTO_RESTART_TO_MIGRATION', '1');
      // Read + honored by MigrationWizardParent's #getMigratorAndProfiles
      // (only while isStartupMigration is true).
      Services.env.set('BENTO_MIGRATION_SCOPE', scopeFirefoxZen ? 'firefox-zen' : '');
      Services.env.set(BENTO_WELCOME_STEP_ENV, __bentoPendingWelcomeResumeStep);
      Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit | Ci.nsIAppStartup.eRestart);
    } catch (err) {
      Services.env.set('BENTO_RESTART_TO_MIGRATION', '');
      Services.env.set('BENTO_MIGRATION_SCOPE', '');
      Services.env.set(BENTO_WELCOME_STEP_ENV, '');
      console.warn('[bento-shell-mount] restart to browser import failed:', err);
      try {
        const { MigrationUtils } = ChromeUtils.importESModule(
          'resource:///modules/MigrationUtils.sys.mjs',
        );
        MigrationUtils.showMigrationWizard(window, {
          entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.NEWTAB,
        });
      } catch (fallbackErr) {
        console.warn('[bento-shell-mount] fallback migration wizard failed:', fallbackErr);
      }
    }
  }

  // ─── Generic chrome-menu overlay ───────────────────────────────────────
  // showChromeMenu({ anchor, items, onSelect, placement }) opens a Mux Menu over
  // the entire chrome window, positioned next to `anchor` (a DOMRect-ish
  // {left, top, width, height} from the trigger element's
  // getBoundingClientRect). Each open generates a unique contextId so
  // overlapping opens (or rapid open→select sequences) route their
  // results back to the right handler. The map cleanup happens on the
  // first SELECT/CLOSE title-IPC we observe for that contextId.
  //
  // No fade transition (unlike palette/confirm) — menus should feel
  // instant. The React side stays mounted and updates state on
  // BroadcastChannel 'menu/open' actions; chrome just toggles host
  // display.
  const menuOnSelectByContext = new Map();
  // The contextId of the open that waits for the menu document, if any.
  let pendingMenuContextId = null;

  function showChromeMenu({ anchor, items, onSelect, placement }) {
    const host = document.getElementById('bento-menu-host');
    if (!host) {
      console.warn('[bento-shell-mount] showChromeMenu: bento-menu-host missing');
      return;
    }
    if (!anchor || !Array.isArray(items)) {
      console.warn('[bento-shell-mount] showChromeMenu: bad args', { anchor, items });
      return;
    }
    const contextId = 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    if (typeof onSelect === 'function') menuOnSelectByContext.set(contextId, onSelect);
    // A newer request replaces an older one that is still waiting for the
    // document, so the older handler can never be called.
    if (pendingMenuContextId !== null) menuOnSelectByContext.delete(pendingMenuContextId);
    pendingMenuContextId = contextId;
    // The menu document hears the payload over the bus, which does not queue, so
    // the host is revealed and the payload sent together, on the document's real
    // announcement and not before (openOverlay).
    openOverlay('menu', () => {
      pendingMenuContextId = null;
      host.style.display = 'flex';
      host.removeAttribute('hidden');
      // Translate the trigger's chrome-document coords into menu-overlay
      // coords. The overlay frame fills #bento-menu-host (which lives
      // inside <hbox id="browser">, BELOW the chrome toolbar/tabstrip);
      // position:fixed inside the overlay is relative to the overlay's
      // own viewport, NOT the chrome document. Without this translation
      // the menu floats roughly one toolbar-height below the trigger.
      const hostRect = host.getBoundingClientRect();
      const adjustedAnchor = {
        left: anchor.left - hostRect.left,
        top: anchor.top - hostRect.top,
        width: anchor.width,
        height: anchor.height,
      };
      // Send the open payload over the shell bus. The menu page's React
      // listens for kind:'action' messages with action.type==='menu/open'.
      dispatchShellAction({
        type: 'menu/open',
        contextId,
        items,
        anchor: adjustedAnchor,
        placement,
      });
      const frame = document.getElementById('bento-menu-frame');
      setTimeout(() => frame?.focus(), 0);
    });
  }

  function hideChromeMenu() {
    overlays.cancel('menu');
    // An open that never reached the document has no SELECT or CLOSE to come.
    if (pendingMenuContextId !== null) {
      menuOnSelectByContext.delete(pendingMenuContextId);
      pendingMenuContextId = null;
    }
    const host = document.getElementById('bento-menu-host');
    if (!host) return;
    host.style.display = 'none';
    host.setAttribute('hidden', 'true');
  }

  // Cross-process IPC via document.title + 'pagetitlechanged'. Content in a
  // remote=true <browser> can't postMessage to the chrome process, but
  // top-level title changes are forwarded to the parent, which dispatches
  // 'pagetitlechanged' on the chrome <browser> element (see
  // attachPaletteCloseListener). Sidebar/palette content set document.title
  // to a sentinel-prefixed string with timestamp suffix; chrome reacts there.
  // Timestamp matters because the parent drops a title identical to the
  // current one — same value twice would be silent.
  const PALETTE_OPEN_PREFIX = 'BENTO_OPEN_PALETTE';
  const PALETTE_CLOSE_PREFIX = 'BENTO_CLOSE_PALETTE';
  const WORKSPACE_PALETTE_OPEN_PREFIX = 'BENTO_OPEN_WORKSPACE_PALETTE';
  const WORKSPACE_PALETTE_CLOSE_PREFIX = 'BENTO_CLOSE_WORKSPACE_PALETTE';
  const MERGE_PALETTE_OPEN_PREFIX = 'BENTO_OPEN_MERGE_PALETTE';
  const MERGE_PALETTE_CLOSE_PREFIX = 'BENTO_CLOSE_MERGE_PALETTE';
  const SETTINGS_OPEN_PREFIX = 'BENTO_OPEN_SETTINGS_';
  const SETTINGS_PRIVACY_OPEN_PREFIX = 'BENTO_OPEN_SETTINGS_PRIVACY_';
  // BENTO_OPEN_SETTING:<root row id of the Settings palette>:<ts>, from a command palette result.
  // It does not start with SETTINGS_OPEN_PREFIX (no 'S' after 'SETTING'), so route order is free.
  const SETTINGS_TARGET_OPEN_PREFIX = 'BENTO_OPEN_SETTING:';
  const SETTINGS_TARGET_ID_PATTERN = /^[A-Za-z0-9:_-]{1,64}$/;
  const SETTINGS_PALETTE_CLOSE_PREFIX = 'BENTO_CLOSE_SETTINGS_PALETTE';
  // The Settings document's back button at its root, when the command palette opened it: hide
  // Settings and show the command palette again, which still holds its query.
  const SETTINGS_BACK_TO_PALETTE_PREFIX = 'BENTO_SETTINGS_BACK_TO_PALETTE';
  const FIREFOX_SEARCH_SETTINGS_OPEN_PREFIX = 'BENTO_OPEN_FIREFOX_SEARCH_SETTINGS';
  const APP_MENU_OPEN_PREFIX = 'BENTO_OPEN_APP_MENU:';
  const DOWNLOADS_OPEN_PREFIX = 'BENTO_OPEN_DOWNLOADS:';
  const DOWNLOADS_ANCHOR_PREFIX = 'BENTO_DOWNLOADS_ANCHOR:';
  const RAIL_TOOLTIP_PREFIX = 'BENTO_RAIL_TOOLTIP:';
  const SIDEBAR_FOOTER_PANEL_POSITION = 'topleft bottomleft';
  const ADDRBAR_OPEN_PREFIX = 'BENTO_OPEN_ADDRBAR:';
  const ADDRBAR_CLOSE_PREFIX = 'BENTO_CLOSE_ADDRBAR';
  const ADDRBAR_READY_PREFIX = 'BENTO_ADDRBAR_READY';
  const ADDRBAR_NAVIGATE_PREFIX = 'BENTO_ADDRBAR_NAVIGATE';
  const SIDEBAR_ADDRESS_SUBMIT_PREFIX = 'BENTO_SIDEBAR_ADDRESS_SUBMIT:';
  const SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX = 'BENTO_SIDEBAR_ADDRESS_BOOKMARK_TOGGLE:';
  const SIDEBAR_ADDRESS_IDENTITY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_IDENTITY:';
  const SIDEBAR_ADDRESS_COPY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_COPY:';
  // Once per sidebar document, after it subscribed to the address channel (bridge/useSidebarAddress.ts).
  const SIDEBAR_ADDRESS_READY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_READY:';
  // Same pattern for the confirm overlay (workspace deletion, etc.). The
  // confirm payload itself travels via BroadcastChannel('bento-confirm-bus')
  // — the title is just the visibility signal.
  const CONFIRM_OPEN_PREFIX = 'BENTO_OPEN_CONFIRM';
  const CONFIRM_CLOSE_PREFIX = 'BENTO_CLOSE_CONFIRM';
  // Same pattern for the edit-workspace overlay (rename/recolor/icon).
  // Payload travels via BroadcastChannel('bento-edit-workspace-bus').
  const EDIT_WORKSPACE_OPEN_PREFIX = 'BENTO_OPEN_EDIT_WORKSPACE';
  const EDIT_WORKSPACE_CLOSE_PREFIX = 'BENTO_CLOSE_EDIT_WORKSPACE';
  // Welcome overlay (first-run). No payload — sidebar's App.tsx reads
  // settings.welcomeSeen and signals BENTO_OPEN_WELCOME_<ts> the first
  // time it sees false; final welcome dismiss paths flip the flag + signal
  // BENTO_CLOSE_WELCOME_<ts>, except the Ready step's Open Settings, which
  // flips the flag and signals BENTO_OPEN_SETTINGS_<ts> alone (title IPC is
  // last-write-wins, so no close title follows): the welcome frame's handler
  // hides the overlay and opens Settings, as the palette's does, but only while
  // the dialog is showing (isWelcomeShowing), so a repeat during the fade does
  // nothing and a later reopen works with no page state. The import action signals
  // BENTO_IMPORT_BROWSER_DATA_<nextStep>_<ts> without flipping the flag, which
  // opens the embedded Firefox migration host above the still-mounted welcome
  // flow.
  const WELCOME_OPEN_PREFIX = 'BENTO_OPEN_WELCOME';
  const WELCOME_CLOSE_PREFIX = 'BENTO_CLOSE_WELCOME';
  const WELCOME_IMPORT_BROWSER_DATA_PREFIX = 'BENTO_IMPORT_BROWSER_DATA';
  const EMBEDDED_IMPORT_CLOSE_PREFIX = 'BENTO_CLOSE_EMBEDDED_IMPORT';
  const EMBEDDED_IMPORT_RESTART_PREFIX = 'BENTO_RESTART_EMBEDDED_IMPORT';
  // The onboarding dialog and the import card swap at one rectangle (see the handoff section
  // above showEmbeddedBrowserImportFromWelcome). The welcome page reports
  // BENTO_WELCOME_HANDOFF_<READY|HIDDEN|RESTORED>_<ts>, the host page
  // BENTO_EMBEDDED_IMPORT_READY_<ts of its URL>.
  const WELCOME_HANDOFF_PREFIX = 'BENTO_WELCOME_HANDOFF';
  // The Import step's sources: the page asks for the report, and its Firefox or Zen tile restarts
  // Bento into the startup import (see "Import sources" above showEmbeddedBrowserImportFromWelcome).
  const WELCOME_IMPORT_SOURCES_REQUEST_PREFIX = 'BENTO_IMPORT_SOURCES_REQUEST';
  const WELCOME_IMPORT_FIREFOX_ZEN_PREFIX = 'BENTO_IMPORT_FIREFOX_ZEN';
  const EMBEDDED_IMPORT_READY_PREFIX = 'BENTO_EMBEDDED_IMPORT_READY';
  // Workspace-switcher menu overlay. Anchor coords travel via
  // BroadcastChannel('bento-workspace-switcher-bus') — title is just the
  // visibility signal.
  const WORKSPACE_SWITCHER_OPEN_PREFIX = 'BENTO_OPEN_WORKSPACE_SWITCHER';
  const WORKSPACE_SWITCHER_CLOSE_PREFIX = 'BENTO_CLOSE_WORKSPACE_SWITCHER';
  // Generic chrome-menu overlay. Items, anchor, and a routing contextId
  // travel from chrome into the menu page via a 'menu/open' shell-bus
  // action; the menu page reports back via these title prefixes which
  // include the contextId so chrome can find the right onSelect handler:
  //   BENTO_MENU_SELECT:<contextId>:<itemId>
  //   BENTO_MENU_CLOSE:<contextId>
  const MENU_SELECT_PREFIX = 'BENTO_MENU_SELECT:';
  const MENU_CLOSE_PREFIX = 'BENTO_MENU_CLOSE:';
  // Sidebar-driven scroll-to-main signal. Fires on every sidebar
  // tab-row click (including re-clicks on the active tab) so the
  // strip always returns to the main slot — see
  // handleScrollToMainTitle for the rationale.
  const SCROLL_TO_MAIN_PREFIX = 'BENTO_SCROLL_TO_MAIN_';
  // Sidebar context menu request. The sidebar cannot render menus
  // outside its own remote <browser> bounds, so it sends a serialized
  // menu request here and chrome renders it in #bento-menu-host.
  const SIDEBAR_CONTEXT_MENU_PREFIX = 'BENTO_SIDEBAR_CONTEXT_MENU:';
  // Sidebar multi-selection state. Cmd/Ctrl+W is a reserved chrome
  // shortcut, so the sidebar mirrors selected tab ids here and chrome's
  // capture listener performs the batch close before Firefox closes only
  // the active tab.
  const SELECTED_TABS_PREFIX = 'BENTO_SELECTED_TABS:';
  // Panel-trailer context menu request. Same title-IPC pattern as the
  // sidebar because the trailer is its own remote extension frame.
  const PANEL_TRAILER_CONTEXT_MENU_PREFIX = 'BENTO_PANEL_TRAILER_CONTEXT_MENU:';
  const PANEL_TRAILER_ADD_BLANK_PREFIX = 'BENTO_PANEL_TRAILER_ADD_BLANK:';
  // Sidebar-driven scroll-into-view + focus signal for a specific
  // panel. Fired by the PinnedPanels row click after the workspace
  // activation dispatches. Format: BENTO_FOCUS_PANEL:<ts>:<tabId>.
  // See handleFocusPanelTitle for the retry rationale (workspace
  // reconcile can run after the title write lands).
  const FOCUS_PANEL_PREFIX = 'BENTO_FOCUS_PANEL:';
  // Multi-panel reconciliation. Title format from sidebar:
  //   BENTO_PANELS:<ts>:<base64-of-json-array>
  // where the JSON array is [{tabId, url}, ...] for the active workspace.
  // Empty array hides the strip; non-empty rebuilds it via the
  // reconcilePanels() diff. Base64 because URLs can contain delimiter
  // chars; timestamp ensures repeated identical states still trigger
  // the title-change event.
  const PANELS_PREFIX = 'BENTO_PANELS:';

  // Color-mode IPC. Title format: BENTO_COLOR_MODE:<ts>:<light|dark|system>
  // The shell sets this on settings/changed; the active BENTO_PANELS
  // payload also carries the same uiColorMode field as a self-correcting
  // backstop in case this dedicated message races with a panels/sync.
  const COLOR_MODE_PREFIX = 'BENTO_COLOR_MODE:';
  // Legacy per-workspace theme IPC. Current sidebar builds carry themeId
  // inside BENTO_PANELS so it lands atomically with uiColorMode; this
  // standalone handler remains for older shell documents and diagnostics.
  const THEME_PREFIX = 'BENTO_THEME:';
  // Sidebar drag-to-reorder. Title format:
  //   BENTO_TAB_MOVE:<ts>:<srcTabId>:<anchorTabId>:<before|after>
  // Calls gBrowser.moveTabBefore / moveTabAfter so the dragged tab lands
  // immediately before/after the anchor. browser.tabs.move would route
  // through Firefox's moveTabTo which does `element = element.splitview`
  // and then throws on Bento's plain-object splitview marker — chrome's
  // moveTabBefore/After skip that transformation and preserve tab
  // identity, so dragging the currently-active (panel-marked) tab works.
  const TAB_MOVE_PREFIX = 'BENTO_TAB_MOVE:';
  let currentSidebarSelectedTabIds = [];

  // Drive the public Mux color-mode cascade in chrome by setting explicit
  // data-color-mode on the chrome window's <window> root.
  // public mode selectors are rewritten from `html` to `:root` by
  // scripts/generate-chrome-tokens.mjs, so the same cascade that flips shell
  // tokens flips chrome tokens. 'system' is stored as Auto but resolved here
  // to light/dark because native chrome renders an explicit mode.
  let chromeColorModePref = null;
  const BENTO_UI_COLOR_MODE_TOPIC = 'bento-ui-color-mode';
  function resolveChromeColorMode(mode) {
    if (mode === 'system') {
      if (typeof window.matchMedia !== 'function') return 'dark';
      return window.matchMedia(CHROME_DARK_QUERY).matches ? 'dark' : 'light';
    }
    if (mode === 'light' || mode === 'dark') return mode;
    return null;
  }
  // A light/dark flip fades every colour of the window together: this attribute turns on the
  // catch-all rule in bento-chrome-theme.css while the flip runs. It goes on in the same task
  // as the mode and comes off only after the fade has ended (dropping the rule mid-fade cancels
  // the running transitions). A flip that was heard before its time goes on at once with
  // BENTO_MODE_FADE_DELAY_PROPERTY holding the transitions until then (prepareChromeColorFlip).
  // The shell's twin is theme/modeFade.ts; keep them in step.
  const BENTO_MODE_FADE_ATTR = 'data-bento-mode-fade';
  const BENTO_MODE_FADE_DELAY_PROPERTY = '--bento-mode-fade-delay';
  // A window that hears of a flip up to this long after its time joins the fade part-way (a
  // negative delay); one that hears of it later fades from the start.
  const BENTO_FLIP_CATCH_UP_MAX_MS = 60;
  let chromeColorModeApplied = false;
  function removeChromeModeFade(root) {
    root.removeAttribute(BENTO_MODE_FADE_ATTR);
    root.style.removeProperty(BENTO_MODE_FADE_DELAY_PROPERTY);
  }
  // A hidden window gets no frames to measure or end a fade by, so one that hides during a fade,
  // however it joined it (prepared early, or late), drops the fade and its delay at once.
  let chromeFadeHideListener = null;
  function unwatchChromeFadeVisibility() {
    if (chromeFadeHideListener) {
      document.removeEventListener('visibilitychange', chromeFadeHideListener);
      chromeFadeHideListener = null;
    }
  }
  function endChromeModeFade(root) {
    unwatchChromeFadeVisibility();
    cancelMotion(root, BENTO_MODE_FADE_ATTR);
    removeChromeModeFade(root);
  }
  function writeChromeColorMode(root, resolved, fade, delayMs = 0) {
    if (
      !fade ||
      document.hidden ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ) {
      // A change that does not fade ends a fade that is running: its rule would otherwise keep
      // every transition forced on. (Called only when the mode really changes, so a delivery
      // that agrees with the running fade never gets here.)
      endChromeModeFade(root);
      root.setAttribute('data-color-mode', resolved);
      return;
    }
    // A flip during a fade keeps the attribute; afterMotion drops the earlier wait for this key.
    root.style.setProperty(BENTO_MODE_FADE_DELAY_PROPERTY, delayMs + 'ms');
    root.setAttribute(BENTO_MODE_FADE_ATTR, '');
    root.setAttribute('data-color-mode', resolved);
    afterMotion(root, BENTO_MODE_FADE_ATTR, {}, () => {
      unwatchChromeFadeVisibility();
      removeChromeModeFade(root);
    });
    unwatchChromeFadeVisibility();
    chromeFadeHideListener = () => {
      if (document.hidden) endChromeModeFade(root);
    };
    document.addEventListener('visibilitychange', chromeFadeHideListener);
  }
  // Order of the two routes a mode reaches chrome by, the direct event and the BENTO_PANELS
  // payload. A payload serialised before a flip can be delivered after the direct event, so
  // each carries bento-tools' stamp ({ run, seq }, SettingsStore.colorStamp) and chrome keeps the
  // newest it applied. The rule, kept in step with bridge/colorStamp.ts in the shell:
  //   - nothing recorded yet: any message applies (first boot, an older payload source);
  //   - a stamped message of another run applies and replaces the record (tools restarted;
  //     sequences and clocks of different runs are never compared);
  //   - a stamped message of the recorded run applies unless its seq is lower;
  //   - an unstamped message after a stamp has been recorded is dropped: it is older than
  //     anything stamped (a sidebar's boot hint, the legacy title).
  // A payload built by the previous run and delivered after the new run's first message gets
  // through (the runs cannot be ordered); the next payload carries the new run and corrects it.
  let chromeColorStamp = null;
  function acceptChromeColorStamp(stamp) {
    const valid = stamp && typeof stamp.run === 'string' && Number.isFinite(stamp.seq);
    if (!valid) return chromeColorStamp === null;
    const sameRun = chromeColorStamp !== null && stamp.run === chromeColorStamp.run;
    if (sameRun && stamp.seq < chromeColorStamp.seq) return false;
    chromeColorStamp = { run: stamp.run, seq: stamp.seq };
    return true;
  }
  // Shows a resolved mode: the fade and the mode attribute together. Returns whether the mode
  // changed, which is when the observers are told (announceChromeColorMode).
  function commitChromeColorMode(mode, resolved, delayMs = 0) {
    const root = document.documentElement;
    // The first application (the startup veil is still up) never fades.
    const fade = chromeColorModeApplied;
    chromeColorModeApplied = true;
    const changed = root.getAttribute('data-color-mode') !== resolved;
    if (changed) writeChromeColorMode(root, resolved, fade, delayMs);
    root.setAttribute('data-bento-color-mode-pref', mode);
    return changed;
  }
  // about:preferences follows this mode too (preferences.js, patch 12). On this topic it
  // re-reads the window that hosts it, so a Settings tab moved to another window keeps
  // following without holding on to the window it first loaded in.
  function announceChromeColorMode(resolved) {
    Services.obs.notifyObservers(window, BENTO_UI_COLOR_MODE_TOPIC, resolved);
  }
  // Runs `run` in the first animation frame at or after `deadline` (a window.performance.now()
  // time). The documents of the shell's process share a thread and a timer alone lets one
  // document's rendering update (which has priority over timers) run between two documents'
  // timers, so the later one would start its fade a frame or more late. Frame times come from the
  // same vsync for every document, so documents that take the first frame at or after the deadline
  // start their transitions from the same time. The timer only wakes the window shortly before.
  // The shell's twin is runAtFlip in theme/modeFade.ts. `flipAt` is wall-clock time and frame
  // times are on this window's monotonic clock; the system clock can be stepped after the window
  // opened, so the two are never compared: setChromeColorMode turns `flipAt` into the deadline
  // once, on receipt.
  const BENTO_FLIP_FRAME_WATCH_MS = 40;
  let cancelChromeColorFlip = null;
  // The flip that waits for its time, from receipt until it is announced: { mode, resolved,
  // deadline, prepared }. A later request for the same mode joins it (keeps the deadline, takes
  // over `mode`); one for the other mode replaces it (see setChromeColorMode).
  let chromeColorFlip = null;
  function runAtChromeFlip(deadline, run) {
    let frame = 0;
    const onFrame = (timestamp) => {
      if (timestamp >= deadline) {
        cancelChromeColorFlip?.();
        cancelChromeColorFlip = null;
        run();
        return;
      }
      frame = window.requestAnimationFrame(onFrame);
    };
    const timer = setTimeout(
      () => {
        frame = window.requestAnimationFrame(onFrame);
      },
      deadline - window.performance.now() - BENTO_FLIP_FRAME_WATCH_MS,
    );
    // A hidden window gets no frames, so one that hides while it waits applies when it hides
    // (without a fade, as commitChromeColorMode does for a hidden window), not at its next show.
    const onVisibility = () => {
      if (!document.hidden) return;
      cancelChromeColorFlip?.();
      cancelChromeColorFlip = null;
      run();
    };
    document.addEventListener('visibilitychange', onVisibility);
    cancelChromeColorFlip = () => {
      clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }
  // Prepares the flip `current`, due at current.deadline. In the first frame after it is heard the
  // mode and the fade attribute go on, with a transition delay that ends at the deadline: the style
  // recalculation and the creation of every transition happen while the lead runs out, and the
  // fade is shown from the deadline. The delay is measured from this frame's time, which the
  // transitions start from; a frame after the deadline (up to BENTO_FLIP_CATCH_UP_MAX_MS) gives
  // a negative delay and joins the fade part-way. The observers are told at the deadline, and a
  // window that hides while the flip waits drops the fade (writeChromeColorMode) and tells them
  // at once. The delay stays on the root until the fade ends: resetting it at the deadline
  // restyles every element in the frame the fade starts (see prepareFlip in theme/modeFade.ts for
  // the numbers). Twin: prepareFlip in theme/modeFade.ts.
  function prepareChromeColorFlip(current) {
    let frame = 0;
    const start = (timestamp) => {
      cancelChromeColorFlip?.();
      cancelChromeColorFlip = null;
      // A joined request may have replaced the mode since the flip was scheduled.
      const mode = current.mode;
      const resolved = resolveChromeColorMode(mode);
      if (!resolved) {
        chromeColorFlip = null;
        return;
      }
      current.resolved = resolved;
      // A hidden window gets no frames and applies without a fade.
      const delay = timestamp === null ? 0 : current.deadline - timestamp;
      const changed = commitChromeColorMode(
        mode,
        resolved,
        delay < -BENTO_FLIP_CATCH_UP_MAX_MS ? 0 : Math.round(delay * 10) / 10,
      );
      if (!changed) {
        chromeColorFlip = null;
        return;
      }
      const remaining = current.deadline - window.performance.now();
      const root = document.documentElement;
      if (remaining > 0 && timestamp !== null && root.hasAttribute(BENTO_MODE_FADE_ATTR)) {
        current.prepared = true;
        runAtChromeFlip(current.deadline, () => {
          chromeColorFlip = null;
          announceChromeColorMode(current.resolved);
        });
      } else {
        chromeColorFlip = null;
        announceChromeColorMode(resolved);
      }
    };
    frame = window.requestAnimationFrame(start);
    const onVisibility = () => {
      if (document.hidden) start(null);
    };
    document.addEventListener('visibilitychange', onVisibility);
    cancelChromeColorFlip = () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }
  // Applies a mode pref that has passed the order check (or needs none: the OS appearance
  // changing under Auto re-resolves the pref already applied). `flipAt` is the stamp's flip time
  // (epoch ms, tools' clock, which is the system clock this window reads too): while it is
  // ahead the change is prepared at once and shown at that time (prepareChromeColorFlip), so the
  // window flips with the shell documents, which receive the same change at other moments. Past
  // it, or without one, the change applies at once; so does the first application, an unchanged
  // mode, and a hidden window (it gets no animation frames). Reduced motion waits for the time
  // and then snaps.
  //
  // Every call is a request that replaces the flip that waits, with one exception, the rule the
  // shell's applyModeWithFade follows too: a request for the mode that flip already shows joins it,
  // prepared or not. The flip keeps the deadline of the request that scheduled it (fixed on
  // receipt), and the newer pref is the one it applies and announces, once, at that deadline. So a
  // duplicate (the BENTO_PANELS payload behind the direct event, whose flipAt would be turned into
  // a wait again after a clock step) and a newer request for the same mode agree across windows
  // and documents: a prepared document cannot be re-timed without a full restyle, so none is. A
  // request for the other mode, and an OS change under Auto that no longer resolves to the mode
  // the flip shows, replace it with their own time, and the stale mode is never announced. The
  // order rules (acceptChromeColorStamp) have already run by the time a request gets here.
  function setChromeColorMode(mode, flipAt) {
    const root = document.documentElement;
    if (!root) return;
    const resolved = resolveChromeColorMode(mode);
    if (!resolved) return;
    chromeColorModePref = mode;
    if (chromeColorFlip && chromeColorFlip.resolved === resolved && !document.hidden) {
      chromeColorFlip.mode = mode;
      if (chromeColorFlip.prepared) root.setAttribute('data-bento-color-mode-pref', mode);
      return;
    }
    cancelChromeColorFlip?.();
    cancelChromeColorFlip = null;
    chromeColorFlip = null;
    const wait = typeof flipAt === 'number' ? flipAt - Date.now() : 0;
    if (
      wait > 0 &&
      chromeColorModeApplied &&
      !document.hidden &&
      root.getAttribute('data-color-mode') !== resolved
    ) {
      const scheduled = {
        mode,
        resolved,
        deadline: window.performance.now() + wait,
        prepared: false,
      };
      chromeColorFlip = scheduled;
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        runAtChromeFlip(scheduled.deadline, () => {
          chromeColorFlip = null;
          if (commitChromeColorMode(scheduled.mode, scheduled.resolved)) {
            announceChromeColorMode(scheduled.resolved);
          }
        });
      } else {
        prepareChromeColorFlip(scheduled);
      }
      return;
    }
    // Already due: a stamp that arrives up to BENTO_FLIP_CATCH_UP_MAX_MS late joins the fade
    // part-way, as a prepared flip whose frame is late does; anything later, or no stamp, fades
    // from the start.
    const late =
      typeof flipAt === 'number' && wait <= 0 && wait >= -BENTO_FLIP_CATCH_UP_MAX_MS;
    if (commitChromeColorMode(mode, resolved, late ? Math.round(wait * 10) / 10 : 0)) {
      announceChromeColorMode(resolved);
    }
  }
  function applyChromeColorMode(mode, stamp) {
    if (!document.documentElement || !resolveChromeColorMode(mode)) return;
    if (acceptChromeColorStamp(stamp)) {
      setChromeColorMode(mode, Number.isFinite(stamp?.flipAt) ? stamp.flipAt : undefined);
    }
  }
  function handleChromeDarkQueryChange() {
    if (chromeColorModePref === 'system') setChromeColorMode('system');
  }
  if (typeof window.matchMedia === 'function') {
    window.matchMedia(CHROME_DARK_QUERY).addEventListener('change', handleChromeDarkQueryChange);
  }
  // The direct leg of a colour flip: bento-tools fires this window event the moment the saved
  // mode changes (bentoPrivacy.notifyUiColorMode), so the chrome fade starts with the shell's
  // documents instead of after the BENTO_PANELS payload, which carries the same value and is
  // the backstop (applyChromeColorMode returns early when the mode already matches, so a late
  // payload that agrees neither restarts nor doubles the fade, and one built before the flip
  // is dropped by its older order stamp). A private window keeps its own in-memory
  // mode and ignores it. A window whose mount script has not run yet misses the event and takes
  // the mode from BENTO_PANELS.
  const BENTO_UI_COLOR_MODE_SET_EVENT = 'bento-ui-color-mode-set';
  function handleUiColorModeSet(event) {
    if (BentoPrivateBrowsingUtils.isWindowPrivate(window)) return;
    applyChromeColorMode(event.detail?.mode, event.detail?.stamp);
  }
  window.addEventListener(BENTO_UI_COLOR_MODE_SET_EVENT, handleUiColorModeSet);
  function handleThemeTitle(rawTitle) {
    // Format: BENTO_THEME:<ts>:<themeId>
    const tail = rawTitle.slice(THEME_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const themeId = tail.slice(colonAfterTs + 1).trim();
    // Defensive: ignore empty / whitespace-only payloads. Anything else
    // is requested as-is — chrome either has a theme sheet for that id
    // (which applies) or doesn't (chrome falls back to Default). Lenient
    // by design so a typo'd new theme in the registry doesn't break chrome.
    if (themeId.length === 0) return;
    applyChromeThemeToDocument(document, themeId);
  }
  function handleColorModeTitle(rawTitle) {
    const tail = rawTitle.slice(COLOR_MODE_PREFIX.length);
    const colonAfterTs = tail.indexOf(':');
    if (colonAfterTs < 0) return;
    const mode = tail.slice(colonAfterTs + 1).trim();
    applyChromeColorMode(mode);
  }

  function ensureSidebarFooterAnchor(anchorRect, id) {
    const shellFrame = document.getElementById('bento-shell-frame');
    const shellRect = shellFrame?.getBoundingClientRect();
    if (!shellRect || !anchorRect) return null;
    let anchor = document.getElementById(id);
    if (!anchor) {
      anchor = document.createElementNS(HTML_NS, 'span');
      anchor.id = id;
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

  function ensureSidebarAppMenuAnchor(anchorRect) {
    return ensureSidebarFooterAnchor(anchorRect, 'bento-sidebar-app-menu-anchor');
  }

  function ensureSidebarDownloadsAnchor(anchorRect) {
    return ensureSidebarFooterAnchor(anchorRect, 'bento-sidebar-downloads-anchor');
  }

  // Where the shell last said its Downloads button is, as distances from the shell
  // viewport's right and bottom edges plus its size (BENTO_DOWNLOADS_ANCHOR, sent
  // when the footer layout changes: rail, merge progress ring). Edges rather than a
  // position, so a window or sidebar resize needs no new report. Firefox's own
  // downloads opens anchor here (DownloadsButton.getAnchor); a click on the button
  // sends its rect with the open instead. Until the first report this is the
  // expanded footer's position.
  const DOWNLOADS_BUTTON_EDGES_DEFAULT = { right: 11, bottom: 10, width: 32, height: 32 };
  let downloadsButtonEdges = DOWNLOADS_BUTTON_EDGES_DEFAULT;

  function handleDownloadsAnchorTitle(rawTitle) {
    // Format: BENTO_DOWNLOADS_ANCHOR:<ts>:<base64-json>
    const edges = parseSidebarAnchorPayload(rawTitle, DOWNLOADS_ANCHOR_PREFIX, 'downloads anchor');
    if (!edges) return;
    const { right, bottom, width, height } = edges;
    if ([right, bottom, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      downloadsButtonEdges = { right, bottom, width, height };
    }
  }

  // The shell's rail merge card asks for a tooltip beside it (BENTO_RAIL_TOOLTIP): the
  // shell frame is the rail wide, so a tooltip drawn inside it would be clipped. The
  // panel navigator tooltip overlay draws it instead, through the same show, hide and
  // delay path as the navigator buttons. 'hover' waits the hover delay, 'focus' shows at
  // once (keyboard focus, and a label that changed while the tooltip is up), 'hide' hides.
  function handleRailTooltipTitle(rawTitle) {
    // Format: BENTO_RAIL_TOOLTIP:<ts>:<base64-json>
    const payload = parseSidebarTitlePayload(rawTitle, RAIL_TOOLTIP_PREFIX, 'rail tooltip');
    if (!payload) return;
    if (payload.action === 'hide') {
      hidePanelNavigatorTooltip();
      return;
    }
    const { label, detail, anchor } = payload;
    const shellRect = document.getElementById('bento-shell-frame')?.getBoundingClientRect();
    if (!shellRect || typeof label !== 'string' || !label || !anchor) return;
    const { left, top, width, height } = anchor;
    if (![left, top, width, height].every(Number.isFinite)) return;
    const tooltip = {
      label,
      detail: typeof detail === 'string' && detail ? detail : undefined,
      placement: 'end',
      screenX: (window.mozInnerScreenX || window.screenX || 0) + shellRect.left + left,
      screenY: (window.mozInnerScreenY || window.screenY || 0) + shellRect.top + top,
      width,
      height,
    };
    if (payload.action === 'hover') {
      armPanelNavigatorTooltip(() => showPanelNavigatorTooltipPayload(tooltip));
    } else if (payload.action === 'focus') {
      showPanelNavigatorTooltipPayload(tooltip);
    }
  }

  function ensureSidebarDownloadsFallbackAnchor() {
    const shellFrame = document.getElementById('bento-shell-frame');
    const shellRect = shellFrame?.getBoundingClientRect();
    if (!shellRect) return null;
    const { right, bottom, width, height } = downloadsButtonEdges;
    return ensureSidebarFooterAnchor(
      {
        left: Math.max(0, shellRect.width - right - width),
        top: Math.max(0, shellRect.height - bottom - height),
        width,
        height,
      },
      'bento-sidebar-downloads-anchor',
    );
  }

  // Title-IPC payloads are <prefix><timestamp>:<base64 of UTF-8 JSON>.
  function parseSidebarTitlePayload(rawTitle, prefix, label) {
    const tail = rawTitle.slice(prefix.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return null;
    try {
      return JSON.parse(decodeURIComponent(escape(atob(tail.slice(colon + 1))))) || null;
    } catch (err) {
      console.warn(`[bento-shell-mount] ${label} payload parse failed:`, err);
      return null;
    }
  }

  function parseSidebarAnchorPayload(rawTitle, prefix, label) {
    return parseSidebarTitlePayload(rawTitle, prefix, label)?.anchor || null;
  }

  function suppressSidebarFooterPanelAnimation(panel) {
    if (!panel) return () => {};
    const previousAnimate = panel.getAttribute('animate');
    const hadAnimate = panel.hasAttribute('animate');
    panel.setAttribute('animate', 'false');
    panel.setAttribute('bento-sidebar-footer-panel', 'true');
    return () => {
      panel.removeAttribute('bento-sidebar-footer-panel');
      if (hadAnimate) {
        panel.setAttribute('animate', previousAnimate);
      } else {
        panel.removeAttribute('animate');
      }
    };
  }

  async function openNativeAppMenuFromSidebar(anchorRect) {
    const panelUi = window.PanelUI;
    if (!panelUi || typeof panelUi.ensureReady !== 'function') {
      console.warn('[bento-shell-mount] PanelUI unavailable; cannot open Firefox menu');
      return false;
    }
    if (document.documentElement.hasAttribute('customizing')) return false;
    const panel = panelUi.panel;
    if (panel?.state === 'open' || panel?.state === 'showing') {
      panelUi.hide?.();
      return true;
    }
    if (typeof window.PanelMultiView?.openPopup !== 'function') {
      console.warn('[bento-shell-mount] PanelMultiView unavailable; cannot open Firefox menu');
      return false;
    }
    const anchor = ensureSidebarAppMenuAnchor(anchorRect);
    if (!anchor) {
      panelUi.show?.();
      return false;
    }
    const restoreAnimation = suppressSidebarFooterPanelAnimation(panel);
    const cleanup = () => {
      panel?.removeEventListener('popuphidden', cleanup);
      anchor.remove();
      restoreAnimation();
    };
    try {
      panelUi._ensureShortcutsShown?.();
      await panelUi.ensureReady();
      panel.addEventListener('popuphidden', cleanup);
      const opened = await window.PanelMultiView.openPopup(panel, anchor, {
        position: SIDEBAR_FOOTER_PANEL_POSITION,
        triggerEvent: null,
      });
      if (!opened) cleanup();
      return opened;
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar Firefox menu open failed:', err);
      cleanup();
      return false;
    }
  }

  function handleAppMenuOpenTitle(rawTitle) {
    // Format: BENTO_OPEN_APP_MENU:<ts>:<base64-json>
    openNativeAppMenuFromSidebar(
      parseSidebarAnchorPayload(rawTitle, APP_MENU_OPEN_PREFIX, 'app menu'),
    );
  }

  // ─── "Bento Settings" item in Firefox's app menu ───────────────────────
  // Firefox builds the app menu's main view lazily: it waits in the
  // appMenu-viewCache template until the first open, and PanelMultiView then
  // moves it into #appMenu-popup. Every way of opening the menu (the sidebar
  // footer button, PanelUI.show, any other PanelMultiView.openPopup of the panel)
  // shows that view and fires ViewShowing, which bubbles to the panel once the
  // view is in the live DOM. One listener on the panel therefore adds the item on
  // whichever open comes first, before the view is measured, and finds it already
  // there afterwards.
  // The item is a plain subviewbutton, so it takes the menu's look, hover and
  // arrow-key navigation, and Firefox's panel close listeners hide the menu on
  // activation as they do for the Settings item. The label is a fixed string
  // like the other Bento-added menu items.
  const BENTO_APPMENU_SETTINGS_ID = 'bento-appmenu-settings-button';
  function installBentoSettingsAppMenuItem() {
    const panel = document.getElementById('appMenu-popup');
    if (!panel) {
      console.warn('[bento-shell-mount] appMenu-popup missing; Bento Settings menu item skipped');
      return;
    }
    panel.addEventListener('ViewShowing', (event) => {
      const view = event.target;
      if (view.id !== 'appMenu-mainView') return;
      if (view.querySelector('#' + BENTO_APPMENU_SETTINGS_ID)) return;
      const firefoxSettings = view.querySelector('#appMenu-settings-button');
      if (!firefoxSettings) {
        console.warn('[bento-shell-mount] appMenu-settings-button missing; Bento Settings item skipped');
        return;
      }
      const item = document.createXULElement('toolbarbutton');
      item.id = BENTO_APPMENU_SETTINGS_ID;
      item.className = 'subviewbutton';
      item.setAttribute('label', 'Bento Settings');
      item.addEventListener('command', () => showSettingsPalette());
      firefoxSettings.before(item);
    });
  }
  installBentoSettingsAppMenuItem();

  function waitForDownloadsViewReady(timeoutMs = 10000) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const tick = () => {
        const view = window.DownloadsView;
        if (!view || !view.loading || Date.now() - startedAt >= timeoutMs) {
          resolve();
          return;
        }
        window.setTimeout(tick, 50);
      };
      tick();
    });
  }

  function openPrivateDownloadsChoiceIfNeeded() {
    const privateBrowsingUtils = window.PrivateBrowsingUtils;
    const privateDownloadsSubview = window.PrivateDownloadsSubview;
    const services = window.Services;
    if (!privateBrowsingUtils || !privateDownloadsSubview || !services) return;
    try {
      if (
        privateBrowsingUtils.isContentWindowPrivate(window) &&
        services.prefs.getBoolPref('browser.download.enableDeletePrivate', false) &&
        !services.prefs.getBoolPref('browser.download.deletePrivate.chosen', false)
      ) {
        privateDownloadsSubview.openWhenReady();
      }
    } catch (err) {
      console.warn('[bento-shell-mount] private downloads subview check failed:', err);
    }
  }

  function patchDownloadsButtonAnchorForSidebar() {
    const downloadsButton = window.DownloadsButton;
    if (!downloadsButton || downloadsButton.__bentoNativeGetAnchor) return;
    bentoCompatNoteNative('DownloadsButton.getAnchor', downloadsButton.getAnchor);
    bentoCompatNoteNative('DownloadsButton.releaseAnchor', downloadsButton.releaseAnchor);
    const nativeGetAnchor = downloadsButton.getAnchor.bind(downloadsButton);
    const nativeReleaseAnchor = downloadsButton.releaseAnchor.bind(downloadsButton);
    Object.defineProperty(downloadsButton, '__bentoNativeGetAnchor', {
      value: nativeGetAnchor,
    });
    Object.defineProperty(downloadsButton, '__bentoNativeReleaseAnchor', {
      value: nativeReleaseAnchor,
    });
    downloadsButton.getAnchor = function getBentoDownloadsAnchor() {
      if (document.documentElement.hasAttribute('bento-sidebar-addressbar')) {
        return ensureSidebarDownloadsFallbackAnchor() || nativeGetAnchor();
      }
      return nativeGetAnchor();
    };
    downloadsButton.releaseAnchor = function releaseBentoDownloadsAnchor() {
      const result = nativeReleaseAnchor();
      document.getElementById('bento-sidebar-downloads-anchor')?.remove();
      return result;
    };
  }

  async function openNativeDownloadsPanelFromSidebar(anchorRect) {
    patchDownloadsButtonAnchorForSidebar();
    const downloadsPanel = window.DownloadsPanel;
    if (!downloadsPanel || typeof downloadsPanel.initialize !== 'function') {
      console.warn('[bento-shell-mount] DownloadsPanel unavailable; cannot open downloads');
      return false;
    }
    if (document.documentElement.hasAttribute('customizing')) return false;
    if (typeof window.PanelMultiView?.openPopup !== 'function') {
      console.warn('[bento-shell-mount] PanelMultiView unavailable; cannot open downloads');
      return false;
    }
    const panel = downloadsPanel.panel;
    if (!panel) {
      console.warn('[bento-shell-mount] downloads panel element unavailable');
      return false;
    }
    if (downloadsPanel.isPanelShowing || panel.state === 'open' || panel.state === 'showing') {
      downloadsPanel._focusPanel?.();
      return true;
    }
    const anchor = ensureSidebarDownloadsAnchor(anchorRect);
    if (!anchor) {
      downloadsPanel.showPanel?.(true, false);
      return false;
    }
    let opened = false;
    const restoreAnimation = suppressSidebarFooterPanelAnimation(panel);
    const cleanup = () => {
      panel.removeEventListener('popuphidden', cleanup);
      anchor.remove();
      restoreAnimation();
    };
    try {
      window.Glean?.downloads?.panelShown?.add?.(1);
      downloadsPanel._openedManually = true;
      downloadsPanel._preventFocusRing = true;
      downloadsPanel.initialize();
      await waitForDownloadsViewReady();
      const visibleItems = window.DownloadsView?._visibleViewItems?.values?.();
      if (visibleItems) {
        for (const viewItem of visibleItems) {
          viewItem.download.refresh().catch(console.error);
        }
      }
      panel.classList.toggle('bookmarks-toolbar', false);
      panel.addEventListener('popuphidden', cleanup);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const result = await window.PanelMultiView.openPopup(
        panel,
        anchor,
        SIDEBAR_FOOTER_PANEL_POSITION,
        0,
        0,
        false,
        null,
      );
      if (result === false) {
        cleanup();
        return false;
      }
      opened = true;
      downloadsPanel._focusPanel?.();
      openPrivateDownloadsChoiceIfNeeded();
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar downloads open failed:', err);
      cleanup();
      return false;
    } finally {
      if (!opened && panel.state === 'closed') cleanup();
    }
  }

  function handleDownloadsOpenTitle(rawTitle) {
    // Format: BENTO_OPEN_DOWNLOADS:<ts>:<base64-json>
    openNativeDownloadsPanelFromSidebar(
      parseSidebarAnchorPayload(rawTitle, DOWNLOADS_OPEN_PREFIX, 'downloads'),
    );
  }

  patchDownloadsButtonAnchorForSidebar();

  // ─── Side panel strip (multi-panel) ────────────────────────────────────
  //
  // The existing bento-side-panel-host (added by 02-bento-side-panel.patch
  // as a single-panel host) is repurposed as a horizontal STRIP that
  // holds N panel containers + an "Add panel" trailer. Reconciler rebuilds
  // children based on the panels/sync snapshot from bento-tools — adds
  // new panel hosts for new tabIds, removes hosts for gone tabIds,
  // navigates existing hosts whose URL changed.
  //
  // Each panel container is a vbox of [bento-panel-header, <browser>].
  // The header carries back/forward/reload buttons, an inline URL input,
  // and bookmark / pin buttons. The header's URL input is the canonical
  // place to navigate the panel — the chrome's main URL bar always
  // reflects the active tab in the main content area.
  //
  // Splitters: one between each pair of adjacent panels. They use
  // `resizebefore="closest" resizeafter="none"` so dragging only resizes
  // the panel on the LEFT of the splitter — right-side panels just shift
  // along the horizontal scroll. The first splitter (between the main
  // content area and the strip) lives outside this code, in the
  // 02-bento-side-panel.patch — it resizes the strip / main as before.
  //
  // The "Add panel" trailer at the end creates a new tab via gBrowser
  // and stamps SessionStore extData "bentoAddAsPanel=1" on it, which
  // bento-tools' tabs.onCreated handler reads to add it to the active
  // workspace's panels list.
  const HTML_NS = 'http://www.w3.org/1999/xhtml';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Lucide icons, copied verbatim from lucide-react 1.37.0: the version
  // @muxui/react depends on and extensions/bento-shell/package.json pins.
  // This file runs in Firefox's chrome JS context (browser.xhtml, parent
  // process), which has no npm module graph, so it cannot import
  // lucide-react the way the React-side extension code does.
  //
  // Each entry is the icon's own node list, [tag, attributes] per shape
  // without React keys, taken from __iconNode in node_modules/lucide-react/
  // dist/esm/icons/<kebab-name>.mjs. Key names are the camelCased upstream
  // names (chevron-left becomes chevronLeft, volume-2 becomes volume2).
  // scripts/mount-icons.test.mjs fails when an entry drifts from the
  // installed package, so re-sync the entries whenever lucide-react changes.
  const ICONS = {
    chevronLeft: [['path', { d: 'm15 18-6-6 6-6' }]],
    chevronRight: [['path', { d: 'm9 18 6-6-6-6' }]],
    rotateCcw: [
      ['path', { d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }],
      ['path', { d: 'M3 3v5h5' }],
    ],
    bookmark: [
      [
        'path',
        {
          d: 'M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z',
        },
      ],
    ],
    volume2: [
      [
        'path',
        {
          d: 'M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z',
        },
      ],
      ['path', { d: 'M16 9a5 5 0 0 1 0 6' }],
      ['path', { d: 'M19.364 18.364a9 9 0 0 0 0-12.728' }],
    ],
    volumeX: [
      [
        'path',
        {
          d: 'M11 4.702a.7.7 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.7.7 0 0 0 11 19.298z',
        },
      ],
      ['path', { d: 'm16.5 14.5 5-5' }],
      ['path', { d: 'm16.5 9.5 5 5' }],
    ],
    pin: [
      ['path', { d: 'M12 17v5' }],
      [
        'path',
        {
          d: 'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
        },
      ],
    ],
    plus: [
      ['path', { d: 'M5 12h14' }],
      ['path', { d: 'M12 5v14' }],
    ],
    x: [
      ['path', { d: 'M18 6 6 18' }],
      ['path', { d: 'm6 6 12 12' }],
    ],
    gripVertical: [
      ['circle', { cx: '9', cy: '12', r: '1' }],
      ['circle', { cx: '9', cy: '5', r: '1' }],
      ['circle', { cx: '9', cy: '19', r: '1' }],
      ['circle', { cx: '15', cy: '12', r: '1' }],
      ['circle', { cx: '15', cy: '5', r: '1' }],
      ['circle', { cx: '15', cy: '19', r: '1' }],
    ],
    ellipsisVertical: [
      ['circle', { cx: '12', cy: '12', r: '1' }],
      ['circle', { cx: '12', cy: '5', r: '1' }],
      ['circle', { cx: '12', cy: '19', r: '1' }],
    ],
    music2: [
      ['circle', { cx: '8', cy: '18', r: '4' }],
      ['path', { d: 'M12 18V2l7 4' }],
    ],
    music3: [
      ['circle', { cx: '12', cy: '18', r: '4' }],
      ['path', { d: 'M16 18V2' }],
    ],
    music4: [
      ['path', { d: 'M9 18V5l12-2v13' }],
      ['path', { d: 'm9 9 12-2' }],
      ['circle', { cx: '6', cy: '18', r: '3' }],
      ['circle', { cx: '18', cy: '16', r: '3' }],
    ],
  };

  const MUSIC_PARTICLE_ICONS = [
    { className: 'bento-panel-nav__audio-particle--1', shapes: ICONS.music2 },
    { className: 'bento-panel-nav__audio-particle--2', shapes: ICONS.music3 },
    { className: 'bento-panel-nav__audio-particle--3', shapes: ICONS.music4 },
  ];
  const PANEL_NAV_AUDIO_EMIT_INTERVAL_MS = 540;
  let nextPanelNavAudioOwnerId = 1;

  function appendIconShapes(svg, shapes) {
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) {
        shape.setAttribute(name, value);
      }
      svg.appendChild(shape);
    }
  }

  function makeIcon(shapes, size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (size) {
      svg.setAttribute('width', String(size));
      svg.setAttribute('height', String(size));
    }
    appendIconShapes(svg, shapes);
    return svg;
  }

  function makeMusicParticleIcon(iconDef) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('bento-panel-nav__audio-particle', iconDef.className);
    appendIconShapes(svg, iconDef.shapes);
    return svg;
  }

  function getPanelNavAudioOwnerId(btn) {
    if (!btn) return '';
    if (!btn.__bentoPanelNavAudioOwnerId) {
      btn.__bentoPanelNavAudioOwnerId = String(nextPanelNavAudioOwnerId++);
    }
    return btn.__bentoPanelNavAudioOwnerId;
  }

  function getExistingPanelNavAudioParticlesRoot() {
    return document.querySelector('#bento-panel-nav > .bento-panel-nav__audio-particles');
  }

  function getPanelNavAudioParticlesRoot() {
    const nav = document.getElementById('bento-panel-nav');
    if (!nav) return null;
    let particles = nav.querySelector(':scope > .bento-panel-nav__audio-particles');
    if (particles) return particles;
    particles = document.createElementNS(HTML_NS, 'span');
    particles.className = 'bento-panel-nav__audio-particles';
    particles.setAttribute('aria-hidden', 'true');
    nav.appendChild(particles);
    return particles;
  }

  function hasPanelNavAudioParticlesForButton(btn, root) {
    const ownerId = btn?.__bentoPanelNavAudioOwnerId;
    if (!ownerId || !root) return false;
    return Array.from(root.children).some(
      (child) => child.getAttribute('data-bento-audio-owner') === ownerId,
    );
  }

  function cleanupPanelNavAudioParticles(btn) {
    if (!btn) return;
    const particlesRoot = getExistingPanelNavAudioParticlesRoot();
    if (
      btn.__bentoPanelNavAudioEmitter ||
      hasPanelNavAudioParticlesForButton(btn, particlesRoot)
    ) {
      return;
    }
    btn.classList.remove('bento-panel-nav__icon--has-audio-particles');
    if (particlesRoot && particlesRoot.childElementCount === 0) particlesRoot.remove();
  }

  function removePanelNavAudioParticlesForButton(btn) {
    if (!btn) return;
    const ownerId = btn.__bentoPanelNavAudioOwnerId;
    const particlesRoot = getExistingPanelNavAudioParticlesRoot();
    if (ownerId && particlesRoot) {
      for (const child of Array.from(particlesRoot.children)) {
        if (child.getAttribute('data-bento-audio-owner') === ownerId) child.remove();
      }
      if (particlesRoot.childElementCount === 0) particlesRoot.remove();
    }
    btn.classList.remove('bento-panel-nav__icon--has-audio-particles');
  }

  function emitPanelNavAudioParticle(btn) {
    if (!btn?.isConnected) return;
    const particlesRoot = getPanelNavAudioParticlesRoot();
    const navRect = document.getElementById('bento-panel-nav')?.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    if (!particlesRoot || !navRect || btnRect.width <= 0 || btnRect.height <= 0) return;
    const iconIndex = btn.__bentoPanelNavAudioParticleIndex || 0;
    const iconDef = MUSIC_PARTICLE_ICONS[iconIndex % MUSIC_PARTICLE_ICONS.length];
    btn.__bentoPanelNavAudioParticleIndex = iconIndex + 1;
    const particle = makeMusicParticleIcon(iconDef);
    particle.setAttribute('data-bento-audio-owner', getPanelNavAudioOwnerId(btn));
    particle.style.left = Math.round(btnRect.right - navRect.left - 3) + 'px';
    particle.style.top = Math.round(btnRect.top - navRect.top + 4) + 'px';
    btn.classList.add('bento-panel-nav__icon--has-audio-particles');
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      particle.remove();
      cleanupPanelNavAudioParticles(btn);
    };
    particlesRoot.appendChild(particle);
    // The particle goes at the end of its CSS animation (or the timer fallback).
    afterMotion(particle, 'particle', { animations: ['bento-panel-nav-music-particle'] }, cleanup);
  }

  function startPanelNavAudioEmitter(btn) {
    if (!btn) return;
    btn.classList.add('bento-panel-nav__icon--audible');
    if (btn.__bentoPanelNavAudioEmitter) return;
    btn.__bentoPanelNavAudioEmitter = window.setInterval(() => {
      if (!btn.isConnected) {
        stopPanelNavAudioEmitter(btn, { removeParticles: true });
        return;
      }
      emitPanelNavAudioParticle(btn);
    }, PANEL_NAV_AUDIO_EMIT_INTERVAL_MS);
    emitPanelNavAudioParticle(btn);
  }

  function stopPanelNavAudioEmitter(btn, options = {}) {
    if (!btn) return;
    if (btn.__bentoPanelNavAudioEmitter) {
      window.clearInterval(btn.__bentoPanelNavAudioEmitter);
      btn.__bentoPanelNavAudioEmitter = null;
    }
    btn.classList.remove('bento-panel-nav__icon--audible');
    if (options.removeParticles) {
      removePanelNavAudioParticlesForButton(btn);
      return;
    }
    cleanupPanelNavAudioParticles(btn);
  }

  function syncPanelNavAudioParticles(btn, audioPlaying) {
    if (!btn) return;
    if (audioPlaying === true) {
      startPanelNavAudioEmitter(btn);
    } else {
      stopPanelNavAudioEmitter(btn);
    }
  }

  function makeHeaderButton(title, iconShapes, onClick) {
    const btn = document.createElementNS(HTML_NS, 'button');
    btn.type = 'button';
    btn.className =
      'bento-button bento-button--ghost bento-icon-button bento-icon-button--sm bento-panel-header-button';
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.appendChild(makeIcon(iconShapes));
    btn.addEventListener('click', onClick);
    return btn;
  }

  let panelHistoryPopup = null;

  function getNavigatorString(name, fallback) {
    try {
      if (typeof gNavigatorBundle !== 'undefined') {
        return gNavigatorBundle.getString(name);
      }
    } catch {
      // Fall through to the local label.
    }
    return fallback;
  }

  function getTabForPanelHistoryBrowser(browserEl) {
    try {
      return window.gBrowser?.getTabForBrowser?.(browserEl) || null;
    } catch {
      return null;
    }
  }

  function clearPanelHistoryPopup() {
    if (!panelHistoryPopup) return;
    const popup = panelHistoryPopup;
    panelHistoryPopup = null;
    try {
      popup.hidePopup?.();
    } catch {
      // Popup may already be closed.
    }
    popup.remove();
  }

  function ensurePanelHistoryPopup(browserEl, tab) {
    clearPanelHistoryPopup();
    const popup = document.createXULElement('menupopup');
    popup.setAttribute('context', '');
    popup._bentoPanelHistoryBrowser = browserEl;
    popup._bentoPanelHistoryTab = tab;

    popup.addEventListener('DOMMenuItemActive', (event) => {
      if (event.target.hasAttribute('checked')) return;
      try {
        XULBrowserWindow.setOverLink(event.target.getAttribute('uri') || '');
      } catch {
        // Status text is best effort.
      }
    });
    popup.addEventListener('DOMMenuItemInactive', () => {
      try {
        XULBrowserWindow.setOverLink('');
      } catch {
        // Status text is best effort.
      }
    });
    popup.addEventListener('command', (event) => {
      navigatePanelHistoryFromMenu(popup, event);
      event.stopPropagation();
    });
    popup.addEventListener('popuphidden', () => {
      try {
        XULBrowserWindow.setOverLink('');
      } catch {
        // Status text is best effort.
      }
      if (panelHistoryPopup === popup) panelHistoryPopup = null;
      popup.remove();
    });

    const popupSet = document.getElementById('mainPopupSet') || document.documentElement;
    popupSet.appendChild(popup);
    panelHistoryPopup = popup;
    return popup;
  }

  function appendPanelHistoryItem(popup, entry, index, currentIndex, ssInParent, tooltips) {
    const uri = ssInParent ? entry?.URI?.spec || '' : entry?.url || entry?.URI?.spec || '';
    if (!uri) return;

    const item = document.createXULElement('menuitem');
    item.setAttribute('uri', uri);
    item.setAttribute('label', entry?.title || uri);
    item.setAttribute('index', index);
    item.setAttribute('historyindex', index - currentIndex);

    if (index !== currentIndex) {
      item.style.setProperty('--menuitem-icon', 'url(page-icon:' + CSS.escape(uri) + ')');
    }

    if (index < currentIndex) {
      item.className = 'unified-nav-back menuitem-iconic menuitem-with-favicon';
      item.setAttribute('tooltiptext', tooltips.back);
    } else if (index === currentIndex) {
      item.setAttribute('type', 'radio');
      item.setAttribute('checked', 'true');
      item.className = 'unified-nav-current';
      item.setAttribute('tooltiptext', tooltips.current);
    } else {
      item.className = 'unified-nav-forward menuitem-iconic menuitem-with-favicon';
      item.setAttribute('tooltiptext', tooltips.forward);
    }

    popup.appendChild(item);
  }

  function fillPanelHistoryPopup(popup, browserEl, sessionHistory, ssInParent) {
    while (popup.firstChild) popup.firstChild.remove();

    const count = ssInParent ? sessionHistory?.count || 0 : sessionHistory?.entries?.length || 0;
    if (count <= 1) return false;

    const MAX_HISTORY_MENU_ITEMS = 15;
    const currentIndex = Number(sessionHistory.index) || 0;
    const halfLength = Math.floor(MAX_HISTORY_MENU_ITEMS / 2);
    let start = Math.max(currentIndex - halfLength, 0);
    const end = Math.min(
      start === 0 ? MAX_HISTORY_MENU_ITEMS : currentIndex + halfLength + 1,
      count,
    );
    if (end === count) start = Math.max(count - MAX_HISTORY_MENU_ITEMS, 0);

    const tooltips = {
      back: getNavigatorString('tabHistory.goBack', 'Go back'),
      current: getNavigatorString('tabHistory.reloadCurrent', 'Reload current page'),
      forward: getNavigatorString('tabHistory.goForward', 'Go forward'),
    };

    for (let index = end - 1; index >= start; index -= 1) {
      const entry = ssInParent
        ? sessionHistory.getEntryAtIndex(index)
        : sessionHistory.entries[index];
      if (
        BrowserUtils.navigationRequireUserInteraction &&
        entry?.hasUserInteraction === false &&
        index !== end - 1 &&
        index !== currentIndex
      ) {
        continue;
      }
      appendPanelHistoryItem(popup, entry, index, currentIndex, ssInParent, tooltips);
    }

    popup._bentoPanelHistoryBrowser = browserEl;
    return popup.children.length > 0;
  }

  function openPanelHistoryPopupAtEvent(popup, anchor, event) {
    if (Number.isFinite(event?.screenX) && Number.isFinite(event?.screenY)) {
      popup.openPopupAtScreen(event.screenX, event.screenY, true, event);
      return;
    }
    popup.openPopup(anchor, 'after_start', 0, 0, true, false, event);
  }

  function showPanelHistoryPopup(browserEl, anchor, event) {
    const tab = getTabForPanelHistoryBrowser(browserEl);
    const popup = ensurePanelHistoryPopup(browserEl, tab);
    let opened = false;

    const openIfPopulated = (sessionHistory, ssInParent) => {
      if (!popup.isConnected || panelHistoryPopup !== popup) return;
      if (!fillPanelHistoryPopup(popup, browserEl, sessionHistory, ssInParent)) {
        if (opened) popup.hidePopup();
        return;
      }
      if (!opened) {
        opened = true;
        openPanelHistoryPopupAtEvent(popup, anchor, event);
      }
    };

    const liveHistory = browserEl?.browsingContext?.sessionHistory;
    if (liveHistory?.count) {
      openIfPopulated(liveHistory, true);
      if (!opened) clearPanelHistoryPopup();
      return;
    }

    const SessionStore = getSessionStore();
    if (!SessionStore || !tab) {
      clearPanelHistoryPopup();
      return;
    }
    const snapshot = SessionStore.getSessionHistory(tab, (nextHistory) => {
      openIfPopulated(nextHistory, false);
    });
    openIfPopulated(snapshot, false);
    if (!opened && (!snapshot || (snapshot.entries?.length || 0) <= 1)) {
      clearPanelHistoryPopup();
    }
  }

  function navigatePanelHistoryFromMenu(popup, event) {
    const index = Number(event.target?.getAttribute?.('index'));
    if (!Number.isInteger(index)) return false;

    const browserEl = popup._bentoPanelHistoryBrowser;
    if (!browserEl?.isConnected) return false;

    let where = 'current';
    try {
      where = BrowserUtils.whereToOpenLink(event);
    } catch {
      where = 'current';
    }

    if (where === 'current') {
      try {
        browserEl.gotoIndex(index);
        return true;
      } catch (err) {
        console.warn('[bento-shell-mount] panel history gotoIndex failed:', err);
        return false;
      }
    }

    const historyIndex = Number(event.target.getAttribute('historyindex'));
    const tab = popup._bentoPanelHistoryTab || getTabForPanelHistoryBrowser(browserEl);
    if (!tab || !Number.isFinite(historyIndex) || typeof duplicateTabIn !== 'function') {
      return false;
    }
    try {
      duplicateTabIn(tab, where, historyIndex);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] panel history duplicate failed:', err);
      return false;
    }
  }

  function attachPanelHistoryContextMenu(button, getBrowser) {
    button.addEventListener('contextmenu', (event) => {
      const actionBrowser = getBrowser();
      if (!actionBrowser) return;
      event.preventDefault();
      event.stopPropagation();
      showPanelHistoryPopup(actionBrowser, button, event);
    });
  }

  // Re-parent a node with Element.moveBefore so a tab <browser> inside it keeps
  // its frameloader (insertBefore/appendChild unbind and recreate it, which
  // strands Tabbrowser's per-tab progress filter on the discarded
  // BrowsingContext). moveBefore throws HierarchyRequestError or
  // NotFoundError when the node and parent are not connected under one root or
  // the reference child is wrong, and is missing on older engines, so fall back
  // to insertBefore. A null ref appends.
  function moveNodeBefore(parent, node, ref) {
    if (typeof parent.moveBefore === 'function') {
      try {
        parent.moveBefore(node, ref);
        return;
      } catch (err) {
        console.warn('[bento-shell-mount] moveBefore failed, using insertBefore:', err);
      }
    }
    parent.insertBefore(node, ref);
  }

  // Move the main tab content (#tabbrowser-tabbox) into the strip as
  // its first child. The strip becomes the entire content area right
  // of the sidebar — main + side panels + Add-panel button share one
  // horizontal scroll context, one bottom-padding gap, etc.
  //
  // Idempotent via the data-bento-strip-unified flag. Risk: tabbrowser
  // internals occasionally walk up the DOM looking for #tabbrowser-tabbox
  // at a specific parent location; if anything breaks (fullscreen,
  // PiP, sidebar splitter), revert by restoring the original parent.
  function unifyMainWithStrip() {
    const host = document.getElementById('bento-side-panel-host');
    const main = document.getElementById('tabbrowser-tabbox');
    if (!host || !main) return;
    if (host.dataset.bentoStripUnified === '1') return;

    host.dataset.bentoStripUnified = '1';

    main.dataset.bentoMainPanel = '1';
    // Same tabindex treatment as side panels so the cycle nav can
    // focus main without inserting it into the natural Tab order.
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    moveNodeBefore(host, main, host.firstChild);
  }

  // Strip layout is fully driven by injected CSS (#bento-side-panel-host
  // rule). This function only needs to clear any lingering inline styles
  // from earlier code revisions.
  function configureSidePanelStrip() {
    const host = document.getElementById('bento-side-panel-host');
    if (!host) return;
    host.style.cssText = '';
  }

  const BENTO_EXPANDED_SIDEBAR_DEFAULT_WIDTH = 300;
  const BENTO_LEGACY_EXPANDED_SIDEBAR_DEFAULT_WIDTH = 240;

  function hasPersistedSidebarWidth(host) {
    try {
      return Services.xulStore.hasValue(host.ownerDocument.documentURI, host.id, 'width');
    } catch (err) {
      console.warn('[bento-shell-mount] xulStore width lookup failed:', err);
      return true;
    }
  }

  function normalizeInitialSidebarWidth() {
    const host = document.getElementById('bento-shell-host');
    if (!host || host.classList.contains('bento-sidebar-collapsed')) return;
    if (hasPersistedSidebarWidth(host)) return;

    const attrWidth = Number(host.getAttribute('width'));
    const currentWidth = Math.round(host.getBoundingClientRect().width);
    const isLegacyDefault =
      attrWidth === BENTO_LEGACY_EXPANDED_SIDEBAR_DEFAULT_WIDTH ||
      currentWidth === BENTO_LEGACY_EXPANDED_SIDEBAR_DEFAULT_WIDTH;

    if (!isLegacyDefault && attrWidth === BENTO_EXPANDED_SIDEBAR_DEFAULT_WIDTH) return;

    const width = String(BENTO_EXPANDED_SIDEBAR_DEFAULT_WIDTH);
    host.setAttribute('width', width);
    host.style.width = width + 'px';
  }

  const BENTO_RESIZE_SETTLED_EVENT = 'bento-resize-settled';
  let prepareSidebarChromeDividerForSidebarResize = null;
  let syncSidebarChromeDividerForSidebarWidth = null;
  let finishSidebarChromeDividerSidebarResize = null;
  let prepareToolbarNavigationForSidebarResize = null;
  let syncToolbarNavigationForSidebarWidth = null;
  let finishToolbarNavigationSidebarResize = null;
  let prepareBookmarksToolbarForSidebarResize = null;
  let syncBookmarksToolbarForSidebarWidth = null;
  let finishBookmarksToolbarSidebarResize = null;
  // Cancels of the pending animation frames of the updaters that read the host, the
  // strip or the toolbar (divider, toolbar navigation, bookmarks toolbar, splitter
  // affordance). A sidebar push cancels them when it starts; the refresh at its end
  // schedules them again.
  const sidebarGeometryFrameCancels = [];

  // The sidebar host as it is laid out, without the transforms on it. Hidden mode
  // parks it at translateX(-100%) and a push translates it, so a rect read through
  // either is not where the toolbar aligns to. footprintRight is where the next
  // sibling starts: the right edge plus the negative right margin that hidden mode
  // and a push give the host, which is the edge the strip's inset is measured from.
  function sidebarHostLayoutBox(host) {
    const rect = host.getBoundingClientRect();
    const style = getComputedStyle(host);
    const shift = new DOMMatrix(style.transform).m41;
    const right = rect.right - shift;
    return {
      left: rect.left - shift,
      right,
      width: rect.width,
      footprintRight: right + (Number.parseFloat(style.marginRight) || 0),
    };
  }

  function isBentoWindowResizing() {
    return document.documentElement.getAttribute('bento-window-resizing') === 'true';
  }

  function isBentoSidebarResizing() {
    return document.documentElement.getAttribute('bento-sidebar-resizing') === 'true';
  }

  // Root attribute for the length of a sidebar push slide (see "Sidebar push" in
  // bento-shell-mount.css). While it is set the host and the page group carry
  // transforms, so geometry reads of them are not layout geometry: the observers
  // that read it are held off like during a live resize (isBentoChromeLiveResizing)
  // and settleSidebarPush refreshes them once at the end.
  const SIDEBAR_PUSH_ATTR = 'bento-sidebar-push';
  // Root attribute while the sidebar is, or is sliding to, the collapsed rail: the rail
  // takes the toolbar's main colour (see bento-shell-mount.css, ':root[bento-sidebar-rail]').
  const SIDEBAR_RAIL_ATTR = 'bento-sidebar-rail';

  function isBentoSidebarPushing() {
    return document.documentElement.hasAttribute(SIDEBAR_PUSH_ATTR);
  }

  let bentoPanelResizeDepth = 0;
  let bentoSettingsAboutLiveResizeDepth = 0;
  const bentoLiveResizeFrozenSettingsAboutBrowsers = new Map();
  const BENTO_SETTINGS_ABOUT_FROZEN_STYLE_PROPERTIES = [
    'contain',
    'flex',
    'height',
    'max-height',
    'max-width',
    'min-height',
    'min-width',
    'width',
  ];

  function isBentoPanelResizing() {
    return document.documentElement.getAttribute('bento-panel-resizing') === 'true';
  }

  function getBrowserCurrentSpec(browserEl) {
    try {
      const currentSpec = browserEl?.currentURI?.spec;
      if (typeof currentSpec === 'string') return currentSpec;
    } catch {}
    try {
      const documentSpec = browserEl?.browsingContext?.currentWindowGlobal?.documentURI?.spec;
      if (typeof documentSpec === 'string') return documentSpec;
    } catch {}
    try {
      const src = browserEl?.getAttribute?.('src');
      if (typeof src === 'string') return src;
    } catch {}
    return '';
  }

  function isBentoSettingsAboutSpec(spec) {
    return (
      typeof spec === 'string' &&
      (spec.startsWith('about:preferences') || spec.startsWith('about:settings'))
    );
  }

  function captureSettingsAboutBrowserInlineStyle(browserEl) {
    const properties = new Map();
    for (const property of BENTO_SETTINGS_ABOUT_FROZEN_STYLE_PROPERTIES) {
      properties.set(property, {
        priority: browserEl.style.getPropertyPriority(property),
        value: browserEl.style.getPropertyValue(property),
      });
    }
    return properties;
  }

  function freezeSettingsAboutBrowserGeometry(browserEl, previous) {
    const browserRect = browserEl.getBoundingClientRect();
    const stackRect = browserEl.closest?.('.browserStack')?.getBoundingClientRect();
    const selectedRect = window.gBrowser?.selectedBrowser?.getBoundingClientRect();
    const width = Math.max(
      1,
      Math.ceil(browserRect.width || stackRect?.width || selectedRect?.width || 0),
    );
    const height = Math.max(
      1,
      Math.ceil(browserRect.height || stackRect?.height || selectedRect?.height || 0),
    );
    previous.inlineStyle = captureSettingsAboutBrowserInlineStyle(browserEl);
    for (const property of ['width', 'min-width', 'max-width']) {
      browserEl.style.setProperty(property, width + 'px', 'important');
    }
    for (const property of ['height', 'min-height', 'max-height']) {
      browserEl.style.setProperty(property, height + 'px', 'important');
    }
    browserEl.style.setProperty('flex', 'none', 'important');
    browserEl.style.setProperty('contain', 'strict', 'important');
    browserEl.setAttribute('bento-settings-about-live-resize-frozen', 'true');
  }

  function restoreSettingsAboutBrowserGeometry(browserEl, previous) {
    browserEl.removeAttribute('bento-settings-about-live-resize-frozen');
    for (const property of BENTO_SETTINGS_ABOUT_FROZEN_STYLE_PROPERTIES) {
      const saved = previous.inlineStyle?.get(property);
      if (saved?.value) {
        browserEl.style.setProperty(property, saved.value, saved.priority);
      } else {
        browserEl.style.removeProperty(property);
      }
    }
  }

  function freezeSettingsAboutBrowsersForLiveResize() {
    // Include background tabs: deactivating their docshell alone does not stop
    // Firefox from resizing the embedded browser viewport on every live frame.
    // Hold that viewport at its pre-gesture size and let the outer Bento frame
    // continue resizing and painting its full shadow.
    for (const browserEl of window.gBrowser?.browsers || []) {
      if (
        bentoLiveResizeFrozenSettingsAboutBrowsers.has(browserEl) ||
        !isBentoSettingsAboutSpec(getBrowserCurrentSpec(browserEl))
      ) {
        continue;
      }
      const previous = {};
      try {
        previous.docShellIsActive = browserEl.docShellIsActive;
      } catch {}
      try {
        previous.renderLayers = browserEl.renderLayers;
      } catch {}
      bentoLiveResizeFrozenSettingsAboutBrowsers.set(browserEl, previous);
      try {
        freezeSettingsAboutBrowserGeometry(browserEl, previous);
      } catch {}
      try {
        browserEl.preserveLayers?.(true);
      } catch {}
      try {
        browserEl.renderLayers = true;
      } catch {}
      try {
        browserEl.docShellIsActive = false;
      } catch {}
    }
  }

  function restoreSettingsAboutBrowsersAfterLiveResize() {
    if (bentoLiveResizeFrozenSettingsAboutBrowsers.size === 0) return;
    for (const [browserEl, previous] of bentoLiveResizeFrozenSettingsAboutBrowsers) {
      try {
        restoreSettingsAboutBrowserGeometry(browserEl, previous);
      } catch {}
      try {
        browserEl.preserveLayers?.(true);
      } catch {}
      try {
        browserEl.renderLayers =
          typeof previous.renderLayers === 'boolean' ? previous.renderLayers : true;
      } catch {}
      try {
        browserEl.docShellIsActive =
          typeof previous.docShellIsActive === 'boolean' ? previous.docShellIsActive : true;
      } catch {}
    }
    bentoLiveResizeFrozenSettingsAboutBrowsers.clear();
  }

  function beginBentoSettingsAboutLiveResize() {
    freezeSettingsAboutBrowsersForLiveResize();
    bentoSettingsAboutLiveResizeDepth += 1;
  }

  function endBentoSettingsAboutLiveResize() {
    if (bentoSettingsAboutLiveResizeDepth === 0) return;
    bentoSettingsAboutLiveResizeDepth -= 1;
    if (bentoSettingsAboutLiveResizeDepth === 0) {
      restoreSettingsAboutBrowsersAfterLiveResize();
    }
  }

  function beginBentoPanelResize() {
    beginBentoSettingsAboutLiveResize();
    bentoPanelResizeDepth += 1;
    if (bentoPanelResizeDepth === 1) {
      document.documentElement.setAttribute('bento-panel-resizing', 'true');
    }
  }

  function endBentoPanelResize() {
    const wasResizing = bentoPanelResizeDepth > 0;
    if (wasResizing) {
      bentoPanelResizeDepth -= 1;
    }
    if (wasResizing && bentoPanelResizeDepth === 0) {
      document.documentElement.removeAttribute('bento-panel-resizing');
      window.dispatchEvent(new CustomEvent(BENTO_RESIZE_SETTLED_EVENT));
    }
    if (wasResizing) endBentoSettingsAboutLiveResize();
  }

  function isBentoChromeLiveResizing() {
    return (
      isBentoWindowResizing() ||
      isBentoSidebarResizing() ||
      isBentoPanelResizing() ||
      isBentoSidebarPushing()
    );
  }

  function attachSidebarSplitterFeedback() {
    const splitter = document.getElementById('bento-shell-splitter');
    const shell = document.getElementById('browser');
    const host = document.getElementById('bento-shell-host');
    if (!splitter || !shell || !host || splitter.dataset.bentoFeedbackAttached === '1') return;
    splitter.dataset.bentoFeedbackAttached = '1';
    splitter.setAttribute('resizebefore', 'none');
    splitter.setAttribute('resizeafter', 'none');

    let affordance = document.getElementById('bento-shell-splitter-affordance');
    if (!affordance) {
      affordance = document.createElementNS(HTML_NS, 'div');
      affordance.id = 'bento-shell-splitter-affordance';
      shell.appendChild(affordance);
    }

    const updateAffordancePosition = () => {
      const shellRect = shell.getBoundingClientRect();
      const splitterRect = splitter.getBoundingClientRect();
      affordance.style.left = Math.round(splitterRect.left - shellRect.left) + 'px';
    };

    const clearDragging = () => {
      affordance.classList.remove('bento-shell-splitter--dragging');
      host.classList.remove('bento-shell-sidebar-resizing');
      document.documentElement.removeAttribute('bento-sidebar-resizing');
      endBentoSettingsAboutLiveResize();
      document.documentElement.style.removeProperty('cursor');
      document.documentElement.style.removeProperty('user-select');
    };

    const beginDrag = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = host.getBoundingClientRect().width;
      const shellRect = shell.getBoundingClientRect();
      const splitterRect = splitter.getBoundingClientRect();
      const startAffordanceLeft = Math.round(splitterRect.left - shellRect.left);
      prepareSidebarChromeDividerForSidebarResize?.();
      prepareToolbarNavigationForSidebarResize?.();
      prepareBookmarksToolbarForSidebarResize?.();
      const style = getComputedStyle(host);
      const min = parseFloat(style.minWidth) || 0;
      const max = parseFloat(style.maxWidth) || Number.POSITIVE_INFINITY;
      let lastWidth = Math.round(startWidth);
      let pendingWidth = startWidth;
      let dragWriteRaf = 0;
      const pointerId = event.pointerId;
      const dragTarget = event.currentTarget || affordance;

      const applyDragWidth = () => {
        dragWriteRaf = 0;
        const next = pendingWidth;
        lastWidth = Math.round(next);
        host.style.width = next + 'px';
        affordance.style.left = Math.round(startAffordanceLeft + next - startWidth) + 'px';
        syncSidebarChromeDividerForSidebarWidth?.(next);
        syncToolbarNavigationForSidebarWidth?.(next);
        syncBookmarksToolbarForSidebarWidth?.(next);
      };
      const scheduleDragWidth = (next) => {
        pendingWidth = next;
        if (dragWriteRaf) return;
        dragWriteRaf = requestAnimationFrame(applyDragWidth);
      };

      affordance.classList.add('bento-shell-splitter--dragging');
      host.classList.add('bento-shell-sidebar-resizing');
      beginBentoSettingsAboutLiveResize();
      document.documentElement.setAttribute('bento-sidebar-resizing', 'true');
      document.documentElement.style.setProperty('cursor', 'col-resize', 'important');
      document.documentElement.style.setProperty('user-select', 'none', 'important');
      try {
        dragTarget.setPointerCapture?.(pointerId);
      } catch (err) {
        console.warn('[bento-shell-mount] sidebar splitter setPointerCapture failed:', err);
      }

      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const next = Math.max(min, Math.min(max, startWidth + moveEvent.clientX - startX));
        scheduleDragWidth(next);
      };

      const onUp = (upEvent) => {
        if (upEvent?.pointerId !== undefined && upEvent.pointerId !== pointerId) return;
        dragTarget.removeEventListener('pointermove', onMove, true);
        dragTarget.removeEventListener('pointerup', onUp, true);
        dragTarget.removeEventListener('pointercancel', onUp, true);
        dragTarget.removeEventListener('lostpointercapture', onUp, true);
        window.removeEventListener('blur', onUp, true);
        try {
          dragTarget.releasePointerCapture?.(pointerId);
        } catch {
          /* already released */
        }
        if (dragWriteRaf) {
          cancelAnimationFrame(dragWriteRaf);
          applyDragWidth();
        }
        host.setAttribute('width', String(lastWidth));
        try {
          Services.xulStore.setValue(host.ownerDocument.documentURI, host.id, 'width', String(lastWidth));
        } catch (err) {
          console.warn('[bento-shell-mount] sidebar width persistence failed:', err);
        }
        clearDragging();
        finishSidebarChromeDividerSidebarResize?.();
        finishToolbarNavigationSidebarResize?.();
        finishBookmarksToolbarSidebarResize?.();
        requestAnimationFrame(updateAffordancePosition);
      };

      dragTarget.addEventListener('pointermove', onMove, true);
      dragTarget.addEventListener('pointerup', onUp, true);
      dragTarget.addEventListener('pointercancel', onUp, true);
      dragTarget.addEventListener('lostpointercapture', onUp, true);
      window.addEventListener('blur', onUp, true);
    };

    const suppressNativeSplitterDrag = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation();
    };
    affordance.addEventListener('pointerdown', beginDrag);
    splitter.addEventListener('pointerdown', beginDrag, true);
    affordance.addEventListener('mousedown', suppressNativeSplitterDrag);
    splitter.addEventListener('mousedown', suppressNativeSplitterDrag, true);

    let raf = 0;
    sidebarGeometryFrameCancels.push(() => {
      cancelAnimationFrame(raf);
      raf = 0;
    });
    const scheduleAffordancePosition = () => {
      if (isBentoChromeLiveResizing()) return;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        // A frame queued before a push began would read the translated splitter.
        if (isBentoSidebarPushing()) return;
        updateAffordancePosition();
      });
    };

    updateAffordancePosition();
    window.addEventListener('resize', scheduleAffordancePosition);
    window.addEventListener(BENTO_RESIZE_SETTLED_EVENT, scheduleAffordancePosition);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(scheduleAffordancePosition);
      ro.observe(host);
      const strip = document.getElementById('bento-strip-container');
      if (strip) ro.observe(strip);
    }
  }

  // Reveals the hidden sidebar (a slide-over of the rail) while the pointer is at the
  // window's left edge or over the host. No element catches the edge: a strip over the
  // page would take clicks from web content.
  function attachHiddenSidebarHoverReveal() {
    const host = document.getElementById('bento-shell-host');
    if (!host || host.dataset.bentoHiddenSidebarHoverAttached === '1') return;
    host.dataset.bentoHiddenSidebarHoverAttached = '1';

    const EDGE_HOVER_WIDTH_PX = 12;
    const HIDE_GRACE_MS = 120;
    let hideTimer = 0;
    const setRevealed = (revealed) => {
      const active = currentSidebarHidden && revealed;
      host.classList.toggle('bento-sidebar-hidden-revealed', active);
      document.documentElement.toggleAttribute('bento-sidebar-hidden-revealed', active);
    };
    const reveal = () => {
      // Not while a hide slide runs: the class would show the host the moment it ends.
      if (!currentSidebarHidden || isBentoSidebarPushing()) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = 0;
      }
      setRevealed(true);
    };
    const scheduleHide = () => {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        hideTimer = 0;
        if (host.matches(':hover')) return;
        setRevealed(false);
      }, HIDE_GRACE_MS);
    };
    const onPointerMove = (event) => {
      if (!currentSidebarHidden) return;
      const y = event.clientY;
      if (y < 0 || y > window.innerHeight) {
        scheduleHide();
        return;
      }
      if (event.clientX <= EDGE_HOVER_WIDTH_PX) {
        reveal();
        return;
      }
      if (!host.classList.contains('bento-sidebar-hidden-revealed')) return;
      const rect = host.getBoundingClientRect();
      if (event.clientX > rect.right + EDGE_HOVER_WIDTH_PX) {
        scheduleHide();
      }
    };

    host.addEventListener('pointerenter', reveal);
    host.addEventListener('mouseenter', reveal);
    host.addEventListener('pointerleave', scheduleHide);
    host.addEventListener('mouseleave', scheduleHide);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('mousemove', onPointerMove, true);
    window.addEventListener('blur', () => setRevealed(false), true);
  }

  function attachNativeSidebarSplitterFeedback() {
    const splitter = document.getElementById('sidebar-splitter');
    const box = document.getElementById('sidebar-box');
    if (!splitter || !box || splitter.dataset.bentoNativeFeedbackAttached === '1') return;
    splitter.dataset.bentoNativeFeedbackAttached = '1';
    splitter.setAttribute('resizebefore', 'none');
    splitter.setAttribute('resizeafter', 'none');

    const isTruthyAttr = (el, name) => {
      const value = el.getAttribute(name);
      return value !== null && value !== 'false';
    };
    const isVisible = () =>
      !box.hidden &&
      !box.collapsed &&
      !isTruthyAttr(box, 'hidden') &&
      !isTruthyAttr(box, 'collapsed') &&
      !splitter.hidden &&
      !splitter.collapsed &&
      !isTruthyAttr(splitter, 'hidden') &&
      !isTruthyAttr(splitter, 'collapsed');
    const readBounds = () => {
      const style = getComputedStyle(box);
      const min = cssLengthToPx(style.minWidth, tokenPx('--bento-tab-strip-width-min', 200));
      const max = cssLengthToPx(style.maxWidth, Math.max(min, window.innerWidth * 0.75));
      return {
        min: Math.max(0, min),
        max: Math.max(min, max),
      };
    };
    const applyWidth = (width) => {
      const { min, max } = readBounds();
      const next = Math.round(Math.max(min, Math.min(max, width)));
      box.style.width = next + 'px';
      box.setAttribute('width', String(next));
      return next;
    };
    const restorePersistedWidth = () => {
      try {
        const value = Services.xulStore.getValue(box.ownerDocument.documentURI, box.id, 'width');
        const width = Number.parseFloat(value);
        if (Number.isFinite(width) && width > 0) {
          applyWidth(width);
        }
      } catch (err) {
        console.warn('[bento-shell-mount] native sidebar width restore failed:', err);
      }
    };
    restorePersistedWidth();

    const clearDragging = () => {
      splitter.classList.remove('bento-native-sidebar-splitter--dragging');
      document.documentElement.removeAttribute('bento-native-sidebar-resizing');
      document.documentElement.style.removeProperty('cursor');
      document.documentElement.style.removeProperty('user-select');
    };

    const beginDrag = (event) => {
      if (event.button !== 0 || !isVisible()) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = box.getBoundingClientRect().width || cssLengthToPx(box.style.width, 0);
      if (!startWidth) return;
      const pointerId = event.pointerId;
      const dragTarget = event.currentTarget || splitter;
      const isPositionEnd = box.hasAttribute('sidebar-positionend');
      let lastWidth = Math.round(startWidth);
      let pendingWidth = startWidth;
      let dragWriteRaf = 0;

      const applyDragWidth = () => {
        dragWriteRaf = 0;
        lastWidth = applyWidth(pendingWidth);
      };
      const scheduleDragWidth = (next) => {
        pendingWidth = next;
        if (dragWriteRaf) return;
        dragWriteRaf = requestAnimationFrame(applyDragWidth);
      };

      splitter.classList.add('bento-native-sidebar-splitter--dragging');
      document.documentElement.setAttribute('bento-native-sidebar-resizing', 'true');
      document.documentElement.style.setProperty('cursor', 'col-resize', 'important');
      document.documentElement.style.setProperty('user-select', 'none', 'important');
      try {
        dragTarget.setPointerCapture?.(pointerId);
      } catch (err) {
        console.warn('[bento-shell-mount] native sidebar splitter setPointerCapture failed:', err);
      }

      const onMove = (moveEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        const delta = moveEvent.clientX - startX;
        scheduleDragWidth(startWidth + (isPositionEnd ? -delta : delta));
      };

      const onUp = (upEvent) => {
        if (upEvent?.pointerId !== undefined && upEvent.pointerId !== pointerId) return;
        dragTarget.removeEventListener('pointermove', onMove, true);
        dragTarget.removeEventListener('pointerup', onUp, true);
        dragTarget.removeEventListener('pointercancel', onUp, true);
        dragTarget.removeEventListener('lostpointercapture', onUp, true);
        window.removeEventListener('blur', onUp, true);
        try {
          dragTarget.releasePointerCapture?.(pointerId);
        } catch {
          /* already released */
        }
        if (dragWriteRaf) {
          cancelAnimationFrame(dragWriteRaf);
          applyDragWidth();
        }
        try {
          Services.xulStore.setValue(
            box.ownerDocument.documentURI,
            box.id,
            'width',
            String(lastWidth),
          );
        } catch (err) {
          console.warn('[bento-shell-mount] native sidebar width persistence failed:', err);
        }
        clearDragging();
        window.dispatchEvent(new CustomEvent(BENTO_RESIZE_SETTLED_EVENT));
      };

      dragTarget.addEventListener('pointermove', onMove, true);
      dragTarget.addEventListener('pointerup', onUp, true);
      dragTarget.addEventListener('pointercancel', onUp, true);
      dragTarget.addEventListener('lostpointercapture', onUp, true);
      window.addEventListener('blur', onUp, true);
    };

    const suppressNativeSplitterDrag = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopImmediatePropagation?.();
      event.stopPropagation();
    };
    splitter.addEventListener('pointerdown', beginDrag, true);
    splitter.addEventListener('mousedown', suppressNativeSplitterDrag, true);
  }

  function attachSidebarChromeDivider() {
    const host = document.getElementById('bento-shell-host');
    const toolbox = document.getElementById('navigator-toolbox');
    const parent = document.body;
    if (!host || !toolbox || !parent) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, attachSidebarChromeDivider, { once: true });
      }
      return;
    }
    if (host.dataset.bentoChromeDividerAttached === '1') return;
    host.dataset.bentoChromeDividerAttached = '1';

    let divider = document.getElementById('bento-sidebar-chrome-divider');
    if (!divider) {
      divider = document.createElementNS(HTML_NS, 'div');
      divider.id = 'bento-sidebar-chrome-divider';
      parent.appendChild(divider);
    }
    let toolbarBackdrop = document.getElementById('bento-toolbar-main-backdrop');
    if (toolbox && !toolbarBackdrop) {
      toolbarBackdrop = document.createElementNS(HTML_NS, 'div');
      toolbarBackdrop.id = 'bento-toolbar-main-backdrop';
      toolbox.insertBefore(toolbarBackdrop, toolbox.firstChild);
    }

    const updateToolbarBackgroundSplit = (dividerLeft) => {
      if (typeof dividerLeft !== 'number') return;
      const rootSplit = Math.max(0, Math.round(dividerLeft)) + 'px';
      document.documentElement.style.setProperty('--bento-toolbar-divider-x', rootSplit);
      const toolboxRect = toolbox?.getBoundingClientRect?.();
      const browserRect = document.getElementById('browser')?.getBoundingClientRect?.();
      if (toolboxRect && browserRect) {
        const height = Math.max(0, Math.round(browserRect.top - toolboxRect.top));
        document.documentElement.style.setProperty('--bento-toolbar-backdrop-height', height + 'px');
      }
      for (const id of ['navigator-toolbox', 'TabsToolbar', 'nav-bar']) {
        const toolbarSurface = document.getElementById(id);
        if (!toolbarSurface) continue;
        const rect = toolbarSurface.getBoundingClientRect();
        const splitX = Math.max(0, Math.round(dividerLeft - rect.left));
        const split = splitX + 'px';
        // The stops are registered <color> custom properties (bento-shell-mount.css), so the colours of
        // a mode flip fade through the gradient; a stop that is not registered changes in one step.
        const gradient =
          'linear-gradient(to right, ' +
          'var(--bento-toolbar-left-bg) 0, ' +
          'var(--bento-toolbar-left-bg) ' +
          split +
          ', var(--bento-toolbar-right-bg) ' +
          split +
          ', var(--bento-toolbar-right-bg) 100%)';
        toolbarSurface.style.setProperty('--bento-toolbar-divider-x', split);
        toolbarSurface.style.setProperty('background-color', 'var(--bento-toolbar-main-bg)', 'important');
        toolbarSurface.style.setProperty('background-image', gradient, 'important');
        toolbarSurface.style.setProperty('background-repeat', 'no-repeat', 'important');
      }
    };

    let sidebarLeftForDrag = 0;
    prepareSidebarChromeDividerForSidebarResize = () => {
      sidebarLeftForDrag = sidebarHostLayoutBox(host).left;
    };
    syncSidebarChromeDividerForSidebarWidth = (width) => {
      if (currentSidebarHidden || width <= 0) {
        divider.hidden = true;
        updateToolbarBackgroundSplit(0);
        return;
      }
      divider.hidden = false;
      const dividerLeft = Math.max(0, Math.round(sidebarLeftForDrag + width) - 1);
      divider.style.left = dividerLeft + 'px';
      updateToolbarBackgroundSplit(dividerLeft);
    };
    finishSidebarChromeDividerSidebarResize = () => {
      scheduleUpdate();
    };

    let raf = 0;
    sidebarGeometryFrameCancels.push(() => {
      cancelAnimationFrame(raf);
      raf = 0;
    });
    const updateDivider = () => {
      raf = 0;
      // A frame queued before a push began would read the translated host.
      if (isBentoSidebarPushing()) return;
      if (currentSidebarHidden) {
        divider.hidden = true;
        updateToolbarBackgroundSplit(0);
        return;
      }
      const rect = host.getBoundingClientRect();
      if (rect.width <= 0) {
        divider.hidden = true;
        updateToolbarBackgroundSplit(0);
        return;
      }
      divider.hidden = false;
      const dividerLeft = Math.max(0, Math.round(rect.right) - 1);
      divider.style.left = dividerLeft + 'px';
      updateToolbarBackgroundSplit(dividerLeft);
    };
    const scheduleUpdate = () => {
      if (isBentoChromeLiveResizing()) return;
      if (raf) return;
      raf = requestAnimationFrame(updateDivider);
    };

    scheduleUpdate();
    if (document.readyState !== 'complete') {
      const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
      window.addEventListener(evt, scheduleUpdate, { once: true });
    }
    window.addEventListener('load', scheduleUpdate, { once: true });
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener(BENTO_RESIZE_SETTLED_EVENT, scheduleUpdate);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(scheduleUpdate);
      ro.observe(host);
      ro.observe(toolbox);
      host._bentoSidebarChromeDividerResizeObserver = ro;
    }
  }

  function attachToolbarNavigationAlignment() {
    const host = document.getElementById('bento-shell-host');
    const target = document.getElementById('nav-bar-customization-target');
    const navBar = document.getElementById('nav-bar');
    const backButton = document.getElementById('back-button');
    const forwardButton = document.getElementById('forward-button');
    const stopReloadButton = document.getElementById('stop-reload-button');
    if (!host || !target || !backButton || !forwardButton || !stopReloadButton) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, attachToolbarNavigationAlignment, { once: true });
      }
      return;
    }
    if (target.dataset.bentoToolbarNavAlignmentAttached === '1') return;
    target.dataset.bentoToolbarNavAlignmentAttached = '1';

    const readMetrics = () => {
      const hostBox = sidebarHostLayoutBox(host);
      const targetRect = target.getBoundingClientRect();
      const groupWidth = [backButton, forwardButton, stopReloadButton].reduce((sum, el) => {
        const rect = el.getBoundingClientRect();
        return sum + Math.max(0, rect.width || 0);
      }, 0);
      return {
        hostLeft: hostBox.left,
        hostRight: hostBox.right,
        hostWidth: hostBox.width,
        targetLeft: targetRect.left,
        targetWidth: targetRect.width,
        groupWidth,
        edgeInset: tokenPx('--space-2xs', 8),
      };
    };
    const computeAlignedSidebarMinWidth = (metrics) => {
      const baseMin = tokenPx('--bento-tab-strip-width-min', 200);
      if (metrics.hostWidth <= 0 || metrics.targetWidth <= 0 || metrics.groupWidth <= 0) {
        return Math.ceil(baseMin);
      }
      const alignedMin = metrics.targetLeft - metrics.hostLeft + metrics.edgeInset + metrics.groupWidth;
      return Math.ceil(Math.max(baseMin, alignedMin));
    };
    let effectiveSidebarMinWidth = null;
    const applyEffectiveSidebarMinWidth = (metrics) => {
      const minWidth = computeAlignedSidebarMinWidth(metrics);
      if (minWidth !== effectiveSidebarMinWidth) {
        document.documentElement.style.setProperty(
          '--bento-tab-strip-width-min-effective',
          minWidth + 'px',
        );
        effectiveSidebarMinWidth = minWidth;
      }
      return minWidth;
    };
    const applyOffset = (metrics, sidebarWidth, cachedMinWidth = null) => {
      if (currentSidebarHidden) {
        target.style.setProperty('--bento-toolbar-nav-offset', '0px');
        return;
      }
      const minWidth =
        typeof cachedMinWidth === 'number'
          ? cachedMinWidth
          : applyEffectiveSidebarMinWidth(metrics);
      if (metrics.hostWidth <= 0 || metrics.targetWidth <= 0 || metrics.groupWidth <= 0) {
        target.style.setProperty('--bento-toolbar-nav-offset', '0px');
        return;
      }
      const sidebarRight =
        typeof sidebarWidth === 'number'
          ? metrics.hostLeft + Math.max(minWidth, sidebarWidth)
          : Math.max(metrics.hostRight, metrics.hostLeft + minWidth);
      const desiredStart = sidebarRight - metrics.edgeInset - metrics.groupWidth;
      const offset = Math.max(0, Math.round(desiredStart - metrics.targetLeft));
      target.style.setProperty('--bento-toolbar-nav-offset', offset + 'px');
    };
    let sidebarResizeMetrics = null;
    let sidebarResizeMinWidth = null;
    prepareToolbarNavigationForSidebarResize = () => {
      sidebarResizeMetrics = readMetrics();
      sidebarResizeMinWidth = applyEffectiveSidebarMinWidth(sidebarResizeMetrics);
    };
    syncToolbarNavigationForSidebarWidth = (width) => {
      if (!sidebarResizeMetrics) {
        sidebarResizeMetrics = readMetrics();
        sidebarResizeMinWidth = applyEffectiveSidebarMinWidth(sidebarResizeMetrics);
      }
      applyOffset(sidebarResizeMetrics, width, sidebarResizeMinWidth);
    };
    finishToolbarNavigationSidebarResize = () => {
      sidebarResizeMetrics = null;
      sidebarResizeMinWidth = null;
      scheduleUpdate();
    };

    let raf = 0;
    sidebarGeometryFrameCancels.push(() => {
      cancelAnimationFrame(raf);
      raf = 0;
    });
    const updateOffset = () => {
      raf = 0;
      // A frame queued before a push began would read the translated host.
      if (isBentoSidebarPushing()) return;
      applyOffset(readMetrics());
    };
    const scheduleUpdate = () => {
      if (isBentoChromeLiveResizing()) return;
      if (raf) return;
      raf = requestAnimationFrame(updateOffset);
    };

    scheduleUpdate();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener(BENTO_RESIZE_SETTLED_EVENT, scheduleUpdate);
    window.addEventListener('aftercustomization', scheduleUpdate, true);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(scheduleUpdate);
      for (const el of [host, target, navBar, backButton, forwardButton, stopReloadButton]) {
        if (el) ro.observe(el);
      }
      target._bentoToolbarNavAlignmentResizeObserver = ro;
    }
  }

  function attachBookmarksToolbarAlignment() {
    const root = document.documentElement;
    const toolbar = document.getElementById('PersonalToolbar');
    const host = document.getElementById('bento-shell-host');
    if (!root || !toolbar || !host) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, attachBookmarksToolbarAlignment, { once: true });
      }
      return;
    }
    if (toolbar.dataset.bentoBookmarksToolbarAlignmentAttached === '1') return;
    toolbar.dataset.bentoBookmarksToolbarAlignmentAttached = '1';

    const getStrip = () =>
      document.getElementById('bento-strip-container') ||
      document.getElementById('bento-side-panel-host');

    let lastOffset = null;
    let lastHeight = null;
    let lastVisibleHeight = 0;
    const applyOffset = (offset) => {
      const viewportWidth = Math.max(
        0,
        window.innerWidth || document.documentElement?.clientWidth || 0,
      );
      const bounded = viewportWidth > 0 ? Math.min(offset, viewportWidth) : offset;
      const safeOffset = Math.max(0, Math.round(Number.isFinite(bounded) ? bounded : 0));
      if (safeOffset === lastOffset) return;
      toolbar.style.setProperty('--bento-bookmarks-toolbar-offset', safeOffset + 'px');
      lastOffset = safeOffset;
    };
    const applyHeight = (height) => {
      const safeHeight = Math.max(0, Math.round(Number.isFinite(height) ? height : 0));
      if (safeHeight === lastHeight) return;
      root.style.setProperty('--bento-bookmarks-toolbar-height', safeHeight + 'px');
      lastHeight = safeHeight;
    };
    const isTruthyToolbarAttr = (name) => {
      const value = toolbar.getAttribute(name);
      return value !== null && value !== 'false';
    };
    const isToolbarVisible = () =>
      !toolbar.hidden &&
      !toolbar.collapsed &&
      !isTruthyToolbarAttr('hidden') &&
      !isTruthyToolbarAttr('collapsed');

    const readOffset = () => {
      if (currentSidebarHidden) return 0;
      const stripRect = getStrip()?.getBoundingClientRect?.();
      if (stripRect && Number.isFinite(stripRect.left)) return stripRect.left;
      const hostRect = host.getBoundingClientRect();
      return hostRect.right;
    };
    const readHeight = () => {
      const rect = toolbar.getBoundingClientRect?.();
      const styles = getComputedStyle(toolbar);
      const measured = Math.max(
        rect && Number.isFinite(rect.height) ? rect.height : 0,
        cssLengthToPx(styles.height, 0),
        cssLengthToPx(styles.minHeight, 0),
      );
      if (measured > 0) lastVisibleHeight = measured;
      if (!isToolbarVisible()) return 0;
      return measured > 0 ? measured : lastVisibleHeight || 28;
    };

    let dragHostLeft = 0;
    let dragStripInset = 0;
    prepareBookmarksToolbarForSidebarResize = () => {
      const hostBox = sidebarHostLayoutBox(host);
      const stripRect = getStrip()?.getBoundingClientRect?.();
      dragHostLeft = hostBox.left;
      dragStripInset =
        stripRect && Number.isFinite(stripRect.left) ? stripRect.left - hostBox.footprintRight : 0;
    };
    syncBookmarksToolbarForSidebarWidth = (width) => {
      applyOffset(currentSidebarHidden ? 0 : dragHostLeft + Math.max(0, width) + dragStripInset);
    };
    finishBookmarksToolbarSidebarResize = () => {
      scheduleUpdate();
    };

    let raf = 0;
    sidebarGeometryFrameCancels.push(() => {
      cancelAnimationFrame(raf);
      raf = 0;
    });
    const updateLayout = () => {
      raf = 0;
      // While a sidebar push runs the strip is translated, and the offset is the one
      // the push committed for its direction (the final one on a collapse, the
      // initial one on an expand until it ends), so it is not read back. This also
      // covers the mutation observer below, which bypasses the scheduling guard when
      // the push adds its class to the toolbar. The height is not affected by it.
      if (!isBentoSidebarPushing()) applyOffset(readOffset());
      applyHeight(readHeight());
    };
    const scheduleUpdate = () => {
      if (isBentoChromeLiveResizing()) return;
      if (raf) return;
      raf = requestAnimationFrame(updateLayout);
    };
    const updateNowAndSchedule = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      updateLayout();
      scheduleUpdate();
    };

    scheduleUpdate();
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener(BENTO_RESIZE_SETTLED_EVENT, scheduleUpdate);
    window.addEventListener('aftercustomization', scheduleUpdate, true);
    toolbar.addEventListener('transitionend', scheduleUpdate, true);
    if (window.MutationObserver) {
      const observer = new MutationObserver(updateNowAndSchedule);
      observer.observe(toolbar, {
        attributes: true,
        attributeFilter: ['collapsed', 'hidden', 'style', 'class'],
      });
      toolbar._bentoBookmarksToolbarMutationObserver = observer;
    }
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(scheduleUpdate);
      ro.observe(host);
      ro.observe(toolbar);
      const strip = getStrip();
      if (strip) ro.observe(strip);
      toolbar._bentoBookmarksToolbarAlignmentResizeObserver = ro;
    }
  }

  // Type the value into the panel browser's URI fixup machinery and
  // navigate. Mirrors what the chrome URL bar does on Enter, but routed
  // to a specific <browser> rather than gBrowser.selectedBrowser.
  function isRealPanelUrl(url) {
    return !!url && url !== 'about:blank' && url !== 'about:newtab' && !isBentoPanelNewTabUrl(url);
  }

  function isBentoPanelNewTabUrl(url) {
    return typeof url === 'string' && url.includes(BENTO_PANEL_NEWTAB_PATH);
  }

  function rememberPanelBrowserUrl(browserEl, url) {
    if (!browserEl || !isRealPanelUrl(url)) return;
    browserEl._bentoLastNonBlankUrl = url;
    const panelEl = browserEl.closest?.('[data-bento-main-panel], [data-bento-panel-tab-id]');
    if (panelEl) panelEl.dataset.bentoLastNonBlankUrl = url;
  }

  function loadInPanel(browserEl, value) {
    if (!browserEl) return;
    try {
      const flags =
        Services.uriFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
        Services.uriFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
      const info = Services.uriFixup.getFixupURIInfo(value, flags);
      const uri = info.preferredURI;
      if (!uri || isDisallowedAddressURI(uri)) return;
      rememberPanelBrowserUrl(browserEl, uri.spec);
      const loadOptions = getBentoContentLoadOptions();
      if (typeof browserEl.fixupAndLoadURIString === 'function') {
        browserEl.fixupAndLoadURIString(uri.spec, loadOptions);
      } else {
        browserEl.loadURI(uri, loadOptions);
      }
    } catch (err) {
      console.warn('[bento-shell-mount] panel header load failed:', err);
    }
  }

  function decodeAddrbarPayload(payload) {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  }

  function parseAddrbarNavigatePayload(encodedPayload) {
    const decoded = decodeAddrbarPayload(encodedPayload).trim();
    if (!decoded.startsWith('{')) {
      return { value: decoded };
    }
    const parsed = JSON.parse(decoded);
    const value = typeof parsed?.value === 'string' ? parsed.value.trim() : '';
    const searchEngineId =
      typeof parsed?.searchEngineId === 'string' && parsed.searchEngineId.trim()
        ? parsed.searchEngineId.trim()
        : undefined;
    return searchEngineId ? { value, searchEngineId } : { value };
  }

  function parseAddrbarOpenPayload(encodedPayload) {
    const decoded = decodeAddrbarPayload(encodedPayload).trim();
    if (!decoded.startsWith('{')) {
      return { mode: decoded === 'newTab' ? 'newTab' : 'current', initialQuery: '', requestId: '' };
    }
    const parsed = JSON.parse(decoded);
    const anchorRect =
      parsed?.anchorRect && typeof parsed.anchorRect === 'object'
        ? {
            left: Number(parsed.anchorRect.left) || 0,
            top: Number(parsed.anchorRect.top) || 0,
            width: Number(parsed.anchorRect.width) || 0,
            height: Number(parsed.anchorRect.height) || 0,
          }
        : null;
    return {
      mode: parsed?.mode === 'newTab' ? 'newTab' : 'current',
      initialQuery: typeof parsed?.initialQuery === 'string' ? parsed.initialQuery : '',
      clipboardUrl: typeof parsed?.clipboardUrl === 'string' ? parsed.clipboardUrl : '',
      requestId: typeof parsed?.requestId === 'string' ? parsed.requestId : '',
      anchorRect,
    };
  }

  function handleAddrbarOpenTitle(title) {
    const tail = title.slice(ADDRBAR_OPEN_PREFIX.length);
    const colon = tail.indexOf(':');
    if (colon < 0) {
      openAddressEntry('newTab');
      return;
    }
    try {
      handleAddrbarOpenAnswer(parseAddrbarOpenPayload(tail.slice(colon + 1)));
    } catch (err) {
      console.warn('[bento-shell-mount] addrbar open payload decode failed:', err);
      openAddressEntry('newTab');
    }
  }

  function handleAddrbarReadyTitle(title) {
    const tail = title.slice(ADDRBAR_READY_PREFIX.length);
    const encodedPayload = tail.startsWith(':') ? tail.slice(1) : tail;
    if (!encodedPayload) return;
    try {
      const parsed = JSON.parse(decodeAddrbarPayload(encodedPayload));
      const openId = typeof parsed?.openId === 'string' ? parsed.openId : '';
      if (openId) revealPendingAddrbar(openId);
    } catch (err) {
      console.warn('[bento-shell-mount] addrbar ready payload decode failed:', err);
    }
  }

  function resolveAddrbarSpec(value) {
    const flags =
      Services.uriFixup.FIXUP_FLAG_ALLOW_KEYWORD_LOOKUP |
      Services.uriFixup.FIXUP_FLAG_FIX_SCHEME_TYPOS;
    const info = Services.uriFixup.getFixupURIInfo(value, flags);
    return info.preferredURI?.spec || null;
  }

  function isDisallowedAddressURI(uri) {
    try {
      return uri?.schemeIs?.('javascript') === true;
    } catch {
      return true;
    }
  }

  function isDisallowedAddressSpec(spec) {
    try {
      return isDisallowedAddressURI(Services.io.newURI(spec));
    } catch {
      return true;
    }
  }

  function getBentoContentLoadOptions() {
    return {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      loadFlags: BENTO_CONTENT_LOAD_FLAGS,
    };
  }

  function stripUnsafeAddressProtocols(value) {
    let sanitized = String(value || '');
    for (;;) {
      let prefixLength = 0;
      while (
        prefixLength < sanitized.length &&
        sanitized.charCodeAt(prefixLength) <= 0x20
      ) {
        prefixLength += 1;
      }
      const candidate = sanitized.slice(prefixLength);
      let scheme = '';
      try {
        scheme = Services.io.extractScheme(candidate);
      } catch {
        return sanitized;
      }
      if (scheme.toLowerCase() !== 'javascript') return sanitized;
      sanitized = candidate.slice(candidate.indexOf(':') + 1);
    }
  }

  function sanitizeAddressPaste(event, input) {
    const pasted = event.clipboardData?.getData?.('text/plain');
    if (typeof pasted !== 'string' || !pasted) return;
    const sanitized = stripUnsafeAddressProtocols(pasted);
    if (sanitized === pasted) return;
    event.preventDefault();
    const start = Number.isInteger(input.selectionStart) ? input.selectionStart : input.value.length;
    const end = Number.isInteger(input.selectionEnd) ? input.selectionEnd : start;
    input.setRangeText(sanitized, start, end, 'end');
  }

  function isAddrbarUrlLike(value) {
    const trimmed = String(value || '').trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return true;
    return /^[^\s]+\.[^\s]+$/.test(trimmed);
  }

  let addrbarSearchService = null;
  function getAddrbarSearchService() {
    if (addrbarSearchService) return addrbarSearchService;
    try {
      const mod = ChromeUtils.importESModule(
        'moz-src:///toolkit/components/search/SearchService.sys.mjs',
      );
      addrbarSearchService = mod.SearchService || null;
    } catch (err) {
      console.warn('[bento-shell-mount] SearchService import failed:', err);
      addrbarSearchService = null;
    }
    return addrbarSearchService;
  }

  async function resolveAddrbarSearchSpec(value, searchEngineId) {
    if (typeof searchEngineId !== 'string' || !searchEngineId.trim()) return null;
    const SearchService = getAddrbarSearchService();
    if (!SearchService) return null;
    await SearchService.promiseInitialized;
    const engine = SearchService.getEngineById(searchEngineId);
    const submission = engine?.getSubmission?.(value);
    return submission?.uri?.spec || null;
  }

  function scheduleScrollMainPanelIntoViewForAddrbar() {
    clearRestoredMainAutoScrollSuppression();
    setTimeout(() => {
      const mainEl =
        getOrderedPanels()[0] || document.querySelector('[data-bento-main-panel="1"]');
      if (mainEl) scrollPanelToLeftmost(mainEl);
    }, 0);
  }

  function shouldOpenAddrbarSpecWithChromeNewTab(spec) {
    try {
      const scheme = Services.io.newURI(spec).scheme;
      return scheme === 'about' || scheme === 'chrome';
    } catch {
      return false;
    }
  }

  function openTrustedAddrbarNewTab(spec) {
    if (!window.gBrowser || typeof window.gBrowser.addTrustedTab !== 'function') return false;
    try {
      const tab = window.gBrowser.addTrustedTab(spec, { skipAnimation: true });
      if (!tab) return false;
      window.gBrowser.selectedTab = tab;
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] addrbar trusted new-tab load failed:', err);
      return false;
    }
  }

  async function navigateAddressEntry(value, mode, searchEngineId) {
    let spec = null;
    if (searchEngineId && !isAddrbarUrlLike(value)) {
      try {
        spec = await resolveAddrbarSearchSpec(value, searchEngineId);
      } catch (err) {
        console.warn('[bento-shell-mount] addrbar search engine resolution failed:', err);
      }
    }
    if (!spec) spec = resolveAddrbarSpec(value);
    if (!spec || isDisallowedAddressSpec(spec)) return false;

    if (mode === 'newTab') {
      if (shouldOpenAddrbarSpecWithChromeNewTab(spec)) {
        if (!openTrustedAddrbarNewTab(spec)) return false;
      } else {
        dispatchShellAction({ type: 'tab/openUrl', url: spec });
      }
      scheduleScrollMainPanelIntoViewForAddrbar();
      return true;
    }

    const browserEl = window.gBrowser?.selectedBrowser;
    if (!browserEl) return false;
    const loadOptions = getBentoContentLoadOptions();
    if (typeof browserEl.fixupAndLoadURIString === 'function') {
      browserEl.fixupAndLoadURIString(spec, loadOptions);
    } else {
      const uri = Services.io.newURI(spec);
      browserEl.loadURI(uri, loadOptions);
    }
    scheduleScrollMainPanelIntoViewForAddrbar();
    return true;
  }

  async function handleAddrbarNavigateTitle(title) {
    const colon = title.indexOf(':');
    if (colon < 0) {
      hideAddrbar();
      return;
    }
    let payload;
    try {
      payload = parseAddrbarNavigatePayload(title.slice(colon + 1));
    } catch (err) {
      console.warn('[bento-shell-mount] addrbar payload decode failed:', err);
      hideAddrbar();
      return;
    }
    const value = payload.value.trim();
    if (!value) {
      hideAddrbar();
      return;
    }

    try {
      await navigateAddressEntry(value, currentAddrbarMode, payload.searchEngineId);
    } catch (err) {
      console.warn('[bento-shell-mount] addrbar navigation failed:', err);
    } finally {
      hideAddrbar();
    }
  }

  function loadDefaultNewTabInBrowser(browserEl) {
    if (!browserEl) return;
    const panelNewTabUrl = moz(BENTO_PANEL_NEWTAB_PATH);
    if (!panelNewTabUrl) return;
    const currentSpec = getBrowserCurrentSpec(browserEl);
    if (isBentoPanelNewTabUrl(currentSpec)) return;
    const now = Date.now();
    if (
      browserEl._bentoEnsuringUrl === panelNewTabUrl &&
      Number(browserEl._bentoEnsuringDefaultNewTabUntil || 0) > now
    ) {
      return;
    }
    browserEl._bentoEnsuringUrl = panelNewTabUrl;
    browserEl._bentoEnsuringDefaultNewTabUntil = now + 1500;
    try {
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      if (typeof browserEl.fixupAndLoadURIString === 'function') {
        browserEl.fixupAndLoadURIString(panelNewTabUrl, { triggeringPrincipal: principal });
      } else if (typeof browserEl.loadURI === 'function') {
        browserEl.loadURI(Services.io.newURI(panelNewTabUrl), {
          triggeringPrincipal: principal,
        });
      }
    } catch (err) {
      console.warn('[bento-shell-mount] default newtab load failed:', err);
    }
  }

  function getBrowserCurrentSpec(browserEl) {
    try {
      return browserEl?.currentURI?.spec || '';
    } catch {
      return '';
    }
  }

  function getLivePanelBrowser(tabOrBrowser) {
    const browserEl =
      tabOrBrowser?.localName === 'browser' ? tabOrBrowser : tabOrBrowser?.linkedBrowser;
    if (!browserEl) return null;
    try {
      if (!browserEl.frameLoader) return null;
      if (!browserEl.browsingContext) return null;
    } catch {
      return null;
    }
    return browserEl;
  }

  function ensurePanelInitialContent(tab, panelEl, browserEl, payloadUrl, options = {}) {
    if (!browserEl) return;
    const currentSpec = getBrowserCurrentSpec(browserEl);
    if (isRealPanelUrl(currentSpec)) {
      rememberPanelBrowserUrl(browserEl, currentSpec);
      return;
    }

    const payload = typeof payloadUrl === 'string' ? payloadUrl.trim() : '';
    if (payload === 'about:newtab' || isBentoPanelNewTabUrl(payload)) {
      if (shouldLoadDefaultNewTabForPanel(browserEl, panelEl, payload, options)) {
        loadDefaultNewTabInBrowser(browserEl);
      }
      return;
    }
    const remembered = getRememberedPanelUrl(panelEl, browserEl);
    const target = isRealPanelUrl(remembered) ? remembered : payload;
    if (!isRealPanelUrl(target)) return;

    try {
      if (browserEl.webProgress?.isLoadingDocument && browserEl._bentoEnsuringUrl === target) {
        return;
      }
    } catch {
      // If webProgress is unavailable, fall through and try the load.
    }

    browserEl._bentoEnsuringUrl = target;
    if (tab?.linkedBrowser) {
      try {
        tab.linkedBrowser.docShellIsActive = true;
      } catch {
        // Best effort before forcing the URL load.
      }
    }
    loadInPanel(browserEl, target);
  }

  function getRememberedPanelUrl(panelEl, browserEl) {
    const headerUrl =
      panelEl?.querySelector?.(':scope > .bento-panel-header .bento-panel-header-url')?.value || '';
    return (
      browserEl?._bentoLastNonBlankUrl || panelEl?.dataset?.bentoLastNonBlankUrl || headerUrl || ''
    );
  }

  function reloadPanelBrowser(browserEl, panelEl, fallbackUrl, reloadFlags = null) {
    if (!browserEl) return;
    try {
      if (reloadFlags !== null && typeof browserEl.reloadWithFlags === 'function') {
        browserEl.reloadWithFlags(reloadFlags);
      } else {
        browserEl.reload();
      }
      return;
    } catch {
      // A panel browser can briefly have a navigation facade that is not
      // ready. Fall back to loading the URL we already know for this panel
      // instead of routing reload to selectedTab.
    }

    const target =
      getRememberedPanelUrl(panelEl, browserEl) ||
      getBrowserCurrentSpec(browserEl) ||
      (typeof fallbackUrl === 'string' ? fallbackUrl : '');
    if (isRealPanelUrl(target)) {
      loadInPanel(browserEl, target);
    } else if (
      !target ||
      target === 'about:newtab' ||
      isBentoPanelNewTabUrl(target) ||
      target === 'about:blank'
    ) {
      loadDefaultNewTabInBrowser(browserEl);
    }
  }

  function shouldLoadDefaultNewTabForPanel(browserEl, panelEl, payloadUrl, options = {}) {
    if (payloadUrl !== 'about:newtab' && !isBentoPanelNewTabUrl(payloadUrl)) return false;
    if (options.wasPending) return false;
    let currentUrl = '';
    try {
      currentUrl = browserEl?.currentURI?.spec || '';
    } catch {
      currentUrl = '';
    }
    if (isRealPanelUrl(currentUrl)) return false;
    if (isBentoPanelNewTabUrl(currentUrl)) return false;
    if (isRealPanelUrl(getRememberedPanelUrl(panelEl, browserEl))) return false;
    return true;
  }

  function getPlacesUtils() {
    const { PlacesUtils } = ChromeUtils.importESModule(
      'resource://gre/modules/PlacesUtils.sys.mjs',
    );
    return PlacesUtils;
  }

  async function getSavedPanelsFolderGuid(PlacesUtils) {
    try {
      const list = [];
      await PlacesUtils.bookmarks.fetch(
        { parentGuid: PlacesUtils.bookmarks.unfiledGuid },
        (item) => {
          if (item?.guid) list.push(item);
        },
      );
      const folder = list.find(
        (item) =>
          item?.type === PlacesUtils.bookmarks.TYPE_FOLDER && item.title === 'Saved panels',
      );
      return folder?.guid || null;
    } catch {
      return null;
    }
  }

  async function getBookmarksForUrl(PlacesUtils, url) {
    const matches = [];
    await PlacesUtils.bookmarks.fetch({ url }, (bookmark) => {
      if (bookmark?.guid) matches.push(bookmark);
    });
    return matches;
  }

  function normalizeBookmarkUrlSpec(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    try {
      return Services.io.newURI(value).spec;
    } catch {
      return '';
    }
  }

  function isBookmarkableUrlSpec(spec) {
    if (!spec) return false;
    if (spec === 'about:blank' || spec === 'about:newtab') return false;
    if (isBentoPanelNewTabUrl(spec)) return false;
    return true;
  }

  function getActiveMainBrowser() {
    return window.gBrowser?.selectedBrowser || null;
  }

  function getSelectedWebExtensionTabId() {
    try {
      const tab = window.gBrowser?.selectedTab;
      const tracker = getTabTracker();
      const id = tab && tracker?.getId?.(tab);
      return Number.isInteger(id) ? id : null;
    } catch {
      return null;
    }
  }

  function activeMainBrowserSpec() {
    try {
      return getActiveMainBrowser()?.currentURI?.spec || '';
    } catch {
      return '';
    }
  }

  function sidebarAddressUrlMatchesActiveMain(url) {
    const payloadSpec = normalizeBookmarkUrlSpec(url);
    const activeSpec = normalizeBookmarkUrlSpec(activeMainBrowserSpec());
    return !!payloadSpec && !!activeSpec && payloadSpec === activeSpec;
  }

  function classifyRegularBookmarks(bookmarks, savedPanelsFolderGuid) {
    return bookmarks.filter((bookmark) => bookmark.parentGuid !== savedPanelsFolderGuid);
  }

  async function getRegularBookmarkStateForUrl(spec) {
    if (!isBookmarkableUrlSpec(spec)) {
      return { isBookmarked: false, canBookmark: false };
    }
    try {
      const PlacesUtils = getPlacesUtils();
      const bookmarks = await getBookmarksForUrl(PlacesUtils, spec);
      const savedPanelsFolderGuid = await getSavedPanelsFolderGuid(PlacesUtils);
      return {
        isBookmarked: classifyRegularBookmarks(bookmarks, savedPanelsFolderGuid).length > 0,
        canBookmark: true,
      };
    } catch {
      return { isBookmarked: false, canBookmark: false };
    }
  }

  function setPanelBookmarkButtonState(bookmarkBtn, isBookmarked) {
    if (!bookmarkBtn) return;
    const title = isBookmarked ? 'Remove bookmark' : 'Bookmark page';
    bookmarkBtn.title = title;
    bookmarkBtn.setAttribute('aria-label', title);
    bookmarkBtn.classList.toggle('bento-panel-header-button--active', isBookmarked);
  }

  async function updatePanelBookmarkButtonState(browserEl, bookmarkBtn) {
    if (!bookmarkBtn) return;
    let uri;
    try {
      uri = browserEl.currentURI;
    } catch {
      setPanelBookmarkButtonState(bookmarkBtn, false);
      return;
    }
    if (!uri || !isRealPanelUrl(uri.spec)) {
      setPanelBookmarkButtonState(bookmarkBtn, false);
      return;
    }
    try {
      const spec = uri.spec;
      const PlacesUtils = getPlacesUtils();
      const bookmarks = await getBookmarksForUrl(PlacesUtils, spec);
      const savedPanelsFolderGuid = await getSavedPanelsFolderGuid(PlacesUtils);
      try {
        if (browserEl.currentURI?.spec !== spec) return;
      } catch {
        return;
      }
      const hasRegularBookmark = bookmarks.some(
        (bookmark) => bookmark.parentGuid !== savedPanelsFolderGuid,
      );
      setPanelBookmarkButtonState(bookmarkBtn, hasRegularBookmark);
    } catch (err) {
      console.warn('[bento-shell-mount] bookmark state lookup failed:', err);
    }
  }

  // Toggle a Firefox bookmark for the panel URL. This is separate from
  // Bento's managed "Saved panels" folder: Save panel still owns that list.
  async function togglePanelPageBookmark(browserEl, bookmarkBtn) {
    let uri;
    try {
      uri = browserEl.currentURI;
    } catch {
      return;
    }
    if (!uri || !isRealPanelUrl(uri.spec)) return;
    let title;
    try {
      title = browserEl.contentTitle || uri.spec;
    } catch {
      title = uri.spec;
    }
    try {
      const PlacesUtils = getPlacesUtils();
      const bookmarks = await getBookmarksForUrl(PlacesUtils, uri.spec);
      const savedPanelsFolderGuid = await getSavedPanelsFolderGuid(PlacesUtils);
      const removableBookmarks = bookmarks.filter(
        (bookmark) => bookmark.parentGuid !== savedPanelsFolderGuid,
      );
      if (removableBookmarks.length > 0) {
        await Promise.all(
          removableBookmarks.map((bookmark) => PlacesUtils.bookmarks.remove(bookmark.guid)),
        );
        setPanelBookmarkButtonState(bookmarkBtn, false);
      } else {
        await PlacesUtils.bookmarks.insert({
          parentGuid: PlacesUtils.bookmarks.unfiledGuid,
          url: uri.spec,
          title,
        });
        setPanelBookmarkButtonState(bookmarkBtn, true);
      }
    } catch (err) {
      console.warn('[bento-shell-mount] bookmark toggle failed:', err);
    }
  }

  // The end of the panel options menu: Save panel, which bookmarks the panel's URL and title
  // into the shared Saved panels folder. A private window saves nothing, so it has no such item.
  function savePanelMenuItems() {
    if (BentoPrivateBrowsingUtils.isWindowPrivate(window)) return [];
    return [
      { id: 'sep-save-panel', kind: 'separator' },
      { id: 'save-panel', label: 'Save panel' },
    ];
  }

  function setPanelPinButtonState(pinBtn, tabId) {
    if (!pinBtn || !Number.isFinite(tabId)) return;
    const isPinned = currentPinnedTabIdsInWorkspace.has(tabId);
    const title = isPinned ? 'Unpin this panel' : 'Pin this panel';
    pinBtn.title = title;
    pinBtn.setAttribute('aria-label', title);
    pinBtn.classList.toggle('bento-panel-header-button--active', isPinned);
  }

  function updatePanelHeaderPinButtons() {
    document.querySelectorAll('.bento-panel-header-button--pin').forEach((pinBtn) => {
      const rawTabId = pinBtn.getAttribute('data-bento-panel-pin-tab-id');
      const tabId = Number(rawTabId);
      setPanelPinButtonState(pinBtn, tabId);
    });
  }

  function setPanelAudioButtonState(audioBtn, tabId) {
    if (!audioBtn || !Number.isFinite(tabId)) return;
    const state = currentPanelAudioByTabId.get(tabId);
    const audible = state?.audible === true;
    const muted = state?.muted === true;
    const visible = audible || muted;
    const title = muted ? 'Unmute panel' : 'Mute panel';
    audioBtn.hidden = !visible;
    audioBtn.title = title;
    audioBtn.setAttribute('aria-label', title);
    audioBtn.classList.toggle('bento-panel-header-button--active', muted);
    audioBtn.replaceChildren(makeIcon(muted ? ICONS.volumeX : ICONS.volume2));
  }

  function updatePanelHeaderAudioButtons() {
    document.querySelectorAll('.bento-panel-header-button--audio').forEach((audioBtn) => {
      const rawTabId = audioBtn.getAttribute('data-bento-panel-audio-tab-id');
      const tabId = Number(rawTabId);
      setPanelAudioButtonState(audioBtn, tabId);
    });
  }

  function canSubdivideFromPanelHeader(tabId, panelEl) {
    if (!Number.isFinite(tabId) || !panelEl) return false;
    return currentPanelStatusByTabId.get(tabId) === 'root-panel';
  }

  function canSplitTopPanelFromPanelHeader(tabId, panelEl) {
    if (!Number.isFinite(tabId) || !panelEl) return false;
    const status = currentPanelStatusByTabId.get(tabId);
    return status === 'chooser-owner' || status === 'subdivision-top';
  }

  function canSplitBottomPanelFromPanelHeader(tabId, panelEl) {
    if (!Number.isFinite(tabId) || !panelEl) return false;
    return currentPanelStatusByTabId.get(tabId) === 'subdivision-bottom';
  }

  function canBreakOutFromPanelHeader(tabId, panelEl) {
    if (!Number.isFinite(tabId) || !panelEl) return false;
    const status = currentPanelStatusByTabId.get(tabId);
    return status === 'subdivision-bottom' || status === 'split-child';
  }

  function getTopLevelSlotPanelElement(panelEl) {
    if (!panelEl) return null;
    return panelEl.closest?.('[data-bento-panel-tab-id]') || panelEl;
  }

  function clearBentoDomFullscreenRequester() {
    document.documentElement.removeAttribute(BENTO_DOM_FULLSCREEN_PANEL_ATTR);
    for (const panelEl of document.querySelectorAll(
      `[${BENTO_DOM_FULLSCREEN_REQUESTER_ATTR}]`,
    )) {
      panelEl.style?.removeProperty('-moz-subtree-hidden-only-visually');
      panelEl.style?.removeProperty('visibility');
      panelEl.style?.removeProperty('opacity');
      panelEl.removeAttribute(BENTO_DOM_FULLSCREEN_REQUESTER_ATTR);
    }
  }

  function getBrowserFromDomFullscreenEvent(event) {
    const target = event?.target;
    if (!target) return null;
    if (target.localName === 'browser') return target;
    return target.documentGlobal?.docShell?.chromeEventHandler || null;
  }

  function markBentoDomFullscreenRequesterForBrowser(browserEl) {
    if (!browserEl?.closest) return false;
    const panelEl = browserEl.closest('[data-bento-panel-tab-id], [data-bento-main-panel]');
    const slotPanelEl = getTopLevelSlotPanelElement(panelEl);
    if (!slotPanelEl?.classList?.contains('split-view-panel-active')) return false;
    clearBentoDomFullscreenRequester();
    slotPanelEl.setAttribute(BENTO_DOM_FULLSCREEN_REQUESTER_ATTR, '1');
    if (panelEl && panelEl !== slotPanelEl) {
      panelEl.setAttribute(BENTO_DOM_FULLSCREEN_REQUESTER_ATTR, '1');
    }
    browserEl.setAttribute(BENTO_DOM_FULLSCREEN_REQUESTER_ATTR, '1');
    for (const el of [slotPanelEl, panelEl, browserEl]) {
      if (!el?.style) continue;
      el.style.setProperty('-moz-subtree-hidden-only-visually', '0', 'important');
      el.style.setProperty('visibility', 'inherit', 'important');
      el.style.setProperty('opacity', '1', 'important');
    }
    try {
      browserEl.preserveLayers?.(true);
      browserEl.renderLayers = true;
      browserEl.docShellIsActive = true;
    } catch {
      // Best-effort paint nudge while entering DOM fullscreen.
    }
    forceHidePanelLoadingOverlay(slotPanelEl);
    forceHidePanelLoadingOverlay(panelEl);
    if (!slotPanelEl.dataset?.bentoMainPanel) {
      document.documentElement.setAttribute(BENTO_DOM_FULLSCREEN_PANEL_ATTR, 'true');
    }
    return true;
  }

  function markBentoDomFullscreenRequester(event) {
    const browserEl = getBrowserFromDomFullscreenEvent(event);
    markBentoDomFullscreenRequesterForBrowser(browserEl);
  }

  function attachBentoDomFullscreenRequesterTracking() {
    window.BentoShellDomFullscreen = {
      clearRequester: clearBentoDomFullscreenRequester,
      markRequesterForBrowser: markBentoDomFullscreenRequesterForBrowser,
    };
    window.addEventListener('MozDOMFullscreen:Entered', markBentoDomFullscreenRequester, true);
    window.addEventListener('MozDOMFullscreen:Exited', clearBentoDomFullscreenRequester, true);
    document.addEventListener(
      'fullscreenchange',
      () => {
        if (!document.fullscreenElement) clearBentoDomFullscreenRequester();
      },
      true,
    );
  }
  attachBentoDomFullscreenRequesterTracking();

  function getTopLevelSlotTabId(panelEl) {
    const slotPanel = getTopLevelSlotPanelElement(panelEl);
    const tabId = Number(slotPanel?.dataset?.bentoPanelTabId);
    return Number.isFinite(tabId) ? tabId : null;
  }

  function layoutNodeContainsTabId(node, tabId) {
    if (!node || !Number.isFinite(tabId)) return false;
    if (node.kind === 'panel') return Number(node.tabId) === tabId;
    if (node.kind === 'chooser') return false;
    return (node.children || []).some((child) => layoutNodeContainsTabId(child, tabId));
  }

  function getRootNodeIdContainingTabId(tabId) {
    if (!Number.isFinite(tabId)) return null;
    for (const root of currentPanelLayout?.root || []) {
      if (!layoutNodeContainsTabId(root, tabId)) continue;
      return root.kind === 'panel' ? 'panel:' + Number(root.tabId) : root.id || null;
    }
    return null;
  }

  function getTopLevelPanelElementForTabId(tabId) {
    if (!Number.isFinite(tabId)) return null;
    const exact = document.querySelector(`[data-bento-panel-tab-id="${CSS.escape(String(tabId))}"]`);
    if (exact) return exact;
    const rootNodeId = getRootNodeIdContainingTabId(tabId);
    if (!rootNodeId) return null;
    return document.querySelector(`[data-bento-root-node-id="${CSS.escape(rootNodeId)}"]`);
  }

  function getPanelElementForTabId(tabId) {
    if (!Number.isFinite(tabId)) return null;
    return document.querySelector(`[data-bento-panel-tab-id="${CSS.escape(String(tabId))}"]`);
  }

  function getViewportPanelRectForTabId(tabId) {
    if (!Number.isFinite(tabId)) return null;
    const panelEl = getPanelElementForTabId(tabId);
    const panelRect = panelEl?.getBoundingClientRect?.();
    if (panelRect && panelRect.width > 0 && panelRect.height > 0) return panelRect;
    const localRect = currentPanelLayoutGeometry?.panelRects?.get(tabId);
    if (!localRect) return null;
    return viewportRectForLocalLayoutRect(localRect);
  }

  function getDevtoolsPartnerElement(panelEl) {
    const slot = getTopLevelSlotPanelElement(panelEl);
    if (!slot) return null;
    if (slot.dataset?.bentoDevtoolsFor) {
      const caller = slot.dataset.bentoDevtoolsFor;
      if (caller === 'main') return document.querySelector('[data-bento-main-panel="1"]');
      return getTopLevelPanelElementForTabId(Number(caller));
    }
    const tabId = getTopLevelSlotTabId(slot);
    const rootNodeId = slot.dataset?.bentoRootNodeId || getRootNodeIdContainingTabId(tabId);
    const link = Array.from(currentDevtoolsLinkByTabId.values()).find(
      (candidate) =>
        candidate.callerTabId === tabId ||
        getRootNodeIdContainingTabId(candidate.callerTabId) === rootNodeId,
    );
    if (link) {
      return document.querySelector(
        `[data-bento-panel-tab-id="${CSS.escape(String(link.devtoolsTabId))}"]`,
      );
    }
    if (slot.dataset?.bentoMainPanel === '1' && currentMainDevtoolsLink) {
      return document.querySelector(
        `[data-bento-panel-tab-id="${CSS.escape(String(currentMainDevtoolsLink.devtoolsTabId))}"]`,
      );
    }
    return null;
  }

  function getDevtoolsFocusPartnerElement(panelEl) {
    if (!panelEl) return null;
    if (panelEl.dataset?.bentoMainPanel === '1') {
      if (!currentMainDevtoolsLink) return null;
      return document.querySelector(
        `[data-bento-panel-tab-id="${CSS.escape(String(currentMainDevtoolsLink.devtoolsTabId))}"]`,
      );
    }

    const tabId = Number(panelEl.dataset?.bentoPanelTabId);
    if (!Number.isFinite(tabId)) return null;
    const devtoolsLink = currentDevtoolsLinkByTabId.get(tabId);
    if (devtoolsLink) {
      if (devtoolsLink.callerTabId === null) {
        return document.querySelector('[data-bento-main-panel="1"]');
      }
      return getPanelElementForTabId(devtoolsLink.callerTabId);
    }

    const link = Array.from(currentDevtoolsLinkByTabId.values()).find(
      (candidate) => candidate.callerTabId === tabId,
    );
    if (!link) return null;
    return document.querySelector(
      `[data-bento-panel-tab-id="${CSS.escape(String(link.devtoolsTabId))}"]`,
    );
  }

  function areDevtoolsPairPanelElements(leftPanelEl, rightPanelEl) {
    if (!leftPanelEl || !rightPanelEl) return false;
    return (
      getDevtoolsPartnerElement(leftPanelEl) === rightPanelEl ||
      getDevtoolsPartnerElement(rightPanelEl) === leftPanelEl
    );
  }

  function getDevtoolsLinkForPanelPair(leftPanelEl, rightPanelEl) {
    const leftDevtoolsFor = leftPanelEl?.dataset?.bentoDevtoolsFor;
    const rightDevtoolsFor = rightPanelEl?.dataset?.bentoDevtoolsFor;
    const leftRootNodeId =
      leftPanelEl?.dataset?.bentoMainPanel === '1'
        ? 'main'
        : leftPanelEl?.dataset?.bentoRootNodeId ||
          getRootNodeIdContainingTabId(getTopLevelSlotTabId(leftPanelEl));
    const rightRootNodeId =
      rightPanelEl?.dataset?.bentoMainPanel === '1'
        ? 'main'
        : rightPanelEl?.dataset?.bentoRootNodeId ||
          getRootNodeIdContainingTabId(getTopLevelSlotTabId(rightPanelEl));

    if (leftDevtoolsFor) {
      const link = currentDevtoolsLinkByTabId.get(getTopLevelSlotTabId(leftPanelEl));
      const callerRootNodeId =
        link?.callerTabId === null ? 'main' : getRootNodeIdContainingTabId(link?.callerTabId);
      if (link && callerRootNodeId === rightRootNodeId) return link;
    }
    if (rightDevtoolsFor) {
      const link = currentDevtoolsLinkByTabId.get(getTopLevelSlotTabId(rightPanelEl));
      const callerRootNodeId =
        link?.callerTabId === null ? 'main' : getRootNodeIdContainingTabId(link?.callerTabId);
      if (link && callerRootNodeId === leftRootNodeId) return link;
    }
    return null;
  }

  function getResizableSlotWidth(panelEl) {
    if (!panelEl) return 0;
    if (panelEl.dataset?.bentoMainPanel === '1') {
      const mainWidth = currentPanelLayoutGeometry?.mainRect?.width;
      if (Number.isFinite(mainWidth) && mainWidth > 0) return Math.round(mainWidth);
    }
    const rootNodeId = panelEl.dataset?.bentoRootNodeId;
    const rootWidth = rootNodeId ? currentPanelLayoutGeometry?.rootRects?.get(rootNodeId)?.width : 0;
    if (Number.isFinite(rootWidth) && rootWidth > 0) return Math.round(rootWidth);
    const rectWidth = panelEl.getBoundingClientRect?.().width || 0;
    return rectWidth > 0 ? Math.round(rectWidth) : 0;
  }

  function getHeaderActionBrowser(panelEl, fallbackBrowserEl) {
    if (fallbackBrowserEl?.isConnected) return fallbackBrowserEl;
    return (
      panelEl?.querySelector?.(':scope > .browserContainer browser') ||
      panelEl?.querySelector?.(':scope > browser') ||
      panelEl?.querySelector?.('browser') ||
      null
    );
  }

  // Build the header above each panel: back / forward / reload / URL
  // input / bookmark / pin. Wires a progress listener on the panel browser so
  // the URL stays in sync as the user navigates inside it.
  //
  // initialUrl pre-populates the URL input synchronously, so the user
  // sees the correct URL the moment the panel appears — the progress
  // listener doesn't need to fire first. about:blank is suppressed
  // (rendered as empty input) since it's the transient initial state
  // before the panel actually navigates.
  function createPanelHeader(browserEl, initialUrl, tabId) {
    const header = document.createXULElement('hbox');
    header.className = 'bento-panel-header';
    const getActionBrowser = () => {
      const panelEl = header.closest?.('[data-bento-main-panel], [data-bento-panel-tab-id]');
      return getHeaderActionBrowser(panelEl, browserEl) || browserEl;
    };

    const backBtn = makeHeaderButton('Back', ICONS.chevronLeft, () => {
      try {
        const actionBrowser = getActionBrowser();
        if (actionBrowser?.canGoBack) actionBrowser.goBack();
      } catch (e) {
        console.warn('[bento-shell-mount] panel goBack failed:', e);
      }
    });
    const forwardBtn = makeHeaderButton('Forward', ICONS.chevronRight, () => {
      try {
        const actionBrowser = getActionBrowser();
        if (actionBrowser?.canGoForward) actionBrowser.goForward();
      } catch (e) {
        console.warn('[bento-shell-mount] panel goForward failed:', e);
      }
    });
    attachPanelHistoryContextMenu(backBtn, getActionBrowser);
    attachPanelHistoryContextMenu(forwardBtn, getActionBrowser);
    const reloadBtn = makeHeaderButton('Reload', ICONS.rotateCcw, () => {
      const panelEl = header.closest?.('[data-bento-main-panel], [data-bento-panel-tab-id]');
      reloadPanelBrowser(getActionBrowser(), panelEl, initialUrl);
    });
    let audioBtn = null;
    if (Number.isFinite(tabId)) {
      audioBtn = makeHeaderButton('Mute panel', ICONS.volume2, () => {
        dispatchShellAction({ type: 'tab/toggleMuted', id: tabId });
      });
      audioBtn.classList.add('bento-panel-header-button--audio');
      audioBtn.setAttribute('data-bento-panel-audio-tab-id', String(tabId));
      setPanelAudioButtonState(audioBtn, tabId);
    }

    const urlInput = document.createElementNS(HTML_NS, 'input');
    urlInput.type = 'text';
    urlInput.className = 'bento-panel-header-url';
    urlInput.placeholder = 'Enter URL';
    urlInput.spellcheck = false;
    // about:blank and about:newtab are transient/empty states — Firefox's
    // own URL bar renders them as empty too. Skip them so the user sees
    // an empty, focusable input ready for typing rather than a noisy
    // about: URL on a fresh panel.
    if (isRealPanelUrl(initialUrl)) {
      urlInput.value = initialUrl;
      rememberPanelBrowserUrl(browserEl, initialUrl);
    }
    urlInput.addEventListener('focus', () => {
      // Spotlight-style: select-all on focus so typing replaces the URL.
      setTimeout(() => urlInput.select(), 0);
    });
    urlInput.addEventListener('paste', (event) => sanitizeAddressPaste(event, urlInput));
    // After Enter (navigate) or Escape (cancel), put DOM focus back on
    // the panel container so the Up/Down content-scroll handler and the
    // keyboard cycle handler keep working. Without this, focus lands
    // on document body after blur, and arrow keys do nothing until the
    // user clicks back into the panel.
    function returnFocusToPanel() {
      const panelEl = urlInput.closest('[data-bento-main-panel], [data-bento-panel-tab-id]');
      if (!panelEl) return;
      try {
        panelEl.focus({ preventScroll: true });
      } catch {
        /* best-effort; setActiveByIndex relies on the same call working */
      }
    }
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = urlInput.value.trim();
        if (value) loadInPanel(getActionBrowser(), value);
        returnFocusToPanel();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        // Discard any in-progress edit by restoring the displayed URL
        // before handing focus back. Mirrors Firefox's #urlbar Esc
        // behaviour.
        let spec = '';
        try {
          spec = getActionBrowser()?.currentURI?.spec || '';
        } catch {
          spec = '';
        }
        if (spec && spec !== 'about:blank' && spec !== 'about:newtab') {
          urlInput.value = spec;
        } else {
          urlInput.value = '';
        }
        returnFocusToPanel();
      }
    });

    const bookmarkBtn = makeHeaderButton('Bookmark page', ICONS.bookmark, () => {
      togglePanelPageBookmark(getActionBrowser(), bookmarkBtn);
    });

    // A private window stores nothing, so it has no pinned panels to pin to.
    let pinBtn = null;
    if (
      Number.isFinite(tabId) &&
      !currentDevtoolsLinkByTabId.has(tabId) &&
      !BentoPrivateBrowsingUtils.isWindowPrivate(window)
    ) {
      pinBtn = makeHeaderButton('Pin this panel', ICONS.pin, () => {
        if (!currentWorkspaceId) return;
        const panelEl = pinBtn.closest?.('[data-bento-panel-tab-id]');
        if (
          currentDevtoolsLinkByTabId.has(tabId) ||
          panelEl?.hasAttribute?.('data-bento-devtools-for')
        ) {
          return;
        }
        const isPinned = currentPinnedTabIdsInWorkspace.has(tabId);
        dispatchShellAction({
          type: isPinned ? 'pinnedPanel/remove' : 'pinnedPanel/add',
          workspaceId: currentWorkspaceId,
          tabId,
        });
      });
      pinBtn.classList.add('bento-panel-header-button--pin');
      pinBtn.setAttribute('data-bento-panel-pin-tab-id', String(tabId));
      setPanelPinButtonState(pinBtn, tabId);
    }

    // Close button: dispatches tab/close (NOT panel/remove). Closing a
    // side panel closes its underlying tab entirely — the tab does not
    // return to the sidebar list. bento-tools' tabs.onRemoved handler
    // (background.ts:201) automatically strips the tab from PanelStore
    // and emits panels/sync, which drives the reconciler to remove the
    // panel from the layout. Only wired when a tabId was passed
    // (defensive — the header can be constructed in test contexts
    // without one).
    let closeBtn = null;
    if (Number.isFinite(tabId)) {
      closeBtn = makeHeaderButton('Close panel', ICONS.x, () => removePanel(tabId));
    }

    // Kebab "more" button: opens a Mux Menu (via the generic
    // chrome-menu overlay) of panel-scoped options. First population
    // is the custom panel sizes from Bento Settings; future items
    // (e.g., move to workspace, duplicate panel) — including SUBMENUS —
    // join here by extending the items array. Hidden on the main
    // panel via CSS: the menu's current actions only apply to side
    // panels (panel/setWidth is per-tab; main uses the shared
    // panel/setMainWidth and gets resized via the splitter).
    let moreBtn = null;
    if (Number.isFinite(tabId)) {
      moreBtn = makeHeaderButton('Panel options', ICONS.ellipsisVertical, () => {
        const panelEl = moreBtn.closest('[data-bento-panel-tab-id]');
        if (!panelEl) return;
        const sizeItems =
          currentCustomPanelSizes.length > 0
            ? currentCustomPanelSizes.map((px) => ({
                id: 'size:' + px,
                label: px + ' px',
              }))
            : [
                {
                  id: 'no-sizes',
                  label: 'No panel sizes set in Bento Settings',
                  isDisabled: true,
                },
              ];
        // Size presets nest under a "Custom panel widths" submenu so
        // the menu has room for new top-level actions — `items.items`
        // makes ChromeMenu.tsx render a SubmenuTrigger via
        // react-aria-components (no Mux Menu change needed).
        // "Save panel" sits as a sibling below a separator; clicking
        // dispatches `savedPanels/save` and bento-tools inserts the
        // bookmark into the "Saved panels" folder (de-dupes silently).
        const isDevtoolsPanel = panelEl.hasAttribute('data-bento-devtools-for');
        const canSubdivide = !isDevtoolsPanel && canSubdivideFromPanelHeader(tabId, panelEl);
        const canSplitTopPanel = !isDevtoolsPanel && canSplitTopPanelFromPanelHeader(tabId, panelEl);
        const canSplitBottomPanel =
          !isDevtoolsPanel && canSplitBottomPanelFromPanelHeader(tabId, panelEl);
        const canBreakOut = !isDevtoolsPanel && canBreakOutFromPanelHeader(tabId, panelEl);
        const subdivisionItems = isDevtoolsPanel
          ? []
          : [
              ...(canSubdivide ? [{ id: 'subdivide', label: 'Subdivide panel' }] : []),
              ...(canSplitTopPanel ? [{ id: 'split-top-panel', label: 'Split this panel' }] : []),
              ...(canSplitBottomPanel
                ? [{ id: 'split-bottom-panel', label: 'Split this panel' }]
                : []),
              ...(canBreakOut
                ? [{ id: 'break-out-sub-panel', label: 'Break out this panel' }]
                : []),
            ];
        const items = [
          { id: 'custom-widths', label: 'Custom panel widths', items: sizeItems },
          ...subdivisionItems,
          { id: 'hide-header', label: 'Hide header' },
          ...savePanelMenuItems(),
        ];
        showChromeMenu({
          anchor: moreBtn.getBoundingClientRect(),
          items,
          onSelect: (itemId) => {
            if (typeof itemId !== 'string') return;
            if (itemId === 'subdivide') {
              dispatchShellAction({ type: 'panelLayout/subdivide', tabId });
              return;
            }
            if (itemId === 'split-top-panel') {
              dispatchShellAction({ type: 'panelLayout/splitTopPanel', tabId });
              return;
            }
            if (itemId === 'split-bottom-panel') {
              dispatchShellAction({ type: 'panelLayout/splitBottomPanel', tabId });
              return;
            }
            if (itemId === 'break-out-sub-panel') {
              dispatchShellAction({ type: 'panelLayout/breakOut', tabId });
              return;
            }
            if (itemId === 'hide-header') {
              setPanelHeaderHidden(panelEl, Number(tabId), true);
              return;
            }
            if (itemId === 'save-panel') {
              // Read the panel's current URL + title and dispatch to
              // bento-tools — SavedPanelsStore owns the find-or-create
              // folder + dedupe + insert path. Keep this separate from
              // the header bookmark button, which toggles normal Firefox
              // bookmarks for the current panel URL.
              const innerBrowser = getHeaderActionBrowser(panelEl, browserEl);
              if (!innerBrowser) return;
              let uri;
              try {
                uri = innerBrowser.currentURI;
              } catch {
                return;
              }
              if (!uri || !uri.spec) return;
              let title;
              try {
                title = innerBrowser.contentTitle || uri.spec;
              } catch {
                title = uri.spec;
              }
              let favIconUrl = '';
              try {
                favIconUrl =
                  innerBrowser.mIconURL ||
                  innerBrowser.getAttribute?.('image') ||
                  innerBrowser.getAttribute?.('icon') ||
                  '';
              } catch {
                favIconUrl = '';
              }
              const metadata = boundSavedPanelMetadata(uri.spec, title, favIconUrl);
              if (!metadata) return;
              dispatchShellAction({ type: 'savedPanels/save', ...metadata });
              return;
            }
            if (itemId.startsWith('size:')) {
              const px = Number(itemId.slice('size:'.length));
              applyPanelWidth(panelEl, px);
            }
          },
        });
      });
      moreBtn.classList.add('bento-panel-header-button--more');
    }

    // Drag handle for panel reordering. setupHeaderDrag binds
    // pointerdown to it and runs the drag loop. The handle is
    // styled small + leftmost so it reads as the obvious "grab
    // here to move this panel" affordance. Absent on the main
    // slot's header (the main panel is always col 0; reordering
    // it would break Bento's selected-tab-is-main model — see
    // setupHeaderDrag's early return).
    const dragHandle = document.createXULElement('hbox');
    dragHandle.className =
      'bento-button bento-button--ghost bento-icon-button bento-icon-button--sm bento-panel-header-drag-handle';
    dragHandle.setAttribute('role', 'button');
    dragHandle.setAttribute('aria-label', 'Drag to reorder panel');
    dragHandle.appendChild(makeIcon(ICONS.gripVertical));

    header.appendChild(dragHandle);
    header.appendChild(backBtn);
    header.appendChild(forwardBtn);
    header.appendChild(reloadBtn);
    header.appendChild(urlInput);
    header.appendChild(bookmarkBtn);
    if (pinBtn) header.appendChild(pinBtn);
    if (audioBtn) header.appendChild(audioBtn);
    if (closeBtn) header.appendChild(closeBtn);
    if (moreBtn) header.appendChild(moreBtn);

    // Refresh URL input + back/forward enabled state on navigation.
    // Initial pass after a short delay covers the case where the
    // browser hasn't started loading yet at construction time.
    //
    // Important: only overwrite urlInput.value when currentURI yields a
    // real URL. about:blank / empty are transient pre-load states; if
    // we wrote them into the input we'd wipe whatever initialUrl gave
    // us (which is the actual destination URL). The progress listener
    // calls this again on every onLocationChange, so the eventual real
    // URL still lands in the input.
    const refresh = () => {
      try {
        const actionBrowser = getActionBrowser();
        if (document.activeElement !== urlInput) {
          let spec = '';
          try {
            spec = actionBrowser?.currentURI ? actionBrowser.currentURI.spec : '';
          } catch {
            spec = '';
          }
          if (isRealPanelUrl(spec)) {
            urlInput.value = spec;
            rememberPanelBrowserUrl(browserEl, spec);
          } else if (spec === 'about:newtab') {
            // Clear when navigating to newtab (e.g. user typed nothing
            // and the address eventually resolves to about:newtab via
            // the redirect path).
            urlInput.value = '';
          }
        }
        if (actionBrowser?.canGoBack) backBtn.removeAttribute('disabled');
        else backBtn.setAttribute('disabled', 'true');
        if (actionBrowser?.canGoForward) forwardBtn.removeAttribute('disabled');
        else forwardBtn.setAttribute('disabled', 'true');
        updatePanelBookmarkButtonState(actionBrowser, bookmarkBtn);
        if (audioBtn) setPanelAudioButtonState(audioBtn, tabId);
      } catch {
        // Browser not yet attached — refresh again on next tick.
      }
    };
    setTimeout(refresh, 50);

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        'nsIWebProgressListener',
        'nsISupportsWeakReference',
      ]),
      onLocationChange() {
        refresh();
      },
      onStateChange() {},
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };
    try {
      if (typeof browserEl.addProgressListener === 'function') {
        browserEl.addProgressListener(
          listener,
          Ci.nsIWebProgress.NOTIFY_LOCATION | Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT,
        );
        header._bentoProgressBrowser = browserEl;
        header._bentoProgressListener = listener;
      }
    } catch (err) {
      console.warn('[bento-shell-mount] panel progress listener attach failed:', err);
    }

    return header;
  }

  function createPanelLoadingOverlay() {
    const overlay = document.createElementNS(HTML_NS, 'div');
    overlay.className = 'bento-panel-loading-overlay';
    overlay.hidden = true;

    const spinner = document.createElementNS(HTML_NS, 'div');
    spinner.className = 'bento-spinner bento-spinner--lg';
    spinner.setAttribute('role', 'status');
    spinner.setAttribute('aria-label', 'Loading');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'bento-spinner__svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');

    const track = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    track.setAttribute('class', 'bento-spinner__track');
    track.setAttribute('cx', '12');
    track.setAttribute('cy', '12');
    track.setAttribute('r', '10');
    track.setAttribute('stroke-width', '3');

    const arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    arc.setAttribute('class', 'bento-spinner__arc');
    arc.setAttribute('cx', '12');
    arc.setAttribute('cy', '12');
    arc.setAttribute('r', '10');
    arc.setAttribute('stroke-width', '3');
    arc.setAttribute('stroke-linecap', 'round');

    svg.appendChild(track);
    svg.appendChild(arc);
    spinner.appendChild(svg);
    overlay.appendChild(spinner);
    return overlay;
  }

  function isPanelBrowserLoading(browserEl) {
    if (!browserEl) return false;
    try {
      if (browserEl.webProgress?.isLoadingDocument) return true;
    } catch {
      // Fall through to URI state.
    }
    try {
      const spec = browserEl.currentURI?.spec ?? '';
      return !spec || spec === 'about:blank';
    } catch {
      return true;
    }
  }

  function syncPanelLoadingOverlayGeometry(panelEl, overlay) {
    if (!panelEl || !overlay) return;
    const headerEl = panelEl.querySelector(':scope > .bento-panel-header');
    if (!headerEl) {
      overlay.style.removeProperty('inset-block-start');
      return;
    }
    const headerH = Math.ceil(headerEl.getBoundingClientRect().height || 0);
    if (headerH > 0) {
      overlay.style.insetBlockStart = headerH + 'px';
    } else {
      overlay.style.removeProperty('inset-block-start');
    }
  }

  function ensurePanelLoadingOverlay(panelEl, browserEl) {
    if (!panelEl || !browserEl) return;
    let overlay = panelEl.querySelector(':scope > .bento-panel-loading-overlay');
    if (!overlay) {
      overlay = createPanelLoadingOverlay();
      panelEl.appendChild(overlay);
    }

    const setVisible = (visible) => {
      syncPanelLoadingOverlayGeometry(panelEl, overlay);
      overlay.hidden = !visible;
      overlay.toggleAttribute('data-bento-visible', visible);
    };
    const hideAfterPaint = () => {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(false)));
    };

    if (panelEl.__bentoLoadingBrowser === browserEl) {
      setVisible(isPanelBrowserLoading(browserEl));
      return;
    }
    if (panelEl.__bentoLoadingBrowser && panelEl.__bentoLoadingListener) {
      try {
        panelEl.__bentoLoadingBrowser.removeProgressListener(panelEl.__bentoLoadingListener);
      } catch {
        // best-effort cleanup
      }
    }

    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        'nsIWebProgressListener',
        'nsISupportsWeakReference',
      ]),
      onStateChange(webProgress, request, stateFlags) {
        if (webProgress && !webProgress.isTopLevel) return;
        if (stateFlags & Ci.nsIWebProgressListener.STATE_START) {
          setVisible(true);
        }
        if (stateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
          hideAfterPaint();
        }
      },
      onLocationChange() {
        if (isPanelBrowserLoading(browserEl)) setVisible(true);
        else hideAfterPaint();
      },
      onProgressChange() {},
      onStatusChange() {},
      onSecurityChange() {},
      onContentBlockingEvent() {},
    };

    try {
      browserEl.addProgressListener(
        listener,
        Ci.nsIWebProgress.NOTIFY_LOCATION | Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT,
      );
      panelEl.__bentoLoadingBrowser = browserEl;
      panelEl.__bentoLoadingListener = listener;
    } catch (err) {
      console.warn('[bento-shell-mount] panel loading listener attach failed:', err);
    }

    setVisible(isPanelBrowserLoading(browserEl));
    setTimeout(() => {
      if (!panelEl.isConnected || panelEl.__bentoLoadingBrowser !== browserEl) return;
      setVisible(isPanelBrowserLoading(browserEl));
    }, 100);
  }

  function forceHidePanelLoadingOverlay(panelEl) {
    if (!panelEl) return;
    const overlay = panelEl.querySelector(':scope > .bento-panel-loading-overlay');
    if (!overlay) return;
    overlay.hidden = true;
    overlay.removeAttribute('data-bento-visible');
  }

  function getBentoTabTracker() {
    try {
      const mod = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      return mod.ExtensionParent?.apiManager?.global?.tabTracker || null;
    } catch {
      return null;
    }
  }

  function getTrackedTabById(tabTracker, tabId) {
    if (!tabTracker || !Number.isFinite(Number(tabId))) return null;
    try {
      return tabTracker.getTab(Number(tabId)) || null;
    } catch {
      return null;
    }
  }

  function getBentoTabId(tab) {
    if (!tab) return null;
    const tabTracker = getBentoTabTracker();
    if (!tabTracker) return null;
    try {
      const id = Number(tabTracker.getId(tab));
      return Number.isFinite(id) ? id : null;
    } catch {
      return null;
    }
  }

  function resetPanelHeaderInlineState(headerEl) {
    if (!headerEl) return;
    for (const prop of [
      'display',
      'flex',
      'height',
      'min-height',
      'max-height',
      'opacity',
      'overflow',
      'margin',
      'padding',
      'border-width',
      'visibility',
      'pointer-events',
      'transition',
      'position',
      'z-index',
    ]) {
      headerEl.style.removeProperty(prop);
    }
  }

  function forcePanelHeaderInteractiveState(headerEl) {
    if (!headerEl) return;
    headerEl.removeAttribute('hidden');
    headerEl.removeAttribute('collapsed');
    headerEl.style.setProperty('position', 'relative', 'important');
    headerEl.style.setProperty('z-index', '5', 'important');
    headerEl.style.setProperty('pointer-events', 'auto', 'important');
    headerEl.style.setProperty('visibility', 'inherit', 'important');
    headerEl.style.setProperty('opacity', '1', 'important');
  }

  function forceSubPanelBrowserPaint(tab, panelEl, options = {}) {
    if (!panelEl) return;
    const browserEl = tab?.linkedBrowser || panelEl.querySelector?.('browser') || null;
    const browserContainer = panelEl.querySelector?.(':scope > .browserContainer') || null;
    const browserStack =
      panelEl.querySelector?.(':scope > .browserContainer > .browserStack') ||
      panelEl.querySelector?.(':scope > .browserStack') ||
      null;

    panelEl.classList.add('split-view-panel-active');
    panelEl.removeAttribute('hidden');
    panelEl.removeAttribute('collapsed');
    panelEl.style.setProperty('-moz-subtree-hidden-only-visually', '0', 'important');
    panelEl.style.setProperty('visibility', 'inherit', 'important');

    for (const el of [browserContainer, browserStack, browserEl]) {
      if (!el) continue;
      el.removeAttribute?.('hidden');
      el.removeAttribute?.('collapsed');
      el.style.setProperty('-moz-subtree-hidden-only-visually', '0', 'important');
      el.style.setProperty('visibility', 'inherit', 'important');
      el.style.setProperty('opacity', '1', 'important');
      el.style.setProperty('min-height', '0', 'important');
      el.style.setProperty('min-width', '0', 'important');
    }
    if (browserEl) {
      browserEl.removeAttribute('blank');
      browserEl.removeAttribute('pendingpaint');
      browserEl.style.setProperty('width', '100%', 'important');
      browserEl.style.setProperty('height', '100%', 'important');
      try {
        browserEl.preserveLayers?.(true);
        browserEl.renderLayers = true;
        browserEl.docShellIsActive = true;
      } catch {
        // Best-effort paint restoration; callers keep layout state intact.
      }
    }
    if (options.hideOverlay !== false) {
      forceHidePanelLoadingOverlay(panelEl);
    }
  }

  function scheduleSubPanelPaintRestore(tab, panelEl, options = {}) {
    forceSubPanelBrowserPaint(tab, panelEl, options);
    requestAnimationFrame(() => {
      forceSubPanelBrowserPaint(tab, panelEl, options);
      requestAnimationFrame(() => forceSubPanelBrowserPaint(tab, panelEl, options));
    });
    window.setTimeout(() => forceSubPanelBrowserPaint(tab, panelEl, options), 350);
  }

  // ─── Inter-panel splitter (drag to resize) ────────────────────────────
  //
  // Firefox's native split-view splitter only sits between col 0 and
  // col 1, has per-tab resize semantics (writes width to the col-0
  // notificationbox, which is the active tab's browser host), and
  // squeezes sibling panels instead of pushing them along the
  // strip's horizontal scroll. None of that fits Bento's N-panel
  // strip model, so we hide Firefox's splitter (see
  // bento-shell-mount.css) and inject our own at every adjacent panel
  // boundary.
  //
  // POINTER events with setPointerCapture survive the cursor
  // crossing into a remote=true content browser mid-drag — the same
  // reason the legacy reconciler used pointer events. mousedown +
  // window-level mousemove would lose drag the moment the cursor
  // entered a panel's webpage.
  //
  // Main panel width is a single window/profile layout choice. Each
  // tab has its own col-0 notificationbox; if we only wrote width to
  // that one element, switching tabs/workspaces would reveal stale
  // per-element sizing. Keep this chrome-side value as the immediate
  // source of truth; bento-tools persists the same value for next boot.
  let mainPanelWidth = null;

  // Cross-panel FLIP animation buffer. setupHeaderDrag's endDrag
  // populates this with each visible panel's pre-reorder rect
  // when a reorder commit is dispatched; runPendingPanelFlip
  // (called from the end of reconcilePanelsSplitView) reads
  // the new rects, applies an instant counter-transform, and
  // transitions back to translate(0) so the user sees the
  // OTHER panels (not just the dragged one) glide between
  // their old and new slots. Cleared at the start of every
  // run so a stale snapshot can never leak across reconciles.
  let __bentoPendingFlip = null;
  let __bentoPendingNavFlip = null;
  let __bentoPendingCloseGapFlip = null;

  function createPanelSplitter() {
    // XUL <splitter> element — only XUL element type that XUL
    // <tabpanels>'s deck-style hit-testing routes pointer events
    // to. Tested:
    //   - HTML <div>: elementFromPoint at splitter center returns
    //     tabpanels, not the splitter (deck blocks non-selected).
    //   - XUL <hbox>: same.
    //   - XUL <hbox> with position:absolute z:999: still blocked.
    //   - XUL <splitter>: works (Firefox's own split-view-splitter
    //     uses this element).
    // resizebefore/resizeafter="none" disables Firefox's default
    // sibling-width-mutation behaviour — we want the splitter to
    // be a passive event sink whose drag is handled entirely by
    // our pointer handlers.
    const splitter = document.createXULElement('splitter');
    splitter.className = 'bento-panel-splitter';
    splitter.setAttribute('resizebefore', 'none');
    splitter.setAttribute('resizeafter', 'none');
    splitter.addEventListener('pointerdown', (e) => startPanelDrag(splitter, e));
    splitter.addEventListener('pointermove', (e) => onPanelDragMove(splitter, e));
    splitter.addEventListener('pointerup', (e) => endPanelDrag(splitter, e));
    splitter.addEventListener('pointercancel', (e) => endPanelDrag(splitter, e));
    splitter.addEventListener('lostpointercapture', () => endPanelDrag(splitter, null));
    splitter.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    splitter.addEventListener('contextmenu', (e) => showPanelSplitterContextMenu(splitter, e));
    return splitter;
  }

  function showPanelSplitterContextMenu(splitter, e) {
    const sourceTabId = getPanelSplitterSourceTabId(splitter);
    if (sourceTabId === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    showChromeMenu({
      anchor: {
        left: e.clientX,
        top: e.clientY,
        width: 1,
        height: 1,
      },
      items: [{ id: 'insert-panel-here', label: 'Insert panel here' }],
      onSelect: (itemId) => {
        if (itemId !== 'insert-panel-here') return;
        addNewPanel(sourceTabId);
      },
    });
  }

  function showPanelStripContextMenu(e) {
    if (e.defaultPrevented) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (
      target.closest('browser') ||
      target.closest('.browserContainer') ||
      target.closest('.bento-panel-header') ||
      target.closest('#bento-panel-nav') ||
      target.closest('#bento-strip-scrollbar') ||
      target.closest('.bento-panel-splitter')
    ) {
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    showChromeMenu({
      anchor: {
        left: e.clientX,
        top: e.clientY,
        width: 1,
        height: 1,
      },
      items: [{ id: 'add-new-panel', label: 'Add new panel' }],
      onSelect: (itemId) => {
        if (itemId !== 'add-new-panel') return;
        addNewPanel();
      },
    });
  }

  // ─── Subdivision chooser (rendered as a flat-layout overlay) ─────

  function createSubdivisionChooser(parentTabId, chooserId, groupId) {
    const container = document.createXULElement('vbox');
    container.className = 'bento-subdivision-chooser';
    container.setAttribute('flex', '1');
    container.setAttribute('tabindex', '-1');
    container.setAttribute('data-bento-chooser-id', chooserId);
    container.setAttribute('data-bento-owner-tab-id', String(parentTabId));
    container.addEventListener('mousedown', (e) => {
      if (e.button === 0 && e.target === container) {
        e.preventDefault();
        focusPanelCycleTarget(container);
      }
    });

    if (groupId) {
      const closeBtn = document.createElementNS(HTML_NS, 'button');
      closeBtn.type = 'button';
      closeBtn.className = 'bento-subdivision-chooser__close';
      closeBtn.title = 'Close subdivision';
      closeBtn.setAttribute('aria-label', 'Close subdivision');
      closeBtn.appendChild(makeIcon(ICONS.x, 14));
      closeBtn.addEventListener('click', () => {
        dispatchShellAction({ type: 'panelLayout/removeVerticalGroup', groupId });
      });
      container.appendChild(closeBtn);
    }

    const primary = document.createElementNS(HTML_NS, 'div');
    primary.className = 'bento-subdivision-chooser__primary';

    const singleBtn = document.createElementNS(HTML_NS, 'button');
    singleBtn.type = 'button';
    singleBtn.className = 'bento-subdivision-chooser__btn';
    singleBtn.textContent = 'Full panel';
    singleBtn.addEventListener('click', () => {
      dispatchShellAction({
        type: 'panelLayout/fillChooser',
        chooserId,
        mode: 'single',
        urls: [''],
      });
    });

    const dualBtn = document.createElementNS(HTML_NS, 'button');
    dualBtn.type = 'button';
    dualBtn.className = 'bento-subdivision-chooser__btn';
    dualBtn.textContent = 'Split panels';
    dualBtn.addEventListener('click', () => {
      dispatchShellAction({
        type: 'panelLayout/fillChooser',
        chooserId,
        mode: 'dual',
        urls: ['', ''],
      });
    });

    primary.appendChild(singleBtn);
    primary.appendChild(dualBtn);
    container.appendChild(primary);

    const saved = currentSavedPanelItems.slice(0, 12).filter((item) => item?.url);
    if (saved.length > 0) {
      const savedWrap = document.createElementNS(HTML_NS, 'div');
      savedWrap.className = 'bento-subdivision-chooser__saved';

      const title = document.createElementNS(HTML_NS, 'div');
      title.className = 'bento-subdivision-chooser__saved-title';
      title.textContent = 'Saved panels';
      savedWrap.appendChild(title);

      const grid = document.createElementNS(HTML_NS, 'div');
      grid.className = 'bento-subdivision-chooser__saved-grid';
      for (const item of saved) {
        const btn = document.createElementNS(HTML_NS, 'button');
        btn.type = 'button';
        btn.className = 'bento-subdivision-chooser__saved-btn';
        const label = (item.title || item.url || 'Saved panel').trim();
        btn.title = label;
        btn.setAttribute('aria-label', 'Open saved panel: ' + label);
        if (item.favIconUrl) {
          const img = document.createElementNS(HTML_NS, 'img');
          img.className = 'bento-subdivision-chooser__saved-icon';
          img.src = item.favIconUrl;
          img.alt = '';
          img.addEventListener(
            'error',
            () => {
              img.replaceWith(createSavedPanelPlaceholder(label));
            },
            { once: true },
          );
          btn.appendChild(img);
        } else {
          btn.appendChild(createSavedPanelPlaceholder(label));
        }
        const text = document.createElementNS(HTML_NS, 'span');
        text.className = 'bento-subdivision-chooser__saved-label';
        text.textContent = label;
        btn.appendChild(text);
        btn.addEventListener('click', () => {
          dispatchShellAction({
            type: 'panelLayout/fillChooser',
            chooserId,
            mode: 'single',
            urls: [item.url],
          });
        });
        grid.appendChild(btn);
      }
      savedWrap.appendChild(grid);
      container.appendChild(savedWrap);
    }
    return container;
  }

  function createSavedPanelPlaceholder(label) {
    const placeholder = document.createElementNS(HTML_NS, 'span');
    placeholder.className = 'bento-subdivision-chooser__saved-icon';
    placeholder.setAttribute('aria-hidden', 'true');
    const first = (label || '').trim().charAt(0).toUpperCase();
    placeholder.textContent = first || 'B';
    return placeholder;
  }

  // Strips the inline layout styles a panel and its direct children may carry
  // from an earlier reconcile, so each pass starts from the stylesheet. The
  // flat layout re-applies its own rects afterwards.
  function resetPanelInlineLayoutState(panelEl) {
    // A close the user cancelled (beforeunload "Stay") re-renders the same
    // element, so the close fade must not outlive the close.
    delete panelEl._bentoPanelRemoving;
    panelEl.classList.remove('bento-panel--removing');
    panelEl.style.removeProperty('display');
    panelEl.style.removeProperty('flex-direction');
    panelEl.style.removeProperty('overflow');
    for (const child of panelEl.querySelectorAll(
      ':scope > .bento-panel-header, :scope > .browserContainer, :scope > browser, :scope > .browserStack, :scope > .bento-panel-loading-overlay',
    )) {
      child.style.removeProperty('min-height');
      child.style.removeProperty('min-width');
      child.style.removeProperty('overflow');
      child.style.removeProperty('flex');
      child.style.removeProperty('display');
      child.style.removeProperty('height');
      child.style.removeProperty('max-height');
      child.style.removeProperty('width');
      child.style.removeProperty('align-self');
      child.style.removeProperty('opacity');
      child.style.removeProperty('visibility');
      child.style.removeProperty('transition');
      child.style.removeProperty('margin');
      child.style.removeProperty('padding');
      child.style.removeProperty('border-width');
      child.style.removeProperty('pointer-events');
      child.style.removeProperty('position');
      child.style.removeProperty('z-index');
    }
  }

  function getPanelSplitterSourceTabId(splitter) {
    const leftPanelId = splitter?._bentoLeftPanelId;
    if (!leftPanelId) return undefined;
    const leftPanel = document.getElementById(leftPanelId);
    if (!leftPanel) return undefined;
    if (leftPanel.dataset.bentoMainPanel === '1') return null;
    return getPanelTabIdForElement(leftPanel);
  }

  function getPanelTabIdForElement(panelEl) {
    const raw = panelEl?.dataset?.bentoPanelTabId;
    const tabId = raw ? Number(raw) : NaN;
    return Number.isFinite(tabId) ? tabId : undefined;
  }

  function startPanelDrag(splitter, e) {
    if (e.button !== 0) return;
    const leftPanelId = splitter._bentoLeftPanelId;
    if (!leftPanelId) return;
    const leftPanel = document.getElementById(leftPanelId);
    if (!leftPanel) return;
    e.preventDefault();
    e.stopPropagation();
    suppressPanelFocusAutoScrollForSplitterInteraction();

    splitter._panelDragState = {
      leftPanel,
      isMain: !!leftPanel.dataset.bentoMainPanel,
      startX: e.clientX,
      startWidth: getResizableSlotWidth(leftPanel),
      pointerId: e.pointerId,
      tabId: getPanelTabIdForElement(leftPanel),
    };
    leftPanel.classList.add('bento-panel-resizing');
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch (err) {
      console.warn('[bento-shell-mount] setPointerCapture failed:', err);
    }
    beginBentoPanelResize();
    splitter.classList.add('bento-panel-splitter--dragging');
    document.documentElement.style.setProperty('cursor', 'col-resize', 'important');
    document.documentElement.style.setProperty('user-select', 'none', 'important');
  }

  function onPanelDragMove(splitter, e) {
    const drag = splitter._panelDragState;
    if (!drag || e.pointerId !== drag.pointerId) return;
    suppressPanelFocusAutoScrollForSplitterInteraction();
    const delta = e.clientX - drag.startX;
    const minWidth = drag.isMain ? 320 : 240;
    const next = Math.max(minWidth, drag.startWidth + delta);
    drag.leftPanel.style.width = next + 'px';
    drag.leftPanel.style.minWidth = next + 'px';
    drag.leftPanel.style.flex = '0 0 ' + next + 'px';
    if (drag.isMain) {
      mainPanelWidth = next;
    }
    const widthByTabId = new Map();
    if (!drag.isMain && Number.isFinite(drag.tabId)) {
      widthByTabId.set(drag.tabId, next);
    }
    const layoutRefreshed = refreshFlatPanelLayoutFromLiveState({
      mainWidthPx: drag.isMain ? next : currentPanelLayoutGeometry?.mainRect?.width,
      widthByTabId,
    });
    if (!layoutRefreshed) {
      // Re-position splitters so they track the live panel widths.
      // Without this the dragged splitter (and any splitters to its
      // right) stay at their pre-drag positions and detach visually
      // from the panel boundaries they own.
      syncInterPanelSplitters();
    }
  }

  function endPanelDrag(splitter, e) {
    const drag = splitter._panelDragState;
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
    suppressPanelFocusAutoScrollForSplitterInteraction();
    try {
      splitter.releasePointerCapture(drag.pointerId);
    } catch {
      /* already released */
    }
    const finalWidth = getResizableSlotWidth(drag.leftPanel);
    const isMain = drag.isMain;
    const leftPanel = drag.leftPanel;
    splitter._panelDragState = null;
    leftPanel.classList.remove('bento-panel-resizing');
    splitter.classList.remove('bento-panel-splitter--dragging');
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
    endBentoPanelResize();
    // After drag, re-position all splitters (the resized panel
    // shifts every splitter to its right).
    syncInterPanelSplitters();
    // Persist the new width. Main panel is per-workspace; side panels
    // are per-tabId. Both flow through bento-tools so the next launch
    // re-applies them on reconcile.
    if (isMain) {
      if (finalWidth > 0) {
        dispatchShellAction({
          type: 'panel/setMainWidth',
          widthPx: Math.round(finalWidth),
        });
      }
    } else {
      const tabIdAttr = leftPanel.dataset.bentoPanelTabId;
      const tabId = tabIdAttr ? Number(tabIdAttr) : NaN;
      if (Number.isFinite(tabId) && finalWidth > 0) {
        dispatchShellAction({
          type: 'panel/setWidth',
          id: tabId,
          widthPx: Math.round(finalWidth),
        });
      }
    }
  }

  function animatePanelEnter(panelEl, options = {}) {
    if (!panelEl) return;
    const animateWidth = options.animateWidth !== false;
    const animateTransform = options.animateTransform !== false;
    const finalWidth = animateWidth ? panelEl.getBoundingClientRect().width : 0;
    if (animateWidth && (!Number.isFinite(finalWidth) || finalWidth <= 0)) return;
    const clearSizingAfter = !!options.clearSizingAfter;
    cancelMotion(panelEl, 'enter');
    panelEl.style.transition = 'none';
    panelEl.style.opacity = '0';
    if (animateTransform) panelEl.style.transform = 'scale(0.98)';
    if (animateWidth) {
      panelEl.style.minWidth = '0';
      panelEl.style.width = '0';
      panelEl.style.flex = '0 0 0';
    }
    panelEl.getBoundingClientRect();
    requestAnimationFrame(() => {
      const reveal = 'var(--muxui-semantic-motion-reveal-transition)';
      const transitions = ['opacity ' + reveal];
      if (animateTransform) transitions.push('transform ' + reveal);
      if (animateWidth) {
        transitions.push('width ' + reveal, 'min-width ' + reveal, 'flex-basis ' + reveal);
      }
      panelEl.style.transition = transitions.join(', ');
      panelEl.style.opacity = '1';
      if (animateTransform) panelEl.style.transform = 'scale(1)';
      if (animateWidth) {
        panelEl.style.width = finalWidth + 'px';
        panelEl.style.minWidth = finalWidth + 'px';
        panelEl.style.flex = '0 0 ' + finalWidth + 'px';
      }
      afterMotion(
        panelEl,
        'enter',
        { properties: ['opacity', 'transform', 'width', 'min-width', 'flex-basis'] },
        () => {
          panelEl.style.removeProperty('transition');
          panelEl.style.removeProperty('opacity');
          panelEl.style.removeProperty('transform');
          if (animateWidth && clearSizingAfter) {
            panelEl.style.removeProperty('width');
            panelEl.style.removeProperty('min-width');
            panelEl.style.removeProperty('flex');
          }
        },
      );
    });
  }

  // ResizeObserver shared across all panels — re-syncs inter-panel
  // splitter positions whenever any observed panel's width changes.
  // Robust against the layout race that previously caused
  // misalignment at boot (reconciler reads bounding rects before
  // Firefox's split-view flex layout commits) and close-animation
  // flicker (panels reflow but splitters stay at stale positions).
  // The observer has a single callback that re-runs the full sync;
  // each sync reconciles the observed set against the current panels.
  const __bentoSplitterRO =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => {
          try {
            syncInterPanelSplitters();
          } catch (err) {
            console.warn('[bento-shell-mount] splitter RO sync failed:', err);
          }
        })
      : null;
  // Elements __bentoSplitterRO currently observes. Membership must stay
  // stable across syncs: disconnect() followed by observe() starts a new
  // observation at last-reported size (-1, -1), which always delivers an
  // initial notification, so the callback's own sync would re-schedule
  // itself every frame.
  const __bentoSplitterObserved = new Set();

  // Make __bentoSplitterRO observe exactly `desiredEls`, touching only the
  // elements that joined or left. Elements that left (including removed
  // from the DOM) are dropped so the Set does not retain them.
  function setObservedSplitterPanels(desiredEls) {
    if (!__bentoSplitterRO) return;
    for (const el of __bentoSplitterObserved) {
      if (desiredEls.has(el)) continue;
      __bentoSplitterRO.unobserve(el);
      __bentoSplitterObserved.delete(el);
    }
    for (const el of desiredEls) {
      if (__bentoSplitterObserved.has(el)) continue;
      __bentoSplitterRO.observe(el);
      __bentoSplitterObserved.add(el);
    }
  }

  // Sync inter-panel splitter elements in #bento-side-panel-host so
  // there's exactly one between each adjacent pair of panels in
  // tabpanels.splitViewPanels, positioned absolutely at the right
  // edge of each "left" panel. Idempotent; called from
  // reconcilePanelsSplitView, the resize-repaint poke (window
  // resize), the strip scroll listener, after each drag commit,
  // and from the per-panel ResizeObserver. Pass the desired panel
  // ordering explicitly to avoid races where tabpanels.splitView-
  // Panels hasn't updated yet; if omitted, reads from current
  // splitViewPanels.
  // FLIP runner for cross-panel reorder animation. Called from
  // the end of reconcilePanelsSplitView. Reads __bentoPendingFlip
  // (a Map<tabId, oldRect> populated by setupHeaderDrag's
  // endDrag), computes each visible panel's new rect, applies
  // an instant counter-transform (translateX(oldLeft - newLeft))
  // so each panel visually starts at where it was before the
  // reorder, then on the next frame transitions back to
  // translate(0) — they glide smoothly to their new slots.
  //
  // The dragged panel is included here too. endDrag stashes its
  // current PAINTED rect (which includes the live drag transform,
  // i.e. the cursor position) as that panel's "old position".
  // The FLIP then animates it from cursor X to its new slot,
  // bypassing the bug where clearing the transform in endDrag
  // would briefly snap the panel back to its OLD slot before
  // the reconciler updated the layout.
  function runPendingPanelFlip() {
    if (!__bentoPendingFlip) return;
    const snapshot = __bentoPendingFlip;
    __bentoPendingFlip = null;
    const moved = [];
    for (const panelEl of getOrderedPanels()) {
      const tabIdAttr = panelEl.dataset.bentoPanelTabId;
      if (!tabIdAttr) continue;
      const tabId = Number(tabIdAttr);
      if (!Number.isFinite(tabId)) continue;
      const oldRect = snapshot.get(tabId);
      if (!oldRect) continue;
      // Reset any leftover transform on the dragged panel so its
      // newRect reflects pure layout coords. Without this, the
      // dragged panel still has its cursor-following transform
      // and getBoundingClientRect would include it, making
      // dx ≈ 0.
      const isDragged = tabId === snapshot.__draggedTabId;
      if (isDragged) {
        cancelMotion(panelEl, 'flip');
        panelEl.style.transition = 'none';
        panelEl.style.transform = '';
      }
      const newRect = panelEl.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      if (Math.abs(dx) < 1) continue;
      moved.push({ panelEl, dx, isDragged });
    }
    if (moved.length === 0) return;
    // Instant counter-transform — panels visually stay where
    // they were before the reorder (or for the dragged panel,
    // where the cursor released).
    for (const { panelEl, dx } of moved) {
      cancelMotion(panelEl, 'flip');
      panelEl.style.transition = 'none';
      panelEl.style.transform = 'translateX(' + dx + 'px)';
    }
    // Force a layout flush so the browser sees the transformed
    // start state before the transition class is applied.
    void window.gBrowser?.tabpanels?.offsetWidth;
    // On the next frame, enable the transition and clear the
    // transform — panels glide to their settled slots.
    requestAnimationFrame(() => {
      for (const { panelEl, isDragged } of moved) {
        panelEl.style.transition = 'transform var(--muxui-semantic-motion-reveal-transition)';
        panelEl.style.transform = '';
        // transitionend, or the measured transition time if that event misses.
        afterMotion(panelEl, 'flip', { properties: ['transform'] }, () => {
          panelEl.style.transition = '';
          if (isDragged && !panelEl.classList.contains('bento-panel--dragging')) {
            panelEl.style.zIndex = '';
          }
        });
      }
    });
  }

  function runPendingPanelNavFlip() {
    if (!__bentoPendingNavFlip) return;
    const snapshot = __bentoPendingNavFlip;
    __bentoPendingNavFlip = null;
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list) return;
    const moved = [];
    for (const btn of Array.from(list.children)) {
      if (!btn.classList?.contains('bento-panel-nav__icon')) continue;
      if (btn.dataset.bentoNavLeaving === '1') continue;
      const key = btn.dataset.bentoNavKey;
      if (!key) continue;
      const oldRect = snapshot.get(key);
      if (!oldRect) continue;
      const newRect = btn.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      if (Math.abs(dx) < 1) continue;
      moved.push({ btn, dx });
    }
    if (moved.length === 0) return;
    for (const { btn, dx } of moved) {
      cancelMotion(btn, 'flip');
      btn.style.transition = 'none';
      btn.style.transform = 'translateX(' + dx + 'px)';
    }
    void list.offsetWidth;
    requestAnimationFrame(() => {
      for (const { btn } of moved) {
        btn.style.transition = 'transform var(--muxui-semantic-motion-reveal-transition)';
        btn.style.transform = '';
        afterMotion(btn, 'flip', { properties: ['transform'] }, () => {
          btn.style.transition = '';
        });
      }
    });
  }

  function getTopLevelCloseGapFlipKey(el) {
    if (!el) return null;
    if (el.id === 'bento-add-panel-trailer') return 'add-panel-trailer';
    const tabId = Number(el.dataset?.bentoPanelTabId);
    if (!Number.isFinite(tabId)) return null;
    return el.dataset.bentoRootNodeId || 'panel:' + tabId;
  }

  function stageTopLevelPanelCloseGapFlip(closingPanel) {
    const tabpanels = window.gBrowser?.tabpanels;
    if (!closingPanel || !tabpanels?.classList?.contains('bento-flat-panel-layout')) {
      return;
    }
    const closingTabId = Number(closingPanel.dataset?.bentoPanelTabId);
    if (!Number.isFinite(closingTabId)) return;
    if (currentPanelStatusByTabId.get(closingTabId) !== 'root-panel') return;

    const closingKey = getTopLevelCloseGapFlipKey(closingPanel);
    const snapshot = new Map();
    const seen = new Set();
    for (const panelEl of getOrderedPanels()) {
      if (panelEl === closingPanel) continue;
      const key = getTopLevelCloseGapFlipKey(panelEl);
      if (!key || key === closingKey || seen.has(key)) continue;
      seen.add(key);
      snapshot.set(key, panelEl.getBoundingClientRect());
    }
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer) {
      const key = getTopLevelCloseGapFlipKey(trailer);
      if (key) snapshot.set(key, trailer.getBoundingClientRect());
    }
    __bentoPendingCloseGapFlip = snapshot.size > 0 ? snapshot : null;
  }

  function runPendingTopLevelPanelCloseGapFlip() {
    if (!__bentoPendingCloseGapFlip) return;
    const snapshot = __bentoPendingCloseGapFlip;
    __bentoPendingCloseGapFlip = null;
    const moved = [];
    const seen = new Set();
    for (const panelEl of getOrderedPanels()) {
      const key = getTopLevelCloseGapFlipKey(panelEl);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const oldRect = snapshot.get(key);
      if (!oldRect) continue;
      const newRect = panelEl.getBoundingClientRect();
      const dx = oldRect.left - newRect.left;
      if (Math.abs(dx) < 1) continue;
      moved.push({ el: panelEl, dx });
    }
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer) {
      const key = getTopLevelCloseGapFlipKey(trailer);
      const oldRect = key ? snapshot.get(key) : null;
      if (oldRect) {
        const newRect = trailer.getBoundingClientRect();
        const dx = oldRect.left - newRect.left;
        if (Math.abs(dx) >= 1) moved.push({ el: trailer, dx });
      }
    }
    if (moved.length === 0) return;
    for (const { el, dx } of moved) {
      cancelMotion(el, 'flip');
      el.style.transition = 'none';
      el.style.transform = 'translateX(' + dx + 'px)';
    }
    void window.gBrowser?.tabpanels?.offsetWidth;
    requestAnimationFrame(() => {
      for (const { el } of moved) {
        el.style.transition = 'transform var(--muxui-semantic-motion-reveal-transition)';
        el.style.transform = '';
        afterMotion(el, 'flip', { properties: ['transform'] }, () => {
          el.style.transition = '';
        });
      }
    });
  }

  function syncInterPanelSplitters(tabsToRender) {
    const host = document.getElementById('bento-side-panel-host');
    if (!host || !window.gBrowser?.tabpanels) return;
    const tabpanels = window.gBrowser.tabpanels;
    let panelIds;
    if (tabsToRender) {
      panelIds = tabsToRender.map((t) => t.linkedPanel).filter((id) => !!id);
    } else {
      panelIds = [];
      const seenRootNodeIds = new Set();
      for (const id of tabpanels.splitViewPanels || []) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.dataset.bentoMainPanel === '1') {
          panelIds.push(id);
          continue;
        }
        if (!el.dataset.bentoPanelTabId) continue;
        const rootNodeId = el.dataset.bentoRootNodeId || 'panel:' + el.dataset.bentoPanelTabId;
        if (seenRootNodeIds.has(rootNodeId)) continue;
        seenRootNodeIds.add(rootNodeId);
        panelIds.push(id);
      }
    }

    // Splitter count: N-1 between adjacent panel pairs, plus 1 more
    // between the last panel and the Add-panel trailer (when the
    // trailer exists). The extra splitter resizes the LAST panel —
    // without it, the last panel has no drag handle on its right
    // and is only resizable by manipulating other panels.
    const trailer = document.getElementById('bento-add-panel-trailer');
    const baseDesired = Math.max(0, panelIds.length - 1);
    const desired = baseDesired + (trailer && panelIds.length > 0 ? 1 : 0);
    const existing = Array.from(host.querySelectorAll(':scope > .bento-panel-splitter'));

    for (let i = existing.length; i > desired; i--) {
      existing[i - 1].remove();
    }
    for (let i = existing.length; i < desired; i++) {
      const sp = createPanelSplitter();
      host.appendChild(sp);
      existing.push(sp);
    }

    // The shared ResizeObserver (see __bentoSplitterRO) observes the
    // current panel set at the end of this sync, so any width change
    // (drag, close-animation, workspace switch,
    // layout-commit-after-reconcile) re-runs this sync without us
    // having to find every code path that mutates panel widths.

    if (desired === 0) {
      // No splitters to position; stop observing.
      setObservedSplitterPanels(new Set());
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const splitterWidth = panelSplitterSizePx();
    const panelRectForSplitter = (panelEl) => {
      if (!panelEl) return null;
      let localRect = null;
      if (panelEl.dataset?.bentoMainPanel === '1') {
        localRect = currentPanelLayoutGeometry?.mainRect || null;
      } else {
        const rootNodeId = panelEl.dataset?.bentoRootNodeId;
        localRect = rootNodeId ? currentPanelLayoutGeometry?.rootRects?.get(rootNodeId) : null;
      }
      const hostLocal = localRect ? viewportRectForLayoutRect(tabpanels, localRect) : null;
      if (hostLocal) {
        return {
          left: hostRect.left + hostLocal.left,
          top: hostRect.top + hostLocal.top,
          right: hostRect.left + hostLocal.left + hostLocal.width,
          bottom: hostRect.top + hostLocal.top + hostLocal.height,
          width: hostLocal.width,
          height: hostLocal.height,
        };
      }
      return panelEl.getBoundingClientRect();
    };
    for (let i = 0; i < desired; i++) {
      const sp = existing[i];
      const leftPanelEl = document.getElementById(panelIds[i]);
      if (!leftPanelEl) continue;
      const lr = panelRectForSplitter(leftPanelEl);
      if (!lr) continue;
      // The right "neighbour" is either the next panel (for inter-
      // panel splitters) or the trailer (for the last splitter).
      // Both code paths centre on the gap between the two elements
      // so the painted bar visually aligns regardless of which
      // splitter type it is. Since the trailer now lives inside
      // tabpanels (scrolling with the strip), the last splitter
      // tracks the last panel naturally — no clamp needed.
      const isLastSplitter = i === panelIds.length - 1;
      let gapCentre;
      let splitterTop = lr.top;
      let splitterHeight = lr.height;
      let devtoolsLinkTop = null;
      let devtoolsLinkHeight = null;
      if (isLastSplitter) {
        if (!trailer) continue;
        const tr = trailer.getBoundingClientRect();
        gapCentre = (lr.right + tr.left) / 2;
        sp.classList.remove('bento-panel-splitter--devtools-link');
      } else {
        const rightPanelEl = document.getElementById(panelIds[i + 1]);
        if (!rightPanelEl) continue;
        const rr = panelRectForSplitter(rightPanelEl);
        if (!rr) continue;
        gapCentre = (lr.right + rr.left) / 2;
        const devtoolsLink = getDevtoolsLinkForPanelPair(leftPanelEl, rightPanelEl);
        const isDevtoolsLink = !!devtoolsLink;
        sp.classList.toggle('bento-panel-splitter--devtools-link', isDevtoolsLink);
        if (isDevtoolsLink) {
          const callerRect =
            devtoolsLink.callerTabId === null
              ? null
              : getViewportPanelRectForTabId(devtoolsLink.callerTabId);
          const devtoolsRect = leftPanelEl.dataset?.bentoDevtoolsFor ? lr : rr;
          const contentRect = callerRect || (leftPanelEl.dataset?.bentoDevtoolsFor ? rr : lr);
          const overlapTop = Math.max(contentRect.top, devtoolsRect.top);
          const overlapBottom = Math.min(contentRect.bottom, devtoolsRect.bottom);
          const overlapHeight =
            overlapBottom > overlapTop
              ? overlapBottom - overlapTop
              : Math.min(contentRect.height, devtoolsRect.height);
          const centreY = callerRect
            ? callerRect.top + callerRect.height / 2
            : overlapBottom > overlapTop
              ? overlapTop + overlapHeight / 2
              : contentRect.top + contentRect.height / 2;
          devtoolsLinkHeight = Math.max(
            panelSplitterSizePx(),
            Math.min(overlapHeight, panelSplitterSizePx() * 4),
          );
          devtoolsLinkTop = centreY - splitterTop - devtoolsLinkHeight / 2;
        }
      }
      sp._bentoLeftPanelId = panelIds[i];
      sp.style.position = 'absolute';
      sp.style.top = splitterTop - hostRect.top + 'px';
      sp.style.height = splitterHeight + 'px';
      sp.style.left = gapCentre - hostRect.left - splitterWidth / 2 + 'px';
      sp.style.width = splitterWidth + 'px';
      sp.style.minWidth = splitterWidth + 'px';
      sp.style.maxWidth = splitterWidth + 'px';
      sp.style.zIndex = '5';
      if (devtoolsLinkTop !== null && devtoolsLinkHeight !== null) {
        sp.style.setProperty('--bento-devtools-link-top', devtoolsLinkTop + 'px');
        sp.style.setProperty('--bento-devtools-link-height', devtoolsLinkHeight + 'px');
      } else {
        sp.style.removeProperty('--bento-devtools-link-top');
        sp.style.removeProperty('--bento-devtools-link-height');
      }
      setSidebarOccludedOverlayState(sp, {
        left: gapCentre - splitterWidth / 2,
        top: splitterTop,
        right: gapCentre + splitterWidth / 2,
        bottom: splitterTop + splitterHeight,
      });
    }
    // Observe after positioning so the next layout commit triggers a
    // re-sync. Observe both the left AND right panel of every boundary
    // plus the right edge of the last panel, so any width change in
    // any panel re-fires. Only joined/left elements are touched.
    if (__bentoSplitterRO) {
      const desiredEls = new Set();
      for (const id of panelIds) {
        const el = document.getElementById(id);
        if (el) desiredEls.add(el);
      }
      for (const link of currentDevtoolsLinkByTabId.values()) {
        if (link?.callerTabId === null) continue;
        const el = getPanelElementForTabId(link?.callerTabId);
        if (el) desiredEls.add(el);
      }
      setObservedSplitterPanels(desiredEls);
    }
  }

  // ─── Shortcut panel navigation ─────────────────────────────────────────
  // Cmd/Ctrl+Shift+Left / Right cycles through panels: main + each side
  // panel's flattened subdivision targets, then the Add-panel trailer
  // when present. The "current" item advances from the user's explicit
  // selection; pressing the Right shortcut scrolls the next item into view,
  // Left scrolls the previous one. Stops at the ends unless wraparound is on.
  //
  // Suppressed when focus is inside any input / textarea / contenteditable
  // (URL bars, form fields, etc.) so the shortcut does not steal text
  // selection. Plain Left / Right arrows are intentionally left to content
  // for media scrubbing and page-specific keyboard behavior.
  function getOrderedPanels() {
    // Panels live as notificationbox children of gBrowser.tabpanels,
    // in tabpanels.splitViewPanels order. The reconciler stamps
    // data-bento-main-panel / data-bento-panel-tab-id on each panel
    // container so downstream code (drag-reorder, shortcut cycling,
    // Esc-to-blur) reads tabIds. When tabpanels isn't yet in split-
    // active mode (boot, or no panels in the active workspace), the
    // ordered list is empty.
    if (!window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
      return [];
    }
    const out = [];
    const ids = window.gBrowser.tabpanels.splitViewPanels || [];
    for (const panelId of ids) {
      const el = document.getElementById(panelId);
      if (el) out.push(el);
    }
    return out;
  }

  function getOwningPanelForSubdivisionChooser(chooser) {
    if (!chooser) return null;
    const ownerTabId = Number(chooser.getAttribute('data-bento-owner-tab-id'));
    if (!Number.isFinite(ownerTabId)) return null;
    return document.querySelector('[data-bento-panel-tab-id="' + ownerTabId + '"]');
  }

  function getPanelCycleTargetForTabId(tabId) {
    const id = Number(tabId);
    if (!Number.isFinite(id)) return null;
    return document.querySelector('[data-bento-panel-tab-id="' + id + '"]');
  }

  function getPanelCycleChooserTarget(chooserId) {
    if (!chooserId) return null;
    const id = String(chooserId);
    return (
      Array.from(document.querySelectorAll('.bento-subdivision-chooser')).find(
        (chooser) => chooser.isConnected && chooser.getAttribute('data-bento-chooser-id') === id,
      ) || null
    );
  }

  function appendLayoutCycleTargets(node, out) {
    if (!node) return;
    if (node.kind === 'panel') {
      const panelEl = getPanelCycleTargetForTabId(node.tabId);
      if (panelEl) out.push(panelEl);
      return;
    }
    if (node.kind === 'chooser') {
      const chooser = getPanelCycleChooserTarget(node.id);
      if (chooser) out.push(chooser);
      return;
    }
    if (node.kind !== 'group') return;
    appendLayoutCycleTargets(node.children?.[0], out);
    appendLayoutCycleTargets(node.children?.[1], out);
  }

  function getFlatLayoutPanelCycleTargets() {
    const tabpanels = window.gBrowser?.tabpanels;
    if (!tabpanels?.classList.contains('bento-flat-panel-layout')) return [];
    if (!Array.isArray(currentPanelLayout?.root) || currentPanelLayout.root.length === 0) return [];

    const targets = [];
    const mainPanel =
      getOrderedPanels().find((panel) => panel.dataset?.bentoMainPanel === '1') || getOrderedPanels()[0];
    if (mainPanel) targets.push(mainPanel);
    for (const node of currentPanelLayout.root) {
      appendLayoutCycleTargets(node, targets);
    }
    return targets.filter((target, index, list) => target && list.indexOf(target) === index);
  }

  function getPanelCycleTargets() {
    // Cycle targets = ordered panels + the Add-panel trailer (when
    // present). The trailer is a focusable XUL vbox sibling of the
    // panel containers inside tabpanels; including it as the final
    // cycle slot lets the Right shortcut past the last panel land on it, and
    // its Enter/Space keydown handler then triggers addNewPanel.
    // The favicon strip renders one entry per root layout node, so
    // applyActiveMarker maps split/subdivision leaves back to their
    // containing root icon.
    let targets = getFlatLayoutPanelCycleTargets();
    if (targets.length === 0) targets = getOrderedPanels();
    if (targets.length === 0) return targets;
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer) targets.push(trailer);
    return targets;
  }

  function getTopLevelPanelForCycleTarget(target) {
    if (!target || target.id === 'bento-add-panel-trailer') return null;
    if (target.classList?.contains('bento-subdivision-chooser')) {
      return getOwningPanelForSubdivisionChooser(target);
    }
    const orderedPanels = getOrderedPanels();
    if (orderedPanels.includes(target)) return target;
    return orderedPanels.find((panel) => panel.contains(target)) || null;
  }

  function getPanelElementRootNodeId(panelEl) {
    const tabId = Number(panelEl?.dataset?.bentoPanelTabId);
    if (!Number.isFinite(tabId)) return null;
    return panelEl.dataset.bentoRootNodeId || 'panel:' + tabId;
  }

  function getPanelNavRootNodeIds(panels = __lastPanelsPayload) {
    return uniqueRootPanels(panels)
      .map((panel) => panel.rootNodeId || 'panel:' + panel.tabId)
      .filter(Boolean);
  }

  function getNavIndexForCycleIndex(idx) {
    const target = getPanelCycleTargets()[idx];
    const topLevelPanel = getTopLevelPanelForCycleTarget(target);
    if (!topLevelPanel) return -1;
    if (topLevelPanel.dataset?.bentoMainPanel === '1') return 0;
    const rootNodeId = getPanelElementRootNodeId(topLevelPanel);
    if (!rootNodeId) return -1;
    const rootIndex = getPanelNavRootNodeIds().indexOf(rootNodeId);
    return rootIndex >= 0 ? rootIndex + 1 : -1;
  }

  function getCycleIndexForPanelElement(panelEl) {
    if (!panelEl) return -1;
    const targets = getPanelCycleTargets();
    let idx = targets.indexOf(panelEl);
    if (idx >= 0) return idx;
    idx = targets.findIndex((target) => panelEl.contains(target));
    return idx;
  }

  function getCycleIndexForPanelTabId(tabId) {
    if (!Number.isFinite(tabId)) return -1;
    const panelEl = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
    return getCycleIndexForPanelElement(panelEl);
  }

  function getPanelTargetBrowser(panelEl) {
    if (!panelEl) return null;
    if (panelEl.dataset?.bentoMainPanel) {
      return window.gBrowser?.selectedBrowser || null;
    }
    return (
      panelEl.querySelector(':scope > .browserContainer browser') ||
      panelEl.querySelector(':scope > browser')
    );
  }

  function isEditableChromeTarget(target) {
    if (!target) return false;
    const tag = target.localName;
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    if (target.isContentEditable) return true;
    return !!target.closest?.(
      '#urlbar, #searchbar, [role="textbox"], [role="searchbox"], [role="combobox"]',
    );
  }

  function getFocusedPanelHistoryBrowser() {
    const active = document.activeElement;
    if (!active || isEditableChromeTarget(active)) return null;
    if (active.localName === 'browser') return active;
    const panel = active.closest?.('[data-bento-panel-tab-id], [data-bento-main-panel]');
    return panel ? getPanelTargetBrowser(panel) : null;
  }

  function navigateFocusedPanelHistory(direction) {
    const browser = getFocusedPanelHistoryBrowser();
    if (!browser) return false;
    try {
      if (direction < 0) {
        if (browser.canGoBack) browser.goBack();
      } else if (direction > 0) {
        if (browser.canGoForward) browser.goForward();
      } else {
        return false;
      }
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] panel history navigation failed:', err);
      return false;
    }
  }

  function getFocusedPanelElementForClose() {
    const active = document.activeElement;
    const activePanel = active?.closest?.('[data-bento-panel-tab-id]');
    if (activePanel) return activePanel;
    if (active && isEditableChromeTarget(active)) return null;
    let focusedContentBrowser = null;
    try {
      focusedContentBrowser = Services.focus.focusedContentBrowsingContext?.top?.embedderElement;
    } catch {}
    const contentPanel = focusedContentBrowser?.closest?.('[data-bento-panel-tab-id]');
    if (contentPanel) return contentPanel;
    if (!window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) return null;
    if (!Number.isFinite(currentFocusedPanelTabId)) return null;
    const focusedPanel = document.querySelector(
      '[data-bento-panel-tab-id="' + CSS.escape(String(currentFocusedPanelTabId)) + '"]',
    );
    if (!focusedPanel?.classList?.contains('bento-panel--focused')) return null;
    return focusedPanel;
  }

  function getPanelFocusIndicatorTargets() {
    const out = [];
    const seen = new Set();
    const add = (target) => {
      if (!target || seen.has(target)) return;
      seen.add(target);
      out.push(target);
    };
    for (const target of getPanelCycleTargets()) add(target);

    const tabpanels = window.gBrowser?.tabpanels;
    if (tabpanels?.classList.contains('bento-split-active')) {
      for (const chooser of Array.from(
        document.querySelectorAll('.bento-subdivision-chooser'),
      )) {
        if (!chooser.isConnected) continue;
        add(chooser);
      }
    }
    return out;
  }

  function shouldHandlePanelArrowKey(target) {
    // Bail when arrow keys belong to a text widget or chrome navigation
    // surface that has its own meaning for ←/→. Without these guards the
    // panel handlers steal caret movement or text selection in the
    // Firefox URL bar / search bar / panel header URL input, and menu
    // navigation in <menupopup>/<menubar>.
    //
    // We check both the event target AND document.activeElement because
    // some chrome widgets dispatch keydown on a wrapper while the focused
    // sub-element (the actual editable) is reported by activeElement.
    const candidates = [target, document.activeElement];
    for (const node of candidates) {
      if (!node) continue;
      // browser.xhtml is XHTML (XML mode), so tagName preserves case for
      // HTML-namespace elements created via createElementNS(HTML_NS, …) —
      // the panel header URL input reports tagName 'input' (lowercase),
      // not 'INPUT'. localName is consistently lowercase across both
      // XUL and HTML namespaces, so use that.
      const tag = node.localName;
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return false;
      if (node.isContentEditable) return false;
      // closest() walks up the flattened tree; bail on any chrome
      // editable / navigable container. #urlbar and #searchbar cover the
      // Firefox awesomebar + search field; <menupopup>/<menubar>/<menu>
      // own arrow-key navigation; [role=…] catches custom widgets that
      // self-identify as text/list nav surfaces.
      if (typeof node.closest === 'function') {
        if (
          node.closest(
            '#urlbar, #searchbar, menupopup, menubar, menu, menulist,' +
              ' [role="textbox"], [role="searchbox"], [role="combobox"],' +
              ' [role="menu"], [role="menubar"], [role="listbox"]',
          )
        )
          return false;
      }
    }
    return true;
  }

  function navigatePanels(delta, options = {}) {
    // Scroll the active host (tabpanels in split-view mode, legacy
    // panel-host otherwise) so the next cycle target is brought into
    // view alongside the favicon-strip marker advance. Without this,
    // panels off-screen of the strip stay off-screen even though the
    // favicon strip indicator advances.
    const host = getStripScrollTarget();
    if (!host) return false;
    const targets = getPanelCycleTargets();
    if (targets.length === 0) return false;

    // Index advances from the user's CURRENT selection — not from
    // wherever the strip happens to be scrolled to. Decoupling these
    // means: (a) repeated cycle clicks always advance one panel even
    // when the strip can't physically scroll further (end of list),
    // (b) the bottom marker stays in sync with what the user just
    // selected, (c) manual scroll (mouse wheel) doesn't change the
    // selection.
    //
    // Endpoint behaviour: clamp by default; wrap when the caller allows
    // it and the user has opted into shortcut wraparound via Settings.
    // Shift-wheel traversal passes allowWrap:false because scroll
    // cycling should stop at the ends regardless of that keyboard shortcut
    // setting.
    let nextIdx;
    const allowWrap = options.allowWrap !== false;
    if (allowWrap && currentPanelCycleWraparound) {
      const n = targets.length;
      nextIdx = (((currentActiveIdx + delta) % n) + n) % n;
    } else {
      nextIdx = Math.max(0, Math.min(targets.length - 1, currentActiveIdx + delta));
    }
    if (nextIdx === currentActiveIdx) return false;

    const targetPanel = targets[nextIdx];
    scrollPanelIntoViewFromRight(targetPanel);
    if (nextIdx === 0) clearRestoredMainAutoScrollSuppression();
    setActiveByIndex(nextIdx);
    return true;
  }

  window.addEventListener('keydown', (e) => {
    const isPanelArrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
    const hasSingleAccel = (e.metaKey || e.ctrlKey) && !(e.metaKey && e.ctrlKey);
    if (
      hasSingleAccel &&
      !e.altKey &&
      !e.shiftKey &&
      isPanelArrow
    ) {
      if (navigateFocusedPanelHistory(e.key === 'ArrowRight' ? 1 : -1)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (hasSingleAccel && e.shiftKey && !e.altKey && isPanelArrow) {
      if (!shouldHandlePanelArrowKey(e.target)) return;
      // When focus lives inside a content <browser>, the BentoKey child actor
      // owns Cmd/Ctrl+Shift+Left/Right. It forwards to chrome only when the
      // inner content target is non-editable, so in-page text selection and
      // plain media scrubbing stay with the page.
      if (document.activeElement?.localName === 'browser') return;
      e.preventDefault();
      navigatePanels(e.key === 'ArrowRight' ? 1 : -1);
      return;
    }

    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!shouldHandlePanelArrowKey(e.target)) return;

    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // Plain Left/Right belong to content. This avoids stealing video
      // scrubbing and page-local horizontal navigation.
      return;
    }

    // Up/Down on a cycle-focused panel container scroll the panel's
    // content vertically. Without this, arrow keys produce no scroll
    // because the panel container (a notificationbox) isn't a scroll
    // surface and keyboard focus is on chrome, not content.
    //
    // We can't simply move keyboard focus to the panel's <browser>
    // element to let the content's natural arrow-key handling take
    // over: with focus in content (a remote process), the chrome
    // keydown listener on `window` no longer sees shortcut key
    // events, breaking cycling. Instead, use the chrome command
    // dispatcher's cmd_scrollLine{Up,Down} which routes scroll
    // commands across the multi-process boundary to whichever
    // browser is currently focused. Brief focus shuffle: focus the
    // browser to direct the command at it, dispatch, then restore
    // focus to the container so shortcut cycling keeps working.
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const target = e.target;
      const isPanelContainer = !!(
        target &&
        target.dataset &&
        (target.dataset.bentoMainPanel || target.dataset.bentoPanelTabId)
      );
      if (!isPanelContainer) return;
      const browser = target.querySelector('browser');
      if (!browser) return;
      e.preventDefault();
      try {
        browser.focus({ preventScroll: true });
        const cmd = e.key === 'ArrowDown' ? 'cmd_scrollLineDown' : 'cmd_scrollLineUp';
        const controller = document.commandDispatcher.getControllerForCommand(cmd);
        controller?.doCommand?.(cmd);
      } catch (err) {
        console.warn('[bento-shell-mount] panel scroll failed:', err);
      } finally {
        try {
          target.focus({ preventScroll: true });
        } catch {
          /* best-effort restore */
        }
      }
    }
  });

  // Scroll the focused panel's content via a frame script. With panel
  // CONTAINER focused (cycle mode), neither contentWindow.scrollBy
  // (returns null for remote=true browsers — frameLoader.docShell is
  // null on the chrome side) nor goDoCommand (vbox has no controllers
  // in its focus chain) reaches the right browser. The reliable
  // cross-process path is to load a tiny frame script into the panel
  // browser, then sendAsyncMessage from chrome — frame script runs in
  // the content process and has direct access to `content.scrollBy`.
  //
  // For the MAIN panel, the underlying browser is the active tab's
  // <browser> (gBrowser.selectedBrowser). We load the frame script
  // into that browser too, on demand.
  const PANEL_SCROLL_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoPanelScroll", function(msg) {' +
    '  try {' +
    '    if (content && typeof content.scrollBy === "function") {' +
    '      content.scrollBy({ left: 0, top: msg.data.dy, behavior: "smooth" });' +
    '    }' +
    '  } catch (e) {}' +
    '});';
  const PANEL_SCROLL_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(PANEL_SCROLL_FRAME_SCRIPT_SRC);

  function ensurePanelScrollFrameScript(browserEl) {
    if (!browserEl || browserEl._bentoScrollScriptLoaded) return;
    try {
      const mm = browserEl.messageManager;
      if (mm && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(PANEL_SCROLL_FRAME_SCRIPT_URL, true);
        browserEl._bentoScrollScriptLoaded = true;
      }
    } catch (err) {
      console.warn('[bento-shell-mount] loadFrameScript failed:', err);
    }
  }

  function getPanelScrollBrowser(panelEl) {
    // For the main panel container (#tabbrowser-tabbox), the actual
    // content lives in the active tab's browser. For side panels,
    // the panel container has its own dedicated <browser> child.
    return getPanelTargetBrowser(panelEl);
  }

  function scrollPanelContent(panelEl, dy) {
    const browser = getPanelScrollBrowser(panelEl);
    if (!browser) return false;
    ensurePanelScrollFrameScript(browser);
    try {
      const mm = browser.messageManager;
      if (mm && typeof mm.sendAsyncMessage === 'function') {
        mm.sendAsyncMessage('BentoPanelScroll', { dy });
        return true;
      }
    } catch (err) {
      console.warn('[bento-shell-mount] sendAsyncMessage failed:', err);
    }
    return false;
  }

  // Keyboard scroll within the focused panel. Active only when focus
  // is on a panel container (data-bento-main-panel /
  // data-bento-panel-tab-id) — i.e. the user is in cycle mode. The
  // panel header buttons / URL input pass through (they're inside the
  // panel but not the container itself, so default behaviour wins).
  // Once focus is inside a content browser, content handles these keys
  // natively in the content process, so this listener doesn't even
  // see them.
  const SCROLL_LINE_PX = 40;
  window.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const isUp = e.key === 'ArrowUp';
    const isDown = e.key === 'ArrowDown';
    const isSpace = e.key === ' ' || e.code === 'Space';
    if (!isUp && !isDown && !isSpace) return;
    const active = document.activeElement;
    if (!active || !active.dataset) return;
    if (!active.dataset.bentoMainPanel && !active.dataset.bentoPanelTabId) return;
    const panelBrowser = getPanelScrollBrowser(active);
    const panelHeight = panelBrowser?.clientHeight || 600;
    const pageStep = Math.max(SCROLL_LINE_PX, panelHeight - SCROLL_LINE_PX);
    let dy = 0;
    if (isUp) dy = -SCROLL_LINE_PX;
    else if (isDown) dy = SCROLL_LINE_PX;
    else if (isSpace) dy = e.shiftKey ? -pageStep : pageStep;
    if (dy === 0) return;
    e.preventDefault();
    e.stopPropagation();
    scrollPanelContent(active, dy);
  });

  // ESC inside a panel returns focus to the panel container itself,
  // letting the user resume keyboard shortcut cycling. Skipped while any of
  // the chrome overlays (palette / confirm / edit-workspace) is open
  // — those have their own ESC dismiss handlers (see
  // attachPaletteEscListener) which run earlier in capture phase
  // and stopPropagation, so we only see ESC when no overlay is
  // intercepting. Skipped for keystrokes inside a remote content
  // browser too — those don't bubble into chrome (different process).
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const active = document.activeElement;
    if (!active) return;
    const panel = active.closest?.('[data-bento-panel-tab-id], [data-bento-main-panel]');
    if (!panel || active === panel) return;
    const idx = getCycleIndexForPanelElement(panel);
    if (idx < 0) return;
    e.preventDefault();
    e.stopPropagation();
    // Blur whatever input/button currently has focus, then focus
    // the panel container. Re-applies the cycle indicator so the
    // user has a visual cue they're back in panel-cycle mode.
    try {
      if (typeof active.blur === 'function') active.blur();
    } catch {
      /* best-effort */
    }
    setActiveByIndex(idx);
  });

  // ─── Panel navigator (favicon strip + cycle buttons) ──────────────────
  // Sits below the strip in a column-flex wrapper. Replaces the native
  // horizontal scrollbar. Buttons cycle panels (same as ←/→ keys).
  // Favicons map to panels in DOM order: main + each side panel. Click
  // a favicon → scroll that panel to the leftmost position.

  function getMainTabFavicon() {
    try {
      return window.gBrowser?.selectedTab?.image || '';
    } catch {
      return '';
    }
  }

  function getMainPanelTooltipLabel() {
    try {
      const tab = window.gBrowser?.selectedTab;
      const title = tab?.label || window.gBrowser?.selectedBrowser?.contentTitle || '';
      return title.trim() || 'New tab';
    } catch {
      return 'New tab';
    }
  }

  let panelNavigatorTooltipTimer = null;
  function hidePanelNavigatorTooltip() {
    if (panelNavigatorTooltipTimer) {
      clearTimeout(panelNavigatorTooltipTimer);
      panelNavigatorTooltipTimer = null;
    }
    panelNavigatorTooltipPayload = null;
    // The frame does not exist until the first hover, and a document that is
    // still loading may not take a message yet.
    const frame = document.getElementById('bento-panel-navigator-tooltip-frame');
    try {
      frame?.messageManager?.sendAsyncMessage?.('BentoPanelNavigatorTooltip', null);
    } catch {
      // Nothing to hide in a document that has not loaded.
    }
  }

  function showPanelNavigatorTooltip(btn) {
    if (!btn?.isConnected) return;
    const label = btn.getAttribute('aria-label') || '';
    if (!label) return;
    const rect = btn.getBoundingClientRect();
    const screenX = (window.mozInnerScreenX || window.screenX || 0) + rect.left;
    const screenY = (window.mozInnerScreenY || window.screenY || 0) + rect.top;
    showPanelNavigatorTooltipPayload({
      label,
      screenX,
      screenY,
      width: rect.width,
      height: rect.height,
    });
  }

  // payload: { label, detail?, placement?, screenX, screenY, width, height }, the anchor
  // in screen coordinates; the tooltip document places a Mux tooltip beside it.
  function showPanelNavigatorTooltipPayload(payload) {
    // An immediate show (focus, a changed rail label) supersedes a pending hover timer, which
    // would otherwise run later and put its older text back.
    if (panelNavigatorTooltipTimer) {
      clearTimeout(panelNavigatorTooltipTimer);
      panelNavigatorTooltipTimer = null;
    }
    panelNavigatorTooltipPayload = payload;
    // First use creates the tooltip document. Until it announces readiness the
    // payload above waits in panelNavigatorTooltipPayload; the manager's
    // onReady (and the STATE_STOP listener) send it.
    const frame = overlays.ensure('panel-navigator-tooltip', 'hover');
    if (!frame) return;
    ensurePanelNavigatorTooltipFrameScript();
    replayPanelNavigatorTooltipPayload(frame);
  }

  // Hover starts loading the document now, so the load overlaps the hover delay, and
  // runs `show` after it.
  function armPanelNavigatorTooltip(show) {
    hidePanelNavigatorTooltip();
    overlays.ensure('panel-navigator-tooltip', 'hover');
    panelNavigatorTooltipTimer = setTimeout(show, 400);
  }

  function attachPanelNavigatorTooltip(btn) {
    btn.addEventListener('mouseenter', () => {
      armPanelNavigatorTooltip(() => showPanelNavigatorTooltip(btn));
    });
    btn.addEventListener('mouseleave', hidePanelNavigatorTooltip);
    btn.addEventListener('focus', () => showPanelNavigatorTooltip(btn));
    btn.addEventListener('blur', hidePanelNavigatorTooltip);
  }

  function isSelectedBrowserTab(tab) {
    try {
      return !!tab && window.gBrowser?.selectedTab === tab;
    } catch {
      return false;
    }
  }

  function scrollPanelToLeftmost(panelEl) {
    if (!panelEl) return;
    // Use getStripScrollTarget() — in split-view mode the actual
    // scroll context is #tabbrowser-tabpanels (Firefox's native deck),
    // NOT #bento-side-panel-host. Hardcoding the host meant favicon
    // clicks scrolled the wrong container in split-view, which both
    // failed to bring the panel into view AND visually misaligned the
    // inter-panel splitters (their absolute positions are computed
    // relative to the active scroll container — scrolling the wrong
    // one leaves splitters anchored to the live tabpanels offsets but
    // visually painted at the host's offsets). The cycle handler at
    // ~line 2015 already uses this helper for the same reason. */
    const host = getStripScrollTarget();
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const insets = getStripScrollInsets(host);
    const stripLeft = hostRect.left + insets.inlineStart;
    const panelLeft = panelEl.getBoundingClientRect().left;
    const targetScrollLeft = host.scrollLeft + (panelLeft - stripLeft);
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
  }

  function clearRestoredMainAutoScrollSuppression() {
    __suppressNextMainAutoScrollForWorkspace = null;
  }

  function isRestoredMainAutoScrollSuppressed(panelEl) {
    return !!(
      panelEl?.dataset?.bentoMainPanel === '1' &&
      __suppressNextMainAutoScrollForWorkspace !== null &&
      __suppressNextMainAutoScrollForWorkspace === currentWorkspaceId
    );
  }

  function getStripScrollInsets(host) {
    if (!host) return { inlineStart: 0, inlineEnd: 0 };
    const styles = getComputedStyle(host);
    const inlineStart = parseFloat(styles.paddingInlineStart || styles.paddingLeft) || 0;
    const inlineEnd = parseFloat(styles.paddingInlineEnd || styles.paddingRight) || 0;
    return { inlineStart, inlineEnd };
  }

  // Minimal-scroll variant for "newly-added panel" auto-scroll. If the
  // panel is already fully on screen, no-op. If it sits past the right
  // edge (the common case — new panels append rightward, after either
  // the source panel for openAt or at the end for plain add), nudge
  // just far enough that the panel's right edge meets the viewport's
  // right edge — keeping the previously-visible panels (including the
  // source) in view to the left. If the panel sits past the left edge,
  // align its left edge instead. Wider-than-viewport panels can't be
  // fully shown; fall back to leftmost alignment so the header is at
  // least visible.
  function scrollPanelIntoViewFromRight(panelEl) {
    if (!panelEl) return;
    const host = getStripScrollTarget();
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const insets = getStripScrollInsets(host);
    const visibleLeft = hostRect.left + insets.inlineStart;
    const visibleRight = hostRect.right - insets.inlineEnd;
    const fullyVisible = panelRect.left >= visibleLeft - 1 && panelRect.right <= visibleRight + 1;
    if (fullyVisible) return;
    if (panelRect.width > visibleRight - visibleLeft) {
      scrollPanelToLeftmost(panelEl);
      return;
    }
    let delta = 0;
    if (panelRect.right > visibleRight) {
      delta = panelRect.right - visibleRight;
    } else if (panelRect.left < visibleLeft) {
      delta = panelRect.left - visibleLeft;
    }
    const targetScrollLeft = host.scrollLeft + delta;
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
  }

  function isPanelFullyVisible(panelEl) {
    if (!panelEl) return false;
    const host = getStripScrollTarget();
    if (!host) return false;
    const hostRect = host.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const insets = getStripScrollInsets(host);
    const visibleLeft = hostRect.left + insets.inlineStart;
    const visibleRight = hostRect.right - insets.inlineEnd;
    if (panelRect.width <= 1 || panelRect.height <= 1) return false;
    return panelRect.left >= visibleLeft - 1 && panelRect.right <= visibleRight + 1;
  }

  function scrollPanelFullyIntoView(panelEl) {
    if (!panelEl) return;
    const host = getStripScrollTarget();
    if (!host) return;
    const hostRect = host.getBoundingClientRect();
    const panelRect = panelEl.getBoundingClientRect();
    const insets = getStripScrollInsets(host);
    // Explicit open targets should land as complete panels. Aligning
    // the left edge is more reliable than a minimal right-edge nudge
    // while the trailer width, panel width, and smooth scroll settle.
    const targetScrollLeft =
      host.scrollLeft + (panelRect.left - hostRect.left - insets.inlineStart);
    host.scrollTo({ left: Math.max(0, targetScrollLeft), behavior: 'smooth' });
  }

  function scheduleScrollPanelTabIntoView(tabId, options = {}) {
    if (!Number.isInteger(tabId)) return;
    const DEADLINE_MS = 2000;
    const POLL_MS = 50;
    const started = Date.now();
    let focused = false;
    const tryScroll = () => {
      const panelEl = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
      if (panelEl) {
        const rect = panelEl.getBoundingClientRect();
        const host = getStripScrollTarget();
        const hasPanelBox = !!host && rect.width > 1 && rect.height > 1;
        const insets = host ? getStripScrollInsets(host) : { inlineStart: 0, inlineEnd: 0 };
        const hostRect = host?.getBoundingClientRect?.();
        const panelAlreadyVisible =
          !!hostRect &&
          rect.left >= hostRect.left + insets.inlineStart - 1 &&
          rect.right <= hostRect.right - insets.inlineEnd + 1;
        const hasOverflow = !!host && host.scrollWidth > host.clientWidth + 1;
        const layoutReady = hasPanelBox && (hasOverflow || panelAlreadyVisible);
        if (!layoutReady && Date.now() - started <= DEADLINE_MS) {
          setTimeout(tryScroll, POLL_MS);
          return;
        }
        if (options.reveal === 'full') {
          scrollPanelFullyIntoView(panelEl);
        } else {
          scrollPanelIntoViewFromRight(panelEl);
        }
        if (!isPanelFullyVisible(panelEl) && Date.now() - started <= DEADLINE_MS) {
          setTimeout(tryScroll, 120);
        }
        if (options.focus && !focused) {
          focused = true;
          focusPanelCycleTarget(panelEl);
        }
        return;
      }
      if (Date.now() - started > DEADLINE_MS) return;
      setTimeout(tryScroll, POLL_MS);
    };
    setTimeout(tryScroll, 0);
  }

  function focusPanelCycleTarget(panelEl) {
    if (!panelEl) return false;
    const idx = getCycleIndexForPanelElement(panelEl);
    if (idx >= 0) {
      currentActiveIdx = idx;
      applyActiveMarker(idx);
      applyPanelFocusIndicator(idx);
      applyFocusedPanelIndicator(panelEl);
    }
    try {
      const browserEl = getPanelTargetBrowser(panelEl);
      if (browserEl) browserEl.focus({ preventScroll: true });
      else panelEl.focus({ preventScroll: true });
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] panel cycle focus failed:', err);
      return false;
    }
  }

  function getPanelRemovalFocusFallback(previousCycleIndex) {
    const targets = getPanelCycleTargets();
    if (targets.length === 0) return null;
    const start =
      Number.isInteger(previousCycleIndex) && previousCycleIndex >= 0
        ? Math.min(previousCycleIndex, targets.length - 1)
        : Math.min(Math.max(currentActiveIdx, 0), targets.length - 1);
    const isFocusablePanelTarget = (target) =>
      !!target && target.id !== 'bento-add-panel-trailer';
    for (let i = start; i < targets.length; i += 1) {
      if (isFocusablePanelTarget(targets[i])) return { target: targets[i], index: i };
    }
    for (let i = start - 1; i >= 0; i -= 1) {
      if (isFocusablePanelTarget(targets[i])) return { target: targets[i], index: i };
    }
    return null;
  }

  function focusSelectedMainAfterPanelRemoval() {
    currentActiveIdx = 0;
    applyActiveMarker(0);
    applyFocusedPanelIndicator(null);
    try {
      const browserEl = window.gBrowser?.selectedBrowser;
      if (browserEl) browserEl.focus({ preventScroll: true });
    } catch (err) {
      console.warn('[bento-shell-mount] main focus after panel removal failed:', err);
    }
    return true;
  }

  function focusNextTargetAfterPanelRemoval(previousCycleIndex) {
    const fallback = getPanelRemovalFocusFallback(previousCycleIndex);
    if (!fallback) return focusSelectedMainAfterPanelRemoval();
    if (fallback.index === 0) {
      clearRestoredMainAutoScrollSuppression();
      scrollPanelToLeftmost(fallback.target);
    } else {
      scrollPanelIntoViewFromRight(fallback.target);
    }
    return focusPanelCycleTarget(fallback.target);
  }

  // The active panel is the user's current cycle selection. Source of
  // truth for both the bottom favicon marker and the cycle-focus
  // indicator on the panel itself. NOT recomputed from scroll position
  // — that would lose track when the selected panel can't physically
  // scroll to leftmost (end of strip), and would also confuse the
  // "press next again to advance further" semantic.
  let currentActiveIdx = 0;
  let currentFocusedPanelTabId = null;
  let panelFocusTimer = null;
  let panelNavContextMenu = null;
  const SPLITTER_FOCUS_AUTOSCROLL_SUPPRESS_MS = 900;
  let __suppressPanelFocusAutoScrollUntil = 0;

  function suppressPanelFocusAutoScrollForSplitterInteraction() {
    __suppressPanelFocusAutoScrollUntil =
      Date.now() + SPLITTER_FOCUS_AUTOSCROLL_SUPPRESS_MS;
  }

  function isPanelFocusAutoScrollSuppressed() {
    return Date.now() < __suppressPanelFocusAutoScrollUntil;
  }

  const SHELL_ACTION_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoShellAction", function(msg) {' +
    '  try {' +
    '    var actionType = msg.data && msg.data.type;' +
    '    if (typeof actionType === "string" && actionType.indexOf("ui/") === 0) content.focus();' +
    '    var channel = new content.BroadcastChannel("bento-shell-bus");' +
    '    channel.postMessage({ kind: "action", action: msg.data });' +
    '    channel.close();' +
    '  } catch (e) {}' +
    '});';
  const SHELL_ACTION_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(SHELL_ACTION_FRAME_SCRIPT_SRC);

  const ADDRBAR_OPEN_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoAddrbarOpen", function(msg) {' +
    '  try {' +
    '    var openId = msg.data && typeof msg.data.openId === "string" ? msg.data.openId : "";' +
    '    var mode = msg.data && msg.data.mode === "newTab" ? "newTab" : "current";' +
    '    var initialQuery = msg.data && typeof msg.data.initialQuery === "string" ? msg.data.initialQuery : "";' +
    '    var suppressFocus = !!(msg.data && msg.data.suppressFocus);' +
    '    var clipboardUrl = msg.data && typeof msg.data.clipboardUrl === "string" ? msg.data.clipboardUrl : "";' +
    '    var placement = msg.data && msg.data.placement && typeof msg.data.placement === "object" ? msg.data.placement : null;' +
    '    var windowId = msg.data && typeof msg.data.windowId === "number" ? msg.data.windowId : null;' +
    '    var channel = new content.BroadcastChannel("bento-addrbar-bus");' +
    '    channel.postMessage({ kind: "open", windowId: windowId, openId: openId, mode: mode, initialQuery: initialQuery, suppressFocus: suppressFocus, clipboardUrl: clipboardUrl, placement: placement });' +
    '    channel.close();' +
    '  } catch (e) {}' +
    '});';
  const ADDRBAR_OPEN_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(ADDRBAR_OPEN_FRAME_SCRIPT_SRC);

  const SIDEBAR_ADDRESS_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoSidebarAddress", function(msg) {' +
    '  try {' +
    '    var channel = new content.BroadcastChannel("bento-sidebar-address-bus");' +
    '    channel.postMessage(msg.data);' +
    '    channel.close();' +
    '  } catch (e) {}' +
    '});';
  const SIDEBAR_ADDRESS_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(SIDEBAR_ADDRESS_FRAME_SCRIPT_SRC);

  const MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoMergePaletteLifecycle", function(msg) {' +
    '  try {' +
    '    var type = msg.data && msg.data.type === "close" ? "close" : "open";' +
    '    var nonce = msg.data && typeof msg.data.nonce === "string" ? msg.data.nonce : String(Date.now());' +
    '    var windowId = msg.data && typeof msg.data.windowId === "number" ? msg.data.windowId : null;' +
    '    var channel = new content.BroadcastChannel("bento-merge-palette");' +
    '    channel.postMessage({ type: type, nonce: nonce, windowId: windowId });' +
    '    channel.close();' +
    '  } catch (e) {}' +
    '});';
  const MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT_SRC);

  // The Settings palette document stays loaded while hidden, so chrome tells it when it is shown (and
  // which setting a link wants) and when it is hidden with DOM events, not the bus: this also reaches
  // a private window.
  const SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoSettingsPaletteShow", function(msg) {' +
    '  try {' +
    '    var target = msg.data && typeof msg.data.target === "string" ? msg.data.target : null;' +
    '    var origin = msg.data && msg.data.origin === "palette" ? "palette" : null;' +
    '    content.dispatchEvent(new content.CustomEvent("bento-settings-show", {' +
    '      detail: JSON.stringify({ target: target, origin: origin })' +
    '    }));' +
    '  } catch (e) {}' +
    '});' +
    'addMessageListener("BentoSettingsPaletteHide", function() {' +
    '  try {' +
    '    content.dispatchEvent(new content.CustomEvent("bento-settings-hide"));' +
    '  } catch (e) {}' +
    '});';
  const SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_SRC);

  const PANEL_TRAILER_FOCUS_FRAME_SCRIPT_SRC =
    '"use strict";' +
    'addMessageListener("BentoPanelTrailerCycleFocus", function(msg) {' +
    '  try {' +
    '    var root = content.document && content.document.documentElement;' +
    '    if (!root) return;' +
    '    if (msg.data && msg.data.focused) {' +
    '      root.setAttribute("data-bento-cycle-focus-add", "1");' +
    '    } else {' +
    '      root.removeAttribute("data-bento-cycle-focus-add");' +
    '    }' +
    '  } catch (e) {}' +
    '});';
  const PANEL_TRAILER_FOCUS_FRAME_SCRIPT_URL =
    'data:application/javascript;charset=utf-8,' +
    encodeURIComponent(PANEL_TRAILER_FOCUS_FRAME_SCRIPT_SRC);

  // bento-tools rejects a whole action when any field exceeds its cap in
  // extensions/_shared/wire-action.ts (the validator stays strict), and a page
  // controls its title, URL, and favicon. Keep these in step with those caps.
  // The URL cap mirrors Firefox's network.standard-url.max-length.
  const SAVED_PANEL_MAX_TITLE_LENGTH = 4096;
  const SAVED_PANEL_MAX_URL_LENGTH = 1048576;
  const SAVED_PANEL_MAX_FAVICON_URL_LENGTH = 262144;

  // Bounds the savedPanels/save fields to those caps. A long title is cut (as
  // Firefox does for bookmark titles) without splitting a surrogate pair, an
  // oversized favicon is dropped because it is optional, and a URL that is too
  // long returns null because a truncated URL would save a different address.
  function boundSavedPanelMetadata(url, title, favIconUrl) {
    if (url.length > SAVED_PANEL_MAX_URL_LENGTH) return null;
    let boundedTitle = title;
    if (boundedTitle.length > SAVED_PANEL_MAX_TITLE_LENGTH) {
      boundedTitle = boundedTitle.slice(0, SAVED_PANEL_MAX_TITLE_LENGTH);
      if (/[\uD800-\uDBFF]$/.test(boundedTitle)) boundedTitle = boundedTitle.slice(0, -1);
    }
    return {
      url,
      title: boundedTitle,
      favIconUrl: favIconUrl.length > SAVED_PANEL_MAX_FAVICON_URL_LENGTH ? '' : favIconUrl,
    };
  }

  // 'menu/open' and 'ui/*' are consumed by other shell documents, never by
  // tools, so they stay on the frame-script BroadcastChannel path (which works
  // inside a private window's partition).
  function isDocumentLocalShellAction(action) {
    const type = action && action.type;
    return typeof type === 'string' && (type === 'menu/open' || type.startsWith('ui/'));
  }

  // A private window's tools-bound actions cannot go over BroadcastChannel (it
  // is partitioned away from the shell background), so they enter the
  // BentoShellBus hub directly. The hub stamps the window identity from chrome.
  function postShellActionThroughBusHub(wireAction) {
    try {
      const { BentoShellBusHub } = ChromeUtils.importESModule(
        'resource:///actors/BentoShellBusParent.sys.mjs',
      );
      return BentoShellBusHub.postFromChrome(window, { kind: 'action', action: wireAction });
    } catch (err) {
      console.warn('[bento-shell-mount] private shell action relay failed:', err);
      return false;
    }
  }

  function dispatchShellAction(action) {
    const shellFrame = document.getElementById('bento-shell-frame');
    if (!shellFrame) return false;
    try {
      if (BentoPrivateBrowsingUtils.isWindowPrivate(window) && !isDocumentLocalShellAction(action)) {
        return postShellActionThroughBusHub(action);
      }
      const mm = shellFrame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') return false;
      if (!shellFrame._bentoShellActionScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(SHELL_ACTION_FRAME_SCRIPT_URL, true);
        shellFrame._bentoShellActionScriptLoaded = true;
      }
      // Stamp this chrome window's WebExtension windowId on the wire
      // envelope so bento-tools' per-window state lookups
      // (getActiveId(sourceWindowId), browser.tabs.create({windowId, …}))
      // resolve to THIS window's active workspace — not the global
      // fallback. Without this stamp, panel/openAt from a chrome menu
      // item routes to whatever workspace getActiveId(null) returns
      // (lastGlobalActiveId), so in multi-window setups the panel can
      // get registered against a workspace that isn't this window's
      // current one: the new tab is created in this window (focused),
      // gets assigned this window's workspaceId via tabs.onCreated, but
      // the panels list update lands on the wrong workspace. Result:
      // tab appears in the sidebar (wrong workspace's panel filter
      // doesn't exclude it) and never renders as a panel here.
      // The React-side dispatch() in useToolsPort.ts does the same
      // stamping — see the WireAction __windowId envelope notes.
      const windowId = getChromeWindowId();
      const wireAction =
        typeof windowId === 'number' && windowId >= 0
          ? Object.assign({}, action, { __windowId: windowId })
          : action;
      mm.sendAsyncMessage('BentoShellAction', wireAction);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] shell action dispatch failed:', err);
      return false;
    }
  }

  function dispatchAddrbarOpen(mode, initialQuery = '', options = {}) {
    const frame = document.getElementById('bento-addrbar-frame');
    if (!frame) return false;
    try {
      const mm = frame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') return false;
      if (!frame._bentoAddrbarOpenScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(ADDRBAR_OPEN_FRAME_SCRIPT_URL, true);
        frame._bentoAddrbarOpenScriptLoaded = true;
      }
      mm.sendAsyncMessage('BentoAddrbarOpen', {
        openId: typeof options.openId === 'string' ? options.openId : '',
        mode,
        initialQuery,
        suppressFocus: options.suppressFocus === true,
        clipboardUrl: typeof options.clipboardUrl === 'string' ? options.clipboardUrl : '',
        placement: options.placement || null,
        // The bus reaches every window's address bar document; this names ours.
        windowId: getChromeWindowId(),
      });
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] addrbar open dispatch failed:', err);
      return false;
    }
  }

  function dispatchSidebarAddressMessage(message, attempt = 0) {
    const frame = document.getElementById('bento-shell-frame');
    if (!frame) return false;
    try {
      const mm = frame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') {
        if (attempt < SIDEBAR_ADDRESS_RETRY_LIMIT) {
          setTimeout(() => dispatchSidebarAddressMessage(message, attempt + 1), 100);
        }
        return false;
      }
      if (!frame._bentoSidebarAddressScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(SIDEBAR_ADDRESS_FRAME_SCRIPT_URL, true);
        frame._bentoSidebarAddressScriptLoaded = true;
      }
      mm.sendAsyncMessage('BentoSidebarAddress', message);
      return true;
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar address dispatch failed:', err);
      return false;
    }
  }

  function dispatchMergePaletteLifecycle(type, nonce, attempt = 0) {
    const frame = document.getElementById('bento-merge-palette-frame');
    if (!frame) return false;
    try {
      const mm = frame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') {
        if (attempt < 10) {
          setTimeout(() => dispatchMergePaletteLifecycle(type, nonce, attempt + 1), 100);
        }
        return false;
      }
      if (!frame._bentoMergePaletteLifecycleScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(MERGE_PALETTE_LIFECYCLE_FRAME_SCRIPT_URL, true);
        frame._bentoMergePaletteLifecycleScriptLoaded = true;
      }
      // The bus reaches every window's merge palette document; this names ours.
      mm.sendAsyncMessage('BentoMergePaletteLifecycle', {
        type,
        nonce,
        windowId: getChromeWindowId(),
      });
      return true;
    } catch (err) {
      if (attempt < 10) {
        setTimeout(() => dispatchMergePaletteLifecycle(type, nonce, attempt + 1), 100);
      } else {
        console.warn('[bento-shell-mount] merge palette lifecycle dispatch failed:', err);
      }
      return false;
    }
  }

  // Every Show or Hide takes the next generation, and a retry of an older one is dropped: a Hide
  // that waited for the frame must not land after the Show that came later (it would cancel the
  // editor session that Show just began), nor a Show after a later Hide reopen the state.
  let settingsLifecycleSeq = 0;

  // Sends a lifecycle message to the Settings document's frame script, loading the script on first
  // use. A message that cannot go yet (the frame has no message manager) is retried briefly.
  function sendSettingsPaletteMessage(
    name,
    data,
    attempt = 0,
    generation = (settingsLifecycleSeq += 1),
  ) {
    if (generation !== settingsLifecycleSeq) return false;
    const frame = document.getElementById('bento-settings-palette-frame');
    if (!frame) return false;
    const retry = () =>
      setTimeout(() => sendSettingsPaletteMessage(name, data, attempt + 1, generation), 100);
    try {
      const mm = frame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') {
        if (attempt < 10) retry();
        return false;
      }
      if (!frame._bentoSettingsPaletteShowScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(SETTINGS_PALETTE_SHOW_FRAME_SCRIPT_URL, true);
        frame._bentoSettingsPaletteShowScriptLoaded = true;
      }
      mm.sendAsyncMessage(name, data);
      return true;
    } catch (err) {
      if (attempt < 10) {
        retry();
      } else {
        console.warn('[bento-shell-mount] settings palette ' + name + ' dispatch failed:', err);
      }
      return false;
    }
  }

  function dispatchSettingsPaletteShow(target, origin) {
    return sendSettingsPaletteMessage('BentoSettingsPaletteShow', {
      target: target || null,
      origin: origin === 'palette' ? 'palette' : null,
    });
  }

  // Only a document that was shown has anything to put back, so a hide before the first show is
  // not sent (it would load the frame script for nothing). It still ends a Show still waiting for
  // the frame.
  function dispatchSettingsPaletteHide() {
    const frame = document.getElementById('bento-settings-palette-frame');
    if (!frame || !frame._bentoSettingsPaletteShowScriptLoaded) {
      settingsLifecycleSeq += 1;
      return false;
    }
    return sendSettingsPaletteMessage('BentoSettingsPaletteHide', {});
  }

  function setPanelTrailerAddFocus(focused) {
    const frame = document.getElementById('bento-panel-trailer-frame');
    if (!frame) return;
    try {
      const mm = frame.messageManager;
      if (!mm || typeof mm.sendAsyncMessage !== 'function') return;
      if (!frame._bentoPanelTrailerFocusScriptLoaded && typeof mm.loadFrameScript === 'function') {
        mm.loadFrameScript(PANEL_TRAILER_FOCUS_FRAME_SCRIPT_URL, true);
        frame._bentoPanelTrailerFocusScriptLoaded = true;
      }
      mm.sendAsyncMessage('BentoPanelTrailerCycleFocus', { focused: !!focused });
    } catch (err) {
      console.warn('[bento-shell-mount] panel trailer focus sync failed:', err);
    }
  }

  function removePanel(tabId) {
    if (!Number.isFinite(tabId)) return;
    hidePanelNavContextMenu();
    const panel = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
    if (!panel) {
      dispatchShellAction({ type: 'tab/close', id: tabId });
      return;
    }
    const promotedChildWidths =
      currentPanelStatusByTabId.get(tabId) === 'subdivision-top'
        ? getPromotedChildWidthsForClosingTop(tabId)
        : [];
    if (panel._bentoPanelRemoving) return;
    panel._bentoPanelRemoving = true;

    panel.style.removeProperty('transition');
    panel.style.removeProperty('transform');
    panel.classList.add('bento-panel--removing');

    // Close the tab once the CSS dismiss fade on .bento-panel--removing has finished.
    afterMotion(panel, 'remove', { properties: ['opacity'] }, () => {
      stageTopLevelPanelCloseGapFlip(panel);
      for (const entry of promotedChildWidths) {
        dispatchShellAction({
          type: 'panel/setWidth',
          id: entry.tabId,
          widthPx: entry.widthPx,
        });
      }
      if (!dispatchShellAction({ type: 'tab/close', id: tabId })) {
        __bentoPendingCloseGapFlip = null;
      }
    });
  }

  // Cmd/Ctrl+W in a side panel closes THAT panel, not the active tab.
  // Without this, key_close → cmd_close → BrowserCommands.closeTabOrWindow
  // → gBrowser.removeCurrentTab always closes the main slot's tab, even
  // when focus is in a side panel — out of step with the user's mental
  // model ("close the thing in front of me").
  //
  // Capture phase + the key's reserved="true" flag means we see the
  // keydown on the chrome window even while content has focus, and
  // stopImmediatePropagation aborts before the XUL <key> binding fires.
  // Main panel closes through bento-tools too. When the main tab is the
  // last non-panel tab in the workspace, tools promotes a panel before
  // removing it; letting Firefox's native close run first can leave the
  // tab switcher pointing at a tab whose linkedBrowser has been nulled.
  // Shift/Alt skipped so Cmd+Shift+W (close window) and other compound
  // shortcuts keep their meaning.
  window.addEventListener(
    'keydown',
    (e) => {
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyW') return;
      if (currentSidebarSelectedTabIds.length > 1) {
        const ids = currentSidebarSelectedTabIds.slice();
        if (!dispatchShellAction({ type: 'tabs/close', ids })) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        currentSidebarSelectedTabIds = [];
        return;
      }
      const panel = getFocusedPanelElementForClose();
      if (panel) {
        const tabId = Number(panel.dataset.bentoPanelTabId);
        if (!Number.isFinite(tabId)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        removePanel(tabId);
        return;
      }

      const tabId = getBentoTabId(window.gBrowser?.selectedTab);
      if (!Number.isFinite(tabId)) return;
      if (!dispatchShellAction({ type: 'tab/closeMain', id: tabId })) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true /* capture */,
  );

  let currentSidebarHidden = false;
  let currentSidebarShortcutBehavior = 'collapse';

  // Cmd/Ctrl+S toggles the sidebar minimized state. Firefox's stock
  // key_savePage is patched to reserved="true" (patches/core-ui/
  // 07-key-savepage-reserved.patch) so chrome's capture-phase listener
  // sees the keydown even when content has focus, and content can no
  // longer intercept it. We stopImmediatePropagation to abort the
  // Browser:SavePage command — File → Save Page As stays available via
  // the menu for users who still need to save.
  //
  // Current state is read from #bento-shell-host (set by the BENTO_PANELS
  // settings payload; during a sidebar push the push's target, since the
  // collapsed class only lands when the slide ends). Dispatch settings/update with the
  // toggled value; tools persists + broadcasts back through the same
  // channel so the next press sees the updated minimized state.
  window.addEventListener(
    'keydown',
    (e) => {
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.altKey || e.shiftKey) return;
      if (e.code !== 'KeyS') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const host = document.getElementById('bento-shell-host');
      const currentlyHidden =
        currentSidebarHidden || !!host?.classList.contains('bento-sidebar-hidden');
      const currentlyCollapsed = isSidebarCollapsedTarget(host);
      if (currentlyHidden) {
        dispatchShellAction({
          type: 'settings/update',
          changes: { sidebarHidden: false, sidebarCollapsed: false },
        });
        return;
      }
      if (currentSidebarShortcutBehavior === 'hide') {
        dispatchShellAction({
          type: 'settings/update',
          changes: { sidebarHidden: true, sidebarCollapsed: true },
        });
        return;
      }
      dispatchShellAction({
        type: 'settings/update',
        changes: { sidebarHidden: false, sidebarCollapsed: !currentlyCollapsed },
      });
    },
    true /* capture */,
  );

  function hidePanelNavContextMenu() {
    if (!panelNavContextMenu) return;
    panelNavContextMenu.remove();
    panelNavContextMenu = null;
  }

  function showPanelNavContextMenu(tabId, x, y) {
    hidePanelNavContextMenu();
    const menu = document.createElementNS(HTML_NS, 'div');
    menu.className = 'bento-panel-nav-menu';
    menu.setAttribute('role', 'menu');

    const removeBtn = document.createElementNS(HTML_NS, 'button');
    removeBtn.type = 'button';
    removeBtn.className = 'bento-panel-nav-menu__item';
    removeBtn.setAttribute('role', 'menuitem');
    removeBtn.textContent = 'Remove panel';
    removeBtn.addEventListener('click', () => removePanel(tabId));
    menu.appendChild(removeBtn);

    document.documentElement.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    const left = Math.max(0, Math.min(x, window.innerWidth - rect.width - 4));
    const top = Math.max(0, Math.min(y, window.innerHeight - rect.height - 4));
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    panelNavContextMenu = menu;
  }

  // Apply a preset width to a single side panel. Mirrors the inline
  // style writes that endPanelDrag produces during a drag so the
  // resize is instant — bento-tools intentionally does NOT broadcast
  // panels/sync after panel/setWidth (see protocol-handler.ts) to
  // avoid clobbering live drag layouts, so the persisted value only
  // re-applies on a future unrelated reconcile. Without the inline
  // write the panel would visually stay at its old width until then.
  // Flat layout also needs the same geometry refresh used during
  // splitter drags; otherwise neighbouring panels, overlay splitters,
  // and the strip scroll extent keep the old slot positions.
  function applyPanelWidth(panelEl, widthPx) {
    if (!panelEl) return;
    if (!Number.isFinite(widthPx) || widthPx <= 0) return;
    const targetPanelEl = getTopLevelSlotPanelElement(panelEl);
    const tabId = getTopLevelSlotTabId(panelEl);
    if (!targetPanelEl) return;
    if (!Number.isFinite(tabId)) return;
    const px = Math.round(widthPx);
    // One-shot transition for menu-driven (non-drag) resizes. Drag uses
    // pointermove which writes inline width every frame — a transition
    // there lags the cursor. Menu-driven resizes have no follow-along
    // pointer, so snapping reads as jarring; ease the change instead.
    // Same shape as the workspace-switch main-panel transition (see
    // reconcilePanels). Both run on the Mux reveal role, like the
    // workspace-switch tab-list slide, so simultaneous transitions feel
    // like one motion. The inline 'transition' is cleared once the motion
    // has finished (see below) so subsequent drags revert to instant.
    const reveal = 'var(--muxui-semantic-motion-reveal-transition)';
    targetPanelEl.style.transition =
      'width ' + reveal + ', min-width ' + reveal + ', flex-basis ' + reveal;
    targetPanelEl.style.width = px + 'px';
    targetPanelEl.style.minWidth = px + 'px';
    targetPanelEl.style.flex = '0 0 ' + px + 'px';
    const widthByTabId = new Map([[tabId, px]]);
    const layoutRefreshed = refreshFlatPanelLayoutFromLiveState({
      mainWidthPx: currentPanelLayoutGeometry?.mainRect?.width,
      widthByTabId,
    });
    if (!layoutRefreshed) {
      syncInterPanelSplitters();
      updateStripScrollbar();
    }
    // After the width transition: clear it, then re-sync the splitters and strip
    // extent against the settled geometry. Called after the width writes above, so
    // a zero-length transition (no motion) syncs against the final layout.
    afterMotion(
      targetPanelEl,
      'width',
      { properties: ['width', 'min-width', 'flex-basis'] },
      () => {
        targetPanelEl.style.removeProperty('transition');
        syncInterPanelSplitters();
        updateStripScrollbar();
      },
    );
    dispatchShellAction({ type: 'panel/setWidth', id: tabId, widthPx: px });
  }

  function setPanelHeaderHidden(panelEl, tabId, hidden) {
    if (!panelEl) return;
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return;
    if (hidden) {
      panelEl.setAttribute('data-bento-header-hidden', '1');
      currentHeaderHiddenTabIds.add(numericTabId);
    } else {
      panelEl.removeAttribute('data-bento-header-hidden');
      currentHeaderHiddenTabIds.delete(numericTabId);
    }
    dispatchShellAction({ type: 'panel/setHeaderHidden', id: numericTabId, hidden: !!hidden });
  }

  function applyActiveMarker(idx) {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list) return;
    const navIdx = getNavIndexForCycleIndex(idx);
    for (let i = 0; i < list.children.length; i++) {
      list.children[i].classList.toggle('bento-panel-nav__icon--active', i === navIdx);
    }
  }

  // Panel-itself focus indicator (inset ring). Auto-removed 1.5s after
  // the last nav action so it doesn't linger when the user stops
  // cycling. Each setActiveByIndex call resets the timer, so cycling
  // through several panels in quick succession keeps the ring visible.
  function applyPanelFocusIndicator(idx) {
    const targets = getPanelCycleTargets();
    for (const target of getPanelFocusIndicatorTargets()) {
      target.classList.remove('bento-panel--cycle-focused');
    }
    setPanelTrailerAddFocus(false);
    if (idx < 0 || idx >= targets.length) return;
    const target = targets[idx];
    target.classList.add('bento-panel--cycle-focused');
    const partner = getDevtoolsFocusPartnerElement(target);
    if (partner) partner.classList.add('bento-panel--cycle-focused');
    const isTrailer = target.id === 'bento-add-panel-trailer';
    if (isTrailer) setPanelTrailerAddFocus(true);
    if (panelFocusTimer) clearTimeout(panelFocusTimer);
    panelFocusTimer = setTimeout(() => {
      target.classList.remove('bento-panel--cycle-focused');
      partner?.classList?.remove('bento-panel--cycle-focused');
      if (isTrailer) setPanelTrailerAddFocus(false);
    }, 1500);
  }

  function applyFocusedPanelIndicator(panelEl) {
    const rawFocusedTabId = panelEl?.getAttribute?.('data-bento-panel-tab-id');
    const focusedTabId =
      rawFocusedTabId !== undefined && rawFocusedTabId !== null ? Number(rawFocusedTabId) : null;
    const nextFocusedTabId = Number.isInteger(focusedTabId) ? focusedTabId : null;
    if (currentFocusedPanelTabId !== nextFocusedTabId) {
      currentFocusedPanelTabId = nextFocusedTabId;
      dispatchShellAction({ type: 'panel/focusedChanged', tabId: nextFocusedTabId });
    }
    const targets = getPanelFocusIndicatorTargets();
    const partner = getDevtoolsFocusPartnerElement(panelEl);
    for (const target of targets) {
      target.classList.toggle('bento-panel--focused', target === panelEl || target === partner);
    }
  }

  function setActiveByIndex(idx) {
    currentActiveIdx = idx;
    applyActiveMarker(idx);
    applyPanelFocusIndicator(idx);
    const targets = getPanelCycleTargets();
    if (idx < 0 || idx >= targets.length) return;
    const target = targets[idx];
    const isTrailer = target.id === 'bento-add-panel-trailer';
    applyFocusedPanelIndicator(isTrailer ? null : target);
    // Panel target → focus the panel's <browser> content so the
    // page receives keys natively. Page-bound keyboard extensions
    // (Vimium j/k, Surfingkeys, etc.) only work when their content
    // document has DOM focus; before the BentoKey content actor
    // landed we focused the chrome notificationbox here instead,
    // which made panel cycling work but blocked all other page-bound
    // keys. Now the cycling shortcut is forwarded back to chrome via
    // the actor (see attachContentKeyBridgeListener), so we can keep
    // content-focused as the default.
    //
    // Add-trailer target → focus the outer vbox (NOT its inner
    // panel-trailer-frame iframe). The trailer hosts a moz-extension
    // iframe child since the saved-panels feature; if we focused that
    // iframe, the chrome-side keydown handler on the vbox wouldn't see
    // Enter and the cycle-Enter "create blank panel" UX would break.
    // Mouse hover/click on the iframe's React buttons still works
    // normally — those don't go through this focus path.
    try {
      const browserEl = isTrailer ? null : getPanelTargetBrowser(target);
      if (browserEl) {
        browserEl.focus({ preventScroll: true });
      } else {
        target.focus({ preventScroll: true });
      }
    } catch {
      /* focus best-effort; some browser elements may reject */
    }
  }

  function normalizeGroupedNavRows(rows) {
    return (
      Array.isArray(rows) && rows.length > 0
        ? rows
            .map((row) => (Array.isArray(row) ? row : []))
            .filter((row) => row.length > 0)
        : [[{ placeholder: true }]]
    );
  }

  function getGroupedNavFaviconSize(rows) {
    return rows.length > 1 || rows.some((row) => row.length > 1) ? 8 : 14;
  }

  function makeGroupedNavImage(url, faviconSize) {
    const img = document.createElementNS(HTML_NS, 'img');
    img.src = url || '';
    img.alt = '';
    img.style.width = faviconSize + 'px';
    img.style.height = faviconSize + 'px';
    img.style.borderRadius = '2px';
    img.style.objectFit = 'cover';
    img.addEventListener('error', () => {
      img.style.background = 'var(--neutral-30)';
      img.removeAttribute('src');
    });
    return img;
  }

  function makeGroupedNavDot(faviconSize) {
    const dot = document.createElementNS(HTML_NS, 'span');
    dot.style.width = faviconSize + 'px';
    dot.style.height = faviconSize + 'px';
    dot.style.borderRadius = '2px';
    dot.style.background = 'var(--neutral-30)';
    dot.style.display = 'block';
    return dot;
  }

  function setGroupedNavCellState(cellEl, discarded) {
    cellEl.classList.toggle('bento-nav-subdiv-cell--discarded', discarded === true);
  }

  function setGroupedNavCellContent(cellEl, favIconUrl, faviconSize) {
    if (favIconUrl === null) return;
    const existing = cellEl.firstElementChild;
    if (favIconUrl) {
      if (existing?.localName === 'img') {
        if (existing.src !== favIconUrl) existing.src = favIconUrl;
        existing.style.background = '';
        existing.style.width = faviconSize + 'px';
        existing.style.height = faviconSize + 'px';
        return;
      }
      cellEl.replaceChildren(makeGroupedNavImage(favIconUrl, faviconSize));
      return;
    }
    if (existing?.localName === 'span') return;
    cellEl.replaceChildren(makeGroupedNavDot(faviconSize));
  }

  function syncGroupedNavIcon(btn, rows, title) {
    btn.title = title || 'Panel group';
    btn.setAttribute('aria-label', btn.title);
    const safeRows = normalizeGroupedNavRows(rows);
    const faviconSize = getGroupedNavFaviconSize(safeRows);
    const rowEls = Array.from(btn.querySelectorAll(':scope > .bento-nav-subdiv-row'));
    if (rowEls.length !== safeRows.length) return false;
    for (let rowIndex = 0; rowIndex < safeRows.length; rowIndex++) {
      const row = safeRows[rowIndex];
      const cellEls = Array.from(rowEls[rowIndex].children);
      if (cellEls.length !== row.length) return false;
      for (let cellIndex = 0; cellIndex < row.length; cellIndex++) {
        setGroupedNavCellState(cellEls[cellIndex], row[cellIndex]?.discarded === true);
        const favIconUrl =
          row[cellIndex]?.favIconUrl === null ? null : row[cellIndex]?.favIconUrl || '';
        setGroupedNavCellContent(cellEls[cellIndex], favIconUrl, faviconSize);
      }
    }
    return true;
  }

  function renderGroupedNavIconRows(btn, rows) {
    const safeRows = normalizeGroupedNavRows(rows);
    const faviconSize = getGroupedNavFaviconSize(safeRows);

    for (const row of safeRows) {
      const rowEl = document.createElementNS(HTML_NS, 'span');
      rowEl.className = 'bento-nav-subdiv-row';
      for (const cell of row) {
        const cellEl = document.createElementNS(HTML_NS, 'span');
        setGroupedNavCellState(cellEl, cell?.discarded === true);
        cellEl.appendChild(
          cell?.favIconUrl
            ? makeGroupedNavImage(cell.favIconUrl, faviconSize)
            : makeGroupedNavDot(faviconSize),
        );
        rowEl.appendChild(cellEl);
      }
      btn.appendChild(rowEl);
    }
  }

  function buildGroupedNavIcon(rows, title, onClick, tabId, rootNodeId) {
    const btn = document.createElementNS(HTML_NS, 'button');
    btn.type = 'button';
    btn.className = 'bento-panel-nav__icon bento-panel-nav__icon--subdivided';
    btn.setAttribute('aria-label', title || 'Panel group');
    attachPanelNavigatorTooltip(btn);
    renderGroupedNavIconRows(btn, rows);

    btn.addEventListener('click', (e) => {
      if (btn._bentoSuppressClick) {
        btn._bentoSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick(e);
    });
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 0) e.preventDefault();
    });
    if (Number.isFinite(tabId)) {
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showPanelNavContextMenu(tabId, e.clientX, e.clientY);
      });
      setupNavDrag(btn, tabId, rootNodeId);
    }
    return btn;
  }

  function buildNavIcon(favIconUrl, title, onClick, tabId, rootNodeId) {
    const btn = document.createElementNS(HTML_NS, 'button');
    btn.type = 'button';
    btn.className = 'bento-panel-nav__icon';
    btn.setAttribute('aria-label', title);
    attachPanelNavigatorTooltip(btn);
    if (favIconUrl) {
      const img = document.createElementNS(HTML_NS, 'img');
      img.src = favIconUrl;
      img.alt = '';
      // If the favicon URL fails to load, fall back to the placeholder
      // dot so the user still sees a uniform-shaped marker for the
      // panel rather than an empty / broken-image button.
      img.addEventListener('error', () => {
        img.remove();
        btn.classList.add('bento-panel-nav__icon--placeholder');
      });
      btn.appendChild(img);
    } else {
      btn.classList.add('bento-panel-nav__icon--placeholder');
    }
    btn.addEventListener('click', (e) => {
      // Drag end synthesises a click on pointerup at the same target —
      // suppress it when a drag actually happened so we don't also
      // scroll-into-view + activate the panel under the released cursor.
      if (btn._bentoSuppressClick) {
        btn._bentoSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      onClick(e);
    });
    // Prevent left-click from moving DOM focus to the button. Without
    // this, the click sequence is: focus → button (mousedown), then
    // focus → panel content browser (setActiveByIndex). Two focus
    // transitions back-to-back cancel the in-progress smooth scroll
    // we kicked off via scrollPanelToLeftmost. Arrow-key cycling
    // doesn't hit this because focus was already in chrome — there's
    // only one focus shift (chrome → panel browser). preventDefault
    // on left mousedown keeps focus stable through the click; the
    // 'click' event still fires (preventDefault on mousedown only
    // suppresses the default focus-on-mousedown behaviour, not the
    // subsequent click event itself). */
    btn.addEventListener('mousedown', (e) => {
      if (e.button === 0) e.preventDefault();
    });
    if (Number.isFinite(tabId)) {
      btn.addEventListener('mousedown', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
      });
      btn.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        e.preventDefault();
        e.stopPropagation();
        removePanel(tabId);
      });
      btn.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showPanelNavContextMenu(tabId, e.clientX, e.clientY);
      });
      setupNavDrag(btn, tabId, rootNodeId);
    }
    return btn;
  }

  // ─── Navigator drag-to-reorder ───────────────────────────────────────
  // Side-panel favicon buttons can be dragged horizontally to reorder the
  // panel strip. The user said: "panels should reorder as soon as I let
  // go of the button for performance reasons" — so during the drag we
  // only paint visual state (source dim + drop indicator), and the actual
  // panel/reorder action fires once on pointerup. The reconciler then
  // FLIP-animates both the real panels and the favicon buttons into
  // their new slots.
  //
  // Pointer events + setPointerCapture so the drag survives the cursor
  // crossing into a panel's remote=true content browser (same constraint
  // splitter dragging already deals with).
  const NAV_DRAG_THRESHOLD_PX = 4;

  function setupNavDrag(btn, tabId, rootNodeId) {
    btn.dataset.bentoNavDraggable = '1';
    btn.dataset.bentoRootNodeId = rootNodeId || 'panel:' + tabId;

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let pointerId = null;
    let indicator = null;

    function getList() {
      return document.querySelector('.bento-panel-nav__list');
    }
    // Side-panel buttons in DOM order, excluding the main panel (always
    // index 0) and the drop indicator overlay.
    function getSidePanelButtons(list) {
      const out = [];
      for (let i = 1; i < list.children.length; i++) {
        const child = list.children[i];
        if (child === indicator) continue;
        if (child.classList && child.classList.contains('bento-panel-nav__icon')) {
          out.push(child);
        }
      }
      return out;
    }
    // targetSlot = number of non-source siblings whose midpoint X is to
    // the left of the cursor. Maps to splice index in the new ordering.
    function computeTargetSlot(list, clientX) {
      const siblings = getSidePanelButtons(list).filter((el) => el !== btn);
      let slot = 0;
      for (const sib of siblings) {
        const r = sib.getBoundingClientRect();
        if (clientX > r.left + r.width / 2) slot++;
        else break;
      }
      return slot;
    }
    // Position the indicator at the visual gap for `slot`. Computed in
    // list-local coords (offsetLeft chain) so horizontal scroll inside
    // the list is naturally accounted for. Indicator is absolutely
    // positioned so its presence doesn't reflow the strip.
    function placeIndicator(list, slot) {
      if (!indicator) {
        indicator = document.createElementNS(HTML_NS, 'div');
        indicator.className = 'bento-panel-nav__drop-indicator';
        list.appendChild(indicator);
      } else if (indicator.parentNode !== list) {
        list.appendChild(indicator);
      }
      const siblings = getSidePanelButtons(list).filter((el) => el !== btn);
      const listRect = list.getBoundingClientRect();
      let x;
      if (siblings.length === 0) {
        // Only the source panel exists — indicator at its current spot.
        const r = btn.getBoundingClientRect();
        x = r.left - listRect.left + list.scrollLeft;
      } else if (slot >= siblings.length) {
        const r = siblings[siblings.length - 1].getBoundingClientRect();
        x = r.right - listRect.left + list.scrollLeft;
      } else {
        const r = siblings[slot].getBoundingClientRect();
        x = r.left - listRect.left + list.scrollLeft;
      }
      // Center the 2px bar on the gap.
      const indicatorWidth = indicator.offsetWidth || 2;
      indicator.style.left = x - indicatorWidth / 2 + 'px';
    }
    function clearIndicator() {
      if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
    }

    function startDrag(list) {
      if (dragging) return;
      dragging = true;
      btn.classList.add('bento-panel-nav__icon--dragging');
      list.classList.add('bento-panel-nav__list--dragging');
      // Suppress the synthesised click on release so the drop doesn't
      // also scroll-and-activate the (unchanged) panel.
      btn._bentoSuppressClick = true;
      // Drag pre-empts the right-click menu / cycle marker for this btn.
      hidePanelNavContextMenu();
    }
    function endDrag(commit, finalClientX) {
      const list = getList();
      if (dragging && commit && list) {
        const slot = computeTargetSlot(list, finalClientX);
        const panels = getOrderedPanels();
        const currentIds = getPanelNavRootNodeIds();
        const sourceRootNodeId = rootNodeId || 'panel:' + tabId;
        const filtered = currentIds.filter((id) => id !== sourceRootNodeId);
        const clampedSlot = Math.max(0, Math.min(slot, filtered.length));
        filtered.splice(clampedSlot, 0, sourceRootNodeId);
        const changed =
          filtered.length !== currentIds.length || filtered.some((id, i) => currentIds[i] !== id);
        if (changed) {
          const panelSnap = new Map();
          for (const panel of panels) {
            const id = Number(panel.dataset.bentoPanelTabId);
            if (!Number.isFinite(id)) continue;
            panelSnap.set(id, panel.getBoundingClientRect());
          }
          __bentoPendingFlip = panelSnap;

          const navSnap = new Map();
          for (const child of Array.from(list.children)) {
            if (!child.classList?.contains('bento-panel-nav__icon')) continue;
            if (child.dataset.bentoNavLeaving === '1') continue;
            const key = child.dataset.bentoNavKey;
            if (key) navSnap.set(key, child.getBoundingClientRect());
          }
          __bentoPendingNavFlip = navSnap;

          dispatchShellAction({ type: 'panelLayout/reorderRoot', rootNodeIds: filtered });
        }
      }
      if (list) list.classList.remove('bento-panel-nav__list--dragging');
      btn.classList.remove('bento-panel-nav__icon--dragging');
      clearIndicator();
      dragging = false;
      pointerId = null;
    }

    btn.addEventListener('pointerdown', (e) => {
      // Left button only; right-click / middle-click already have other
      // handlers (context menu / close).
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      try {
        btn.setPointerCapture(e.pointerId);
      } catch {
        /* setPointerCapture can throw on some pointer types — drag will
           still work, just won't survive cursor crossing remote content. */
      }
    });

    btn.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      if (!dragging) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (dx * dx + dy * dy < NAV_DRAG_THRESHOLD_PX * NAV_DRAG_THRESHOLD_PX) return;
        const list = getList();
        if (!list) return;
        startDrag(list);
      }
      const list = getList();
      if (!list) return;
      placeIndicator(list, computeTargetSlot(list, e.clientX));
    });

    function release(e, commit) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      try {
        btn.releasePointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      endDrag(commit, e.clientX);
    }
    btn.addEventListener('pointerup', (e) => release(e, true));
    btn.addEventListener('pointercancel', (e) => release(e, false));
    btn.addEventListener('lostpointercapture', (e) => release(e, dragging));
  }

  // Drag-to-reorder via a dedicated grip handle on the per-panel
  // header. The handle (createPanelHeader's leftmost child) is
  // the only pointerdown target that initiates a drag — the rest
  // of the header still routes to its native controls. Skips
  // the main slot (main stays col 0).
  //
  // During drag the panel container follows the cursor via
  // transform: translateX so the user gets immediate physical
  // feedback. On release the panel CSS-transitions back to its
  // settled spot (transform: 0); if the slot changed, the
  // panel/reorder dispatch updates layout in the same frame.
  function setupHeaderDrag(header, panelEl, tabId) {
    if (!Number.isFinite(tabId) || !panelEl) return;
    if (panelEl.dataset.bentoMainPanel === '1') return;
    const handle = header.querySelector('.bento-panel-header-drag-handle');
    if (!handle) return;

    let startX = 0;
    let startY = 0;
    let dragging = false;
    let pointerId = null;
    let indicator = null;
    let dragDropTargets = null;
    let dragHorizontalDropTargets = null;
    let dragChooserDropTargets = null;
    let dragMainDropEntry = null;
    const sourceIsDevtoolsPanel = panelEl.hasAttribute('data-bento-devtools-for');

    function getStripContainer() {
      return document.getElementById('bento-side-panel-host');
    }
    // All split-view panels in visual order including main.
    function getPanels() {
      return getOrderedPanels();
    }
    function getMainDropEntry() {
      const host = getStripContainer();
      const tabpanels = window.gBrowser?.tabpanels;
      const hostLocal = currentPanelLayoutGeometry?.mainRect
        ? viewportRectForLayoutRect(tabpanels, currentPanelLayoutGeometry.mainRect)
        : null;
      if (host && hostLocal) {
        const hostRect = host.getBoundingClientRect();
        return {
          rect: {
            left: hostRect.left + hostLocal.left,
            top: hostRect.top + hostLocal.top,
            right: hostRect.left + hostLocal.left + hostLocal.width,
            bottom: hostRect.top + hostLocal.top + hostLocal.height,
            width: hostLocal.width,
            height: hostLocal.height,
          },
        };
      }
      const main = getPanels().find((p) => p.dataset.bentoMainPanel === '1');
      const rect = main?.getBoundingClientRect?.();
      return rect ? { rect } : null;
    }
    function cloneLayoutNode(node) {
      if (!node) return null;
      if (node.kind === 'panel') return { kind: 'panel', tabId: Number(node.tabId) };
      if (node.kind === 'chooser') {
        return { kind: 'chooser', id: node.id, ownerTabId: Number(node.ownerTabId) };
      }
      if (node.kind === 'group') {
        return {
          kind: 'group',
          axis: node.axis,
          id: node.id,
          ratio: node.ratio,
          children: (node.children || []).map(cloneLayoutNode),
        };
      }
      return null;
    }
    function clonePanelLayoutForDrag(layout) {
      return { root: (layout?.root || []).map(cloneLayoutNode).filter(Boolean) };
    }
    function horizontalCapableRemoval(node, sourceTabId) {
      if (node?.kind === 'panel') {
        return Number(node.tabId) === sourceTabId
          ? { changed: true, node: null }
          : { changed: false, node };
      }
      if (node?.kind !== 'group' || node.axis !== 'horizontal') {
        return { changed: false, node };
      }
      const [left, right] = node.children || [];
      if (Number(left?.tabId) === sourceTabId) return { changed: true, node: right || null };
      if (Number(right?.tabId) === sourceTabId) return { changed: true, node: left || null };
      return { changed: false, node };
    }
    function topLayoutNodeToRootNodes(node) {
      if (!node) return [];
      if (node.kind === 'panel') return [node];
      if (node.kind === 'group' && node.axis === 'horizontal') return (node.children || []).slice();
      return [];
    }
    function bottomLayoutNodeToRootNodes(node) {
      if (!node || node.kind === 'chooser') return [];
      if (node.kind === 'panel') return [node];
      if (node.kind === 'group' && node.axis === 'horizontal') return (node.children || []).slice();
      return [];
    }
    function removePanelFromLayoutRoot(node, sourceTabId) {
      if (node?.kind === 'panel') {
        return Number(node.tabId) === sourceTabId
          ? { changed: true, nodes: [] }
          : { changed: false, nodes: [node] };
      }
      if (node?.kind !== 'group' || node.axis !== 'vertical') {
        return { changed: false, nodes: node ? [node] : [] };
      }
      const [top, bottom] = node.children || [];
      const topRemoval = horizontalCapableRemoval(top, sourceTabId);
      if (topRemoval.changed) {
        if (!topRemoval.node) return { changed: true, nodes: bottomLayoutNodeToRootNodes(bottom) };
        node.children[0] = topRemoval.node;
        return { changed: true, nodes: [node] };
      }
      if (bottom?.kind === 'panel') {
        if (Number(bottom.tabId) !== sourceTabId) return { changed: false, nodes: [node] };
        return { changed: true, nodes: topLayoutNodeToRootNodes(top) };
      }
      if (bottom?.kind !== 'group' || bottom.axis !== 'horizontal') {
        return { changed: false, nodes: [node] };
      }
      const [left, right] = bottom.children || [];
      if (Number(left?.tabId) === sourceTabId) {
        node.children[1] = right;
        return { changed: true, nodes: [node] };
      }
      if (Number(right?.tabId) === sourceTabId) {
        node.children[1] = left;
        return { changed: true, nodes: [node] };
      }
      return { changed: false, nodes: [node] };
    }
    function removePanelFromDragLayout(layout, sourceTabId) {
      const nextRoot = [];
      let changed = false;
      for (const node of layout?.root || []) {
        const replacement = removePanelFromLayoutRoot(node, sourceTabId);
        if (replacement.changed) changed = true;
        nextRoot.push(...replacement.nodes);
      }
      if (!changed) return false;
      layout.root = nextRoot;
      return true;
    }
    function getPostRemovalDragLayout() {
      const layout = clonePanelLayoutForDrag(currentPanelLayout);
      if (!removePanelFromDragLayout(layout, Number(tabId))) return null;
      return layout;
    }
    function getDragGeometryForLayout(layout) {
      const tabpanels = window.gBrowser?.tabpanels;
      if (!tabpanels || !layout) return null;
      return computePanelLayoutGeometry(layout, __lastPanelsPayload, tabpanels, {
        preferLivePanelWidths: true,
        mainWidthPx: currentPanelLayoutGeometry?.mainRect?.width,
      });
    }
    function getRootDropEntriesForLayout(layout, geometry) {
      if (!layout || !geometry) return [];
      return (layout.root || [])
        .map((node) => {
          const rootNodeId =
            node?.kind === 'panel' ? 'panel:' + Number(node.tabId) : node?.id || null;
          const rect = rootNodeId
            ? viewportRectForLocalLayoutRect(geometry.rootRects?.get(rootNodeId))
            : null;
          return rootNodeId && rect ? { rootNodeId, rect } : null;
        })
        .filter(Boolean);
    }
    function getVerticalGroupIdsForLayout(layout) {
      const ids = new Set();
      for (const node of layout?.root || []) {
        if (node?.kind === 'group' && node.axis === 'vertical' && node.id) ids.add(node.id);
      }
      return ids;
    }
    function getChooserIdsForLayout(layout) {
      const ids = new Set();
      for (const node of layout?.root || []) {
        if (node?.kind !== 'group' || node.axis !== 'vertical') continue;
        const bottom = node.children?.[1];
        if (bottom?.kind === 'chooser' && bottom.id) ids.add(bottom.id);
      }
      return ids;
    }
    function getHorizontalDropEntriesForCurrentLayout(allowedGroupIds) {
      if (!currentPanelLayoutGeometry) return [];
      const out = [];
      const sourceTabId = Number(tabId);
      for (const node of currentPanelLayout?.root || []) {
        if (node?.kind !== 'group' || node.axis !== 'vertical') continue;
        if (allowedGroupIds && !allowedGroupIds.has(node.id)) continue;
        const addPanelRowTarget = (row, panelNode) => {
          const rect = viewportRectForLocalLayoutRect(
            currentPanelLayoutGeometry.panelRects?.get(Number(panelNode?.tabId)),
          );
          if (rect) out.push({ groupId: node.id, row, rect });
        };
        const addRowTarget = (row, child) => {
          if (child?.kind === 'panel') {
            addPanelRowTarget(row, child);
            return;
          }
          if (child?.kind !== 'group' || child.axis !== 'horizontal') return;
          const children = child.children || [];
          const sourceIndex = children.findIndex((panel) => Number(panel?.tabId) === sourceTabId);
          if (sourceIndex < 0) return;
          const survivor = children[sourceIndex === 0 ? 1 : 0];
          if (survivor) addPanelRowTarget(row, survivor);
        };
        addRowTarget('top', node.children?.[0]);
        addRowTarget('bottom', node.children?.[1]);
      }
      return out;
    }
    function getChooserDropEntriesForCurrentLayout(allowedChooserIds) {
      const out = [];
      const allowed = allowedChooserIds instanceof Set ? allowedChooserIds : null;
      const addEntry = (chooserId, rect) => {
        if (!chooserId || (allowed && !allowed.has(chooserId)) || !rect) return;
        out.push({ chooserId, rect });
      };
      for (const chooserInfo of currentPanelLayoutGeometry?.choosers || []) {
        addEntry(chooserInfo.id, viewportRectForLocalLayoutRect(chooserInfo.rect));
      }
      if (out.length > 0) return out;
      const host = getStripContainer();
      if (!host) return out;
      for (const chooser of host.querySelectorAll(':scope > .bento-layout-chooser')) {
        addEntry(
          chooser._bentoChooserId || chooser.dataset?.bentoChooserId,
          chooser.getBoundingClientRect(),
        );
      }
      return out;
    }
    // Root panels (excluding main) in visual order after removing the
    // dragged source leaf. Computing this from a cloned layout lets
    // sub/split-panel drags break one leaf out of a group instead of
    // treating the whole vertical group as the source.
    function getCollapsedDropTargets() {
      const layout = getPostRemovalDragLayout();
      const geometry = getDragGeometryForLayout(layout);
      return getRootDropEntriesForLayout(layout, geometry);
    }
    function getActiveDropTargets() {
      return dragDropTargets || getCollapsedDropTargets();
    }
    function getActiveHorizontalDropTargets() {
      if (dragHorizontalDropTargets) return dragHorizontalDropTargets;
      const layout = getPostRemovalDragLayout();
      return getHorizontalDropEntriesForCurrentLayout(getVerticalGroupIdsForLayout(layout));
    }
    function getActiveChooserDropTargets() {
      if (dragChooserDropTargets) return dragChooserDropTargets;
      const layout = getPostRemovalDragLayout();
      return getChooserDropEntriesForCurrentLayout(getChooserIdsForLayout(layout));
    }
    function getActiveMainDropEntry() {
      return dragMainDropEntry || getMainDropEntry();
    }
    function captureDragDropGeometry() {
      const layout = getPostRemovalDragLayout();
      const geometry = getDragGeometryForLayout(layout);
      dragDropTargets = getRootDropEntriesForLayout(layout, geometry);
      dragHorizontalDropTargets = sourceIsDevtoolsPanel
        ? []
        : getHorizontalDropEntriesForCurrentLayout(getVerticalGroupIdsForLayout(layout));
      dragChooserDropTargets = sourceIsDevtoolsPanel
        ? []
        : getChooserDropEntriesForCurrentLayout(getChooserIdsForLayout(layout));
      dragMainDropEntry = getMainDropEntry();
    }
    function clearDragDropGeometry() {
      dragDropTargets = null;
      dragHorizontalDropTargets = null;
      dragChooserDropTargets = null;
      dragMainDropEntry = null;
    }
    function settleActiveHeaderDragTransforms() {
      const panels = getPanels();
      let changed = false;
      for (const p of panels) {
        const transition = p?.style?.transition || '';
        const transform = p?.style?.transform || '';
        if (!transform && !transition.includes('transform')) continue;
        cancelMotion(p, 'flip');
        p.style.transition = 'none';
        p.style.transform = '';
        if (p !== panelEl) p.style.zIndex = '';
        changed = true;
      }
      if (!changed) return;
      void window.gBrowser?.tabpanels?.offsetWidth;
      for (const p of panels) {
        if (p !== panelEl && p.style.transition === 'none') {
          p.style.removeProperty('transition');
        }
      }
    }
    function findPanelLocationInLayout(layout, sourceTabId) {
      for (let rootIndex = 0; rootIndex < (layout?.root || []).length; rootIndex++) {
        const root = layout.root[rootIndex];
        if (root?.kind === 'panel') {
          if (Number(root.tabId) === sourceTabId) {
            return { rootIndex, rootNodeId: 'panel:' + root.tabId };
          }
          continue;
        }
        if (root?.kind !== 'group' || root.axis !== 'vertical') continue;
        const rootNodeId = root.id;
        const top = root.children?.[0];
        if (top?.kind === 'panel' && Number(top.tabId) === sourceTabId) {
          return { rootIndex, rootNodeId, row: 'top', horizontalIndex: null };
        }
        if (top?.kind === 'group' && top.axis === 'horizontal') {
          for (let i = 0; i < (top.children || []).length; i++) {
            if (Number(top.children[i]?.tabId) === sourceTabId) {
              return { rootIndex, rootNodeId, row: 'top', horizontalIndex: i };
            }
          }
        }
        const bottom = root.children?.[1];
        if (bottom?.kind === 'panel' && Number(bottom.tabId) === sourceTabId) {
          return { rootIndex, rootNodeId, row: 'bottom', horizontalIndex: null };
        }
        if (bottom?.kind === 'group' && bottom.axis === 'horizontal') {
          for (let i = 0; i < (bottom.children || []).length; i++) {
            if (Number(bottom.children[i]?.tabId) === sourceTabId) {
              return { rootIndex, rootNodeId, row: 'bottom', horizontalIndex: i };
            }
          }
        }
      }
      return null;
    }
    function isNoopRootMove(index) {
      const source = findPanelLocationInLayout(currentPanelLayout, Number(tabId));
      return source && source.rootNodeId === 'panel:' + tabId && source.rootIndex === index;
    }
    function isNoopHorizontalMove(target) {
      const source = findPanelLocationInLayout(currentPanelLayout, Number(tabId));
      if (!source || source.rootNodeId !== target.groupId || source.row !== target.row) {
        return false;
      }
      if (!Number.isInteger(source.horizontalIndex)) return false;
      return (
        (source.horizontalIndex === 0 && target.position === 'before') ||
        (source.horizontalIndex === 1 && target.position === 'after')
      );
    }
    function getChooserDropTarget(clientX, clientY) {
      for (const target of getActiveChooserDropTargets()) {
        const r = target.rect;
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
          continue;
        }
        return {
          kind: 'chooser',
          target: { type: 'chooser', chooserId: target.chooserId },
          rect: r,
        };
      }
      return null;
    }
    function getHorizontalDropTarget(clientX, clientY) {
      for (const target of getActiveHorizontalDropTargets()) {
        const r = target.rect;
        if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) {
          continue;
        }
        return {
          kind: 'horizontal',
          target: {
            type: 'horizontal',
            groupId: target.groupId,
            row: target.row,
            position: clientX < r.left + r.width / 2 ? 'before' : 'after',
          },
          rect: r,
        };
      }
      return null;
    }
    // targetSlot = number of post-removal root slots whose midpoint
    // is to the left of the pointer. Maps to splice index in the
    // post-move root-panel array. Use the pointer rather than the
    // dragged panel's centre so the target zones do not scale with
    // the width of the panel being dragged.
    function computeTargetSlot(pointerX) {
      const targets = getActiveDropTargets();
      let slot = 0;
      for (const t of targets) {
        const r = t.rect;
        if (pointerX > r.left + r.width / 2) slot++;
        else break;
      }
      return slot;
    }
    function computeDropTarget(clientX, clientY) {
      if (!sourceIsDevtoolsPanel) {
        const chooser = getChooserDropTarget(clientX, clientY);
        if (chooser) return chooser;
        const horizontal = getHorizontalDropTarget(clientX, clientY);
        if (horizontal) return horizontal;
      }
      const targets = getActiveDropTargets();
      const slot = Math.max(0, Math.min(computeTargetSlot(clientX), targets.length));
      return { kind: 'root', target: { type: 'root', index: slot }, slot };
    }
    // Position a drop indicator in #bento-side-panel-host using the
    // same absolute overlay coordinate space as layout splitters.
    function placeIndicator(drop) {
      const host = getStripContainer();
      if (!host) return;
      if (!indicator) {
        indicator = document.createElementNS(HTML_NS, 'div');
        indicator.className = 'bento-panel-drop-indicator';
        host.appendChild(indicator);
      }
      const hostRect = host.getBoundingClientRect();
      indicator.style.position = 'absolute';
      indicator.style.zIndex = '6';
      if (drop?.kind === 'chooser') {
        const r = drop.rect;
        indicator.style.top = Math.max(0, r.top - hostRect.top) + 'px';
        indicator.style.bottom = Math.max(0, hostRect.height - (r.bottom - hostRect.top)) + 'px';
        indicator.style.left = Math.max(0, r.left - hostRect.left) + 'px';
        indicator.style.width = Math.max(0, r.width) + 'px';
        indicator.style.border = '2px solid var(--color-60)';
        indicator.style.borderRadius = 'var(--radius-s)';
        indicator.style.boxSizing = 'border-box';
        indicator.style.backgroundColor = 'color-mix(in srgb, var(--color-60) 12%, transparent)';
        return;
      }
      indicator.style.removeProperty('border');
      indicator.style.removeProperty('box-sizing');
      indicator.style.removeProperty('background-color');
      indicator.style.borderRadius = '1.5px';
      let x;
      let top = 0;
      let bottom = hostRect.height;
      if (drop?.kind === 'horizontal') {
        const r = drop.rect;
        x = (drop.target.position === 'before' ? r.left : r.right) - hostRect.left;
        top = r.top - hostRect.top;
        bottom = r.bottom - hostRect.top;
      } else {
        const targets = getActiveDropTargets();
        const main = getActiveMainDropEntry();
        const slot = drop?.slot || 0;
        if (targets.length === 0 && main) {
          // Only main + dragged source — drop spot is just after main.
          x = main.rect.right - hostRect.left;
        } else if (targets.length === 0) {
          return;
        } else if (slot >= targets.length) {
          const r = targets[targets.length - 1].rect;
          x = r.right - hostRect.left;
        } else if (slot === 0) {
          // Drop before the first side panel — between main and it.
          const r = targets[0].rect;
          x = r.left - hostRect.left;
        } else {
          const r = targets[slot].rect;
          x = r.left - hostRect.left;
        }
      }
      const indicatorWidth = 3;
      indicator.style.top = Math.max(0, top) + 'px';
      indicator.style.bottom = Math.max(0, hostRect.height - bottom) + 'px';
      indicator.style.left = x - indicatorWidth / 2 + 'px';
      indicator.style.width = indicatorWidth + 'px';
    }
    function clearIndicator() {
      if (indicator?.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
    }

    function startDrag() {
      if (dragging) return;
      dragging = true;
      settleActiveHeaderDragTransforms();
      handle.classList.add('bento-panel-header-drag-handle--dragging');
      panelEl.classList.add('bento-panel--dragging');
      // Hide all inter-panel splitters for the duration of the
      // drag. Their absolute-positioned overlays are anchored to
      // panel rects via syncInterPanelSplitters, but during the
      // drag the panel transforms (translate) without firing the
      // ResizeObserver — splitters end up partially out of sync
      // and visually trail. Cleanest is to skip them entirely;
      // they re-sync (and re-appear) when the reconciler settles
      // the post-drop layout.
      const host = document.getElementById('bento-side-panel-host');
      if (host) host.classList.add('bento-side-panel-host--reordering');
      // No transition while the user is actively dragging — the
      // transform should stick to the cursor 1:1. The release
      // handler re-enables it before resetting transform so the
      // snap-back / settle is animated.
      cancelMotion(panelEl, 'flip');
      panelEl.style.transition = 'none';
      panelEl.style.zIndex = '10';
      hidePanelNavContextMenu();
      document.documentElement.style.setProperty('cursor', 'grabbing', 'important');
      document.documentElement.style.setProperty('user-select', 'none', 'important');
    }
    function followCursor(clientX) {
      const dx = clientX - startX;
      panelEl.style.transform = 'translateX(' + dx + 'px)';
    }
    function endDrag(commit, finalClientX, finalClientY) {
      let dispatched = false;
      if (dragging && commit) {
        const drop = computeDropTarget(finalClientX, finalClientY);
        const sidePanelEls = getPanels().filter((p) => p.dataset.bentoPanelTabId);
        const changed =
          drop.kind === 'horizontal'
            ? !isNoopHorizontalMove(drop.target)
            : drop.kind === 'root'
            ? !isNoopRootMove(drop.target.index)
            : true;
        if (changed) {
          // Snapshot every visible side panel's pre-reorder rect.
          // The reconciler that runs after panels/sync arrives will
          // read this via runPendingPanelFlip and animate every
          // panel (including the dragged one) from its old screen
          // position to its new slot.
          //
          // For the DRAGGED panel we record the cursor's release
          // X instead of the layout left edge: the panel is
          // currently displayed at cursorX (transform follows
          // cursor), so the FLIP needs to use that as its
          // "old position" anchor. Without this the dragged panel
          // visually snaps back to its source slot for one frame
          // before re-appearing at its destination.
          const snap = new Map();
          for (const p of sidePanelEls) {
            const id = Number(p.dataset.bentoPanelTabId);
            if (!Number.isFinite(id)) continue;
            if (id === tabId) {
              // Use the dragged panel's CURRENT painted rect —
              // includes the live drag transform — so the FLIP
              // can compute newRect.left - paintedLeft to
              // counter-translate.
              snap.set(id, p.getBoundingClientRect());
            } else {
              // Non-dragged panels are at their layout positions.
              snap.set(id, p.getBoundingClientRect());
            }
          }
          snap.__draggedTabId = tabId;
          __bentoPendingFlip = snap;
          dispatchShellAction({ type: 'panelLayout/movePanel', tabId, target: drop.target });
          dispatched = true;
          // Don't clear the dragged panel's transform yet — the
          // FLIP runner will replace it with a counter-transform
          // matching the post-reorder layout, then transition
          // to translate(0). Clearing it now would animate the
          // panel back to its OLD slot for the brief window
          // before the reconciler runs, which is the bug we're
          // fixing.
        }
      }
      // Snap-back path: no commit OR no actual reorder. Animate
      // the dragged panel back to its original slot.
      if (dragging && !dispatched) {
        panelEl.style.transition = 'transform var(--muxui-semantic-motion-reveal-transition)';
        panelEl.style.transform = '';
        afterMotion(panelEl, 'flip', { properties: ['transform'] }, () => {
          panelEl.style.transition = '';
          panelEl.style.zIndex = '';
        });
      }
      handle.classList.remove('bento-panel-header-drag-handle--dragging');
      panelEl.classList.remove('bento-panel--dragging');
      const host = document.getElementById('bento-side-panel-host');
      if (host) host.classList.remove('bento-side-panel-host--reordering');
      // Splitters were hidden during the drag; immediately re-sync
      // their positions so they re-appear at the post-drop layout
      // boundaries without waiting for the ResizeObserver tick.
      try {
        syncInterPanelSplitters();
      } catch (err) {
        console.warn('[bento-shell-mount] post-drop splitter sync failed:', err);
      }
      clearIndicator();
      document.documentElement.style.removeProperty('cursor');
      document.documentElement.style.removeProperty('user-select');
      dragging = false;
      pointerId = null;
      clearDragDropGeometry();
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      captureDragDropGeometry();
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* best-effort capture */
      }
      e.preventDefault();
      e.stopPropagation();
    });

    handle.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;
      if (!dragging) {
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (dx * dx + dy * dy < NAV_DRAG_THRESHOLD_PX * NAV_DRAG_THRESHOLD_PX) return;
        startDrag();
      }
      followCursor(e.clientX);
      placeIndicator(computeDropTarget(e.clientX, e.clientY));
    });

    function release(e, commit) {
      if (pointerId === null || e.pointerId !== pointerId) return;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch {
        /* best-effort */
      }
      endDrag(commit, e.clientX, e.clientY);
    }
    handle.addEventListener('pointerup', (e) => release(e, true));
    handle.addEventListener('pointercancel', (e) => release(e, false));
    handle.addEventListener('lostpointercapture', (e) => release(e, dragging));
  }

  function refreshPanelNavMain() {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list || list.children.length === 0) return;
    const mainBtn = list.children[0];
    const fav = getStableMainNavFavicon(mainBtn);
    if (fav !== null) refreshNavIconImage(mainBtn, fav);
    syncPanelNavAudioParticles(mainBtn, isMainTabAudioPlaying());
  }

  function isMainTabAudioPlaying() {
    try {
      const tab = window.gBrowser?.selectedTab;
      return (
        tab?.hasAttribute?.('soundplaying') === true && tab?.hasAttribute?.('muted') !== true
      );
    } catch {
      return false;
    }
  }

  function refreshPanelNavFromTabAttr(tab) {
    const tabId = getBentoTabId(tab);
    if (!Number.isFinite(tabId)) return false;
    if (!Array.isArray(__lastPanelsPayload) || __lastPanelsPayload.length === 0) return false;
    let favIconUrl = '';
    try {
      favIconUrl = tab?.image || tab?.getAttribute?.('image') || '';
    } catch {
      favIconUrl = '';
    }
    let title = '';
    try {
      title = tab?.label || tab?.getAttribute?.('label') || '';
    } catch {
      title = '';
    }
    let changed = false;
    for (const panel of __lastPanelsPayload) {
      if (Number(panel?.tabId) !== tabId) continue;
      const retainExistingFavicon = !favIconUrl && panel.favIconUrl && isTabStillLoading(tab);
      if (!retainExistingFavicon && (panel.favIconUrl || '') !== favIconUrl) {
        panel.favIconUrl = favIconUrl;
        changed = true;
      }
      if (title && panel.title !== title) {
        panel.title = title;
        changed = true;
      }
    }
    if (!changed) return false;
    refreshPanelNav(__lastPanelsPayload);
    return true;
  }

  function refreshPanelNavOnTabAttrModified(event) {
    const tab = event?.target;
    if (isSelectedBrowserTab(tab)) refreshPanelNavMain();
    refreshPanelNavFromTabAttr(tab);
  }

  function isTabStillLoading(tab) {
    if (!tab) return false;
    try {
      if (tab.hasAttribute?.('busy')) return true;
    } catch {
      // Fall through.
    }
    try {
      if (tab.linkedBrowser?.webProgress?.isLoadingDocument) return true;
    } catch {
      // Fall through.
    }
    return false;
  }

  function getTrackedTabForPanelNav(tabId) {
    return getTrackedTabById(getBentoTabTracker(), Number(tabId));
  }

  function getStablePanelNavFavicon(tabId, incomingFavIconUrl, btn) {
    if (incomingFavIconUrl) return incomingFavIconUrl;
    if (!btn?.querySelector?.('img')) return '';
    const tab = getTrackedTabForPanelNav(tabId);
    return isTabStillLoading(tab) ? null : '';
  }

  function getStableMainNavFavicon(btn) {
    const favIconUrl = getMainTabFavicon();
    if (favIconUrl) return favIconUrl;
    if (!btn?.querySelector?.('img')) return '';
    return isTabStillLoading(window.gBrowser?.selectedTab) ? null : '';
  }

  function getLayoutRootNodeId(node) {
    if (node?.kind === 'panel') return 'panel:' + node.tabId;
    if (node?.kind === 'group' && node.axis === 'vertical') return node.id || null;
    return null;
  }

  function getLayoutRootNodeForNav(rootNodeId) {
    if (!rootNodeId) return null;
    for (const node of currentPanelLayout?.root || []) {
      if (getLayoutRootNodeId(node) === rootNodeId) return node;
    }
    return null;
  }

  function getPanelPayloadByTabIdForNav(panels) {
    const out = new Map();
    for (const panel of panels || []) {
      const tabId = Number(panel?.tabId);
      if (!Number.isFinite(tabId) || out.has(tabId)) continue;
      out.set(tabId, panel);
    }
    return out;
  }

  function getPanelNavCell(panelNode, payloadByTabId) {
    if (panelNode?.kind !== 'panel') return null;
    const tabId = Number(panelNode.tabId);
    if (!Number.isFinite(tabId)) return null;
    const payload = payloadByTabId.get(tabId);
    return {
      tabId,
      title: payload?.title || 'Panel',
      favIconUrl: payload?.favIconUrl || '',
      discarded: payload?.discarded === true,
      audioPlaying: payload?.audible === true && payload?.muted !== true,
    };
  }

  function getPanelNavRowForLayoutNode(node, payloadByTabId) {
    if (node?.kind === 'panel') {
      const cell = getPanelNavCell(node, payloadByTabId);
      return cell ? [cell] : [];
    }
    if (node?.kind === 'group' && node.axis === 'horizontal') {
      return (node.children || [])
        .map((child) => getPanelNavCell(child, payloadByTabId))
        .filter(Boolean);
    }
    if (node?.kind === 'chooser') {
      return [{ placeholder: true }];
    }
    return [];
  }

  function getPanelNavInfo(panelPayload, payloadByTabId) {
    const fallbackTabId = Number(panelPayload?.tabId);
    const fallbackCell = {
      tabId: fallbackTabId,
      title: panelPayload?.title || 'Panel',
      favIconUrl: panelPayload?.favIconUrl || '',
      discarded: panelPayload?.discarded === true,
      audioPlaying: panelPayload?.audible === true && panelPayload?.muted !== true,
    };
    const rootNodeId = panelPayload?.rootNodeId || 'panel:' + fallbackTabId;
    const rootNode = getLayoutRootNodeForNav(rootNodeId);
    if (rootNode?.kind !== 'group' || rootNode.axis !== 'vertical') {
      return {
        rootNodeId,
        tabId: fallbackTabId,
        title: fallbackCell.title,
        favIconUrl: fallbackCell.favIconUrl,
        discarded: fallbackCell.discarded,
        audioPlaying: fallbackCell.audioPlaying,
        rows: [[fallbackCell]],
        isGrouped: false,
      };
    }

    const rows = [
      getPanelNavRowForLayoutNode(rootNode.children?.[0], payloadByTabId),
      getPanelNavRowForLayoutNode(rootNode.children?.[1], payloadByTabId),
    ].filter((row) => row.length > 0);
    const firstPanelCell = rows.flat().find((cell) => Number.isFinite(cell?.tabId)) || fallbackCell;
    return {
      rootNodeId,
      tabId: Number(firstPanelCell.tabId),
      title: firstPanelCell.title || fallbackCell.title,
      favIconUrl: firstPanelCell.favIconUrl || fallbackCell.favIconUrl,
      discarded: rows.flat().some((cell) => cell?.discarded === true),
      audioPlaying: rows.flat().some((cell) => cell?.audioPlaying === true),
      rows: rows.length > 0 ? rows : [[fallbackCell]],
      isGrouped: rows.length > 1 || rows.some((row) => row.length > 1),
    };
  }

  function syncPanelNavDiscardedClass(btn, navInfo) {
    btn.classList.toggle('bento-panel-nav__icon--discarded', navInfo?.discarded === true);
  }

  function syncPanelNavAudioClass(btn, navInfo) {
    syncPanelNavAudioParticles(btn, navInfo?.audioPlaying === true);
  }

  function getPanelNavSignature(panelPayload, payloadByTabId) {
    const info = getPanelNavInfo(panelPayload, payloadByTabId);
    if (!info.isGrouped) {
      return ['panel', info.tabId].join(':');
    }
    const rowSig = info.rows
      .map((row) =>
        row
          .map((cell) =>
            [
              Number.isFinite(cell?.tabId) ? cell.tabId : 'placeholder',
            ].join('@'),
          )
          .join(','),
      )
      .join('|');
    return ['grouped', info.rootNodeId, rowSig].join(':');
  }

  // Puts `nodes` in order inside `list`, moving only those out of place. A node that is removed
  // and inserted again drops its running transitions, so appending every node on each reconcile
  // cut a mode flip's colour fade short (the BENTO_PANELS payload that follows the direct event
  // lands inside the fade's lead) and the node jumped to its new colours. Anything else in the
  // list (the navigator's absolutely positioned drop indicator) stays where it is.
  function placeInOrder(list, nodes) {
    const next = (node) => {
      let sibling = node.nextElementSibling;
      while (sibling && !nodes.includes(sibling)) sibling = sibling.nextElementSibling;
      return sibling;
    };
    let cursor = Array.from(list.children).find((child) => nodes.includes(child)) || null;
    for (const node of nodes) {
      if (node === cursor) cursor = next(cursor);
      else list.insertBefore(node, cursor);
    }
  }

  // Called from reconcilePanels with the current desired panel list.
  // Diff-based update so favicon buttons that survive a reconcile
  // (same tabId still present) are reused — that preserves their
  // pointer-capture / drag state and limits entry fade transitions
  // to icons that are actually new. The full innerHTML='' rebuild used
  // previously made every
  // reconcile look like every favicon was new (no animation possible)
  // and tore down drag listeners between reconciles.
  function refreshPanelNav(panels) {
    const list = document.querySelector('.bento-panel-nav__list');
    if (!list) return;
    hidePanelNavContextMenu();
    const navPanels = uniqueRootPanels(panels);
    const payloadByTabId = getPanelPayloadByTabIdForNav(panels);

    // Index existing children by their bento nav key. Any stale
    // mid-leave child is removed immediately: structural nav changes
    // must not leave a temporary button ahead of the main icon for a
    // paint, or the navigator visibly jumps.
    const existing = new Map();
    for (const child of Array.from(list.children)) {
      if (child.dataset.bentoNavLeaving === '1') {
        stopPanelNavAudioEmitter(child, { removeParticles: true });
        child.remove();
        continue;
      }
      const key = child.dataset.bentoNavKey;
      if (key) existing.set(key, child);
    }

    // Desired keys in order: 'main' first, then each root layout node id.
    const desiredKeys = ['main'];
    for (const panel of navPanels) desiredKeys.push(panel.rootNodeId || 'panel:' + panel.tabId);

    // Build / reuse each desired icon in order, collecting which ones
    // are new (need enter animation).
    const desiredEls = [];
    const newEls = [];
    for (let i = 0; i < desiredKeys.length; i++) {
      const key = desiredKeys[i];
      let btn = existing.get(key);
      if (btn) {
        if (key === 'main') {
          btn.classList.add('bento-panel-nav__icon--main');
          btn.setAttribute('aria-label', getMainPanelTooltipLabel());
          syncPanelNavAudioParticles(btn, isMainTabAudioPlaying());
          existing.delete(key);
          desiredEls.push(btn);
          continue;
        }
        // Rebuild if subdivision state changed (e.g. panel was subdivided or unsubdivided)
        const panelPayload = key === 'main' ? null : navPanels[i - 1];
        const desiredSignature = panelPayload
          ? getPanelNavSignature(panelPayload, payloadByTabId)
          : key;
        const wasSub = btn.classList.contains('bento-panel-nav__icon--subdivided');
        const navInfo = panelPayload ? getPanelNavInfo(panelPayload, payloadByTabId) : null;
        const isSub = !!navInfo?.isGrouped;
        const signatureChanged =
          key !== 'main' && btn.dataset.bentoNavSignature !== desiredSignature;
        if (wasSub !== isSub || signatureChanged) {
          existing.delete(key);
          stopPanelNavAudioEmitter(btn, { removeParticles: true });
          btn.remove();
          btn = null;
        } else if (!updatePanelNavButton(btn, navInfo)) {
          existing.delete(key);
          stopPanelNavAudioEmitter(btn, { removeParticles: true });
          btn.remove();
          btn = null;
        } else {
          existing.delete(key);
        }
      }
      if (!btn) {
        // New icon — construct via buildNavIcon with the right handler.
        if (key === 'main') {
          btn = buildNavIcon(getMainTabFavicon(), getMainPanelTooltipLabel(), () => {
            const ordered = getOrderedPanels();
            const main = ordered[0] || document.getElementById('tabbrowser-tabbox');
            clearRestoredMainAutoScrollSuppression();
            scrollPanelToLeftmost(main);
            setActiveByIndex(0);
          });
          btn.classList.add('bento-panel-nav__icon--main');
          syncPanelNavAudioParticles(btn, isMainTabAudioPlaying());
        } else {
          const panelPayload = navPanels[i - 1];
          const tabId = Number(panelPayload?.tabId);
          const clickHandler = () => {
            const el = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
            if (el) scrollPanelToLeftmost(el);
            const idx = getCycleIndexForPanelTabId(tabId);
            setActiveByIndex(idx >= 0 ? idx : 0);
          };
          const navInfo = getPanelNavInfo(panelPayload, payloadByTabId);
          if (!navInfo.isGrouped) {
            btn = buildNavIcon(
              navInfo.favIconUrl || panelPayload.favIconUrl || '',
              navInfo.title || panelPayload.title || 'Panel',
              clickHandler,
              tabId,
              panelPayload.rootNodeId || key,
            );
            syncPanelNavDiscardedClass(btn, navInfo);
            syncPanelNavAudioClass(btn, navInfo);
          } else {
            btn = buildGroupedNavIcon(
              navInfo.rows,
              (navInfo.title || panelPayload.title || 'Panel') + ' (grouped)',
              clickHandler,
              tabId,
              panelPayload.rootNodeId || key,
            );
            syncPanelNavDiscardedClass(btn, navInfo);
            syncPanelNavAudioClass(btn, navInfo);
          }
        }
        btn.dataset.bentoNavKey = key;
        btn.classList.add('bento-panel-nav__icon--entering');
        newEls.push(btn);
      }
      desiredEls.push(btn);
      if (key !== 'main') {
        const panelPayload = navPanels[i - 1];
        if (panelPayload) {
          btn.dataset.bentoNavSignature = getPanelNavSignature(panelPayload, payloadByTabId);
        }
      }
    }

    // Remove stale icons before reordering desired buttons. This is
    // especially important when a panel is subdivided or promoted back
    // to a normal panel: the root nav key changes, and a delayed
    // stale-button removal can flash an extra favicon before the main
    // icon.
    for (const [, el] of existing) {
      stopPanelNavAudioEmitter(el, { removeParticles: true });
      el.remove();
    }

    // Re-order without re-inserting buttons that are already in place.
    placeInOrder(list, desiredEls);

    // Trigger enter animation on next frame so the browser commits
    // the initial transparent state before we remove the class.
    // Without the rAF, browsers may collapse both states into one
    // paint and skip the transition.
    if (newEls.length > 0) {
      requestAnimationFrame(() => {
        for (const el of newEls) {
          el.classList.remove('bento-panel-nav__icon--entering');
        }
      });
    }

    // Clamp active index to current cycle target count and re-paint
    // the marker (panel count may have decreased since the last
    // selection). The Add-panel trailer is part of keyboard cycling
    // but has no favicon marker, so applyActiveMarker naturally
    // leaves all favicons unmarked when it is selected.
    const total = getPanelCycleTargets().length;
    if (currentActiveIdx >= total) currentActiveIdx = 0;
    applyActiveMarker(currentActiveIdx);
  }

  function updatePanelNavButton(btn, navInfo) {
    if (!btn || !navInfo) return false;
    syncPanelNavDiscardedClass(btn, navInfo);
    syncPanelNavAudioClass(btn, navInfo);
    if (!navInfo.isGrouped) {
      btn.setAttribute('aria-label', navInfo.title || 'Panel');
      const favIconUrl = getStablePanelNavFavicon(navInfo.tabId, navInfo.favIconUrl || '', btn);
      if (favIconUrl !== null) refreshNavIconImage(btn, favIconUrl);
      return true;
    }
    const title = (navInfo.title || 'Panel') + ' (grouped)';
    const rows = navInfo.rows.map((row) =>
      row.map((cell) => {
        if (!Number.isFinite(cell?.tabId)) return cell;
        const favIconUrl = getStablePanelNavFavicon(cell.tabId, cell.favIconUrl || '', btn);
        return favIconUrl === null ? { ...cell, favIconUrl: null } : { ...cell, favIconUrl };
      }),
    );
    return syncGroupedNavIcon(btn, rows, title);
  }

  // Update a nav-icon button's <img> src without rebuilding the button
  // (preserves drag state). Mirrors the placeholder fallback from
  // buildNavIcon.
  function refreshNavIconImage(btn, favIconUrl) {
    let img = btn.querySelector('img');
    if (favIconUrl) {
      btn.classList.remove('bento-panel-nav__icon--placeholder');
      if (img) {
        if (img.src !== favIconUrl) img.src = favIconUrl;
      } else {
        img = document.createElementNS(HTML_NS, 'img');
        img.src = favIconUrl;
        img.alt = '';
        img.addEventListener('error', () => {
          img.remove();
          btn.classList.add('bento-panel-nav__icon--placeholder');
        });
        btn.appendChild(img);
      }
    } else {
      if (img) img.remove();
      btn.classList.add('bento-panel-nav__icon--placeholder');
    }
  }

  // ─── Custom always-on horizontal scrollbar ────────────────────────────
  // macOS auto-hides native scrollbars regardless of CSS. We hide the
  // native one and draw our own that stays put: a track + a draggable
  // thumb, sized proportionally to (visible / total) panel-strip width.
  // setPointerCapture on the thumb so drags continue when the cursor
  // crosses over a remote content browser (same reason inter-panel
  // splitters use it).
  // Returns the element whose horizontal scroll the custom scrollbar
  // should track. In split-view mode, the actual scroll context is
  // #tabbrowser-tabpanels (Firefox's native deck — content-area.css and
  // our injected overflow-x: auto make it scrollable when N panels
  // exceed viewport width). In the legacy parallel-browser path, it's
  // #bento-side-panel-host. Single helper so updateStripScrollbar +
  // pointer drag handlers + track-click all stay aligned.
  function getStripScrollTarget() {
    // Once the reconciler has activated split-view mode, the deck
    // (#tabbrowser-tabpanels) IS the scroll context for the panel
    // strip. Before then (boot, or no panels in this workspace), the
    // unified host vbox is the strip and tabpanels is just main.
    if (window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
      return window.gBrowser.tabpanels;
    }
    return document.getElementById('bento-side-panel-host');
  }

  function updateStripScrollbar() {
    if (isBentoChromeLiveResizing()) return;
    const host = getStripScrollTarget();
    const bar = document.getElementById('bento-strip-scrollbar');
    if (!host || !bar) return;
    // Show ONLY when there's actually overflow. +1 tolerance for
    // sub-pixel rounding so the scrollbar doesn't flicker on a
    // borderline content size. When visible it stays visible (no
    // auto-hide); only the overflow check toggles it.
    const hasOverflow = host.scrollWidth > host.clientWidth + 1;
    bar.style.display = hasOverflow ? '' : 'none';
    if (!hasOverflow) return;

    const thumb = bar.querySelector('.bento-strip-scrollbar__thumb');
    if (!thumb) return;
    const trackWidth = bar.clientWidth;
    if (trackWidth <= 0) return;
    // Thumb width proportional to visible/total ratio. 30px min via CSS
    // so it stays grabbable even with very wide overflow.
    const ratio = host.clientWidth / host.scrollWidth;
    const thumbWidth = Math.max(30, trackWidth * ratio);
    const scrollableWidth = host.scrollWidth - host.clientWidth;
    const scrollRatio = scrollableWidth > 0 ? host.scrollLeft / scrollableWidth : 0;
    const thumbLeft = (trackWidth - thumbWidth) * scrollRatio;
    thumb.style.width = thumbWidth + 'px';
    thumb.style.transform = 'translateX(' + thumbLeft + 'px)';
  }

  function preserveStripScrollDuringLiveLayout(fn, afterRestore) {
    const host = getStripScrollTarget();
    if (!host) {
      const result = fn();
      if (typeof afterRestore === 'function') afterRestore();
      return result;
    }
    const scrollLeft = host.scrollLeft;
    const token = ++__liveLayoutScrollPreserveToken;
    __suppressStripScrollDispatch = true;
    try {
      const result = fn();
      void host.scrollWidth;
      const maxScrollLeft = Math.max(0, host.scrollWidth - host.clientWidth);
      host.scrollLeft = Math.max(0, Math.min(maxScrollLeft, scrollLeft));
      if (typeof afterRestore === 'function') afterRestore();
      updateStripScrollbar();
      return result;
    } finally {
      requestAnimationFrame(() => {
        if (token === __liveLayoutScrollPreserveToken) {
          __suppressStripScrollDispatch = false;
        }
      });
    }
  }

  function buildStripScrollbar() {
    const bar = document.createElementNS(HTML_NS, 'div');
    bar.id = 'bento-strip-scrollbar';
    const thumb = document.createElementNS(HTML_NS, 'div');
    thumb.className = 'bento-strip-scrollbar__thumb';
    bar.appendChild(thumb);

    let dragState = null; // { startX, startScrollLeft, pointerId }

    thumb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const host = getStripScrollTarget();
      if (!host) return;
      dragState = {
        startX: e.clientX,
        startScrollLeft: host.scrollLeft,
        pointerId: e.pointerId,
      };
      thumb.classList.add('bento-strip-scrollbar__thumb--dragging');
      try {
        thumb.setPointerCapture(e.pointerId);
      } catch (err) {
        console.warn('[bento-shell-mount] scrollbar setPointerCapture failed:', err);
      }
    });

    thumb.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      const host = getStripScrollTarget();
      if (!host) return;
      const trackWidth = bar.clientWidth - thumb.clientWidth;
      const scrollableWidth = host.scrollWidth - host.clientWidth;
      if (trackWidth <= 0 || scrollableWidth <= 0) return;
      const pixelDelta = e.clientX - dragState.startX;
      const ratio = scrollableWidth / trackWidth;
      host.scrollLeft = Math.max(
        0,
        Math.min(scrollableWidth, dragState.startScrollLeft + pixelDelta * ratio),
      );
    });

    function endDrag(e) {
      if (!dragState) return;
      if (e && e.pointerId !== undefined && e.pointerId !== dragState.pointerId) return;
      try {
        thumb.releasePointerCapture(dragState.pointerId);
      } catch {
        /* already released */
      }
      dragState = null;
      thumb.classList.remove('bento-strip-scrollbar__thumb--dragging');
    }
    thumb.addEventListener('pointerup', endDrag);
    thumb.addEventListener('pointercancel', endDrag);
    thumb.addEventListener('lostpointercapture', () => endDrag(null));

    // Click on the empty track jumps the scroll to that position.
    bar.addEventListener('pointerdown', (e) => {
      if (e.target !== bar) return; // ignore clicks on the thumb
      if (e.button !== 0) return;
      const host = getStripScrollTarget();
      if (!host) return;
      const rect = bar.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const scrollableWidth = host.scrollWidth - host.clientWidth;
      host.scrollTo({
        left: Math.max(
          0,
          Math.min(scrollableWidth, ratio * host.scrollWidth - host.clientWidth / 2),
        ),
        behavior: 'smooth',
      });
    });

    return bar;
  }

  // SHIFT + wheel should feel like panel cycling, not like pixel-wise
  // horizontal strip scrolling. Trackpads emit many tiny wheel events;
  // mouse wheels emit fewer, larger line/page events. Normalize both and
  // advance one panel per threshold crossed, reusing navigatePanels so
  // the active marker, focus ring, and edge behavior match the keyboard shortcut.
  // A short gesture lock also captures momentum tail events whose
  // shiftKey can drop before the wheel burst has fully ended.
  const PANEL_WHEEL_STEP_PX = 32;
  const PANEL_WHEEL_GESTURE_LOCK_MS = 220;
  let panelWheelRemainder = 0;
  let panelWheelGestureUntil = 0;

  function normalizeWheelDeltaPx(e) {
    const linePx = SCROLL_LINE_PX;
    const pagePx = Math.max(linePx, window.innerWidth || 800);
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? linePx
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? pagePx
          : 1;
    const dominantDelta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    return dominantDelta * unit;
  }

  // Horizontal scroll anywhere on chrome (sidebar, panel headers, gaps
  // between panels) routes to the panel strip. Gives the user a reliable
  // place to rest the cursor and scroll the strip without panels'
  // horizontally-overflowing web content stealing the scroll. Skips
  // events targeting web content (<browser>) so pages keep handling
  // their own horizontal scroll. Skips modifier gestures so it doesn't
  // collide with Shift+wheel (panel cycling) or Ctrl/Cmd+wheel (zoom).
  function onChromeHorizontalWheel(e) {
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target;
    if (target?.localName === 'browser') return;
    if (typeof target?.closest === 'function' && target.closest('browser')) return;
    // Only act on horizontal-dominant deltas. A tie (deltaX === deltaY)
    // is ambiguous; defer to native handling.
    const ax = Math.abs(e.deltaX);
    const ay = Math.abs(e.deltaY);
    if (ax === 0 || ax <= ay) return;
    const stripTarget = getStripScrollTarget();
    if (!stripTarget) return;
    const linePx = SCROLL_LINE_PX;
    const pagePx = Math.max(linePx, window.innerWidth || 800);
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? linePx
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? pagePx
          : 1;
    e.preventDefault();
    stripTarget.scrollLeft += e.deltaX * unit;
  }

  function onPanelStripWheel(e) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (!shouldHandlePanelArrowKey(e.target)) return;
    const isPanelWheelGesture = e.shiftKey || Date.now() < panelWheelGestureUntil;
    if (!isPanelWheelGesture) return;

    const delta = normalizeWheelDeltaPx(e);
    if (!delta) return;

    e.preventDefault();
    e.stopPropagation();
    panelWheelGestureUntil = Date.now() + PANEL_WHEEL_GESTURE_LOCK_MS;
    panelWheelRemainder += delta;

    let steps = 0;
    while (Math.abs(panelWheelRemainder) >= PANEL_WHEEL_STEP_PX) {
      steps += panelWheelRemainder > 0 ? 1 : -1;
      panelWheelRemainder += panelWheelRemainder > 0 ? -PANEL_WHEEL_STEP_PX : PANEL_WHEEL_STEP_PX;
    }

    if (steps === 0) return;
    const direction = steps > 0 ? 1 : -1;
    for (let i = 0; i < Math.abs(steps); i++) {
      if (!navigatePanels(direction, { allowWrap: false })) {
        panelWheelRemainder = 0;
        break;
      }
    }
  }

  function isExtensionToolbarChild(el) {
    if (!el || el.id === 'bento-panel-nav') return false;
    const id = el.id || '';
    if (id === 'unified-extensions-button' || id === 'wrapper-unified-extensions-button') {
      return true;
    }
    if (id.endsWith('-browser-action')) return true;
    if (el.classList?.contains('webextension-browser-action')) return true;
    return !!el.querySelector?.(
      '#unified-extensions-button, .webextension-browser-action, [id$="-browser-action"]',
    );
  }

  function getPanelNavigatorToolbarTarget() {
    return (
      document.getElementById('nav-bar-customization-target') ||
      document.getElementById('nav-bar')
    );
  }

  function getPanelNavigatorToolbarAnchor(target) {
    if (!target?.children) return null;
    for (const child of Array.from(target.children)) {
      if (isExtensionToolbarChild(child)) return child;
    }
    return null;
  }

  function markExtensionToolbarAnchor(target, anchor) {
    if (!target?.children) return;
    for (const child of Array.from(target.children)) {
      if (child.getAttribute?.('data-bento-extension-toolbar-anchor') === 'true') {
        child.removeAttribute('data-bento-extension-toolbar-anchor');
      }
    }
    anchor?.setAttribute?.('data-bento-extension-toolbar-anchor', 'true');
  }

  function placePanelNavigatorInToolbar(nav) {
    const target = getPanelNavigatorToolbarTarget();
    if (!target || !nav) return false;
    const anchor = getPanelNavigatorToolbarAnchor(target);
    markExtensionToolbarAnchor(target, anchor);
    if (nav.parentNode === target) {
      if (anchor && nav.nextSibling === anchor) return true;
      if (!anchor && nav === target.lastElementChild) return true;
    }
    target.insertBefore(nav, anchor || null);
    return true;
  }

  function mountPanelNavigator(nav, fallbackParent) {
    if (placePanelNavigatorInToolbar(nav)) return;
    if (fallbackParent && nav.parentNode !== fallbackParent) fallbackParent.appendChild(nav);
  }

  function watchPanelNavigatorToolbarPlacement(nav, fallbackParent) {
    const mount = () => mountPanelNavigator(nav, fallbackParent);
    window.addEventListener('load', mount, { once: true });
    window.addEventListener('aftercustomization', mount, true);

    const target = getPanelNavigatorToolbarTarget();
    if (!target || !window.MutationObserver) return;
    const observer = new MutationObserver(mount);
    observer.observe(target, { childList: true });
    nav._bentoToolbarPlacementObserver = observer;
  }

  function setupPanelNavigator() {
    const host = document.getElementById('bento-side-panel-host');
    if (!host) return;
    if (document.getElementById('bento-strip-container')) return; // already wrapped

    const wrap = document.createXULElement('vbox');
    wrap.id = 'bento-strip-container';
    wrap.setAttribute('flex', '1');
    host.parentNode.insertBefore(wrap, host);
    moveNodeBefore(wrap, host, null);
    wrap.addEventListener('contextmenu', showPanelStripContextMenu);

    // Custom scrollbar between strip and navigator.
    const scrollbar = buildStripScrollbar();
    wrap.appendChild(scrollbar);

    const nav = document.createElementNS(HTML_NS, 'div');
    nav.id = 'bento-panel-nav';
    nav.setAttribute('role', 'toolbar');
    nav.setAttribute('aria-label', 'Panel navigator');

    const prevBtn = document.createElementNS(HTML_NS, 'button');
    prevBtn.type = 'button';
    prevBtn.className = 'bento-panel-nav__btn';
    prevBtn.title = 'Previous panel';
    prevBtn.setAttribute('aria-label', 'Previous panel');
    prevBtn.appendChild(makeIcon(ICONS.chevronLeft));
    function cyclePanelFromNavigator(event, delta) {
      event.preventDefault();
      event.stopPropagation();
      navigatePanels(delta);
    }

    function suppressPanelNavigatorDoubleClick(event) {
      event.preventDefault();
      event.stopPropagation();
    }

    prevBtn.addEventListener('click', (event) => cyclePanelFromNavigator(event, -1));
    prevBtn.addEventListener('dblclick', suppressPanelNavigatorDoubleClick);

    const list = document.createElementNS(HTML_NS, 'div');
    list.className = 'bento-panel-nav__list';

    const addBtn = document.createElementNS(HTML_NS, 'button');
    addBtn.type = 'button';
    addBtn.className = 'bento-panel-nav__btn';
    addBtn.title = 'Add panel';
    addBtn.setAttribute('aria-label', 'Add panel');
    addBtn.appendChild(makeIcon(ICONS.plus));
    addBtn.addEventListener('click', addNewPanel);

    const nextBtn = document.createElementNS(HTML_NS, 'button');
    nextBtn.type = 'button';
    nextBtn.className = 'bento-panel-nav__btn';
    nextBtn.title = 'Next panel';
    nextBtn.setAttribute('aria-label', 'Next panel');
    nextBtn.appendChild(makeIcon(ICONS.chevronRight));
    nextBtn.addEventListener('click', (event) => cyclePanelFromNavigator(event, 1));
    nextBtn.addEventListener('dblclick', suppressPanelNavigatorDoubleClick);

    nav.appendChild(prevBtn);
    nav.appendChild(list);
    nav.appendChild(addBtn);
    nav.appendChild(nextBtn);
    mountPanelNavigator(nav, wrap);
    watchPanelNavigatorToolbarPlacement(nav, wrap);

    // Live updates: tab switches refresh the main favicon. Tab attribute
    // changes also patch the last panel payload so panel nav favicons keep up
    // with URL-bar navigation before the next panels/sync arrives. We
    // deliberately do NOT update the active marker on scroll —
    // currentActiveIdx is set only by explicit nav (click / button / key), so
    // manual scroll doesn't override the user's selection. The custom
    // scrollbar's thumb position DOES update on scroll though.
    host.addEventListener('scroll', updateStripScrollbar, { passive: true });
    // Shift+wheel panel cycling is attached to the strip CONTAINER for
    // the bottom scrollbar and to the toolbar navigator for its top
    // controls. A listener on the panel host alone never sees either
    // surface.
    wrap.addEventListener('wheel', onPanelStripWheel, { capture: true, passive: false });
    nav.addEventListener('wheel', onPanelStripWheel, { capture: true, passive: false });
    // Chrome-wide horizontal-wheel intercept: any side-scroll over the
    // chrome (sidebar, panel headers, between-panel gaps) scrolls the
    // panel strip, so the user always has a reliable surface to rest
    // the cursor on. Capture-phase so it sees the event before any
    // chrome scroll container's native handling; preventDefault on
    // matched events prevents double-scroll. Web content (<browser>)
    // is excluded inside the handler so pages keep their own
    // horizontal scrolling. Once-per-window; setupPanelNavigator runs
    // exactly once at chrome boot.
    window.addEventListener('wheel', onChromeHorizontalWheel, {
      capture: true,
      passive: false,
    });
    // Splitters live in bento-side-panel-host (not tabpanels) because
    // tabpanels' XUL deck refuses to paint non-panel children, so
    // they don't follow tabpanels' horizontal scroll automatically.
    // Re-sync them on every scroll tick of the active strip target so
    // they track the panel boundaries the user actually sees. */
    const stripTarget = getStripScrollTarget();
    if (stripTarget && stripTarget !== host) {
      stripTarget.addEventListener(
        'scroll',
        () => {
          syncInterPanelSplitters();
        },
        { passive: true },
      );
    }
    window.addEventListener('mousedown', (e) => {
      if (panelNavContextMenu && !panelNavContextMenu.contains(e.target)) {
        hidePanelNavContextMenu();
      }
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hidePanelNavContextMenu();
    });
    window.addEventListener('blur', hidePanelNavContextMenu);
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(updateStripScrollbar);
      ro.observe(host);
    }
    if (window.gBrowser?.tabContainer) {
      window.gBrowser.tabContainer.addEventListener('TabSelect', refreshPanelNavMain);
      window.gBrowser.tabContainer.addEventListener(
        'TabAttrModified',
        refreshPanelNavOnTabAttrModified,
      );
    }
    // Initial paint on next tick (give layout a beat to settle).
    setTimeout(updateStripScrollbar, 0);
  }

  // The "Add panel" trailer at the end of the strip. Click creates a new
  // tab at a sentinel URL and attaches a one-time grant to the native tab.
  // bento-tools' tabs.onCreated handler sees the sentinel, consumes the
  // grant through bentoPrivacy.consumeAddPanelGrant, adds the tab to the
  // window's active workspace panel list and emits panels/sync, which
  // round-trips back to chrome so the next reconcilePanels pass renders
  // the new panel.
  //
  // Grant IPC: chrome creates the tab at about:blank?bento_add_as_panel=<token>
  // and stores { token, windowId, source, expiresAt, acknowledge } on the
  // XUL tab element (newTab.bentoAddPanelGrant). Web content cannot reach
  // that element, so the URL alone is never authority: a page that navigates
  // to a marker-shaped URL has no grant, and bento-tools ignores it. The
  // tools side resolves the native tab through the extension tabManager and
  // atomically checks (tabId, token), deletes the grant and reads
  // windowId/source from it (consumeAddPanelGrant in
  // extensions/bento-tools/experiments/bento-privacy/api.js), so a replayed
  // URL or another tab's token is rejected. We tried SessionStore.setTabValue
  // first but the SessionStore module's exported shape is not stable across
  // Firefox versions in chrome scripts loaded via jar.mn from inc.xhtml.
  const ADD_AS_PANEL_MARKER_PREFIX = 'about:blank?bento_add_as_panel=';
  // Minimum time on the sentinel URL before navigating to the new-tab page;
  // keeps the pre-grant timing (bento-tools normally consumes the grant
  // within a few milliseconds of onCreated).
  const ADD_AS_PANEL_REDIRECT_MIN_DELAY_MS = 250;
  // A grant not consumed within this window is discarded and the tab is
  // redirected anyway, so a stalled bento-tools cannot leave the sentinel up.
  const ADD_AS_PANEL_GRANT_TTL_MS = 2000;

  // 'main' inserts before the main slot, a tab id inserts after that panel,
  // and 'end' appends. The "+" click handler passes the click Event here, so
  // anything that is not null or a tab id means 'end'.
  function resolveAddPanelSource(sourceTabId) {
    if (sourceTabId === null) return 'main';
    if (Number.isInteger(sourceTabId) && sourceTabId >= 0) return sourceTabId;
    return 'end';
  }

  function addNewPanel(sourceTabId) {
    if (!window.gBrowser || typeof window.gBrowser.addTab !== 'function') {
      console.warn('[bento-shell-mount] addNewPanel: gBrowser unavailable');
      return;
    }
    let newTab;
    let grant;
    let consumed;
    try {
      grant = {
        token: crypto.randomUUID(),
        windowId: getChromeWindowId(),
        source: resolveAddPanelSource(sourceTabId),
        expiresAt: Date.now() + ADD_AS_PANEL_GRANT_TTL_MS,
        acknowledge: null,
      };
      consumed = new Promise((resolve) => {
        grant.acknowledge = resolve;
      });
      newTab = window.gBrowser.addTab(ADD_AS_PANEL_MARKER_PREFIX + grant.token, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        skipAnimation: true,
        inBackground: true,
      });
    } catch (err) {
      console.warn('[bento-shell-mount] addNewPanel: addTab failed:', err);
      return;
    }
    if (!newTab) return;
    // Set in the same synchronous turn as addTab: bento-tools only sees the
    // tab through an asynchronous extension event, after this assignment.
    newTab.bentoAddPanelGrant = grant;
    // The newly-created tab needs to navigate away from the marker URL so
    // the tab title and main URL bar (when this tab becomes active) show a
    // clean state. Chrome's loadURI bypasses any WebExtension API
    // restrictions on privileged/new-tab navigation. Navigate once the
    // minimum delay has passed AND bento-tools has consumed the grant (or
    // the grant expired), so the panel is added before the URL changes.
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    Promise.all([
      wait(ADD_AS_PANEL_REDIRECT_MIN_DELAY_MS),
      Promise.race([consumed, wait(ADD_AS_PANEL_GRANT_TTL_MS)]),
    ]).then(() => {
      if (newTab.bentoAddPanelGrant === grant) delete newTab.bentoAddPanelGrant;
      try {
        const browserEl = newTab.linkedBrowser;
        loadDefaultNewTabInBrowser(browserEl);
      } catch (err) {
        console.warn('[bento-shell-mount] addNewPanel: post-create navigate failed:', err);
      }
    });
  }

  // Add-panel trailer at the end of the strip. Idempotent — created on
  // first call, then kept mounted in place. Flat-layout geometry and the
  // order:999 rule keep it visually after every panel without reparenting.
  // Lives inside #tabbrowser-tabpanels.bento-split-active as a flex
  // child sibling of the panel containers; does NOT register in
  // splitViewPanels (Firefox's split-view APIs would treat it as a
  // panel and try to wrap a <browser> around it). The order:999 inline
  // CSS keeps it at the visual end regardless of where Firefox's
  // append puts it in DOM order. Do not move the existing trailer between
  // reconciles: it hosts a remote extension <browser>, and reparenting that
  // iframe can visibly blink the Add panels cluster when subdivision fills
  // add new panel nodes.
  //
  // The visible "+" button and the per-saved-bookmark favicon buttons
  // are rendered by a React app inside a moz-extension <browser>
  // iframe (panel-trailer.html). The XUL <vbox> here is purely the
  // host: it owns the paint-pipeline class, focus-ring CSS,
  // splitter/cycle-target identity, and the keyboard Enter handler
  // that survives for cycle-Enter UX (since chrome captures the key
  // before the iframe's React app sees it).
  function ensureAddPanelTrailer(tabpanels) {
    let trailer = document.getElementById('bento-add-panel-trailer');
    if (!trailer) {
      // XUL <vbox> (NOT HTML <button>) because tabpanels is a XUL
      // <tabpanels>/deck element, and HTML children inside it lay out
      // (getBoundingClientRect returns a sensible rect) but don't
      // paint or receive hit-testing — elementsFromPoint at the
      // trailer's centre showed tabpanels itself rather than the
      // trailer, confirming the HTML element wasn't reaching the
      // compositor. Other tabpanels children are XUL notificationboxes
      // for the same reason. The XUL <browser> child paints fine
      // inside this <vbox> — same constraint that makes every real
      // panel's <browser> work.
      trailer = document.createXULElement('vbox');
      trailer.id = 'bento-add-panel-trailer';
      // .split-view-panel-active opts the trailer into Firefox's
      // split-view paint pipeline. Without it the deck silently
      // suppresses non-panel children even with display:flex +
      // visibility:visible !important. Our #id rule overrides the
      // 380px min-width that the .split-view-panel-active class
      // selector applies to real panels.
      trailer.classList.add('split-view-panel-active');
      // tabindex + keydown survive so keyboard cycling Right past the
      // last panel lands on the trailer; Enter still creates a blank
      // panel via the existing addNewPanel marker URL path. The
      // visible "+" inside the iframe uses title IPC so tab creation
      // still happens through this chrome window's addNewPanel path.
      trailer.setAttribute('tabindex', '0');
      trailer.setAttribute('aria-label', 'Add panel');
      // Removed (vs. pre-iframe trailer):
      //   - role="button": the vbox is now a CONTAINER; the iframe
      //     child renders the actual button widgets.
      //   - inline `title`: replaced by the iframe's Mux Tooltip.
      //   - click handler: the iframe captures mouse clicks before
      //     they reach the vbox. The keydown handler stays only for
      //     keyboard cycle-Enter while the OUTER vbox itself is
      //     focused (see setActiveByIndex's trailer special-case).
      //     When Tab moves focus into the iframe buttons, those
      //     buttons own Enter/Space so saved-panel keyboard activation
      //     opens the saved URL instead of falling through to blank add.
      trailer.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          if (document.activeElement !== trailer) return;
          e.preventDefault();
          e.stopPropagation();
          addNewPanel();
        }
      });
      // Inner moz-extension iframe — same attribute set as
      // createOverlayFrame frames. Renders /dist/panel-trailer.html
      // which mounts the React PanelTrailer app. Saved favicon buttons
      // dispatch panel/openAt with position 'end'; the blank "+" button
      // signals chrome to call addNewPanel directly.
      const frame = document.createXULElement('browser');
      frame.id = 'bento-panel-trailer-frame';
      frame.setAttribute('type', 'content');
      frame.setAttribute('remote', 'true');
      frame.setAttribute('remoteType', 'extension');
      frame.setAttribute('primary', 'false');
      frame.setAttribute('flex', '1');
      frame.setAttribute('transparent', 'transparent');
      frame.style.cssText = 'background-color: transparent; -moz-appearance: none;';
      trailer.appendChild(frame);
      // NOTE: setBentoPanelTrailerSrc() is called AFTER the trailer is
      // appended to tabpanels below — setFrameSrc resolves the frame
      // via document.getElementById, which silently returns null when
      // the element is still detached from the document.
    }
    // Append only when detached. The flat-layout renderer positions the
    // trailer from computed geometry, and CSS order:999 is enough for any
    // brief flex-layout paint before absolute rects land. Re-appending an
    // already-mounted trailer reparents the remote iframe and can flicker.
    const wasDetached = trailer.parentNode !== tabpanels;
    if (wasDetached) {
      tabpanels.appendChild(trailer);
    }
    // First-mount-only: now that the trailer + its inner <browser> are
    // in the document, kick off the moz-extension URL load. Subsequent
    // reconciles re-append the same node but the iframe's `src`
    // (already set on first mount) survives the DOM move.
    if (wasDetached) {
      const frame = document.getElementById('bento-panel-trailer-frame');
      if (frame && !frame.getAttribute('src')) {
        setBentoPanelTrailerSrc();
      }
    }
  }

  // Update the trailer's flex-basis so it grows only when the saved-panel
  // overflow select is present. The first eight saved panels fit into the
  // 3x3 grid around the centre "new tab" button.
  function applyTrailerWidth(count) {
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (!trailer) return;
    const safe = Number.isFinite(count) && count >= 0 ? Math.round(count) : 0;
    trailer.style.setProperty('--bento-saved-panel-overflow', safe > 8 ? '1' : '0');
  }

  function removeAddPanelTrailer() {
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer) trailer.remove();
  }

  function setNoSidePanelsMode(enabled) {
    const container = document.getElementById('bento-strip-container');
    const host = document.getElementById('bento-side-panel-host');
    const nav = document.getElementById('bento-panel-nav');
    const tabpanels = window.gBrowser?.tabpanels;
    if (enabled) {
      document.documentElement.setAttribute('bento-no-side-panels', 'true');
    } else {
      document.documentElement.removeAttribute('bento-no-side-panels');
    }
    if (container) {
      container.classList.toggle('bento-no-side-panels', enabled);
    }
    if (nav) {
      nav.classList.toggle('bento-panel-nav--hidden', enabled);
    }
    if (enabled) {
      if (host) host.scrollLeft = 0;
      if (tabpanels) tabpanels.scrollLeft = 0;
    }
  }

  function forceMainOnlyChromeState(gBrowser, tabpanels) {
    cancelWorkspaceFadeForMainOnly();
    __bentoPendingCloseGapFlip = null;
    setNoSidePanelsMode(true);
    clearFlatPanelLayout(tabpanels);
    syncInterPanelSplitters([]);
    removeAddPanelTrailer();

    if (tabpanels) {
      try {
        const previous = tabpanels.splitViewPanels || [];
        const previousTabs = previous
          .map((id) => gBrowser?.tabs?.find((t) => t.linkedPanel === id))
          .filter((t) => !!t);
        if (previousTabs.length && typeof tabpanels.removeTabsFromSplitview === 'function') {
          tabpanels.removeTabsFromSplitview(previousTabs);
        } else {
          tabpanels.splitViewPanels = [];
        }
      } catch (err) {
        console.warn('[bento-shell-mount] force main-only teardown failed:', err);
        try {
          tabpanels.splitViewPanels = [];
        } catch {
          /* best-effort fallback */
        }
      }
      tabpanels.classList.remove('bento-split-active');
      tabpanels.removeAttribute('splitview');
    }

    if (gBrowser?.tabs) {
      for (const tab of gBrowser.tabs) {
        if (tab.splitview && tab.splitview.kind === BENTO_SPLIT_KIND) {
          delete tab.splitview;
        }
        const panelEl = document.getElementById(tab.linkedPanel);
        if (!panelEl) continue;
        delete panelEl.dataset.bentoMainPanel;
        delete panelEl.dataset.bentoPanelTabId;
        delete panelEl.dataset.bentoRootNodeId;
        panelEl.style.removeProperty('order');
        panelEl.style.removeProperty('left');
        panelEl.style.removeProperty('top');
        panelEl.style.removeProperty('width');
        panelEl.style.removeProperty('min-width');
        panelEl.style.removeProperty('max-width');
        panelEl.style.removeProperty('height');
        panelEl.style.removeProperty('min-height');
        panelEl.style.removeProperty('max-height');
        panelEl.style.removeProperty('flex');
        panelEl.style.removeProperty('display');
        panelEl.style.removeProperty('flex-direction');
        panelEl.style.removeProperty('overflow');
        panelEl.style.removeProperty('position');
        panelEl.style.removeProperty('opacity');
        panelEl.style.removeProperty('visibility');
        panelEl.style.removeProperty('pointer-events');
        panelEl.style.removeProperty('margin');
        panelEl.style.removeProperty('padding');
        panelEl.style.removeProperty('border-width');
        panelEl.style.removeProperty('transform');
        panelEl.style.removeProperty('transition');
        panelEl.classList.remove(
          'split-view-panel',
          'split-view-panel-active',
          'bento-panel--focused',
          'bento-panel--cycle-focused',
        );
        removeInjectedPanelHeader(panelEl);
        panelEl.removeAttribute('column');
        if (panelEl.getAttribute('tabindex') === '-1') {
          panelEl.removeAttribute('tabindex');
        }
      }
    }

    restoreSelectedMainBrowser(gBrowser, tabpanels, 'force main-only');

    if (__lastSplitViewMarker) {
      try {
        window.dispatchEvent(
          new CustomEvent('TabSplitViewDeactivate', {
            bubbles: true,
            detail: {
              tabs: __lastSplitViewMarker.tabs,
              splitview: __lastSplitViewMarker,
            },
          }),
        );
      } catch (err) {
        console.warn('[bento-shell-mount] force teardown deactivate failed:', err);
      }
      __lastSplitViewMarker = null;
    }

    refreshPanelNav([]);
    currentActiveIdx = 0;
    __lastPanelsPayload = [];
    __reconciledForWorkspace = currentWorkspaceId;
    __lastMainPanelId = window.gBrowser?.selectedTab?.linkedPanel ?? null;
    updateStripScrollbar();
  }

  // ─── Native split-view panel rendering ──────────────────────────────
  //
  // Panel rendering is driven through Firefox 150's
  // `tabpanels.splitViewPanels = [...]` setter — each panel is a real
  // Firefox tab whose `linkedBrowser` stays in tabpanels for its
  // lifetime. Extension content scripts attach correctly because
  // nothing about a tab's identity changes.
  //
  // Plan: plans/bento-spaces-split-view-panels.md.

  // The most recent panels payload, stashed so the TabSelect listener
  // can re-reconcile when only the active main tab changes (the panel
  // set is unchanged but the first slot of splitViewPanels follows
  // gBrowser.selectedTab).
  let __lastPanelsPayload = [];
  // The linkedPanel id of the most recent main tab. Compared on each
  // reconcile to detect "selected tab actually changed" (vs. reconcile
  // for an unrelated reason like panel width refresh) so we know when
  // to auto-scroll the strip back to the main slot — sidebar-tab
  // clicks should bring main back into view even if the user was
  // looking at a side panel.
  let __lastMainPanelId = null;
  let __suppressNextMainAutoScrollForWorkspace = null;
  // Workspace ID we've successfully reconciled at least once. Compared
  // against currentWorkspaceId to detect "this is the initial hydration
  // for this workspace" (boot OR workspace switch) versus "user mutated
  // the panel set within the same workspace". The previousTabIds diff
  // alone can't distinguish these: a workspace that previously had zero
  // panels has previousTabIds empty whether we're hydrating it for the
  // first time or the user just added the first panel via the link
  // context menu. Updated in both the empty-panels early-return path
  // AND the main return path so it stays accurate across teardowns.
  let __reconciledForWorkspace = null;
  // True once this window has started handing its tabs to another window as it closes (see
  // handOverTabsBeforeClose). The reconciler stands down: it would mark the leaving tabs with
  // split-view markers again.
  let handingOverTabs = false;

  function sanitizePanelLayoutPayload(rawLayout, panels) {
    const panelIds = new Set((panels || []).map((panel) => Number(panel?.tabId)));
    const collectPresentPanelIds = (node, out) => {
      if (!node) return;
      if (node.kind === 'panel') {
        const tabId = Number(node.tabId);
        if (Number.isFinite(tabId)) out.add(tabId);
        return;
      }
      if (node.kind !== 'group' || !Array.isArray(node.children)) return;
      collectPresentPanelIds(node.children[0], out);
      collectPresentPanelIds(node.children[1], out);
    };
    const sanitizePanelNode = (node) => {
      const tabId = Number(node?.tabId);
      if (node?.kind !== 'panel' || !Number.isFinite(tabId) || !panelIds.has(tabId)) return null;
      return { kind: 'panel', tabId };
    };
    const sanitizeHorizontalGroupNode = (node) => {
      if (node?.kind !== 'group' || node.axis !== 'horizontal' || typeof node.id !== 'string') {
        return null;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      const left = sanitizePanelNode(children[0]);
      const right = sanitizePanelNode(children[1]);
      if (!left || !right) return null;
      return {
        kind: 'group',
        id: node.id,
        axis: 'horizontal',
        ratio: typeof node.ratio === 'number' ? node.ratio : 0.5,
        children: [left, right],
      };
    };
    const sanitizeTopNode = (node) => {
      return sanitizePanelNode(node) || sanitizeHorizontalGroupNode(node);
    };
    const sanitizeBottomNode = (node) => {
      const panel = sanitizePanelNode(node);
      if (panel) return panel;
      if (node?.kind === 'chooser' && typeof node.id === 'string') {
        const ownerTabId = Number(node.ownerTabId);
        if (!Number.isFinite(ownerTabId) || !panelIds.has(ownerTabId)) return null;
        return { kind: 'chooser', id: node.id, ownerTabId };
      }
      const horizontal = sanitizeHorizontalGroupNode(node);
      if (horizontal) return horizontal;
      return null;
    };
    const root = [];
    for (const node of Array.isArray(rawLayout?.root) ? rawLayout.root : []) {
      const panel = sanitizePanelNode(node);
      if (panel) {
        root.push(panel);
        continue;
      }
      if (node?.kind !== 'group' || node.axis !== 'vertical' || typeof node.id !== 'string') {
        continue;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      const top = sanitizeTopNode(children[0]);
      const bottom = sanitizeBottomNode(children[1]);
      if (!top || !bottom) continue;
      root.push({
        kind: 'group',
        id: node.id,
        axis: 'vertical',
        ratio: typeof node.ratio === 'number' ? node.ratio : 0.5,
        children: [top, bottom],
      });
    }
    const present = new Set();
    for (const node of root) collectPresentPanelIds(node, present);
    for (const panel of panels || []) {
      const tabId = Number(panel?.tabId);
      if (!Number.isFinite(tabId) || present.has(tabId)) continue;
      root.push({ kind: 'panel', tabId });
      present.add(tabId);
    }
    return { root };
  }

  function cssLengthToPx(value, fallback) {
    if (typeof value !== 'string') return fallback;
    const raw = value.trim();
    if (!raw) return fallback;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n)) return fallback;
    if (raw.endsWith('rem') || raw.endsWith('em')) {
      const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      return n * (Number.isFinite(rootSize) && rootSize > 0 ? rootSize : 16);
    }
    return n;
  }

  function tokenPx(name, fallback) {
    return cssLengthToPx(resolveChromeToken(name), fallback);
  }

  function panelSplitterSizePx() {
    return tokenPx('--bento-splitter-hit-size', 14);
  }

  function clampLayoutRatio(value, fallback = 0.5) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0.2, Math.min(0.8, n));
  }

  function collectLayoutLeafEntries(layout) {
    const entries = [];
    const visitHorizontalGroup = (node, rootNodeId) => {
      if (!node || node.kind !== 'group' || node.axis !== 'horizontal') return false;
      const left = node.children?.[0];
      const right = node.children?.[1];
      if (left?.kind === 'panel') {
        entries.push({
          tabId: Number(left.tabId),
          rootNodeId,
          role: 'split-child',
          horizontalGroupId: node.id,
        });
      }
      if (right?.kind === 'panel') {
        entries.push({
          tabId: Number(right.tabId),
          rootNodeId,
          role: 'split-child',
          horizontalGroupId: node.id,
        });
      }
      return true;
    };
    const visitBottom = (node, rootNodeId, role) => {
      if (!node) return;
      if (node.kind === 'panel') {
        entries.push({ tabId: Number(node.tabId), rootNodeId, role });
        return;
      }
      visitHorizontalGroup(node, rootNodeId);
    };

    for (const node of layout?.root || []) {
      if (node?.kind === 'panel') {
        entries.push({ tabId: Number(node.tabId), rootNodeId: 'panel:' + node.tabId, role: 'root' });
        continue;
      }
      if (node?.kind !== 'group' || node.axis !== 'vertical') continue;
      const rootNodeId = node.id;
      const top = node.children?.[0];
      const bottom = node.children?.[1];
      if (top?.kind === 'panel') {
        entries.push({
          tabId: Number(top.tabId),
          rootNodeId,
          role: 'subdivision-top',
          verticalGroupId: node.id,
        });
      } else {
        visitHorizontalGroup(top, rootNodeId);
      }
      visitBottom(bottom, rootNodeId, bottom?.kind === 'panel' ? 'subdivision-bottom' : 'split-child');
    }
    return entries.filter((entry) => Number.isFinite(entry.tabId));
  }

  function decoratePanelsForLayout(layout, panels) {
    const payloadByTabId = new Map((panels || []).map((panel) => [Number(panel?.tabId), panel]));
    const entries = collectLayoutLeafEntries(layout);
    const out = [];
    const seen = new Set();
    for (const entry of entries) {
      const payload = payloadByTabId.get(entry.tabId);
      if (!payload || seen.has(entry.tabId)) continue;
      seen.add(entry.tabId);
      out.push(Object.assign({}, payload, entry));
    }
    for (const payload of panels || []) {
      const tabId = Number(payload?.tabId);
      if (!Number.isFinite(tabId) || seen.has(tabId)) continue;
      seen.add(tabId);
      out.push(Object.assign({}, payload, { rootNodeId: 'panel:' + tabId, role: 'root' }));
    }
    return out;
  }

  function uniqueRootPanels(panels) {
    const out = [];
    const seen = new Set();
    for (const panel of panels || []) {
      const tabId = Number(panel?.tabId);
      if (!Number.isFinite(tabId)) continue;
      const rootNodeId = panel.rootNodeId || 'panel:' + tabId;
      if (seen.has(rootNodeId)) continue;
      seen.add(rootNodeId);
      out.push(Object.assign({}, panel, { rootNodeId }));
    }
    return out;
  }

  function getTrailerLayoutWidth(trailer) {
    if (!trailer) return 0;
    const saved = {
      width: trailer.style.width,
      minWidth: trailer.style.minWidth,
      maxWidth: trailer.style.maxWidth,
      flex: trailer.style.flex,
    };
    trailer.style.removeProperty('width');
    trailer.style.removeProperty('min-width');
    trailer.style.removeProperty('max-width');
    trailer.style.removeProperty('flex');
    try {
      const rectWidth = trailer.getBoundingClientRect?.().width || 0;
      if (rectWidth > 0) return rectWidth;
      const styles = getComputedStyle(trailer);
      const styleWidth = cssLengthToPx(styles.width, 0);
      if (styleWidth > 0) return styleWidth;
      // The host's widths come from the pinned --bento-panel-trailer-* tokens, so there
      // is no px guess to fall back on here.
      return cssLengthToPx(styles.minWidth, 0);
    } finally {
      if (saved.width) trailer.style.width = saved.width;
      else trailer.style.removeProperty('width');
      if (saved.minWidth) trailer.style.minWidth = saved.minWidth;
      else trailer.style.removeProperty('min-width');
      if (saved.maxWidth) trailer.style.maxWidth = saved.maxWidth;
      else trailer.style.removeProperty('max-width');
      if (saved.flex) trailer.style.flex = saved.flex;
      else trailer.style.removeProperty('flex');
    }
  }

  function computePanelLayoutGeometry(layout, panels, tabpanels, options = {}) {
    const widthByTabIdOverride =
      options.widthByTabId instanceof Map ? options.widthByTabId : new Map();
    const preferLivePanelWidths = options.preferLivePanelWidths === true;
    const panelByTabId = new Map((panels || []).map((panel) => [Number(panel?.tabId), panel]));
    const rootPanelById = new Map();
    for (const panel of panels || []) {
      const tabId = Number(panel?.tabId);
      if (!Number.isFinite(tabId)) continue;
      const rootNodeId = panel.rootNodeId || 'panel:' + tabId;
      if (!rootPanelById.has(rootNodeId)) rootPanelById.set(rootNodeId, panel);
    }

    const styles = getComputedStyle(tabpanels);
    const padLeft = cssLengthToPx(styles.paddingLeft, 8);
    const padRight = cssLengthToPx(styles.paddingRight, 8);
    const padTop = cssLengthToPx(styles.paddingTop, 8);
    const padBottom = cssLengthToPx(styles.paddingBottom, 44);
    const columnGap = cssLengthToPx(styles.columnGap, NaN);
    const gap = Number.isFinite(columnGap) ? columnGap : cssLengthToPx(styles.gap, 8);
    const splitterSize = panelSplitterSizePx();
    const minPanelWidth = tokenPx('--bento-panel-min-width', 380);
    const minMainWidth = tokenPx('--bento-main-panel-min-width', 640);
    const viewportWidth = Math.max(0, tabpanels.clientWidth || 0);
    const viewportHeight = Math.max(0, tabpanels.clientHeight || 0);
    const contentHeight = Math.max(120, viewportHeight - padTop - padBottom);

    const liveWidthForTabId = (tabId) => {
      const panelEl = document.querySelector('[data-bento-panel-tab-id="' + Number(tabId) + '"]');
      const rectWidth = panelEl?.getBoundingClientRect?.().width || 0;
      return rectWidth > 0 ? Math.round(rectWidth) : 0;
    };

    const overrideWidthForTabId = (tabId) => {
      const overrideWidth = Number(widthByTabIdOverride.get(Number(tabId)));
      if (Number.isFinite(overrideWidth) && overrideWidth > 0) return Math.round(overrideWidth);
      return 0;
    };

    const payloadWidthForTabId = (tabId) => {
      const payload = panelByTabId.get(Number(tabId));
      const payloadWidth = Number(payload?.widthPx);
      if (Number.isFinite(payloadWidth) && payloadWidth > 0) return Math.round(payloadWidth);
      return 0;
    };

    const existingWidthForTabId = (tabId) => {
      const overrideWidth = overrideWidthForTabId(tabId);
      if (overrideWidth > 0) return overrideWidth;
      if (preferLivePanelWidths) {
        const liveWidth = liveWidthForTabId(tabId);
        if (liveWidth > 0) return liveWidth;
      }
      const payloadWidth = payloadWidthForTabId(tabId);
      if (payloadWidth > 0) return payloadWidth;
      const liveWidth = liveWidthForTabId(tabId);
      if (liveWidth > 0) return liveWidth;
      return minPanelWidth;
    };

    const firstPanelNode = (node) => {
      if (node?.kind === 'panel') return node;
      if (node?.kind === 'group' && node.axis === 'horizontal') {
        return firstPanelNode(node.children?.[0]) || firstPanelNode(node.children?.[1]);
      }
      return null;
    };

    const rootWidth = (node) => {
      if (node?.kind === 'panel') return existingWidthForTabId(node.tabId);
      if (node?.kind === 'group' && node.axis === 'vertical') {
        const anchor = firstPanelNode(node.children?.[0]) || firstPanelNode(node.children?.[1]);
        if (anchor) {
          const overrideWidth = overrideWidthForTabId(anchor.tabId);
          if (overrideWidth > 0) return overrideWidth;
          if (preferLivePanelWidths) {
            const liveRootWidth = currentPanelLayoutGeometry?.rootRects?.get(node.id)?.width;
            if (Number.isFinite(liveRootWidth) && liveRootWidth > 0) {
              return Math.round(liveRootWidth);
            }
          }
          const payloadWidth = payloadWidthForTabId(anchor.tabId);
          if (payloadWidth > 0) return payloadWidth;
          const liveRootWidth = currentPanelLayoutGeometry?.rootRects?.get(node.id)?.width;
          if (Number.isFinite(liveRootWidth) && liveRootWidth > 0) return Math.round(liveRootWidth);
          return existingWidthForTabId(anchor.tabId);
        }
      }
      return minPanelWidth;
    };

    const rootNodes = Array.isArray(layout?.root) ? layout.root : [];
    const rootWidths = rootNodes.map(rootWidth);
    const trailer = document.getElementById('bento-add-panel-trailer');
    const trailerWidth = getTrailerLayoutWidth(trailer);
    const sideGapCount = rootNodes.length + (trailer ? 1 : 0);
    const sideWidth =
      rootWidths.reduce((sum, width) => sum + width, 0) +
      Math.max(0, sideGapCount) * gap +
      trailerWidth;
    const mainWidthOverride = Number(options.mainWidthPx);
    const mainWidth =
      Number.isFinite(mainWidthOverride) && mainWidthOverride > 0
        ? Math.round(mainWidthOverride)
        : mainPanelWidth !== null
        ? mainPanelWidth
        : Math.max(minMainWidth, viewportWidth - padLeft - padRight - sideWidth);

    const panelRects = new Map();
    const rootRects = new Map();
    const splitters = [];
    const choosers = [];

    const addPanelRect = (node, rect, rootNodeId) => {
      if (node?.kind !== 'panel') return;
      const tabId = Number(node.tabId);
      if (!panelByTabId.has(tabId)) return;
      panelRects.set(tabId, Object.assign({ rootNodeId }, rect));
    };

    const layoutHorizontalGroup = (node, rect, rootNodeId) => {
      const ratio = clampLayoutRatio(node.ratio);
      const leftWidth = Math.max(0, (rect.width - splitterSize) * ratio);
      const rightWidth = Math.max(0, rect.width - splitterSize - leftWidth);
      const leftRect = {
        left: rect.left,
        top: rect.top,
        width: leftWidth,
        height: rect.height,
      };
      const splitterRect = {
        left: rect.left + leftWidth,
        top: rect.top,
        width: splitterSize,
        height: rect.height,
      };
      const rightRect = {
        left: splitterRect.left + splitterSize,
        top: rect.top,
        width: rightWidth,
        height: rect.height,
      };
      addPanelRect(node.children?.[0], leftRect, rootNodeId);
      addPanelRect(node.children?.[1], rightRect, rootNodeId);
      splitters.push({
        axis: 'horizontal',
        groupId: node.id,
        rect: splitterRect,
        groupRect: rect,
      });
    };

    const layoutVerticalChild = (node, rect, rootNodeId) => {
      if (!node) return;
      if (node.kind === 'panel') {
        addPanelRect(node, rect, rootNodeId);
        return;
      }
      if (node.kind === 'chooser') {
        choosers.push({
          id: node.id,
          ownerTabId: Number(node.ownerTabId),
          groupId: rootNodeId,
          rect,
        });
        return;
      }
      if (node.kind === 'group' && node.axis === 'horizontal') {
        layoutHorizontalGroup(node, rect, rootNodeId);
      }
    };

    let x = padLeft;
    const mainRect = { left: x, top: padTop, width: mainWidth, height: contentHeight };
    x += mainWidth + gap;

    for (let i = 0; i < rootNodes.length; i++) {
      const node = rootNodes[i];
      const width = rootWidths[i] || minPanelWidth;
      const rootNodeId = node?.kind === 'panel' ? 'panel:' + node.tabId : node?.id;
      const rootRect = { left: x, top: padTop, width, height: contentHeight };
      if (rootNodeId) rootRects.set(rootNodeId, rootRect);
      if (node?.kind === 'panel') {
        addPanelRect(node, rootRect, rootNodeId);
      } else if (node?.kind === 'group' && node.axis === 'vertical') {
        const ratio = clampLayoutRatio(node.ratio);
        const topHeight = Math.max(0, (contentHeight - splitterSize) * ratio);
        const bottomHeight = Math.max(0, contentHeight - splitterSize - topHeight);
        const topRect = { left: x, top: padTop, width, height: topHeight };
        const splitterRect = {
          left: x,
          top: padTop + topHeight,
          width,
          height: splitterSize,
        };
        const bottomRect = {
          left: x,
          top: splitterRect.top + splitterSize,
          width,
          height: bottomHeight,
        };
        layoutVerticalChild(node.children?.[0], topRect, rootNodeId);
        layoutVerticalChild(node.children?.[1], bottomRect, rootNodeId);
        splitters.push({
          axis: 'vertical',
          groupId: node.id,
          rect: splitterRect,
          groupRect: rootRect,
        });
      }
      x += width + gap;
    }

    const trailerRect = trailer
      ? { left: x, top: padTop, width: trailerWidth, height: contentHeight }
      : null;
    const totalWidth = Math.max(viewportWidth, x + (trailer ? trailerWidth + gap : 0) + padRight);
    return { mainRect, panelRects, rootRects, splitters, choosers, trailerRect, totalWidth };
  }

  function ensureFlatLayoutExtent(tabpanels, totalWidth) {
    let extent = document.getElementById('bento-flat-layout-extent');
    if (!extent) {
      extent = document.createXULElement('hbox');
      extent.id = 'bento-flat-layout-extent';
      extent.setAttribute('aria-hidden', 'true');
      tabpanels.appendChild(extent);
    } else if (extent.parentNode !== tabpanels) {
      tabpanels.appendChild(extent);
    }
    extent.style.width = Math.max(0, Math.round(totalWidth || 0)) + 'px';
  }

  function applyRectStyle(el, rect) {
    if (!el || !rect) return;
    el.style.left = Math.round(rect.left) + 'px';
    el.style.top = Math.round(rect.top) + 'px';
    el.style.width = Math.max(0, Math.round(rect.width)) + 'px';
    el.style.minWidth = Math.max(0, Math.round(rect.width)) + 'px';
    el.style.maxWidth = Math.max(0, Math.round(rect.width)) + 'px';
    el.style.height = Math.max(0, Math.round(rect.height)) + 'px';
    el.style.minHeight = Math.max(0, Math.round(rect.height)) + 'px';
    el.style.maxHeight = Math.max(0, Math.round(rect.height)) + 'px';
    el.style.flex = '0 0 auto';
  }

  function applyPanelLayoutRects(tabpanels, geometry) {
    if (!tabpanels || !geometry) return;
    tabpanels.classList.add('bento-flat-panel-layout');
    ensureFlatLayoutExtent(tabpanels, geometry.totalWidth);
    const mainPanel = tabpanels.querySelector(':scope > [data-bento-main-panel]');
    applyRectStyle(mainPanel, geometry.mainRect);
    for (const panelEl of tabpanels.querySelectorAll(':scope > [data-bento-panel-tab-id]')) {
      const tabId = Number(panelEl.dataset.bentoPanelTabId);
      const rect = geometry.panelRects.get(tabId);
      if (!rect) continue;
      panelEl.dataset.bentoRootNodeId = rect.rootNodeId || 'panel:' + tabId;
      applyRectStyle(panelEl, rect);
    }
    const trailer = document.getElementById('bento-add-panel-trailer');
    if (trailer && geometry.trailerRect) applyRectStyle(trailer, geometry.trailerRect);
  }

  function refreshFlatPanelLayoutFromLiveState(options = {}) {
    const tabpanels = window.gBrowser?.tabpanels;
    if (!tabpanels?.classList?.contains('bento-flat-panel-layout')) return false;
    return preserveStripScrollDuringLiveLayout(
      () => {
        currentPanelLayoutGeometry = computePanelLayoutGeometry(
          currentPanelLayout,
          __lastPanelsPayload,
          tabpanels,
          Object.assign({ preferLivePanelWidths: true }, options),
        );
        applyPanelLayoutRects(tabpanels, currentPanelLayoutGeometry);
        return true;
      },
      () => {
        syncFlatLayoutOverlays(tabpanels, currentPanelLayoutGeometry);
        syncInterPanelSplitters();
      },
    );
  }

  function clearFlatPanelLayout(tabpanels) {
    if (!tabpanels) return;
    currentPanelLayoutGeometry = null;
    tabpanels.classList.remove('bento-flat-panel-layout');
    document.getElementById('bento-flat-layout-extent')?.remove();
    const host = document.getElementById('bento-side-panel-host');
    for (const el of host?.querySelectorAll?.(
      ':scope > .bento-layout-vsplitter, :scope > .bento-layout-hsplitter, :scope > .bento-layout-chooser',
    ) || []) {
      el.remove();
    }
  }

  function applyPanelLayoutStatusAttributes(statusByTabId) {
    for (const panelEl of document.querySelectorAll('[data-bento-panel-tab-id]')) {
      const tabId = Number(panelEl.dataset.bentoPanelTabId);
      const status = statusByTabId?.get?.(tabId) || 'unknown';
      panelEl.dataset.bentoPanelLayoutStatus = status;
    }
  }

  // Maps a rect in panel-layout coordinates to viewport coordinates inside the
  // side-panel host. Top-level so the DevTools connector fallback in
  // getViewportPanelRectForTabId and the header-drag drop targets share it.
  function viewportRectForLocalLayoutRect(rect) {
    if (!rect) return null;
    const host = document.getElementById('bento-side-panel-host');
    const hostLocal = viewportRectForLayoutRect(window.gBrowser?.tabpanels, rect);
    if (!host || !hostLocal) return null;
    const hostRect = host.getBoundingClientRect();
    return {
      left: hostRect.left + hostLocal.left,
      top: hostRect.top + hostLocal.top,
      right: hostRect.left + hostLocal.left + hostLocal.width,
      bottom: hostRect.top + hostLocal.top + hostLocal.height,
      width: hostLocal.width,
      height: hostLocal.height,
    };
  }

  function viewportRectForLayoutRect(tabpanels, rect) {
    const host = document.getElementById('bento-side-panel-host');
    if (!host || !tabpanels || !rect) return null;
    const hostRect = host.getBoundingClientRect();
    const tabpanelsRect = tabpanels.getBoundingClientRect();
    return {
      left: tabpanelsRect.left - hostRect.left - tabpanels.scrollLeft + rect.left,
      top: tabpanelsRect.top - hostRect.top + rect.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function rectOverlapsBentoSidebar(rect) {
    const sidebar = document.getElementById('bento-shell-host');
    if (!sidebar || !rect) return false;
    const sidebarRect = sidebar.getBoundingClientRect();
    return (
      rect.left < sidebarRect.right &&
      rect.right > sidebarRect.left &&
      rect.top < sidebarRect.bottom &&
      rect.bottom > sidebarRect.top
    );
  }

  function setSidebarOccludedOverlayState(el, viewportRect) {
    const occluded = rectOverlapsBentoSidebar(viewportRect);
    if (occluded) {
      el.style.setProperty('pointer-events', 'none', 'important');
      el.style.visibility = 'hidden';
    } else {
      el.style.removeProperty('pointer-events');
      el.style.removeProperty('visibility');
    }
  }

  function createLayoutSplitter(axis) {
    const splitter = document.createXULElement('splitter');
    splitter.className =
      axis === 'vertical'
        ? 'bento-subdivision-vsplitter bento-layout-vsplitter'
        : 'bento-subdivision-hsplitter bento-layout-hsplitter';
    splitter.setAttribute('resizebefore', 'none');
    splitter.setAttribute('resizeafter', 'none');
    splitter.addEventListener('pointerdown', (e) => startLayoutSplitterDrag(splitter, e));
    splitter.addEventListener('pointermove', (e) => onLayoutSplitterDrag(splitter, e));
    splitter.addEventListener('pointerup', (e) => endLayoutSplitterDrag(splitter, e));
    splitter.addEventListener('pointercancel', (e) => endLayoutSplitterDrag(splitter, e));
    splitter.addEventListener('lostpointercapture', () => endLayoutSplitterDrag(splitter, null));
    splitter.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
    });
    return splitter;
  }

  function findCurrentLayoutGroup(groupId) {
    if (!groupId) return null;
    const visitChild = (node) => {
      if (!node) return null;
      if (node.kind === 'group') return visitGroup(node);
      return null;
    };
    const visitGroup = (node) => {
      if (!node || node.kind !== 'group') return null;
      if (node.id === groupId) return node;
      if (node.axis === 'vertical') {
        return visitChild(node.children?.[0]) || visitChild(node.children?.[1]);
      }
      return null;
    };
    for (const node of currentPanelLayout?.root || []) {
      const found = visitGroup(node);
      if (found) return found;
    }
    return null;
  }

  function getPanelElementsForLayoutGroup(groupId) {
    const group = findCurrentLayoutGroup(groupId);
    if (!group) return [];
    const tabIds = [];
    const collect = (node) => {
      if (!node) return;
      if (node.kind === 'panel') {
        const tabId = Number(node.tabId);
        if (Number.isFinite(tabId)) tabIds.push(tabId);
        return;
      }
      if (node.kind === 'group') {
        collect(node.children?.[0]);
        collect(node.children?.[1]);
      }
    };
    collect(group);
    return tabIds
      .map((tabId) =>
        document.querySelector(
          '[data-bento-panel-tab-id="' + CSS.escape(String(tabId)) + '"]',
        ),
      )
      .filter(Boolean);
  }

  function ratioFromLayoutPointer(axis, groupRect, clientX, clientY) {
    if (!groupRect) return 0.5;
    const splitterSize = panelSplitterSizePx();
    const point = axis === 'vertical' ? clientY : clientX;
    const start = axis === 'vertical' ? groupRect.top : groupRect.left;
    const size = axis === 'vertical' ? groupRect.height : groupRect.width;
    const usable = Math.max(1, size - splitterSize);
    return clampLayoutRatio((point - start - splitterSize / 2) / usable);
  }

  function updateFlatLayoutOverlayPositions(tabpanels, geometry) {
    const host = document.getElementById('bento-side-panel-host');
    if (!host || !tabpanels || !geometry) return;
    const hostRect = host.getBoundingClientRect();
    for (const splitterInfo of geometry.splitters || []) {
      const splitter = Array.from(
        host.querySelectorAll(':scope > .bento-layout-vsplitter, :scope > .bento-layout-hsplitter'),
      ).find((el) => el._bentoGroupId === splitterInfo.groupId);
      if (!splitter) continue;
      const rect = viewportRectForLayoutRect(tabpanels, splitterInfo.rect);
      const groupRect = viewportRectForLayoutRect(tabpanels, splitterInfo.groupRect);
      if (!rect || !groupRect) continue;
      splitter._bentoGroupViewportRect = {
        left: groupRect.left + hostRect.left,
        top: groupRect.top + hostRect.top,
        width: groupRect.width,
        height: groupRect.height,
      };
      splitter.style.left = Math.round(rect.left) + 'px';
      splitter.style.top = Math.round(rect.top) + 'px';
      splitter.style.width = Math.max(0, Math.round(rect.width)) + 'px';
      splitter.style.height = Math.max(0, Math.round(rect.height)) + 'px';
      setSidebarOccludedOverlayState(splitter, {
        left: hostRect.left + rect.left,
        top: hostRect.top + rect.top,
        right: hostRect.left + rect.left + rect.width,
        bottom: hostRect.top + rect.top + rect.height,
      });
    }
    for (const chooserInfo of geometry.choosers || []) {
      const chooser = Array.from(host.querySelectorAll(':scope > .bento-layout-chooser')).find(
        (el) => el._bentoChooserId === chooserInfo.id,
      );
      if (!chooser) continue;
      const rect = viewportRectForLayoutRect(tabpanels, chooserInfo.rect);
      if (!rect) continue;
      chooser.style.left = Math.round(rect.left) + 'px';
      chooser.style.top = Math.round(rect.top) + 'px';
      chooser.style.width = Math.max(0, Math.round(rect.width)) + 'px';
      chooser.style.height = Math.max(0, Math.round(rect.height)) + 'px';
    }
  }

  function applyLiveLayoutGroupRatio(groupId, ratio) {
    const group = findCurrentLayoutGroup(groupId);
    const tabpanels = window.gBrowser?.tabpanels;
    if (!group || !tabpanels) return false;
    return preserveStripScrollDuringLiveLayout(
      () => {
        group.ratio = clampLayoutRatio(ratio);
        currentPanelLayoutGeometry = computePanelLayoutGeometry(
          currentPanelLayout,
          __lastPanelsPayload,
          tabpanels,
          {
            mainWidthPx: currentPanelLayoutGeometry?.mainRect?.width,
            preferLivePanelWidths: true,
          },
        );
        applyPanelLayoutRects(tabpanels, currentPanelLayoutGeometry);
        return true;
      },
      () => {
        updateFlatLayoutOverlayPositions(tabpanels, currentPanelLayoutGeometry);
        syncInterPanelSplitters();
      },
    );
  }

  function startLayoutSplitterDrag(splitter, e) {
    if (e.button !== 0) return;
    const groupRect = splitter._bentoGroupViewportRect;
    if (!groupRect) return;
    e.preventDefault();
    e.stopPropagation();
    suppressPanelFocusAutoScrollForSplitterInteraction();
    splitter._bentoLayoutDrag = {
      axis: splitter._bentoAxis,
      groupId: splitter._bentoGroupId,
      groupRect,
      pointerId: e.pointerId,
      lastRatio: null,
    };
    try {
      splitter.setPointerCapture(e.pointerId);
    } catch {}
    beginBentoPanelResize();
    splitter.classList.add(
      splitter._bentoAxis === 'vertical'
        ? 'bento-subdivision-vsplitter--dragging'
        : 'bento-subdivision-hsplitter--dragging',
    );
    document.documentElement.style.setProperty(
      'cursor',
      splitter._bentoAxis === 'vertical' ? 'row-resize' : 'col-resize',
      'important',
    );
    document.documentElement.style.setProperty('user-select', 'none', 'important');
  }

  function onLayoutSplitterDrag(splitter, e) {
    const drag = splitter._bentoLayoutDrag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    suppressPanelFocusAutoScrollForSplitterInteraction();
    const ratio = ratioFromLayoutPointer(drag.axis, drag.groupRect, e.clientX, e.clientY);
    drag.lastRatio = ratio;
    applyLiveLayoutGroupRatio(drag.groupId, ratio);
  }

  function endLayoutSplitterDrag(splitter, e) {
    const drag = splitter._bentoLayoutDrag;
    if (!drag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== drag.pointerId) return;
    suppressPanelFocusAutoScrollForSplitterInteraction();
    try {
      splitter.releasePointerCapture(drag.pointerId);
    } catch {}
    splitter._bentoLayoutDrag = null;
    splitter.classList.remove('bento-subdivision-vsplitter--dragging', 'bento-subdivision-hsplitter--dragging');
    document.documentElement.style.removeProperty('cursor');
    document.documentElement.style.removeProperty('user-select');
    endBentoPanelResize();
    const point =
      drag.axis === 'vertical'
        ? (e?.clientY ?? splitter.getBoundingClientRect().top + splitter.getBoundingClientRect().height / 2)
        : (e?.clientX ?? splitter.getBoundingClientRect().left + splitter.getBoundingClientRect().width / 2);
    const ratio =
      typeof drag.lastRatio === 'number'
        ? drag.lastRatio
        : ratioFromLayoutPointer(
            drag.axis,
            drag.groupRect,
            drag.axis === 'vertical' ? 0 : point,
            drag.axis === 'vertical' ? point : 0,
          );
    applyLiveLayoutGroupRatio(drag.groupId, ratio);
    dispatchShellAction({
      type: 'panelLayout/setGroupRatio',
      groupId: drag.groupId,
      ratio,
    });
  }

  // What a subdivision chooser shows: its owner, whether it has a close button, and the saved
  // panels it lists. A chooser whose signature is unchanged is kept as it is.
  function layoutChooserSignature(chooserInfo) {
    return JSON.stringify([
      chooserInfo.ownerTabId,
      chooserInfo.groupId || null,
      currentSavedPanelItems
        .slice(0, 12)
        .filter((item) => item?.url)
        .map((item) => [item.title, item.url, item.favIconUrl]),
    ]);
  }

  // Reconciles the splitters and subdivision choosers of the flat layout with `geometry`, by
  // splitter group and axis and by chooser id. A node that is removed and created again has no
  // style to transition from, so rebuilding them on every payload (and scroll and layout
  // refresh) made a visible chooser appear in the colours of a mode flip that was only being
  // prepared, and a hovered splitter lose its transition. Matching nodes are kept and updated in
  // place; only obsolete ones are removed and only new or changed ones are created.
  function syncFlatLayoutOverlays(tabpanels, geometry) {
    const host = document.getElementById('bento-side-panel-host');
    if (!host || !tabpanels || !geometry) return;
    const existing = new Map();
    for (const el of host.querySelectorAll(
      ':scope > .bento-layout-vsplitter, :scope > .bento-layout-hsplitter, :scope > .bento-layout-chooser',
    )) {
      existing.set(el._bentoOverlayKey, el);
    }
    const hostRect = host.getBoundingClientRect();
    const desired = [];
    for (const splitterInfo of geometry.splitters || []) {
      const rect = viewportRectForLayoutRect(tabpanels, splitterInfo.rect);
      const groupRect = viewportRectForLayoutRect(tabpanels, splitterInfo.groupRect);
      if (!rect || !groupRect) continue;
      const key = 'splitter:' + splitterInfo.axis + ':' + splitterInfo.groupId;
      let splitter = existing.get(key);
      existing.delete(key);
      if (!splitter) {
        splitter = createLayoutSplitter(splitterInfo.axis);
        splitter._bentoOverlayKey = key;
        splitter._bentoAxis = splitterInfo.axis;
        splitter._bentoGroupId = splitterInfo.groupId;
        splitter.dataset.bentoGroupId = splitterInfo.groupId;
        splitter.dataset.bentoAxis = splitterInfo.axis;
      }
      splitter._bentoGroupViewportRect = {
        left: groupRect.left + hostRect.left,
        top: groupRect.top + hostRect.top,
        width: groupRect.width,
        height: groupRect.height,
      };
      splitter.style.left = Math.round(rect.left) + 'px';
      splitter.style.top = Math.round(rect.top) + 'px';
      splitter.style.width = Math.max(0, Math.round(rect.width)) + 'px';
      splitter.style.height = Math.max(0, Math.round(rect.height)) + 'px';
      setSidebarOccludedOverlayState(splitter, {
        left: hostRect.left + rect.left,
        top: hostRect.top + rect.top,
        right: hostRect.left + rect.left + rect.width,
        bottom: hostRect.top + rect.top + rect.height,
      });
      desired.push(splitter);
    }
    for (const chooserInfo of geometry.choosers || []) {
      const rect = viewportRectForLayoutRect(tabpanels, chooserInfo.rect);
      if (!rect) continue;
      const key = 'chooser:' + chooserInfo.id;
      const signature = layoutChooserSignature(chooserInfo);
      let chooser = existing.get(key);
      existing.delete(key);
      if (chooser && chooser._bentoChooserSignature !== signature) {
        chooser.remove();
        chooser = null;
      }
      if (!chooser) {
        chooser = createSubdivisionChooser(
          chooserInfo.ownerTabId,
          chooserInfo.id,
          chooserInfo.groupId,
        );
        chooser.classList.add('bento-layout-chooser');
        chooser._bentoOverlayKey = key;
        chooser._bentoChooserId = chooserInfo.id;
        chooser._bentoChooserSignature = signature;
        chooser.setAttribute('data-bento-chooser-id', chooserInfo.id);
        chooser.setAttribute('data-bento-owner-tab-id', String(chooserInfo.ownerTabId));
      }
      chooser.style.left = Math.round(rect.left) + 'px';
      chooser.style.top = Math.round(rect.top) + 'px';
      chooser.style.width = Math.max(0, Math.round(rect.width)) + 'px';
      chooser.style.height = Math.max(0, Math.round(rect.height)) + 'px';
      desired.push(chooser);
    }
    for (const obsolete of existing.values()) obsolete.remove();
    placeInOrder(host, desired);
  }

  function getPromotedChildWidthsForClosingTop(tabId) {
    const widths = [];
    const visit = (node) => {
      if (!node || node.kind !== 'group' || node.axis !== 'vertical') return;
      const top = node.children?.[0];
      if (top?.kind !== 'panel' || Number(top.tabId) !== Number(tabId)) return;
      const bottom = node.children?.[1];
      const add = (panelNode) => {
        if (panelNode?.kind !== 'panel') return;
        const rect = currentPanelLayoutGeometry?.panelRects?.get(Number(panelNode.tabId));
        const widthPx = rect ? Math.round(rect.width) : 0;
        if (widthPx > 0) widths.push({ tabId: Number(panelNode.tabId), widthPx });
      };
      if (bottom?.kind === 'panel') add(bottom);
      if (bottom?.kind === 'group' && bottom.axis === 'horizontal') {
        add(bottom.children?.[0]);
        add(bottom.children?.[1]);
      }
    };
    for (const node of currentPanelLayout?.root || []) visit(node);
    return widths;
  }

  // The most recent split-view marker dispatched via TabSplitViewActivate.
  // We need to dispatch a matching TabSplitViewDeactivate (with === identity)
  // before activating the next marker so gBrowser.#activeSplitView is cleared
  // properly. Null when no split is currently active.
  let __lastSplitViewMarker = null;

  // Marker assigned to `tab.splitview` for tabs Bento puts into the
  // split. Firefox's setSplitViewActive() in tabbox.js gates the
  // [splitview] attribute on tabpanels by `selectedTab.splitview &&
  // updatedValue` (a boolean check), so the marker must be truthy.
  //
  // It also has to expose `.tabs` (the array of tabs in the split) and
  // `.activeTab` because Firefox's tabbrowser.js progress listener does
  // `this.mTab.splitview.tabs.indexOf(this.mTab)` on every onLocation-
  // Change for split-view tabs (browser/components/tabbrowser/content/
  // tabbrowser.js:9594). Without `.tabs` the read throws Uncaught
  // TypeError, which aborts Firefox's progress-listener bookkeeping and
  // leaves panel docShells in a half-broken state (this surfaced as
  // "panels go blank when focus leaves them" during smoke testing).
  //
  // Each reconcile creates a fresh marker bound to the current
  // tabsToRender array; the same marker object is shared by every tab
  // in the split, so `tab.splitview.tabs.indexOf(tab)` always finds the
  // tab and returns its slot index.
  const BENTO_SPLIT_KIND = 'bento-split';
  function makeSplitViewMarker(tabs) {
    return {
      kind: BENTO_SPLIT_KIND,
      get tabs() {
        return tabs;
      },
      get activeTab() {
        return tabs[0];
      },
      // tabbrowser.js:_insertTabAtIndex (line ~4867) treats `tab.splitview`
      // as a MozTabSplitViewWrapper DOM element — when the opener tab is
      // the first in the split, it does `itemAfter = splitview` then
      // `node.before(newTab)`. Without these shims our plain-object marker
      // throws "node.before is not a function" on right-click→Open in New
      // Tab and on Cmd+Shift+T panel restore. Delegating to the first /
      // last tab in the split places the new tab adjacent to ours in the
      // (hidden) tab strip, matching Firefox's intent.
      before(newNode) {
        tabs[0]?.before(newNode);
      },
      get nextElementSibling() {
        return tabs[tabs.length - 1]?.nextElementSibling || null;
      },
    };
  }

  // Reconciles the split-view layout to match the current panels payload
  // (bento-tools' side-panel set) plus gBrowser.selectedTab (the active
  // sidebar tab — always slot 0 of splitViewPanels). This is the single
  // entry point for layout updates, called from both runtime panels/sync
  // messages and from window-level selection signals (TabSelect /
  // TabOpen / tp.select).
  //
  // ── The N-panel split-view fix architecture ────────────────────────
  // Firefox's split-view machinery (toolkit/content/widgets/tabbox.js +
  // browser/components/tabbrowser/AsyncTabSwitcher.sys.mjs) is built for
  // a 2-panel UI driven by MozTabSplitViewWrapper. Bento drives N
  // simultaneous panels directly via tabpanels.splitViewPanels = [...]
  // and dispatches the same TabSplitViewActivate event the wrapper
  // emits, which feeds gBrowser.#activeSplitView and makes
  // splitViewBrowsers / shouldDeactivateDocShell respect our panels.
  //
  // Several pieces of Firefox's per-tab activation lifecycle don't
  // hold up under this usage. The fix is three coordinated mechanisms;
  // removing any one re-introduces a specific failure mode:
  //
  // 1. tab.splitview marker (set via Object.defineProperty per-tab,
  //    BEFORE the cleanup loop). Required so setSplitViewActive's
  //    `gBrowser.selectedTab.splitview && updatedValue` gate keeps
  //    [splitview] = true throughout the cleanup. Without it, cleanup
  //    transiently removes [splitview] and the AsyncTabSwitcher
  //    queues docShell deactivations that race with the rebuild.
  //    The marker also exposes `.tabs`, which Firefox's onLocationChange
  //    needs (tabbrowser.js:9594 reads `.splitview.tabs.indexOf(tab)`).
  //
  // 2. preserveLayers(true) before docShellIsActive=false on departing
  //    tabs (cleanup loop). Without it, Firefox destroys the browser's
  //    compositor layer when deactivated; on re-entry the slot stays
  //    blank for one paint cycle even though all activation invariants
  //    hold. preserveLayers caches the layer so re-entry paints
  //    immediately.
  //
  // 3. gBrowser.warmupTab(tab) for every tab in tabsToKeepActive (after
  //    showSplitViewPanels). The AsyncTabSwitcher (gBrowser._switcher)
  //    is created lazily and DESTROYS itself after every successful
  //    tab switch (AsyncTabSwitcher.sys.mjs:343 finish() calls
  //    destroy() which sets tabbrowser._switcher = null). When the
  //    switcher is null, gBrowser.on_visibilitychange takes the
  //    `!this._switcher` fallback (tabbrowser.js:8158) which iterates
  //    selectedBrowsers and forces docShellIsActive = !document.hidden
  //    — silently deactivating panels on every visibility transition
  //    with no path back. Calling the public warmupTab API recreates
  //    the switcher so the fallback never runs. Belt-and-suspenders:
  //    we also override on_visibilitychange to no-op while in
  //    split-view mode (see attachTabSelectListener) for the windows
  //    where the switcher gets destroyed between reconciles.
  //
  // The combined effect: panels stay painted across sidebar tab
  // switches, Cmd+T, window minimise/restore, and DevTools toggling.
  function reconcilePanelsSplitView(panels, options = {}) {
    if (handingOverTabs) return;
    if (!window.gBrowser) {
      console.warn('[bento-shell-mount] reconcilePanelsSplitView: gBrowser unavailable');
      return;
    }
    const gBrowser = window.gBrowser;
    const tabpanels = gBrowser.tabpanels;
    if (!tabpanels) {
      console.warn('[bento-shell-mount] reconcilePanelsSplitView: tabpanels unavailable');
      return;
    }
    // Capture the previous panel-set for "did a new panel just get
    // added?" detection at the end of this function — so we can
    // auto-scroll the strip to bring the freshly-added panel into
    // view. Snapshot BEFORE overwriting __lastPanelsPayload below;
    // otherwise the comparison would always show zero deltas.
    const previousTabIds = new Set(__lastPanelsPayload.map((p) => p.tabId));
    const isInitialReconcileForWorkspace = __reconciledForWorkspace !== currentWorkspaceId;
    const previousFocusedPanelTabId = Number.isFinite(currentFocusedPanelTabId)
      ? currentFocusedPanelTabId
      : null;
    const previousFocusedPanelCycleIndex =
      previousFocusedPanelTabId !== null
        ? getCycleIndexForPanelTabId(previousFocusedPanelTabId)
        : -1;
    const incomingPanelTabIds = new Set(
      panels
        .map((panel) => Number(panel?.tabId))
        .filter((tabId) => Number.isFinite(tabId) && Number.isInteger(tabId)),
    );
    const shouldPromoteFocusAfterPanelRemoval =
      !isInitialReconcileForWorkspace &&
      previousFocusedPanelTabId !== null &&
      !incomingPanelTabIds.has(previousFocusedPanelTabId);
    const materializeRetry = Number.isInteger(options.materializeRetry)
      ? options.materializeRetry
      : 0;
    let hasPendingMaterialization = false;
    let materializeRetryScheduled = false;
    const scheduleMaterializeRetry = () => {
      hasPendingMaterialization = true;
      if (materializeRetryScheduled || materializeRetry >= 8) return;
      materializeRetryScheduled = true;
      const delay = Math.min(500, 50 + materializeRetry * 75);
      window.setTimeout(() => {
        reconcilePanelsSplitView(__lastPanelsPayload, {
          ...options,
          materializeRetry: materializeRetry + 1,
        });
      }, delay);
    };
    __lastPanelsPayload = panels.slice();

    // No panels in the workspace → tear down split-view entirely
    // instead of wrapping the lone selected tab in a 1-element "split".
    // The previous behaviour added .split-view-panel-active to the tab's
    // notificationbox, which applies the .split-view-panel-active margin
    // from content-area.css:170 — visible as a small inset around an
    // otherwise-normal full-width tab. Also avoids dispatching repeated
    // TabSplitViewActivate cycles on every TabSelect when there are no
    // panels (which TabSelect fires for whether a workspace has panels
    // or not).
    if (!panels || panels.length === 0) {
      cancelWorkspaceFadeForMainOnly();
      setNoSidePanelsMode(true);
      const previous = tabpanels.splitViewPanels || [];
      const splitActive = tabpanels.classList.contains('bento-split-active');
      const mainOnlyStyleProps = [
        'order',
        'left',
        'top',
        'width',
        'min-width',
        'max-width',
        'height',
        'min-height',
        'max-height',
        'flex',
      ];
      const clearMainOnlyArtifactsForTab = (tab) => {
        if (tab?.splitview && tab.splitview.kind === BENTO_SPLIT_KIND) {
          delete tab.splitview;
        }
        const linkedPanel = tab?.linkedPanel;
        if (!linkedPanel) return;
        const panelEl = document.getElementById(linkedPanel);
        if (!panelEl) return;
        delete panelEl.dataset.bentoMainPanel;
        delete panelEl.dataset.bentoPanelTabId;
        delete panelEl.dataset.bentoRootNodeId;
        for (const prop of mainOnlyStyleProps) {
          panelEl.style.removeProperty(prop);
        }
        panelEl.classList.remove(
          'split-view-panel',
          'split-view-panel-active',
          'bento-panel--focused',
          'bento-panel--cycle-focused',
        );
        panelEl.removeAttribute('column');
        if (panelEl.getAttribute('tabindex') === '-1') {
          panelEl.removeAttribute('tabindex');
        }
        removeInjectedPanelHeader(panelEl);
      };
      const hasMainOnlyArtifacts = () => {
        if (tabpanels.classList.contains('bento-flat-panel-layout')) return true;
        if (document.getElementById('bento-flat-layout-extent')) return true;
        const host = document.getElementById('bento-side-panel-host');
        if (
          host?.querySelector?.(
            ':scope > .bento-layout-vsplitter, :scope > .bento-layout-hsplitter, :scope > .bento-layout-chooser',
          )
        ) {
          return true;
        }
        for (const tab of gBrowser.tabs) {
          if (tab?.splitview && tab.splitview.kind === BENTO_SPLIT_KIND) return true;
          const linkedPanel = tab?.linkedPanel;
          if (!linkedPanel) continue;
          const panelEl = document.getElementById(linkedPanel);
          if (!panelEl) continue;
          if (
            panelEl.dataset.bentoMainPanel !== undefined ||
            panelEl.dataset.bentoPanelTabId !== undefined ||
            panelEl.dataset.bentoRootNodeId !== undefined
          ) {
            return true;
          }
          if (panelEl.hasAttribute('column')) return true;
          if (
            panelEl.classList.contains('split-view-panel') ||
            panelEl.classList.contains('split-view-panel-active') ||
            panelEl.classList.contains('bento-panel--focused') ||
            panelEl.classList.contains('bento-panel--cycle-focused')
          ) {
            return true;
          }
          if (mainOnlyStyleProps.some((prop) => panelEl.style.getPropertyValue(prop))) {
            return true;
          }
          if (
            panelEl.querySelector(
              ':scope > .bento-panel-header[data-bento-injected="1"], :scope > .bento-panel-loading-overlay',
            )
          ) {
            return true;
          }
        }
        return false;
      };
      if (!previous.length && !__lastSplitViewMarker && !splitActive && !hasMainOnlyArtifacts()) {
        if (shouldPromoteFocusAfterPanelRemoval) {
          focusSelectedMainAfterPanelRemoval();
        }
        // Already torn down — record the workspace so a subsequent
        // first-panel-add within it is detected as mid-session.
        __reconciledForWorkspace = currentWorkspaceId;
        return;
      }

      // Walk every tab in the window and strip the artifacts the
      // reconciler stamps on panel containers. Two reasons we need to
      // do this comprehensively here (not just for `previous`):
      //   1. The TabSelect-triggered reconcile that fires WHEN bento-
      //      tools activates the new workspace's tab runs BEFORE the
      //      panels/sync arrives, so the new mainTab's container gets
      //      stamped with data-bento-main-panel + style.order even
      //      though the "real" reconcile (this one) is about to tear
      //      everything down.
      //   2. Firefox's tabpanels.splitViewPanels = [] setter only
      //      adds .split-view-panel to NEW entries — it doesn't strip
      //      from departing ones (asymmetric API). Without removing,
      //      ex-panels keep `flex: 1; width: 49.4%` from
      //      content-area.css:160 even after they've left the split,
      //      causing the new selectedTab to render at fractional
      //      width with blank flex slots beside it (the user-reported
      //      "first tab in new workspace doesn't extend to full
      //      window viewport" symptom).
      //
      // Includes all tabs (not just `previous`) to catch any artifacts
      // left over from the transient TabSelect reconcile above.
      for (const tab of gBrowser.tabs) {
        clearMainOnlyArtifactsForTab(tab);
      }
      // Remove inter-panel splitters — they live in the strip
      // host, NOT in tabpanels (XUL deck blocks hit-testing of
      // non-panel children). syncInterPanelSplitters with no args
      // walks the now-empty splitViewPanels and clears all.
      clearFlatPanelLayout(tabpanels);
      syncInterPanelSplitters([]);

      // Use Firefox's removeTabsFromSplitview to strip .split-view-
      // panel + [column] from each previous panel container in one
      // go. Then clear the deck's split state.
      const previousTabs = previous
        .map((id) => gBrowser.tabs.find((t) => t.linkedPanel === id))
        .filter((t) => !!t);
      if (previousTabs.length) {
        try {
          tabpanels.removeTabsFromSplitview(previousTabs);
        } catch (err) {
          console.warn('[bento-shell-mount] tear-down: removeTabsFromSplitview failed:', err);
        }
      } else {
        try {
          tabpanels.splitViewPanels = [];
        } catch (err) {
          console.warn('[bento-shell-mount] tear-down: clear splitViewPanels failed:', err);
        }
      }

      // Strip the Bento class from tabpanels so our overrides
      // (overflow-x, scrollbar-width, etc.) stop applying — the deck
      // returns to default Firefox rendering where the .deck-selected
      // notificationbox uses position: absolute (from
      // .browserSidebarContainer) to fill the viewport.
      tabpanels.classList.remove('bento-split-active');

      restoreSelectedMainBrowser(gBrowser, tabpanels, 'tear-down');

      // Drop the Add-panel trailer too — its dashed-border styling
      // would float in the empty deck without any panels around it.
      removeAddPanelTrailer();

      // Notify Firefox so #activeSplitView clears and
      // shouldActivateDocShell stops returning true for ex-panel
      // browsers.
      if (__lastSplitViewMarker) {
        try {
          window.dispatchEvent(
            new CustomEvent('TabSplitViewDeactivate', {
              bubbles: true,
              detail: {
                tabs: __lastSplitViewMarker.tabs,
                splitview: __lastSplitViewMarker,
              },
            }),
          );
        } catch (err) {
          console.warn('[bento-shell-mount] tear-down: deactivate dispatch failed:', err);
        }
        __lastSplitViewMarker = null;
      }

      // Refresh nav strip (no panels → empty)
      refreshPanelNav([]);
      if (shouldPromoteFocusAfterPanelRemoval) {
        focusSelectedMainAfterPanelRemoval();
      }
      // Record that we've completed a reconcile for this workspace —
      // the next reconcile within the same workspace is mid-session
      // (e.g. user adding the first panel via "Open in new panel"),
      // not hydration.
      __reconciledForWorkspace = currentWorkspaceId;
      return;
    }

    // Resolve panel tabIds (WebExtension IDs from bento-tools' panels/sync
    // payload) to gBrowser tab elements via the same TabTracker path the
    // Cmd+1..9 handler uses.
    const tabTracker = (() => {
      try {
        const mod = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
        return mod.ExtensionParent?.apiManager?.global?.tabTracker || null;
      } catch (err) {
        console.warn('[bento-shell-mount] tabTracker import failed:', err);
        return null;
      }
    })();

    let resolved = [];
    if (tabTracker) {
      for (const p of panels) {
        try {
          const t = tabTracker.getTab(p.tabId);
          // Skip tabs that are being closed. Firefox sets tab.closing in
          // #beginRemoveTab only AFTER #blurTab has fired TabSelect on the
          // successor, so the TabSelect-triggered reconcile is deferred to a
          // microtask (see `reconcile` in attachTabSelectListener); by then
          // `closing` is set and the closing tab is not re-rendered as a
          // strip panel for one frame (the "ghost panel" symptom).
          if (t && !t.closing) {
            resolved.push({ tab: t, payload: p });
          } else if (!t) {
            scheduleMaterializeRetry();
          }
        } catch {
          // Tab might be gone (race with tab/close); skip
          scheduleMaterializeRetry();
        }
      }
    }
    // Materialize + load lazy/pending panel tabs. SessionStore restores
    // tabs with `pending="true"`, no linkedPanel, and no actual content
    // loaded (Firefox's restore_on_demand default — content loads when
    // the user clicks the tab). Two problems for panels:
    //   1. The reconciler below filters tabs without linkedPanel, so a
    //      pending tab is silently dropped — sessions reopen with panel
    //      favicons in the navigator but no panel strip.
    //   2. Even after insertBrowser materializes the docshell (which
    //      sets linkedPanel), no content is loaded — the panel renders
    //      blank until clicked.
    // Fix: insertBrowser to materialize (same path gBrowser.selectTab
    // uses for a lazy click, minus the selection change), then
    // linkedBrowser.reload() to actually fetch the URL.
    const materializePanelTab = (tab, payloadUrl, label) => {
      const needsMaterialize = !tab.linkedPanel;
      const wasPending = tab.hasAttribute('pending');
      if (needsMaterialize) {
        try {
          window.gBrowser.insertBrowser(tab);
        } catch (err) {
          scheduleMaterializeRetry();
          if (materializeRetry >= 8) {
            console.warn(
              '[bento-shell-mount] insertBrowser failed for tabId',
              tab.id || '?',
              label || 'panel',
              err,
            );
          }
          return false;
        }
      }
      if (!tab.linkedPanel || !tab.linkedBrowser) {
        scheduleMaterializeRetry();
        if (materializeRetry >= 8) {
          console.warn(
            '[bento-shell-mount] dropping split tab without linkedBrowser',
            tab.id || '?',
            label || 'panel',
          );
        }
        return false;
      }
      if (!getLivePanelBrowser(tab)) {
        scheduleMaterializeRetry();
        return false;
      }
      const panelEl = tab.linkedPanel ? document.getElementById(tab.linkedPanel) : null;

      if (wasPending) {
        try {
          const spec = tab.linkedBrowser?.currentURI?.spec || '';
          if (needsMaterialize || !spec || spec === 'about:blank') {
            tab.linkedBrowser?.reload();
          }
        } catch (err) {
          console.warn(
            '[bento-shell-mount] reload() failed for tabId',
            tab.id || '?',
            label || 'panel',
            err,
          );
        }
      }
      ensurePanelInitialContent(tab, panelEl, tab.linkedBrowser, payloadUrl, { wasPending });
      return true;
    };
    resolved = resolved.filter(({ tab, payload }) => {
      return materializePanelTab(tab, payload?.url, 'panel');
    });
    if (resolved.length === 0) {
      if (hasPendingMaterialization) return;
      forceMainOnlyChromeState(gBrowser, tabpanels);
      return;
    }
    setNoSidePanelsMode(false);

    // NOTE: we do NOT call gBrowser.hideTab(tab) on panel tabs.
    //
    // The plan called for it (so panels stay out of native visibleTabs
    // iterations), but the smoke test showed Firefox's split-view
    // rendering produces a black/empty content slot for any tab that's
    // hidden — the deck-selected attribute is set, the panel container
    // sizes correctly, but the browser inside doesn't paint.
    //
    // Bento hides #TabsToolbar entirely (patches/core-ui/02-hide-native-
    // tabs.patch) so panel tabs are already invisible to the user via
    // the native strip. The sidebar's tab list filters panels via
    // PanelStore membership in bento-tools (see useWorkspaceTabIds).
    // Skipping tab.hidden costs us nothing visually and lets the
    // split-view paint content for every panel.
    //
    // Side effect to watch in Phase 4: visibleTabs iterations from
    // home.js / multi-account-containers / sessionstore will include
    // panel tabs. If any of those misbehave, revisit (likely with a
    // more surgical attribute or a tab-flag that's separate from
    // hidden=true).

    // Build the ordered list of tabs to render in the split. Active
    // main tab (gBrowser.selectedTab) is the FIRST slot; panel tabs
    // follow in bento-tools' order. Dedupe on linkedPanel so a tab
    // that's both selected and a panel doesn't appear twice.
    const topLevelPanelIds = new Set(resolved.map(({ tab }) => tab.linkedPanel));
    let mainTab = gBrowser.selectedTab;
    // A replacement main tab must belong to the workspace being rendered. Picking the
    // first non-panel tab in the window can select a tab of another workspace, which
    // tools never follows: the sidebar keeps showing this workspace over a foreign page.
    const isInRenderedWorkspace = (tab) =>
      !currentWorkspaceId || selectedTabWorkspaceId(tab) === currentWorkspaceId;
    if (mainTab && !materializePanelTab(mainTab, '', 'main')) {
      const canBeReplacement = (tab) => {
        if (!tab || tab.closing) return false;
        if (topLevelPanelIds.has(tab.linkedPanel)) return false;
        return materializePanelTab(tab, '', 'main replacement');
      };
      const replacementMain =
        Array.from(gBrowser.tabs).find((tab) => isInRenderedWorkspace(tab) && canBeReplacement(tab)) ||
        Array.from(gBrowser.tabs).find(canBeReplacement);
      if (replacementMain) {
        mainTab = replacementMain;
        try {
          gBrowser.selectedTab = replacementMain;
        } catch {
          // Best effort; render with the replacement below.
        }
      } else {
        forceMainOnlyChromeState(gBrowser, tabpanels);
        return;
      }
    }
    const selectedPanelEl = mainTab?.linkedPanel
      ? document.getElementById(mainTab.linkedPanel)
      : null;
    const selectedIsBentoPanel =
      mainTab?.linkedPanel &&
      (topLevelPanelIds.has(mainTab.linkedPanel) ||
        selectedPanelEl?.hasAttribute('data-bento-panel'));
    if (
      mainTab?.linkedPanel &&
      selectedIsBentoPanel
    ) {
      const replacement = Array.from(gBrowser.tabs).find((tab) => {
        if (!tab?.linkedPanel || tab.closing) return false;
        if (topLevelPanelIds.has(tab.linkedPanel)) return false;
        // The selected tab is a panel still listed in a stale payload (a promoted panel
        // is activated before its panels/sync arrives). With no sidebar tab of this
        // workspace to fall back to, keep it selected rather than jumping to another
        // workspace's tab; the dedupe below renders it as the main slot.
        if (!isInRenderedWorkspace(tab)) return false;
        const panelEl = document.getElementById(tab.linkedPanel);
        return (
          !panelEl?.hasAttribute('data-bento-panel') &&
          materializePanelTab(tab, '', 'main replacement')
        );
      });
      if (replacement) {
        mainTab = replacement;
        try {
          gBrowser.selectedTab = replacement;
        } catch {
          // Best effort: rendering with the replacement is still better
          // than promoting a side panel into the main slot.
        }
      }
    }
    const tabsToRender = [];
    const tabsToKeepActive = [];
    const seenPanelIds = new Set();
    const activePanelIds = new Set();
    const keepActiveTab = (tab) => {
      if (!tab?.linkedPanel || !getLivePanelBrowser(tab) || activePanelIds.has(tab.linkedPanel))
        return;
      tabsToKeepActive.push(tab);
      activePanelIds.add(tab.linkedPanel);
    };
    const renderTab = (tab) => {
      if (!tab?.linkedPanel || !getLivePanelBrowser(tab) || seenPanelIds.has(tab.linkedPanel))
        return;
      tabsToRender.push(tab);
      seenPanelIds.add(tab.linkedPanel);
      keepActiveTab(tab);
    };
    if (mainTab?.linkedPanel) {
      renderTab(mainTab);
    }
    for (const { tab } of resolved) {
      renderTab(tab);
    }
    const rootLayoutTabsToRender = [];
    if (mainTab?.linkedPanel) rootLayoutTabsToRender.push(mainTab);
    const seenRootNodeIdsForSplitters = new Set();
    for (const { tab, payload } of resolved) {
      const tabId = Number(payload?.tabId);
      const rootNodeId = payload?.rootNodeId || (Number.isFinite(tabId) ? 'panel:' + tabId : null);
      if (!rootNodeId || seenRootNodeIdsForSplitters.has(rootNodeId)) continue;
      seenRootNodeIdsForSplitters.add(rootNodeId);
      rootLayoutTabsToRender.push(tab);
    }
    // Closing the last side panel can briefly leave that tab selected
    // as the main slot while it still appears in the stale panels
    // payload. After dedupe, that means there is only main to render:
    // tear the split down instead of leaving a main-only strip.
    if (tabsToRender.length <= 1) {
      if (hasPendingMaterialization) return;
      forceMainOnlyChromeState(gBrowser, tabpanels);
      return;
    }

    // Tabs that USED to be in the split but no longer are: clear their
    // per-panel split-view-active attribute, clear our split sentinel,
    // ORDER MATTERS:
    //   1. Set markers on every tab in tabsToRender FIRST.
    //   2. Then run the cleanup loop (removeTabsFromSplitview).
    //
    // Why: removeTabsFromSplitview internally calls setSplitViewActive
    // (toolkit/content/widgets/tabbox.js:536), which gates the
    // [splitview] attribute on `gBrowser.selectedTab.splitview &&
    // updatedValue` (line 546). If we run cleanup before setting the
    // marker on the new mainTab, selectedTab.splitview is undefined →
    // setSplitViewActive removes [splitview] → split deactivates
    // briefly. The AsyncTabSwitcher (gBrowser._switcher) sees
    // splitViewBrowsers shrink, queues docShell deactivations for the
    // ex-split browsers, and those land before our subsequent
    // showSplitViewPanels can re-assert docShellIsActive=true. Net
    // result: blank content in the new main slot when toggling between
    // two sidebar tabs (the bug surfaced in late Phase 2 testing).
    //
    // tab.splitview is a GETTER (browser/components/tabbrowser/content/
    // tab.js:399) that returns parentElement only when parentElement is
    // a <tab-split-view-wrapper>; no setter, so a plain assignment is
    // silently shadowed. Use Object.defineProperty to add an own-
    // property that takes precedence over the prototype getter.
    const splitViewMarker = makeSplitViewMarker(tabsToKeepActive);
    for (const tab of tabsToKeepActive) {
      try {
        Object.defineProperty(tab, 'splitview', {
          value: splitViewMarker,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      } catch (err) {
        console.warn('[bento-shell-mount] tab.splitview defineProperty failed:', err);
      }
    }

    const cleanupDroppedSplitViewPanel = (panelId) => {
      const panelEl = panelId ? document.getElementById(panelId) : null;
      if (!panelEl) return;
      panelEl.classList.remove('split-view-panel', 'split-view-panel-active');
      panelEl.removeAttribute('column');
      const tab = gBrowser.tabs.find((candidate) => candidate.linkedPanel === panelId);
      if (tab && !activePanelIds.has(panelId) && tab.splitview?.kind === BENTO_SPLIT_KIND) {
        delete tab.splitview;
      }
      const browserContainer = panelEl.querySelector('.browserContainer');
      const browserEl = panelEl.querySelector('browser');
      browserContainer?.removeEventListener('click', tabpanels);
      browserContainer?.removeEventListener('mouseover', tabpanels);
      browserContainer?.removeEventListener('mouseout', tabpanels);
      browserEl?.removeEventListener('focus', tabpanels);
      if (tab && activePanelIds.has(panelId)) {
        scheduleSubPanelPaintRestore(tab, panelEl);
      }
    };

    const sanitizeExistingSplitViewPanelsForFirefox = () => {
      const currentPanelIds = Array.from(tabpanels.splitViewPanels || []);
      if (!currentPanelIds.length) return currentPanelIds;

      const nextPanelIds = [];
      const droppedPanelIds = [];
      for (const panelId of currentPanelIds) {
        const panelEl = panelId ? document.getElementById(panelId) : null;
        if (panelEl?.parentNode === tabpanels) {
          nextPanelIds.push(panelId);
        } else {
          droppedPanelIds.push(panelId);
        }
      }

      const changed =
        nextPanelIds.length !== currentPanelIds.length ||
        nextPanelIds.some((panelId, index) => panelId !== currentPanelIds[index]);
      if (!changed) return currentPanelIds;

      for (const panelId of droppedPanelIds) {
        cleanupDroppedSplitViewPanel(panelId);
      }

      try {
        tabpanels.splitViewPanels = nextPanelIds;
        return nextPanelIds;
      } catch (err) {
        console.warn('[bento-shell-mount] sanitize splitViewPanels failed:', err);
        try {
          tabpanels.splitViewPanels = [];
        } catch (clearErr) {
          console.warn('[bento-shell-mount] clear stale splitViewPanels failed:', clearErr);
        }
        return [];
      }
    };

    sanitizeExistingSplitViewPanelsForFirefox();

    // Now teardown. Each departing tab is one that was in the previous
    // splitViewPanels but isn't in the new tabsToRender. Firefox's
    // removeTabsFromSplitview (toolkit/content/widgets/tabbox.js:516)
    // handles the full per-panel teardown:
    //   - .split-view-panel class removed (otherwise the base CSS at
    //     content-area.css:160 keeps width: 49.4%, flex: 1 on the
    //     leftover panel — it's invisible because it lacks
    //     .split-view-panel-active and .deck-selected, but it still
    //     consumes flex space, pushing the new main into visual
    //     position 2. This was the original "main moves between
    //     first and second positions" symptom.)
    //   - [column] attribute removed.
    //   - Auto-select click/focus listeners detached.
    //   - panelId spliced from tabpanels.#splitViewPanels.
    // Because we set the new marker first (above), the internal
    // setSplitViewActive call here sees mainTab.splitview = truthy and
    // keeps [splitview] = true throughout — no transient deactivation.
    const previous = tabpanels.splitViewPanels || [];
    const departingTabs = [];
    const departingStillActiveTabs = [];
    for (const panelId of previous) {
      if (seenPanelIds.has(panelId)) continue;
      const t = gBrowser.tabs.find((tab) => tab.linkedPanel === panelId);
      if (!t) continue;
      const stillKeepActive = activePanelIds.has(panelId);
      departingTabs.push(t);
      if (stillKeepActive) {
        departingStillActiveTabs.push(t);
      }
      if (!stillKeepActive && t.splitview && t.splitview.kind === BENTO_SPLIT_KIND) {
        delete t.splitview;
      }
      const liveBrowser = getLivePanelBrowser(t);
      if (!stillKeepActive && t !== mainTab && liveBrowser) {
        // preserveLayers(true) BEFORE docShellIsActive=false. Without
        // this, Firefox destroys the browser's compositor layers when
        // deactivated; on reactivation the docShell processes again
        // but the layers need re-rendering, leaving a blank frame
        // until the next paint cycle. Empirically: even though all
        // diagnostic invariants (docShellIsActive=true, frameLoader
        // present, classes correct, panel rect non-zero, visibility
        // visible) hold after re-entry, the slot stays blank because
        // the cached layer is gone. Mirrors the order in
        // tabbrowser.js:8161 on_visibilitychange.
        liveBrowser.preserveLayers(true);
        liveBrowser.docShellIsActive = false;
      }
    }
    // removeTabsFromSplitview strips both .split-view-panel and
    // .split-view-panel-active (Firefox 154 tabbox.js). A stale
    // .split-view-panel-active keeps a departing panel visible via
    // `tabpanels > .split-view-panel-active { visibility: inherit }`
    // and, with preserveLayers(true) above, shows as a ghost overlay on
    // the new mainTab's slot.
    if (departingTabs.length) {
      try {
        tabpanels.removeTabsFromSplitview(departingTabs);
      } catch (err) {
        console.warn('[bento-shell-mount] removeTabsFromSplitview failed:', err);
      }
    }

    for (const tab of departingStillActiveTabs) {
      const panelEl = tab.linkedPanel ? document.getElementById(tab.linkedPanel) : null;
      if (panelEl) {
        scheduleSubPanelPaintRestore(tab, panelEl);
      }
    }

    // Register the marker as gBrowser's activeSplitView via the same
    // event MozTabSplitViewWrapper dispatches. tabbrowser.js listens
    // for TabSplitViewActivate at window level (line 218) and stores
    // event.detail.splitview in #activeSplitView. The splitViewBrowsers
    // getter then iterates `#activeSplitView.tabs` (our marker exposes
    // .tabs), and shouldActivateDocShell() returns true for any browser
    // in that list (line 7949). That's how Firefox keeps every panel's
    // docShell active even when only one is `selectedBrowser`.
    //
    // Without this, AsyncTabSwitcher (gBrowser._switcher) deactivates
    // every browser except selectedBrowser as soon as it processes the
    // next tick — exactly matching the reported "panels go blank
    // moments after creation" symptom.
    //
    // Deactivate the previous marker first so the === identity check in
    // on_TabSplitViewDeactivate (tabbrowser.js:8225) matches and the
    // private field actually clears before we set the new one.
    if (__lastSplitViewMarker) {
      try {
        window.dispatchEvent(
          new CustomEvent('TabSplitViewDeactivate', {
            bubbles: true,
            detail: {
              tabs: __lastSplitViewMarker.tabs,
              splitview: __lastSplitViewMarker,
            },
          }),
        );
      } catch (err) {
        console.warn('[bento-shell-mount] TabSplitViewDeactivate dispatch failed:', err);
      }
    }
    try {
      window.dispatchEvent(
        new CustomEvent('TabSplitViewActivate', {
          bubbles: true,
          detail: { tabs: tabsToKeepActive, splitview: splitViewMarker },
        }),
      );
      __lastSplitViewMarker = splitViewMarker;
    } catch (err) {
      console.warn('[bento-shell-mount] TabSplitViewActivate dispatch failed:', err);
    }

    try {
      gBrowser.showSplitViewPanels(tabsToRender);
    } catch (err) {
      if (!String(err?.message || err).includes('Wrong reference child')) {
        console.error('[bento-shell-mount] showSplitViewPanels failed:', err);
        return;
      }
      console.warn('[bento-shell-mount] showSplitViewPanels stale split list; retrying:', err);
      try {
        tabpanels.splitViewPanels = [];
      } catch (clearErr) {
        console.warn('[bento-shell-mount] retry clear splitViewPanels failed:', clearErr);
      }
      for (const tab of tabsToKeepActive) {
        const liveBrowser = getLivePanelBrowser(tab);
        if (!liveBrowser) continue;
        try {
          liveBrowser.preserveLayers?.(true);
          liveBrowser.renderLayers = true;
          liveBrowser.docShellIsActive = true;
        } catch (paintErr) {
          console.warn('[bento-shell-mount] retry paint preserve failed:', paintErr);
        }
      }
      try {
        gBrowser.showSplitViewPanels(tabsToRender);
      } catch (retryErr) {
        console.error('[bento-shell-mount] showSplitViewPanels retry failed:', retryErr);
        return;
      }
    }

    // The splitViewPanels setter (toolkit/content/widgets/tabbox.js:498)
    // attaches `click` and `focus` listeners on each panel's
    // `.browserContainer` / `<browser>`. The handler (line 346-350)
    // does `tabstrip.selectedItem = tab` — i.e. clicking into a panel
    // makes that panel's tab the global gBrowser.selectedTab. That's
    // correct for Firefox's 2-tab split UI but wrong for Bento, where
    // panels are subordinate to a main tab: clicking a side panel
    // should focus its content WITHOUT changing which sidebar tab is
    // "main". Without this strip, our reconciler runs on every panel
    // click, treats the just-clicked panel as mainTab, and shuffles
    // splitViewPanels[0] to that panel — which causes the reported
    // "main content disappears when focus leaves a panel" and
    // "panels reorder when I click around" symptoms.
    //
    // Listeners are added with `this` (the tabpanels element itself)
    // as the listener; removeEventListener with the same reference
    // detaches them. Idempotent: safe to run after every reconcile.
    // Mouseover/mouseout are left alone — they manage the per-panel
    // link-preview StatusPanel, which is desirable behaviour.
    for (const tab of tabsToKeepActive) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      const browserContainer = panelEl.querySelector('.browserContainer');
      const browserEl = panelEl.querySelector('browser');
      browserContainer?.removeEventListener('click', tabpanels);
      browserEl?.removeEventListener('focus', tabpanels);
      attachBentoPanelContentClickFallback(browserContainer, browserEl);
    }

    // Set inline `order` per panel so flex layout renders them in
    // splitViewPanels index order regardless of count. The static
    // CSS rules in bento-shell-mount.css only enumerate columns 0..9
    // (Firefox's split-view CSS only ships 0 and 1; we extended to
    // 9). Beyond column 9, columns get default `order: 0` and end
    // up in the same flex group as the main panel (also order: 0),
    // rendering interleaved or before main. Empirically observed at
    // ~10 panels: new panels start appearing adjacent to the right
    // of main rather than at the strip's tail; older panels can land
    // visually to the LEFT of main. Inline style.order overrides any
    // CSS rule and scales to N panels.
    //
    // Also stamp the data-bento-main-panel / data-bento-panel-tab-id
    // attributes the legacy parallel-browser renderer used to set —
    // downstream code (getOrderedPanels, navigatePanels keyboard cycle,
    // setupNavDrag drag-reorder, the Esc-to-blur handler) reads these
    // to identify panels and recover tabIds. Without them, drag-
    // reorder dispatches a bogus single-element panels list (which
    // PanelStore.reorder rejects on length mismatch) and keyboard
    // cycling has no targets to walk through.
    // Panels at even orders (0, 2, 4, ...) so splitters can slot in
    // at odd orders (1, 3, 5, ...) between them. The splitter has
    // `_bentoLeftPanelId` set to the panel it resizes (the one to
    // its left in visual order), used by startPanelDrag.
    // Build per-tabId width lookup from the BENTO_PANELS payload so we
    // can re-apply persisted widths during reconcile. Without this, a
    // panel restored at boot or reordered during a workspace switch
    // would render at its default flex width and lose whatever the
    // user previously dragged it to.
    const widthByTabId = new Map();
    const payloadByTabId = new Map();
    for (const p of panels) {
      payloadByTabId.set(p.tabId, p);
      if (typeof p.widthPx === 'number' && p.widthPx > 0) {
        widthByTabId.set(p.tabId, p.widthPx);
      }
    }
    for (const { tab } of resolved) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (panelEl) resetPanelInlineLayoutState(panelEl);
    }
    const newTabIds = panels.map((p) => p.tabId).filter((id) => !previousTabIds.has(id));
    const shouldAnimateNewPanels = newTabIds.length > 0 && !isInitialReconcileForWorkspace;
    const pendingSubdivisionPanelEnters = [];
    const pendingRootPanelEnters = [];
    for (const [i, tab] of tabsToRender.entries()) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      panelEl.style.order = String(i * 2);
      // tabindex="-1" makes the notificationbox programmatically
      // focusable. Without it, setActiveByIndex's targets[idx].focus()
      // call is a silent no-op (HBOX/notificationbox isn't focusable
      // by default), DOM focus stays wherever the user last clicked,
      // and the Up/Down panel-content scroll handler routes the
      // command to the wrong panel.
      if (!panelEl.hasAttribute('tabindex')) {
        panelEl.setAttribute('tabindex', '-1');
      }
      if (i === 0) {
        panelEl.dataset.bentoMainPanel = '1';
        delete panelEl.dataset.bentoPanelTabId;
        delete panelEl.dataset.bentoDevtoolsFor;
        panelEl.classList.remove('bento-panel--discarded');
        panelEl.removeAttribute('data-bento-header-hidden');
        removeInjectedPanelHeader(panelEl);
        // Apply the active workspace's main-panel width every reconcile.
        // Only paints when the user has dragged the main splitter in this
        // workspace; other workspaces fall back to normal flex sizing.
        if (mainPanelWidth !== null) {
          // On workspace-switch reconciles, give the panel a one-shot
          // CSS transition so the width change animates from the old
          // to the new value instead of snapping ~200ms after the
          // tab content swap. Drag-driven reconciles bypass this
          // (the flag is only set when handlePanelsTitle observes a
          // workspace-id change in the payload).
          if (__mainWidthTransitionForNextReconcile) {
            // The Mux reveal role matches the workspace-switch tab-list slide
            // (TabList.css) so the simultaneous main-panel resize and
            // sidebar tab swap feel like one motion.
            const reveal = 'var(--muxui-semantic-motion-reveal-transition)';
            panelEl.style.transition =
              'width ' + reveal + ', min-width ' + reveal + ', flex-basis ' + reveal;
            // Clear the inline transition once it has finished so
            // subsequent inline width writes (e.g. drag pointermove)
            // are instant.
            afterMotion(
              panelEl,
              'width',
              { properties: ['width', 'min-width', 'flex-basis'] },
              () => {
                panelEl.style.removeProperty('transition');
              },
            );
            __mainWidthTransitionForNextReconcile = false;
          }
          panelEl.style.width = mainPanelWidth + 'px';
          panelEl.style.minWidth = mainPanelWidth + 'px';
          panelEl.style.flex = '0 0 ' + mainPanelWidth + 'px';
        } else {
          // A tab panel can carry stale inline sizing from a previous
          // workspace, split-view activation, or pre-sync reconcile.
          // When the profile has no persisted main width yet, let the
          // CSS flex rule make the main slot fill available space
          // instead of preserving an old narrow per-workspace width.
          panelEl.style.removeProperty('width');
          panelEl.style.removeProperty('min-width');
          panelEl.style.removeProperty('flex');
        }
      } else {
        delete panelEl.dataset.bentoMainPanel;
        let tabId = null;
        if (tabTracker) {
          try {
            tabId = tabTracker.getId(tab);
            if (tabId) panelEl.dataset.bentoPanelTabId = String(tabId);
          } catch {
            /* tabTracker can throw for transient/uninitialised tabs */
          }
        }
        // Apply persisted width if we have one. Don't paint a default
        // width when none is persisted — the panel keeps whatever it
        // had (in-flight drag width, or Firefox's flex default).
        if (tabId !== null) {
          const payload = payloadByTabId.get(tabId);
          panelEl.classList.toggle('bento-panel--discarded', payload?.discarded === true);
          panelEl.dataset.bentoRootNodeId = payload?.rootNodeId || 'panel:' + tabId;
          const devtoolsLink = currentDevtoolsLinkByTabId.get(tabId);
          if (devtoolsLink) {
            panelEl.dataset.bentoDevtoolsFor =
              devtoolsLink.callerTabId === null ? 'main' : String(devtoolsLink.callerTabId);
          } else {
            delete panelEl.dataset.bentoDevtoolsFor;
          }
          const w = widthByTabId.get(tabId);
          if (typeof w === 'number') {
            // Skip if a drag is currently in flight on this panel —
            // we'd otherwise stomp the user's live mutation with
            // the persisted value (which is one drag-end behind).
            const dragInFlight =
              panelEl.style.width && panelEl.classList.contains('bento-panel-resizing');
            if (!dragInFlight) {
              panelEl.style.width = w + 'px';
              panelEl.style.minWidth = w + 'px';
              panelEl.style.flex = '0 0 ' + w + 'px';
            }
          }
          if (shouldAnimateNewPanels && newTabIds.includes(tabId)) {
            const layoutStatus = currentPanelStatusByTabId.get(tabId);
            const isSubdivisionChildEnter =
              layoutStatus === 'subdivision-bottom' || layoutStatus === 'split-child';
            if (isSubdivisionChildEnter) {
              pendingSubdivisionPanelEnters.push(panelEl);
            } else {
              pendingRootPanelEnters.push(panelEl);
            }
          }
        }
      }
    }

    // Inter-panel splitters: one between each adjacent pair. They
    // CANNOT live inside tabpanels — XUL <tabpanels> is a deck and
    // its hit-testing routes events only to panels with the
    // .split-view-panel-active class, ignoring all sibling
    // elements regardless of element type, position, z-index, etc.
    // Tested with HTML <div>, XUL <hbox>, XUL <splitter>, all with
    // and without position:absolute z:999 — all blocked.
    //
    // Workaround: park splitters in #bento-side-panel-host (the
    // strip parent of tabbox), positioned absolutely at the right
    // edge of each "left" panel. They float above tabpanels'
    // boundary regions. Repositioned on every reconcile and on
    // window resize so panel-width changes shift the splitter.
    syncInterPanelSplitters(rootLayoutTabsToRender);

    // Strip stale inline order + data attrs from departing tabs so
    // they don't leak into a future split (e.g. tab returns to the
    // layout via a workspace switch with a different position) or
    // make getOrderedPanels mistakenly include them.
    for (const tab of departingTabs) {
      const panelEl = document.getElementById(tab.linkedPanel);
      if (!panelEl) continue;
      panelEl.style.removeProperty('order');
      panelEl.style.removeProperty('left');
      panelEl.style.removeProperty('top');
      panelEl.style.removeProperty('width');
      panelEl.style.removeProperty('min-width');
      panelEl.style.removeProperty('max-width');
      panelEl.style.removeProperty('height');
      panelEl.style.removeProperty('min-height');
      panelEl.style.removeProperty('max-height');
      panelEl.style.removeProperty('flex');
      delete panelEl.dataset.bentoMainPanel;
      delete panelEl.dataset.bentoPanelTabId;
      delete panelEl.dataset.bentoRootNodeId;
      panelEl.removeAttribute('data-bento-header-hidden');
      removeInjectedPanelHeader(panelEl);
    }

    // Force the AsyncTabSwitcher to exist by calling the public
    // gBrowser.warmupTab API (which internally calls _getSwitcher() in
    // multi-process mode). This is critical: without the switcher,
    // gBrowser.on_visibilitychange (tabbrowser.js:8158) takes the
    // `!this._switcher` fallback that iterates selectedBrowsers and
    // sets docShellIsActive = !document.hidden — silently
    // DEACTIVATING every panel browser whenever the OS/DevTools
    // toggles window visibility, with no path to reactivate them.
    // Empirically observed via docShellIsActive setter trace:
    // 4 panels all set to false from on_visibilitychange line 8162,
    // matching the user-reported "blank panels after a sidebar tab
    // toggle" symptom.
    //
    // With the switcher created, on_visibilitychange's `if
    // (!this._switcher)` branch never runs, and the switcher's own
    // shouldDeactivateDocShell (AsyncTabSwitcher.sys.mjs:937) respects
    // splitViewBrowsers — so panels stay active across visibility
    // transitions.
    //
    // warmupTab is also idempotent + advances tabs in STATE_UNLOADED
    // back to STATE_LOADING, so tabs that were previously unloaded
    // get repainted on re-entry into the split.
    for (const tab of tabsToKeepActive) {
      if (!getLivePanelBrowser(tab)) {
        scheduleMaterializeRetry();
        continue;
      }
      try {
        gBrowser.warmupTab(tab);
      } catch {
        scheduleMaterializeRetry();
      }
    }

    // showSplitViewPanels sets each tab.linkedBrowser.docShellIsActive
    // = true BEFORE calling setIsSplitViewActive, which internally
    // does `this.selectedPanel = selectedPanel`. Setting selectedPanel
    // on a MozDeck triggers the deck's mutation observer / activation
    // logic which DEACTIVATES docShells of non-selected children. So
    // by the time showSplitViewPanels returns, every panel except the
    // currently-deck-selected one has docShellIsActive=false again,
    // and only the selected panel paints content (the others render
    // their .split-view-panel-active container + our injected header
    // but the browser inside stays blank).
    //
    // Re-force docShellIsActive=true on every panel's browser AFTER
    // showSplitViewPanels has done its dance. The deck won't toggle
    // them off again until the next setSelectedPanel — which we
    // re-run on TabSelect, where this same path fires.
    for (const tab of tabsToKeepActive) {
      const liveBrowser = getLivePanelBrowser(tab);
      if (liveBrowser && !liveBrowser.docShellIsActive) {
        liveBrowser.docShellIsActive = true;
      }
    }

    // Per-panel header injection. Each linkedPanel is a notificationbox;
    // we inject Bento's header (URL bar, back/forward/reload, X close,
    // bookmark) as the FIRST child so the visual order is
    // [header, notificationstack, browser]. Idempotent — re-running
    // skips panels that already have a header.
    for (const { tab, payload } of resolved) {
      injectPanelHeaderIntoLinkedPanel(tab, payload.url || '');
      const panelEl = document.getElementById(tab.linkedPanel);
      if (panelEl && !panelEl.dataset.bentoMainPanel) {
        const tabId = Number(payload.tabId);
        if (payload.headerHidden === true) {
          panelEl.setAttribute('data-bento-header-hidden', '1');
          if (Number.isFinite(tabId)) currentHeaderHiddenTabIds.add(tabId);
        } else {
          panelEl.removeAttribute('data-bento-header-hidden');
          if (Number.isFinite(tabId)) currentHeaderHiddenTabIds.delete(tabId);
        }
      }
    }

    // Mark tabpanels with classes so CSS can switch into Bento's
    // split-view layout and the flat logical-layout positioning mode.
    tabpanels.classList.add('bento-split-active', 'bento-flat-panel-layout');

    // Ensure the Add-panel trailer exists. It must stay mounted once created;
    // flat-layout geometry keeps it visually trailing without reparenting its
    // remote iframe on every panel/layout mutation.
    ensureAddPanelTrailer(tabpanels);

    currentPanelLayoutGeometry = computePanelLayoutGeometry(currentPanelLayout, panels, tabpanels);
    applyPanelLayoutRects(tabpanels, currentPanelLayoutGeometry);
    applyPanelLayoutStatusAttributes(currentPanelStatusByTabId);
    syncFlatLayoutOverlays(tabpanels, currentPanelLayoutGeometry);
    syncInterPanelSplitters(rootLayoutTabsToRender);
    for (const panelEl of pendingRootPanelEnters) {
      // Flat layout is absolute-positioned; inline width is the
      // authoritative rect. Start the enter animation only after the
      // flat rects have been applied, otherwise a restored panel can
      // measure Firefox's stale split-view width and write that width
      // back over the correct geometry on the next animation frame.
      animatePanelEnter(panelEl);
    }
    for (const panelEl of pendingSubdivisionPanelEnters) {
      animatePanelEnter(panelEl, {
        animateWidth: false,
        animateTransform: false,
      });
    }

    // Refresh favicon nav strip (lives outside tabpanels; reads from
    // panels/sync payload — same data the legacy reconciler consumes).
    refreshPanelNav(panels);
    runPendingPanelNavFlip();

    // Resize/reposition the custom always-visible scrollbar thumb to
    // match the new panel count. Layout settles after this tick, so
    // queue for the next frame.
    setTimeout(updateStripScrollbar, 0);

    // FLIP-animate any cross-panel reorder that endDrag (header
    // drag) has staged. No-op when no snapshot is pending.
    runPendingPanelFlip();
    // A plain top-level panel close fades the departing panel at its
    // original size. After the delayed tab close reconciles the strip,
    // slide the surviving root slots into their settled positions.
    runPendingTopLevelPanelCloseGapFlip();

    // Auto-scroll to bring any freshly-added panel into view. Trigger
    // whenever a new panel id appears AND we've already reconciled
    // this workspace at least once (so this is a mid-session mutation,
    // not the initial hydration of a boot/switch). Scrolls to the
    // LAST new tab id (rightmost in DOM, which is where panel/add
    // appends and the right-click-on-side-panel insert lands; for
    // panel/openAt-from-main with sourceTabId=null, the new panel is
    // at position 0 and is the only new id, so "last new" still
    // resolves correctly).
    //
    // Workspace match handles three cases that the previous
    // previousTabIds-only guard conflated:
    //   - Boot hydration (__reconciledForWorkspace null → mismatch → skip)
    //   - Workspace switch (__reconciledForWorkspace = prior → mismatch → skip)
    //   - First-panel-add to a previously-empty workspace
    //     (__reconciledForWorkspace was set by the empty-panels early-
    //     return path → match → scroll)
    //
    // setTimeout 0 lets tabpanels' layout commit the new panel's
    // width before scrollPanelIntoViewFromRight reads its bounding
    // rect. Uses the minimal-scroll variant rather than leftmost so
    // the source panel (the one the user right-clicked, or the
    // currently-focused panel for plain panel/add) stays in view to
    // the left of the new one — the new panel just nudges into view
    // from the right, instead of jumping the strip to the new panel.
    let scrolledToNewPanel = false;
    const explicitScrollId = Number.isInteger(options.scrollToPanelTabId)
      ? options.scrollToPanelTabId
      : null;
    if (explicitScrollId !== null) {
      scrolledToNewPanel = true;
      scheduleScrollPanelTabIntoView(explicitScrollId, {
        reveal: options.scrollToPanelReveal === 'right-edge' ? 'right-edge' : 'full',
        focus: true,
      });
    } else if (newTabIds.length > 0 && !isInitialReconcileForWorkspace) {
      const newRootId = [...newTabIds]
        .reverse()
        .find((tabId) => currentPanelStatusByTabId.get(tabId) === 'root-panel');
      if (Number.isInteger(newRootId)) {
        scrolledToNewPanel = true;
        scheduleScrollPanelTabIntoView(newRootId);
      }
    }
    if (!scrolledToNewPanel && shouldPromoteFocusAfterPanelRemoval) {
      scrolledToNewPanel = focusNextTargetAfterPanelRemoval(previousFocusedPanelCycleIndex);
    }
    __reconciledForWorkspace = currentWorkspaceId;

    // Auto-scroll to the MAIN panel when the selected tab changes
    // (sidebar tab click, Cmd+T new tab, Cmd+Shift+T undo-close, ...).
    // The main slot follows gBrowser.selectedTab; if the user was
    // looking at a side panel and clicked a sidebar tab, the new
    // main is offscreen-left until we scroll to it.
    // Skipped when:
    //   - we just scrolled to a new side panel (above) — that's the
    //     more specific user intent, don't immediately yank back
    //   - selected tab didn't actually change (reconcile fired for
    //     an unrelated reason like a width refresh)
    //   - the first selected-tab linkage after boot restored the strip
    //     to a saved nonzero scroll position. That linkage is Firefox
    //     settling chrome state, not a user request to reveal main.
    //   - the workspace has no side panels (main fills the strip,
    //     no scroll needed)
    const currentMainPanelId = window.gBrowser?.selectedTab?.linkedPanel ?? null;
    const mainChanged = currentMainPanelId !== __lastMainPanelId;
    __lastMainPanelId = currentMainPanelId;
    const suppressImplicitMainAutoScroll =
      __suppressNextMainAutoScrollForWorkspace !== null &&
      __suppressNextMainAutoScrollForWorkspace === currentWorkspaceId;
    if (
      !scrolledToNewPanel &&
      mainChanged &&
      !suppressImplicitMainAutoScroll &&
      panels.length > 0 &&
      currentMainPanelId &&
      !__workspaceSwitchSwapping
    ) {
      setTimeout(() => {
        const mainEl = getOrderedPanels()[0];
        if (mainEl) scrollPanelToLeftmost(mainEl);
      }, 0);
    }
  }

  // Sidebar-driven scroll-to-main signal. Sidebar sets
  // document.title = BENTO_SCROLL_TO_MAIN_<ts> on every tab-row click,
  // INCLUDING clicks on the already-active tab. Without this, clicking
  // the active tab fires no TabSelect (Firefox doesn't re-emit when
  // the same tab is reselected) → no reconcile → no scroll. The
  // dedicated sentinel covers that case so EVERY sidebar tab click
  // brings main back into view.
  function handleScrollToMainTitle() {
    const mainEl = getOrderedPanels()[0];
    if (!mainEl) return;
    clearRestoredMainAutoScrollSuppression();
    scrollPanelToLeftmost(mainEl);
    currentActiveIdx = 0;
    applyActiveMarker(0);
    applyFocusedPanelIndicator(mainEl);
  }

  function handleSelectedTabsTitle(rawTitle) {
    // Format: BENTO_SELECTED_TABS:<ts>:<base64-json-array>
    const tail = rawTitle.slice(SELECTED_TABS_PREFIX.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return;
    try {
      const decoded = JSON.parse(decodeURIComponent(escape(atob(tail.slice(colon + 1)))));
      currentSidebarSelectedTabIds = Array.isArray(decoded)
        ? Array.from(
            new Set(
              decoded
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && Number.isInteger(id)),
            ),
          )
        : [];
    } catch (err) {
      console.warn('[bento-shell-mount] selected tabs payload parse failed:', err);
      currentSidebarSelectedTabIds = [];
    }
  }

  function handleSidebarContextMenuTitle(rawTitle) {
    // Format: BENTO_SIDEBAR_CONTEXT_MENU:<ts>:<base64-json>
    const tail = rawTitle.slice(SIDEBAR_CONTEXT_MENU_PREFIX.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return;
    let payload;
    try {
      payload = JSON.parse(decodeURIComponent(escape(atob(tail.slice(colon + 1)))));
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar menu payload parse failed:', err);
      return;
    }
    if (!payload || !payload.anchor || !Array.isArray(payload.items)) return;
    const shellFrame = document.getElementById('bento-shell-frame');
    if (!shellFrame) return;
    const shellRect = shellFrame.getBoundingClientRect();
    const anchor = {
      left: shellRect.left + Number(payload.anchor.left || 0),
      top: shellRect.top + Number(payload.anchor.top || 0),
      width: Number(payload.anchor.width || 1),
      height: Number(payload.anchor.height || 1),
    };
    const tabId = Number(payload.tabId);
    const hasTabId =
      payload.tabId !== null && payload.tabId !== undefined && Number.isFinite(tabId);
    const tabIndex = Number(payload.tabIndex);
    const tabIds = Array.isArray(payload.tabIds)
      ? Array.from(
          new Set(
            payload.tabIds
              .map((id) => Number(id))
              .filter((id) => Number.isFinite(id) && Number.isInteger(id)),
          ),
        )
      : hasTabId
        ? [tabId]
        : [];
    const parseTabIds = (value) =>
      Array.isArray(value)
        ? Array.from(
            new Set(
              value
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && Number.isInteger(id)),
            ),
          )
        : [];
    const closeMultipleTabIds =
      payload.closeMultipleTabIds && typeof payload.closeMultipleTabIds === 'object'
        ? {
            above: parseTabIds(payload.closeMultipleTabIds.above),
            below: parseTabIds(payload.closeMultipleTabIds.below),
            other: parseTabIds(payload.closeMultipleTabIds.other),
          }
        : { above: [], below: [], other: [] };
    const pinnedPanel =
      payload.pinnedPanel &&
      typeof payload.pinnedPanel.workspaceId === 'string' &&
      Number.isFinite(Number(payload.pinnedPanel.tabId))
        ? {
            workspaceId: payload.pinnedPanel.workspaceId,
            tabId: Number(payload.pinnedPanel.tabId),
          }
        : null;
    const folderId = typeof payload.folderId === 'string' ? payload.folderId : null;
    const newFolderId = typeof payload.newFolderId === 'string' ? payload.newFolderId : null;
    showChromeMenu({
      anchor,
      items: payload.items,
      placement: payload.placement === 'bottom start' ? 'bottom start' : undefined,
      onSelect: (itemId) => {
        if (itemId === 'new-tab') {
          openAddressEntry('newTab');
          return;
        }
        if (itemId === 'new-panel') {
          addNewPanel();
          return;
        }
        if (itemId === 'reopen-closed-tab') {
          dispatchShellAction({ type: 'tab/reopenClosed' });
          return;
        }
        if (itemId === 'select-all-tabs') {
          dispatchShellAction({ type: 'ui/selectAllTabs' });
          return;
        }
        if (hasTabId && itemId === 'new-tab-below') {
          dispatchShellAction({
            type: 'tab/create',
            ...(Number.isFinite(tabIndex) && Number.isInteger(tabIndex) && tabIndex >= 0
              ? { index: tabIndex + 1 }
              : {}),
          });
          return;
        }
        if (pinnedPanel && itemId === 'pinned-panel-remove') {
          dispatchShellAction({
            type: 'pinnedPanel/remove',
            workspaceId: pinnedPanel.workspaceId,
            tabId: pinnedPanel.tabId,
          });
          return;
        }
        if (pinnedPanel && itemId === 'pinned-panel-close') {
          dispatchShellAction({
            type: 'pinnedPanel/close',
            workspaceId: pinnedPanel.workspaceId,
            tabId: pinnedPanel.tabId,
          });
          return;
        }
        if (folderId && itemId === 'rename-folder') {
          dispatchShellAction({ type: 'ui/renameRequest', target: { kind: 'folder', id: folderId } });
          return;
        }
        if (folderId && itemId === 'delete-folder') {
          dispatchShellAction({ type: 'tabFolder/delete', id: folderId });
          return;
        }
        if (
          folderId &&
          typeof itemId === 'string' &&
          itemId.startsWith('move-folder-to-workspace:')
        ) {
          dispatchShellAction({
            type: 'tabFolder/assignWorkspace',
            id: folderId,
            workspaceId: itemId.slice('move-folder-to-workspace:'.length),
          });
          return;
        }
        if (!hasTabId) return;
        if (itemId === 'reload-tab') {
          dispatchShellAction({ type: 'tab/reload', id: tabId });
        } else if (itemId === 'unload-tab') {
          dispatchShellAction({ type: 'tab/unload', id: tabId });
        } else if (itemId === 'rename-tab') {
          dispatchShellAction({ type: 'ui/renameRequest', target: { kind: 'tab', id: tabId } });
        } else if (itemId === 'toggle-muted') {
          dispatchShellAction({ type: 'tab/toggleMuted', id: tabId });
        } else if (itemId === 'toggle-pin') {
          dispatchShellAction({ type: 'tab/togglePin', id: tabId });
        } else if (itemId === 'open-in-side-panel') {
          dispatchShellAction({ type: 'panel/add', id: tabId });
        } else if (itemId === 'close-tab') {
          dispatchShellAction({ type: 'tab/close', id: tabId });
        } else if (itemId === 'close-tabs-above') {
          dispatchShellAction({ type: 'tabs/close', ids: closeMultipleTabIds.above });
        } else if (itemId === 'close-tabs-below') {
          dispatchShellAction({ type: 'tabs/close', ids: closeMultipleTabIds.below });
        } else if (itemId === 'close-other-tabs') {
          dispatchShellAction({ type: 'tabs/close', ids: closeMultipleTabIds.other });
        } else if (itemId === 'reload-selected-tabs') {
          dispatchShellAction({ type: 'tabs/reload', ids: tabIds });
        } else if (itemId === 'close-selected-tabs') {
          dispatchShellAction({ type: 'tabs/close', ids: tabIds });
        } else if (itemId === 'move-selected-to-new-workspace') {
          dispatchShellAction({ type: 'tabs/moveToNewWorkspace', ids: tabIds });
        } else if (typeof itemId === 'string' && itemId.startsWith('move-to-workspace:')) {
          const workspaceId = itemId.slice('move-to-workspace:'.length);
          if (tabIds.length > 1) {
            dispatchShellAction({ type: 'tabs/assignWorkspace', ids: tabIds, workspaceId });
          } else {
            dispatchShellAction({
              type: 'tab/assignWorkspace',
              id: tabId,
              workspaceId,
            });
          }
        } else if (itemId === 'move-to-folder:new') {
          const id =
            newFolderId ||
            (typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : String(Date.now()));
          dispatchShellAction({ type: 'tabFolder/create', id, tabIds });
          dispatchShellAction({ type: 'ui/renameRequest', target: { kind: 'folder', id } });
        } else if (itemId === 'move-to-folder:none') {
          dispatchShellAction({ type: 'tabs/setFolder', ids: tabIds, folderId: null });
        } else if (typeof itemId === 'string' && itemId.startsWith('move-to-folder:')) {
          const targetFolderId = itemId.slice('move-to-folder:'.length);
          dispatchShellAction({ type: 'tabs/setFolder', ids: tabIds, folderId: targetFolderId });
        }
      },
    });
  }

  function handlePanelTrailerContextMenuTitle(rawTitle) {
    // Format: BENTO_PANEL_TRAILER_CONTEXT_MENU:<ts>:<base64-json>
    const tail = rawTitle.slice(PANEL_TRAILER_CONTEXT_MENU_PREFIX.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return;
    let payload;
    try {
      payload = JSON.parse(decodeURIComponent(escape(atob(tail.slice(colon + 1)))));
    } catch (err) {
      console.warn('[bento-shell-mount] panel trailer menu payload parse failed:', err);
      return;
    }
    if (!payload || !payload.anchor) return;
    const frame = document.getElementById('bento-panel-trailer-frame');
    if (!frame) return;
    const frameRect = frame.getBoundingClientRect();
    showChromeMenu({
      anchor: {
        left: frameRect.left + Number(payload.anchor.left || 0),
        top: frameRect.top + Number(payload.anchor.top || 0),
        width: Number(payload.anchor.width || 1),
        height: Number(payload.anchor.height || 1),
      },
      items: [{ id: 'add-new-panel', label: 'Add new panel' }],
      onSelect: (itemId) => {
        if (itemId !== 'add-new-panel') return;
        addNewPanel();
      },
    });
  }

  // Sidebar-driven panel focus signal. Fired by the PinnedPanels row
  // click in the React shell — workspace switch goes through the
  // tools port, but the workspace's panels are only materialized
  // after the next reconcile, so the target [data-bento-panel-tab-id]
  // element may not exist when this title write lands. Retry briefly
  // (covers the fade + reconcile window), then give up — the user
  // can still click the panel themselves.
  function handleFocusPanelTitle(rawTitle) {
    // Format: BENTO_FOCUS_PANEL:<ts>:<tabId>
    const tail = rawTitle.slice(FOCUS_PANEL_PREFIX.length);
    const colon = tail.indexOf(':');
    if (colon < 0) return;
    const tabId = Number.parseInt(tail.slice(colon + 1), 10);
    if (!Number.isInteger(tabId)) return;
    const DEADLINE_MS = 2000;
    const POLL_MS = 50;
    const started = Date.now();
    const tryFocus = () => {
      const panel = document.querySelector('[data-bento-panel-tab-id="' + tabId + '"]');
      if (panel) {
        // Scroll the strip so the panel lands at the leftmost visible
        // slot, matching the favicon-navigator-click affordance. Focus
        // the inner <browser> so the page receives keys natively
        // (mirrors setActiveByIndex's panel-target branch).
        try {
          scrollPanelToLeftmost(panel);
        } catch (err) {
          console.warn('[bento-shell-mount] FOCUS_PANEL scroll failed:', err);
        }
        const idx = getCycleIndexForPanelElement(panel);
        if (idx >= 0) {
          currentActiveIdx = idx;
          applyActiveMarker(idx);
          applyPanelFocusIndicator(idx);
        }
        try {
          const browserEl = getPanelTargetBrowser(panel);
          if (browserEl) browserEl.focus({ preventScroll: true });
          else panel.focus({ preventScroll: true });
        } catch (err) {
          console.warn('[bento-shell-mount] FOCUS_PANEL focus failed:', err);
        }
        return;
      }
      if (Date.now() - started > DEADLINE_MS) return;
      setTimeout(tryFocus, POLL_MS);
    };
    tryFocus();
  }

  // Sidebar drag-to-reorder. Resolves srcTabId + anchorTabId (WebExtension
  // ids from bento-tools' TabRegistry) to <tab> DOM elements via the same
  // tabTracker the panel reconciler uses, then calls
  // gBrowser.moveTabBefore / moveTabAfter. Those APIs operate on element
  // references (no `element.splitview` transformation), so the
  // currently-active tab — which has Bento's plain-object .splitview
  // marker — moves correctly. Firefox's tab-moved event fires from
  // gBrowser; bento-tools' TabRegistry.#onMoved catches it and emits the
  // `updated` delta that refreshes the sidebar mirror, so the visual
  // reorder rides the same pipeline as any other tab-index change.
  function handleTabMoveTitle(rawTitle) {
    // Format: BENTO_TAB_MOVE:<ts>:<srcId>:<anchorId>:<before|after>
    const tail = rawTitle.slice(TAB_MOVE_PREFIX.length);
    const parts = tail.split(':');
    if (parts.length !== 4) return;
    const srcId = Number.parseInt(parts[1], 10);
    const anchorId = Number.parseInt(parts[2], 10);
    const side = parts[3];
    if (!Number.isInteger(srcId) || !Number.isInteger(anchorId)) return;
    if (side !== 'before' && side !== 'after') return;
    let tabTracker;
    try {
      const mod = ChromeUtils.importESModule('resource://gre/modules/ExtensionParent.sys.mjs');
      tabTracker = mod.ExtensionParent?.apiManager?.global?.tabTracker;
    } catch (err) {
      console.warn('[bento-shell-mount] BENTO_TAB_MOVE: tabTracker import failed:', err);
      return;
    }
    if (!tabTracker) return;
    let srcTab;
    let anchorTab;
    try {
      srcTab = tabTracker.getTab(srcId);
      anchorTab = tabTracker.getTab(anchorId);
    } catch {
      // One of the tabs was closed between the drop and now — drop the
      // reorder silently. The sidebar will reflect the gone tab via its
      // own removed-delta path.
      return;
    }
    if (!srcTab || !anchorTab || srcTab === anchorTab) return;
    try {
      if (side === 'before') {
        window.gBrowser.moveTabBefore(srcTab, anchorTab);
      } else {
        window.gBrowser.moveTabAfter(srcTab, anchorTab);
      }
    } catch (err) {
      console.warn('[bento-shell-mount] BENTO_TAB_MOVE: gBrowser.moveTab* failed:', err);
    }
  }

  function updatePanelActivationFromChromeTarget(target) {
    if (!target || typeof target.closest !== 'function') return;
    if (
      isPanelFocusAutoScrollSuppressed() ||
      target.closest(
        '.bento-panel-splitter, .bento-layout-vsplitter, .bento-layout-hsplitter',
      )
    ) {
      return;
    }
    // Add-panel trailer focus still needs the same reveal behavior as
    // normal panels, but must bypass panel-index bookkeeping: the
    // trailer has neither data-bento-* attr, so closest() can walk
    // past it up to the outer #tabbrowser-tabbox and incorrectly
    // reset currentActiveIdx to 0.
    const trailerEl = target.closest('#bento-add-panel-trailer');
    if (trailerEl) {
      if (window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
        scrollPanelIntoViewFromRight(trailerEl);
      }
      applyFocusedPanelIndicator(null);
      return;
    }
    // Browser elements live inside the panel containers (notif-
    // boxes) tagged with data-bento-{main-panel,panel-tab-id};
    // closest() walks up to find the right one regardless of any
    // wrapper depth Firefox introduces between <browser> and the
    // panel container.
    const panelEl = target.closest(
      '.bento-subdivision-chooser, [data-bento-panel-tab-id], [data-bento-main-panel]',
    );
    if (!panelEl) {
      applyFocusedPanelIndicator(null);
      return;
    }
    // Only scroll if the panel is inside the active strip. If
    // tabpanels isn't in split-view mode, no strip to scroll.
    if (!window.gBrowser?.tabpanels?.classList.contains('bento-split-active')) {
      applyFocusedPanelIndicator(null);
      return;
    }
    const stripPanelEl =
      panelEl.classList?.contains('bento-subdivision-chooser')
        ? getOwningPanelForSubdivisionChooser(panelEl) || panelEl
        : getTopLevelSlotPanelElement(panelEl) || panelEl;
    if (isRestoredMainAutoScrollSuppressed(stripPanelEl)) {
      return;
    }
    scrollPanelIntoViewFromRight(stripPanelEl);
    // Sync the navigator's active marker to match the panel that
    // just received focus. Without this, clicking into a panel
    // scrolls the strip but leaves the favicon highlight stuck on
    // wherever the last keyboard cycle put it. Update state +
    // marker directly rather than calling setActiveByIndex —
    // that helper also focuses the panel's <browser>, which
    // would re-fire this same focusin handler.
    const targets = getPanelCycleTargets();
    let idx = getCycleIndexForPanelElement(panelEl);
    if (idx < 0 && panelEl.id === 'tabbrowser-tabbox' && targets.length > 0) {
      idx = 0;
    }
    if (idx >= 0) {
      currentActiveIdx = idx;
      applyActiveMarker(idx);
    }
    applyFocusedPanelIndicator(idx >= 0 ? targets[idx] : panelEl);
  }

  // Click-into-partial-panel auto-scroll. When the user clicks inside
  // a panel's <browser> content, Firefox's focus engine usually routes
  // chrome focus to that <browser> element — focusin fires on chrome's
  // document with the browser as the target. Some privileged about: pages
  // do not reliably produce that focusin path, so reconciled panel
  // browsers also attach a click fallback that calls the same helper.
  function attachPanelClickAutoScroll() {
    window.addEventListener(
      'focusin',
      (e) => {
        updatePanelActivationFromChromeTarget(e.target);
      },
      true,
    );
  }
  attachPanelClickAutoScroll();

  function handleBentoPanelContentClick(e) {
    if (e._bentoPanelContentClickHandled) return;
    e._bentoPanelContentClickHandled = true;
    updatePanelActivationFromChromeTarget(e.currentTarget || e.target);
  }

  function attachBentoPanelContentClickFallback(...targets) {
    for (const target of targets) {
      if (!target || target._bentoPanelContentClickFallbackAttached) continue;
      target.addEventListener('click', handleBentoPanelContentClick, true);
      target._bentoPanelContentClickFallbackAttached = true;
    }
  }

  // ─── "Open in new panel" link context-menu item ────────────────────────
  // Adds a menuitem to Firefox's contentAreaContextMenu that appears when
  // the user right-clicks a link inside any Bento panel (main or side).
  // Clicking the item dispatches panel/openAt with the link's URL plus
  // the source panel's identity — bento-tools then creates the tab and
  // inserts it as a panel immediately to the right of the source.
  function installOpenInNewPanelMenuItem() {
    const menu = document.getElementById('contentAreaContextMenu');
    if (!menu) {
      console.warn('[bento-shell-mount] contentAreaContextMenu missing');
      return;
    }
    if (document.getElementById('bento-context-open-in-panel')) return;

    const item = document.createXULElement('menuitem');
    item.id = 'bento-context-open-in-panel';
    item.setAttribute('label', 'Open in new panel');
    item.hidden = true;
    // Sit next to the existing "Open Link in New Tab" / "Open Link in
    // New Window" items if they exist; fall back to first child.
    const anchor =
      document.getElementById('context-openlinkincurrent') ||
      document.getElementById('context-openlink') ||
      menu.firstChild;
    menu.insertBefore(item, anchor);

    // Resolve the source panel container from gContextMenu.browser.
    // closest() walks up — when split-view is active, the inner main
    // panel and inner side panels carry data-bento-* attrs (set by
    // reconcilePanelsSplitView). When NO side panels exist yet, the
    // OUTER #tabbrowser-tabbox is the only element tagged data-bento-
    // main-panel (set by unifyMainWithStrip at boot). Accept that
    // case too: the outer tabbox has no data-bento-panel-tab-id, so
    // the command handler reads sourceTabId as null → handler inserts
    // at position 0 (first side panel), seeding split-view from a
    // right-click in a plain tab.
    function findSourcePanel() {
      const browser = typeof gContextMenu !== 'undefined' ? gContextMenu?.browser : null;
      if (!browser) return null;
      return browser.closest('[data-bento-panel-tab-id], [data-bento-main-panel]');
    }

    // Defer popupshowing-listener registration until DOMContentLoaded.
    // Firefox initializes gContextMenu inside a DOMContentLoaded callback in
    // browser-context.js — that callback is registered before this script
    // runs (browser-context.inc is parsed before browser-box.inc.xhtml), so
    // it fires first and Firefox's popupshowing listener attaches first. If
    // we attach during parsing, our listener registers earlier and runs
    // first on every popup — seeing gContextMenu from the PREVIOUS open
    // (or undefined initially) and bailing on !onLink before Firefox
    // reassigns it. Deferring to DOMContentLoaded guarantees Firefox's
    // listener registers first.
    const attachPopupShowingListener = () => {
      menu.addEventListener('popupshowing', () => {
        try {
          if (typeof gContextMenu === 'undefined' || !gContextMenu?.onLink) {
            item.hidden = true;
            return;
          }
          if (!gContextMenu.linkURL) {
            item.hidden = true;
            return;
          }
          if (!findSourcePanel()) {
            item.hidden = true;
            return;
          }
          item.hidden = false;
        } catch (err) {
          console.warn('[bento-shell-mount] open-in-panel popupshowing failed:', err);
          item.hidden = true;
        }
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachPopupShowingListener, { once: true });
    } else {
      attachPopupShowingListener();
    }

    item.addEventListener('command', () => {
      try {
        const url = gContextMenu?.linkURL;
        if (!url) return;
        const source = findSourcePanel();
        if (!source) return;
        const sourceTabId = source.dataset.bentoPanelTabId
          ? Number(source.dataset.bentoPanelTabId)
          : null;
        dispatchShellAction({ type: 'panel/openAt', url, sourceTabId });
      } catch (err) {
        console.warn('[bento-shell-mount] open-in-panel command failed:', err);
      }
    });
  }
  installOpenInNewPanelMenuItem();

  function getDevToolsShim() {
    try {
      const mod = ChromeUtils.importESModule(
        'chrome://devtools-startup/content/DevToolsShim.sys.mjs',
      );
      return mod.DevToolsShim || null;
    } catch (err) {
      console.warn('[bento-shell-mount] DevToolsShim import failed:', err);
      return null;
    }
  }

  async function selectNodeInToolbox(toolbox, tool, domReference) {
    if (!toolbox || !domReference) return;
    try {
      if (tool === 'accessibility') {
        await toolbox.selectTool('accessibility');
        const inspectorFront = await toolbox.commands.client.mainRoot.getFront('inspector');
        const nodeFront =
          await inspectorFront.getNodeActorFromContentDomReference(domReference);
        const panel = toolbox.getCurrentPanel?.();
        if (nodeFront && panel?.selectAccessibleForNode) {
          await panel.selectAccessibleForNode(nodeFront, 'browser-context-menu');
        }
        return;
      }
      const inspector = await toolbox.selectTool('inspector');
      const inspectorFront = toolbox.commands?.targetCommand?.targetFront?.inspectorFront;
      const front =
        inspectorFront || (await toolbox.commands.client.mainRoot.getFront('inspector'));
      const nodeFront = await front.getNodeActorFromContentDomReference(domReference);
      if (nodeFront) {
        inspector.selection.setNodeFront(nodeFront, { reason: 'browser-context-menu' });
      }
    } catch (err) {
      console.warn('[bento-shell-mount] selectNodeInToolbox failed:', err);
    }
  }

  function matchingLivePageToolbox(browserId) {
    const shim = getDevToolsShim();
    const toolboxes = shim?.getToolboxes?.();
    if (!toolboxes) return null;
    for (const toolbox of toolboxes) {
      try {
        if (toolbox?.isDestroying?.()) continue;
        if (toolbox?.hostType !== 'page') continue;
        const descriptor = toolbox.commands?.descriptorFront;
        if (descriptor?.browserId === browserId) return toolbox;
      } catch {
        // Ignore half-destroyed toolboxes.
      }
    }
    return null;
  }

  function closeDevtoolsPanelTab(tabId) {
    if (!Number.isFinite(tabId)) return;
    dispatchShellAction({ type: 'tab/close', id: tabId });
  }

  function openDevtoolsPanelFor({ browser, browserId, callerTabId, inspectedTabId, domReference, tool }) {
    const pairKey = `${callerTabId === null ? 'main' : callerTabId}:${inspectedTabId}`;
    const existingDevtoolsTabId = currentDevtoolsTabIdByPairKey.get(pairKey);
    if (Number.isFinite(existingDevtoolsTabId)) {
      const toolbox = matchingLivePageToolbox(browserId);
      if (toolbox) {
        void selectNodeInToolbox(toolbox, tool, domReference);
        if (currentWorkspaceId) {
          dispatchShellAction({
            type: 'panel/focus',
            workspaceId: currentWorkspaceId,
            id: existingDevtoolsTabId,
          });
        }
        return;
      }
    }
    if (
      callerTabId === null &&
      currentMainDevtoolsLink &&
      currentMainDevtoolsLink.inspectedTabId !== inspectedTabId
    ) {
      closeDevtoolsPanelTab(currentMainDevtoolsLink.devtoolsTabId);
    }

    const shim = getDevToolsShim();
    const url =
      'about:devtools-toolbox?type=tab&id=' +
      encodeURIComponent(String(browserId)) +
      '&tool=' +
      encodeURIComponent(tool);
    let timeoutId = null;
    const onReady = (event, maybeToolbox) => {
      try {
        const toolbox = maybeToolbox || event;
        const descriptor = toolbox?.commands?.descriptorFront;
        if (toolbox?.hostType !== 'page' || descriptor?.browserId !== browserId) return;
        if (timeoutId !== null) clearTimeout(timeoutId);
        shim?.off?.('toolbox-ready', onReady);
        void selectNodeInToolbox(toolbox, tool, domReference);
      } catch (err) {
        console.warn('[bento-shell-mount] toolbox-ready handling failed:', err);
      }
    };
    shim?.on?.('toolbox-ready', onReady);
    timeoutId = setTimeout(() => shim?.off?.('toolbox-ready', onReady), 30000);
    try {
      const tab = gBrowser.addTrustedTab(url, { skipAnimation: true });
      const tabId = getBentoTabId(tab);
      if (!Number.isFinite(tabId)) return;
      dispatchShellAction({
        type: 'panel/addDevtools',
        tabId,
        forTabId: callerTabId,
        inspectedTabId,
      });
    } catch (err) {
      if (timeoutId !== null) clearTimeout(timeoutId);
      shim?.off?.('toolbox-ready', onReady);
      console.warn('[bento-shell-mount] openDevtoolsPanelFor failed:', err);
    }
  }

  function installInspectInPanelMenuItems() {
    const menu = document.getElementById('contentAreaContextMenu');
    if (!menu || document.getElementById('bento-context-inspect-in-panel')) return;

    function findSourcePanel() {
      const browser = typeof gContextMenu !== 'undefined' ? gContextMenu?.browser : null;
      if (!browser) return null;
      return browser.closest('[data-bento-panel-tab-id], [data-bento-main-panel]');
    }

    const inspectItem = document.createXULElement('menuitem');
    inspectItem.id = 'bento-context-inspect-in-panel';
    inspectItem.setAttribute('label', 'Inspect in Panel');
    inspectItem.hidden = true;
    const inspectAnchor = document.getElementById('context-inspect');
    if (inspectAnchor?.nextSibling) menu.insertBefore(inspectItem, inspectAnchor.nextSibling);
    else menu.appendChild(inspectItem);

    const a11yItem = document.createXULElement('menuitem');
    a11yItem.id = 'bento-context-inspect-a11y-in-panel';
    a11yItem.setAttribute('label', 'Inspect Accessibility Properties in Panel');
    a11yItem.hidden = true;
    const a11yAnchor = document.getElementById('context-inspect-a11y');
    if (a11yAnchor?.nextSibling) menu.insertBefore(a11yItem, a11yAnchor.nextSibling);
    else menu.appendChild(a11yItem);

    const updateVisibility = () => {
      try {
        const source = findSourcePanel();
        const canShow = !!source && !source.dataset.bentoDevtoolsFor;
        const stockInspect = document.getElementById('context-inspect');
        const stockA11y = document.getElementById('context-inspect-a11y');
        inspectItem.hidden = !canShow || !stockInspect || stockInspect.hidden;
        a11yItem.hidden = !canShow || !stockA11y || stockA11y.hidden;
      } catch {
        inspectItem.hidden = true;
        a11yItem.hidden = true;
      }
    };
    const attachPopupShowingListener = () => {
      menu.addEventListener('popupshowing', updateVisibility);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachPopupShowingListener, { once: true });
    } else {
      attachPopupShowingListener();
    }

    const command = (tool) => {
      try {
        const browser = gContextMenu?.browser;
        const browserId = browser?.browserId;
        const source = findSourcePanel();
        if (!browser || !Number.isFinite(browserId) || !source) return;
        const callerTabId = source.dataset.bentoPanelTabId
          ? Number(source.dataset.bentoPanelTabId)
          : null;
        const inspectedTabId = getBentoTabId(gBrowser.getTabForBrowser(browser));
        if (!Number.isFinite(inspectedTabId)) return;
        openDevtoolsPanelFor({
          browser,
          browserId,
          callerTabId,
          inspectedTabId,
          domReference: gContextMenu?.targetIdentifier,
          tool,
        });
      } catch (err) {
        console.warn('[bento-shell-mount] Inspect in Panel command failed:', err);
      }
    };
    inspectItem.addEventListener('command', () => command('inspector'));
    a11yItem.addEventListener('command', () => command('accessibility'));
  }
  installInspectInPanelMenuItems();

  // ─── "Open in new panel" places context-menu item ──────────────────────
  // Mirrors installOpenInNewPanelMenuItem but for the bookmark / history /
  // sidebar Places menu (#placesContext). Right-click a bookmark on the
  // toolbar, in the bookmarks menu, or in the sidebar → "Open in New Panel"
  // dispatches panel/openAt with sourceTabId=null, which the handler treats
  // as "insert as first side panel" — same path the main-panel link
  // right-click already uses, so the behaviour is consistent across the
  // two surfaces.
  function installOpenInNewPanelBookmarkMenuItem() {
    const menu = document.getElementById('placesContext');
    if (!menu) return;
    if (document.getElementById('bento-places-context-open-in-panel')) return;

    const item = document.createXULElement('menuitem');
    item.id = 'bento-places-context-open-in-panel';
    item.setAttribute('label', 'Open in New Panel');
    item.hidden = true;
    // Sit immediately after "Open in New Tab" so the open-in-* items stay
    // visually grouped. Fall back through the rest of the family if the
    // preferred anchor is missing (private-browsing / container disabled).
    const anchor =
      document.getElementById('placesContext_open:newcontainertab') ||
      document.getElementById('placesContext_openContainer:tabs') ||
      document.getElementById('placesContext_openLinks:tabs') ||
      document.getElementById('placesContext_open:newwindow') ||
      document.getElementById('placesContext_openSeparator') ||
      null;
    if (anchor) menu.insertBefore(item, anchor);
    else menu.appendChild(item);

    // Read the single-selection URL. Firefox's own popupshowing listener
    // (PlacesUIUtils.placesContextShowing) runs first — it stashes the
    // resolved view on menu._view and the trigger element on
    // PlacesUIUtils.lastContextMenuTriggerNode. Managed (enterprise-policy)
    // bookmarks live in a separate DOM tree under #managed-bookmarks and
    // carry the URL directly on the trigger as .link instead of going
    // through a Places view.
    //
    // place: URIs are Firefox-internal query strings (history smart
    // folders, tag queries, etc.) — they don't render meaningfully in a
    // tab let alone a panel, so we hide the item for those.
    function getBookmarkUrl(callsite) {
      try {
        const trigger =
          typeof PlacesUIUtils !== 'undefined' ? PlacesUIUtils.lastContextMenuTriggerNode : null;
        if (trigger?.closest?.('#managed-bookmarks')) {
          const link = typeof trigger.link === 'string' ? trigger.link : null;
          const result = link && !link.startsWith('place:') ? link : null;
          return result;
        }
        const view = menu._view;
        const selected = view?.selectedNode;
        if (!selected) {
          return null;
        }
        const uri = typeof selected.uri === 'string' ? selected.uri : null;
        if (!uri || uri.startsWith('place:')) {
          return null;
        }
        return uri;
      } catch (err) {
        console.warn(
          '[bento-shell-mount] places open-in-panel:',
          callsite,
          '— getBookmarkUrl threw:',
          err,
        );
        return null;
      }
    }

    // Same registration-order rationale as installOpenInNewPanelMenuItem:
    // Firefox attaches its popupshowing handler inside DOMContentLoaded
    // (placesContextMenu.js), so we defer ours to the same event to
    // guarantee menu._view is populated by the time we run.
    const attachPopupShowing = () => {
      menu.addEventListener('popupshowing', () => {
        try {
          const url = getBookmarkUrl('popupshowing');
          item.hidden = !url;
        } catch (err) {
          console.warn('[bento-shell-mount] places open-in-panel popupshowing failed:', err);
          item.hidden = true;
        }
      });
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', attachPopupShowing, { once: true });
    } else {
      attachPopupShowing();
    }

    item.addEventListener('command', () => {
      try {
        const url = getBookmarkUrl('command');
        if (!url) {
          console.warn(
            '[bento-shell-mount] places open-in-panel: command fired but no url — view was probably cleared by popuphiding before command ran',
          );
          return;
        }
        const sent = dispatchShellAction({ type: 'panel/openAt', url, sourceTabId: null });
        void sent;
      } catch (err) {
        console.warn('[bento-shell-mount] places open-in-panel command failed:', err);
      }
    });
  }
  installOpenInNewPanelBookmarkMenuItem();

  function injectPanelHeaderIntoLinkedPanel(tab, url) {
    const panelEl = document.getElementById(tab.linkedPanel);
    if (!panelEl) return;
    if (!tab.linkedBrowser) return;
    const tabId = getBentoTabId(tab);
    const numericTabId = Number(tabId);
    const canCompareHeaderTabId = Number.isFinite(numericTabId);
    let existingHeader = panelEl.querySelector(
      ':scope > .bento-panel-header[data-bento-injected="1"]',
    );
    if (existingHeader) {
      const headerTabId = Number(existingHeader.dataset.bentoPanelHeaderTabId);
      const headerTabMatches = !canCompareHeaderTabId || headerTabId === numericTabId;
      const headerBrowserMatches =
        !existingHeader._bentoBrowserEl || existingHeader._bentoBrowserEl === tab.linkedBrowser;
      if (!headerTabMatches || !headerBrowserMatches) {
        removePanelHeaderElement(existingHeader);
        existingHeader = null;
      } else {
        resetPanelHeaderInlineState(existingHeader);
        forcePanelHeaderInteractiveState(existingHeader);
        ensurePanelLoadingOverlay(panelEl, tab.linkedBrowser);
        ensureHeaderRestoreHandle(panelEl, numericTabId);
        return; // already injected
      }
    }
    const header = createPanelHeader(tab.linkedBrowser, url, tabId);
    header.dataset.bentoInjected = '1';
    if (canCompareHeaderTabId) {
      header.dataset.bentoPanelHeaderTabId = String(numericTabId);
    }
    header._bentoBrowserEl = tab.linkedBrowser;
    forcePanelHeaderInteractiveState(header);
    // notificationbox children typically are [notificationstack, browser];
    // insert header as the first child so it visually sits above content.
    panelEl.insertBefore(header, panelEl.firstChild);
    ensurePanelLoadingOverlay(panelEl, tab.linkedBrowser);
    ensureHeaderRestoreHandle(panelEl, numericTabId);
    setupHeaderDrag(header, panelEl, tabId);
  }

  function ensureHeaderRestoreHandle(panelEl, tabId) {
    if (!panelEl) return null;
    const numericTabId = Number(tabId);
    if (!Number.isFinite(numericTabId)) return null;
    let handle = panelEl.querySelector(':scope > .bento-panel-header-restore');
    if (handle) {
      handle.dataset.bentoPanelHeaderRestoreTabId = String(numericTabId);
      return handle;
    }
    handle = document.createElementNS(HTML_NS, 'button');
    handle.type = 'button';
    handle.className = 'bento-panel-header-restore';
    handle.setAttribute('aria-label', 'Show panel header');
    handle.dataset.bentoPanelHeaderRestoreTabId = String(numericTabId);
    const pill = document.createElementNS(HTML_NS, 'span');
    pill.className = 'bento-panel-header-restore__pill';
    handle.appendChild(pill);
    handle.addEventListener('click', () => {
      const liveTabId = Number(handle.dataset.bentoPanelHeaderRestoreTabId);
      setPanelHeaderHidden(panelEl, liveTabId, false);
    });
    panelEl.appendChild(handle);
    return handle;
  }

  function removePanelHeaderElement(header) {
    if (!header) return;
    if (header._bentoProgressBrowser && header._bentoProgressListener) {
      try {
        header._bentoProgressBrowser.removeProgressListener(header._bentoProgressListener);
      } catch {
        // The browser may already be mid-removal/remoteness-change.
      }
    }
    delete header._bentoProgressBrowser;
    delete header._bentoProgressListener;
    header.remove();
  }

  function removeInjectedPanelHeader(panelEl) {
    if (!panelEl) return;
    const header = panelEl.querySelector(':scope > .bento-panel-header[data-bento-injected="1"]');
    if (header) removePanelHeaderElement(header);
    const overlay = panelEl.querySelector(':scope > .bento-panel-loading-overlay');
    if (overlay) overlay.remove();
    const restoreHandle = panelEl.querySelector(':scope > .bento-panel-header-restore');
    if (restoreHandle) restoreHandle.remove();
    if (panelEl.__bentoLoadingBrowser && panelEl.__bentoLoadingListener) {
      try {
        panelEl.__bentoLoadingBrowser.removeProgressListener(panelEl.__bentoLoadingListener);
      } catch {
        // best-effort cleanup
      }
    }
    delete panelEl.__bentoLoadingBrowser;
    delete panelEl.__bentoLoadingListener;
  }

  function forceSelectedMainPanelPaint(tab, panelEl, browserEl) {
    if (!tab || !panelEl || !browserEl) return;
    panelEl.removeAttribute('hidden');
    panelEl.removeAttribute('collapsed');
    panelEl.style.removeProperty('display');
    panelEl.style.removeProperty('opacity');
    panelEl.style.removeProperty('visibility');
    panelEl.style.removeProperty('pointer-events');
    panelEl.style.removeProperty('-moz-subtree-hidden-only-visually');

    const browserContainer = panelEl.querySelector?.(':scope > .browserContainer') || null;
    const browserStack =
      panelEl.querySelector?.(':scope > .browserContainer > .browserStack') ||
      panelEl.querySelector?.(':scope > .browserStack') ||
      null;
    for (const el of [browserContainer, browserStack, browserEl]) {
      if (!el) continue;
      el.removeAttribute?.('hidden');
      el.removeAttribute?.('collapsed');
      el.style.removeProperty('display');
      el.style.removeProperty('opacity');
      el.style.removeProperty('visibility');
      el.style.removeProperty('pointer-events');
      el.style.removeProperty('-moz-subtree-hidden-only-visually');
    }
    browserEl.removeAttribute('blank');
    browserEl.removeAttribute('pendingpaint');
    try {
      browserEl.preserveLayers?.(true);
      browserEl.renderLayers = true;
      browserEl.docShellIsActive = true;
    } catch {
      // Best-effort repaint after split-view teardown.
    }
  }

  function restoreSelectedMainBrowser(gBrowser, tabpanels, context) {
    try {
      const selectedTab = gBrowser?.selectedTab;
      const selectedPanel = selectedTab?.linkedPanel
        ? document.getElementById(selectedTab.linkedPanel)
        : null;
      if (selectedPanel && tabpanels) {
        tabpanels.selectedPanel = selectedPanel;
      }
      const selectedBrowser = getLivePanelBrowser(selectedTab);
      if (selectedBrowser) {
        forceSelectedMainPanelPaint(selectedTab, selectedPanel, selectedBrowser);
      }
      scheduleSelectedMainBrowserRepaint(gBrowser, tabpanels, selectedTab, context);
    } catch (err) {
      console.warn('[bento-shell-mount] ' + context + ' selected browser restore failed:', err);
    }
  }

  function scheduleSelectedMainBrowserRepaint(gBrowser, tabpanels, expectedTab, context) {
    const repaint = () => {
      try {
        if (!expectedTab || gBrowser?.selectedTab !== expectedTab) {
          return;
        }
        const selectedPanel = document.getElementById(expectedTab.linkedPanel);
        if (selectedPanel && tabpanels) {
          tabpanels.selectedPanel = selectedPanel;
        }
        const browserEl = getLivePanelBrowser(expectedTab);
        if (!browserEl) return;
        forceSelectedMainPanelPaint(expectedTab, selectedPanel, browserEl);
        browserEl.preserveLayers?.(true);
        browserEl.docShellIsActive = false;
        browserEl.docShellIsActive = true;
      } catch (err) {
        console.warn('[bento-shell-mount] ' + context + ' selected browser repaint failed:', err);
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(repaint));
    window.setTimeout(repaint, 80);
  }

  // Closing a window destroys every tab it hosts, and bento-tools could only recreate them from
  // their URLs later, losing page state, history, form text and media. So a window that closes
  // while another Bento window stays open adopts its live tabs into that window first
  // (gBrowser.adoptTab, the docShell swap behind tabs.move; the tab id is kept). Two listeners
  // cover every close, both synchronous and followed by teardown with no way to cancel it:
  //   'close'          the OS close button. window.onclose = WindowIsClosing has already shown
  //                    the closing-tabs warning and the beforeunload prompts (a cancelled close
  //                    arrives with defaultPrevented).
  //   'DOMWindowClose' window.close() from chrome script, windows.remove, Cmd+Shift+W after
  //                    WindowIsClosing. CanClose (the same prompts) ran before it.
  // Each adopted tab gets a 'bento.handover' tab value, a list of the windows it was handed
  // between (a tab can be handed on again before bento-tools has seen the first hop), so
  // bento-tools can tell this from a user dragging a tab out: it keeps the tab's workspace
  // (tabs/Handover.ts).
  const TOOLS_SESSION_PREFIX = 'extension:bento-tools@bento.app:';
  const HANDOVER_SESSION_KEY = TOOLS_SESSION_PREFIX + 'bento.handover';
  const CLOSING_TAB_SESSION_KEY = TOOLS_SESSION_PREFIX + 'bento.closingTab';
  const WINDOW_WORKSPACE_SESSION_KEY = TOOLS_SESSION_PREFIX + 'bento.activeWorkspaceId';
  // How long bento-tools matches a hop; keep in step with HANDOVER_TTL_MS in tabs/Handover.ts.
  const HANDOVER_TTL_MS = 15000;
  let pageClosedTab = null;

  // True while one of the window's tabs is answering a beforeunload check. permitUnload throws
  // for a tab that is already being asked, so a close repeated while its prompt is still up goes
  // on regardless; neither side of a handover should be a window in that state.
  function isCheckingUnload(win) {
    let busy = false;
    for (const browser of win.gBrowser.browsers) {
      // A lazy (not yet restored) browser is not connected and has nothing to unload.
      if (!browser.isConnected) continue;
      browser.getInPermitUnload((checking) => {
        if (checking) busy = true;
      });
    }
    return busy;
  }

  // Another window that can take tabs: a regular window (visible toolbar, not private, the same
  // Fission mode: swapBrowsersAndCloseOther refuses a swap between different ones) with a mounted
  // shell that is still open, not in the middle of a close prompt of its own, and was given a
  // workspace, which tools does after its shell/hello.
  function findHandoverSurvivor(SessionStore) {
    for (const other of Services.wm.getEnumerator('navigator:browser')) {
      try {
        if (
          other !== window &&
          !other.closed &&
          other.__bentoShellMountInitialized &&
          other.toolbar?.visible &&
          !BentoPrivateBrowsingUtils.isWindowPrivate(other) &&
          other.gFissionBrowser === window.gFissionBrowser &&
          !other.gDialogBox?.isOpen &&
          !isCheckingUnload(other) &&
          SessionStore.getCustomWindowValue(other, WINDOW_WORKSPACE_SESSION_KEY) &&
          getChromeWindowId(other) !== null
        ) {
          return other;
        }
      } catch {
        // SessionStore throws for a window it does not track yet: not ready for tabs.
      }
    }
    return null;
  }

  // A tab's window.close() also reaches the window, as a DOMWindowClose from the browser
  // element that is not cancelable (BrowserElementParent). The tabbrowser then closes the tab,
  // or the window when it is the only tab, from inside that event: the page asked to go, so
  // that tab is not handed over. Registered in the capture phase to run before the tabbrowser.
  function notePageClose(event) {
    if (event.target === window) return;
    pageClosedTab = window.gBrowser.getTabForBrowser(event.target) ?? null;
    window.setTimeout(() => (pageClosedTab = null));
  }

  function parseHandoverHops(value) {
    try {
      const hops = JSON.parse(value);
      return Array.isArray(hops) ? hops.filter((hop) => typeof hop?.at === 'number') : [];
    } catch {
      return [];
    }
  }

  // adoptTab for one tab. Null when Firefox refuses or fails, logged with the tab's name: adoptTab
  // first makes an empty twin in `dest`, TabOpen moves the tab's id and custom values to it, and
  // a refusal removes the twin with them. The tab stays in this window as it is, but bento-tools
  // no longer knows it and its values are gone, so it is not parked and not restored by its
  // workspace. Everything adoptTab refuses on its own terms is ruled out before the call.
  //
  // On TabClose SessionStore waits for a flush of the old browser and then copies its cached
  // state, history included, to the twin. That flush promise belongs to this window, and
  // nothing chained on it runs once the window is gone (the close that follows), so the copy
  // never happened and the adopted tab had no history in SessionStore until it navigated. For
  // the call the old frame loader hands out a promise of the survivor that settles with it, and
  // adds it to `flushes` for the session save that follows (saveSessionAfterHandover).
  function adoptTabInto(survivor, tab, SessionStore, flushes) {
    const dest = survivor.gBrowser;
    const loader = tab.linkedBrowser.frameLoader;
    const requestFlush = loader?.requestTabStateFlush;
    let adopted = null;
    let error = 'refused';
    let pendingValues = null;
    try {
      // A pending (not yet restored) tab comes out of adoptTab without its custom values: its
      // state is copied to the new tab, extData not included. A live tab's values moved with it.
      if (tab.hasAttribute('pending')) {
        pendingValues = JSON.parse(SessionStore.getTabState(tab)).extData;
      }
      if (requestFlush) {
        loader.requestTabStateFlush = () => {
          const flushed = requestFlush.call(loader);
          const survivorFlush = new survivor.Promise((resolve, reject) =>
            flushed.then(resolve, reject),
          );
          flushes.push(survivorFlush);
          return survivorFlush;
        };
      }
      adopted = dest.adoptTab(tab, {
        tabIndex: tab.pinned ? dest.pinnedTabCount : dest.tabs.length,
        selectTab: false,
      });
    } catch (err) {
      error = err;
    } finally {
      if (requestFlush) delete loader.requestTabStateFlush;
    }
    if (!adopted) {
      const url = tab.linkedBrowser.currentURI?.spec;
      console.error('[bento-shell-mount] adoptTab failed, the tab stays:', tab.label, url, error);
      return null;
    }
    for (const [key, value] of Object.entries(pendingValues ?? {})) {
      SessionStore.setCustomTabValue(adopted, key, value);
    }
    return adopted;
  }

  // The survivor's half of a handover: write the session once SessionStore has copied the
  // adopted tabs' state to their new browsers. SessionStore only writes 2 to 15 s after a close
  // (SessionSaver.runDelayed) and a tab's history reaches the parent up to 15 s after it
  // changes, so a crash just after a handover would lose every adopted tab that an earlier write
  // did not hold. The copy is a reaction to the flush promises adoptTabInto collected, so the
  // write waits for them and one more task. Called by the closing window on its survivor
  // (window.__bentoSaveSessionAfterHandover): nothing of the closing window runs after the
  // close, so the wait and the write must be this window's promises and timers. Handovers
  // whose requests arrive before this window's next timer task share one write (the batch is
  // sealed by a timer, so a request from a promise reaction still joins); a chain of closes ends
  // in the last survivor, which holds the tabs of the earlier ones. A flush that has not settled
  // after SESSION_SAVE_CAP_MS does not hold the write. Since run() also resets SessionStore's own
  // timer, each flush that settles after the cap then gets a write of its own, one timer task
  // later (those that settle before that task share it), or that tab's state would stay out of
  // the file until the next interval. A flush that never settles arms nothing.
  const SESSION_SAVE_CAP_MS = 2000;
  let sessionSaveFlushes = null;
  async function saveSessionAfterHandover(flushes) {
    if (sessionSaveFlushes) {
      sessionSaveFlushes.push(...flushes);
      return;
    }
    sessionSaveFlushes = [...flushes];
    const nextTask = () => new Promise((resolve) => window.setTimeout(resolve));
    await nextTask();
    const batch = sessionSaveFlushes;
    sessionSaveFlushes = null;
    const outstanding = new Set(batch);
    let allIn;
    const inTime = new Promise((resolve) => (allIn = resolve));
    let afterCap = false;
    let followUp = null;
    const onSettled = (flush) => {
      outstanding.delete(flush);
      if (!afterCap) {
        if (outstanding.size === 0) allIn(true);
      } else {
        followUp ??= nextTask().then(() => {
          followUp = null;
          return writeSessionAfterHandover();
        });
      }
    };
    for (const flush of batch) {
      const done = () => onSettled(flush);
      flush.then(done, done);
    }
    if (batch.length === 0) allIn(true);
    let capTimer;
    const capped = new Promise((resolve) => {
      capTimer = window.setTimeout(() => resolve(false), SESSION_SAVE_CAP_MS);
    });
    const allInTime = await Promise.race([inTime, capped]);
    window.clearTimeout(capTimer);
    await nextTask();
    // From here on a settling flush is newer than this write's state: it gets a write too.
    afterCap = !allInTime;
    await writeSessionAfterHandover();
  }
  async function writeSessionAfterHandover() {
    // A quit writes the session itself.
    if (window.closed || Services.startup.attemptingQuit) return;
    try {
      await getSessionSaver()?.run();
    } catch (err) {
      console.warn('[bento-shell-mount] session save after a window handover failed:', err);
    }
  }
  window.__bentoSaveSessionAfterHandover = saveSessionAfterHandover;

  function handOverTabsBeforeClose(event) {
    if (event.target !== window || event.defaultPrevented || handingOverTabs) return;
    // A quit closes every window itself and SessionStore collects them as they are. shuttingDown
    // is still false then; attemptingQuit is set just before the windows are closed.
    if (Services.startup.attemptingQuit) return;
    if (BentoPrivateBrowsingUtils.isWindowPrivate(window) || !window.toolbar?.visible) return;
    const SessionStore = getSessionStore();
    const survivor = SessionStore && findHandoverSurvivor(SessionStore);
    const from = getChromeWindowId();
    const to = survivor && getChromeWindowId(survivor);
    if (!survivor || from === null || to === null) return;
    // Empty, closing and tools-closing tabs (a workspace delete marks them before it closes
    // the window) are not worth keeping, nor is the tab whose page is closing the window. A tab
    // that is not remote stays too: its twin is always remote, and swapBrowsersAndCloseOther
    // refuses a swap between the two. (It also refuses a closing tab, a private mismatch and a
    // Fission mismatch, all ruled out here and in findHandoverSurvivor, and a tabbrowser whose
    // window is already closing, which is not the case for any close that reaches this handler
    // with live tabs.) A tab left behind is parked with the window, as before the handover.
    const keep = Array.from(window.gBrowser.tabs).filter(
      (tab) =>
        !tab.closing &&
        !tab.isEmpty &&
        tab.linkedBrowser.isRemoteBrowser &&
        tab !== pageClosedTab &&
        !SessionStore.getCustomTabValue(tab, CLOSING_TAB_SESSION_KEY),
    );
    if (keep.length === 0 || isCheckingUnload(window)) return;
    // adoptTab does not cope with Bento's split-view markers, and the window is going anyway.
    reconcilePanelsSplitView([]);
    handingOverTabs = true;
    // Adopting a window's last tab closes the window from inside adoptTab and skips the TabClose
    // a DevTools toolbox moves with. A blank selected tab stays behind, so no adopted tab is the
    // last one or the selected one, and the window closes as it was going to. Blank pages are
    // not parked. addTab returns null when it cannot make the tab.
    let anchor = null;
    try {
      anchor = window.gBrowser.addTrustedTab('about:blank', {
        inBackground: false,
        skipAnimation: true,
      });
    } catch (err) {
      console.warn('[bento-shell-mount] blank tab for a window handover failed:', err);
    }
    if (!anchor?.isConnected) {
      console.warn('[bento-shell-mount] no tab holds the window open, nothing handed over');
      return;
    }
    const flushes = [];
    let adoptedCount = 0;
    for (const tab of keep) {
      const adopted = adoptTabInto(survivor, tab, SessionStore, flushes);
      if (!adopted) continue;
      adoptedCount += 1;
      // Hops tools can no longer match, or that claim to be from the future, are dropped as the
      // next one is appended: tools only reads this value.
      const now = Date.now();
      const hops = parseHandoverHops(
        SessionStore.getCustomTabValue(adopted, HANDOVER_SESSION_KEY),
      ).filter((hop) => hop.at <= now && now - hop.at <= HANDOVER_TTL_MS);
      hops.push({ from, to, at: now });
      SessionStore.setCustomTabValue(adopted, HANDOVER_SESSION_KEY, JSON.stringify(hops));
    }
    if (adoptedCount === 0) return;
    // Fire and forget: the survivor runs the save, this window is gone in a moment.
    try {
      survivor.__bentoSaveSessionAfterHandover(flushes);
    } catch (err) {
      console.warn('[bento-shell-mount] session save after a window handover failed:', err);
    }
  }

  function attachWindowCloseHandover() {
    // Added once the window has loaded: window.onclose is assigned while it is parsed, and a
    // handler property keeps its place in the listener order, so this runs after it and sees
    // whether it cancelled the close.
    if (document.readyState !== 'complete') {
      window.addEventListener('load', attachWindowCloseHandover, { once: true });
      return;
    }
    window.addEventListener('close', handOverTabsBeforeClose);
    window.addEventListener('DOMWindowClose', notePageClose, true);
    window.addEventListener('DOMWindowClose', handOverTabsBeforeClose, true);
  }

  // Re-reconcile the split view when the active main tab changes —
  // splitViewPanels[0] needs to follow gBrowser.selectedTab. Cheap:
  // computes the same desired array minus an unchanged panel set.
  // No-op when the pref is off.
  //
  // Listen on multiple targets to make sure we catch the event no matter
  // how it's dispatched: tabContainer (where Mozilla's own listeners
  // live), gBrowser itself (some flows fire here), and the window
  // (TabSelect bubbles). Use a single dedup'd callback so we don't
  // run the reconciler multiple times per actual selection change.
  function attachTabSelectListener() {
    // The IIFE that hosts this script runs synchronously during window
    // construction, before gBrowser, gBrowser.tabContainer, and
    // gBrowser.tabpanels are wired up. If we early-returned without
    // attaching, none of the selection signals would ever fire and
    // new-tab creation would silently bypass the reconciler — that's
    // exactly the bug we hit when the listeners stayed silent for
    // Cmd+T despite TabOpen demonstrably being dispatched. Defer until
    // the window is fully loaded.
    if (!window.gBrowser?.tabContainer || !window.gBrowser?.tabpanels) {
      if (document.readyState !== 'complete') {
        const evt = document.readyState === 'loading' ? 'DOMContentLoaded' : 'load';
        window.addEventListener(evt, attachTabSelectListener, { once: true });
      }
      return;
    }
    // Override gBrowser.on_visibilitychange so it doesn't deactivate
    // split-view panels when the AsyncTabSwitcher isn't around.
    //
    // Background: tabbrowser.js:8158's on_visibilitychange runs the
    // `!this._switcher` fallback that iterates selectedBrowsers and
    // sets docShellIsActive = !document.hidden on each. With the
    // AsyncTabSwitcher, this branch is skipped (the switcher handles
    // visibility itself, respecting splitViewBrowsers). But the
    // switcher destroys itself after every successful tab switch
    // (AsyncTabSwitcher.sys.mjs:343 finish() → destroy() →
    // tabbrowser._switcher = null), so by the time a visibility event
    // fires, _switcher is null again, the fallback runs, and our
    // panels get deactivated. Empirically observed: pre-warmup logs
    // showed "switcher exists: false" at the start of every reconcile
    // even though warmupTab created it inside the previous one.
    //
    // Our override is a no-op when in split-view mode. Panels stay
    // active regardless of window visibility — small additional CPU
    // cost when the window is minimised, but no blank-panel race.
    // Out of split-view mode, falls through to the original handler
    // so non-Bento behaviour is preserved.
    if (
      window.gBrowser &&
      typeof window.gBrowser.on_visibilitychange === 'function' &&
      !window.gBrowser.__bentoVisOverride
    ) {
      bentoCompatNoteNative('gBrowser.on_visibilitychange', window.gBrowser.on_visibilitychange);
      const original = window.gBrowser.on_visibilitychange.bind(window.gBrowser);
      window.gBrowser.on_visibilitychange = function () {
        if (this.tabpanels?.hasAttribute('splitview')) {
          return;
        }
        return original();
      };
      window.gBrowser.__bentoVisOverride = true;
    }

    // Moving a panel's <browser> can transiently detach its browsingContext.
    // Firefox can synchronously run MozTab.isEmpty from its progress
    // listener during that move; the stock getter reads
    // browser.hasContentOpener, which throws when browsingContext is null.
    // Treat that narrow transient as "not empty" so the native listener
    // keeps bookkeeping intact.
    if (window.gBrowser && !window.gBrowser.__bentoTabIsEmptyOverride) {
      const sampleTab = window.gBrowser.tabs?.[0] || null;
      let proto = sampleTab ? Object.getPrototypeOf(sampleTab) : null;
      let ownerProto = null;
      let descriptor = null;
      while (proto && !descriptor) {
        descriptor = Object.getOwnPropertyDescriptor(proto, 'isEmpty');
        if (descriptor) ownerProto = proto;
        proto = Object.getPrototypeOf(proto);
      }
      if (ownerProto && descriptor?.get && descriptor.configurable) {
        const originalIsEmpty = descriptor.get;
        bentoCompatNoteNative('MozTabbrowserTab.isEmpty', originalIsEmpty);
        Object.defineProperty(ownerProto, 'isEmpty', {
          configurable: true,
          enumerable: descriptor.enumerable,
          get() {
            try {
              return originalIsEmpty.call(this);
            } catch (err) {
              const browserEl = this?.linkedBrowser || null;
              try {
                if (browserEl && !browserEl.browsingContext) {
                  return false;
                }
              } catch {
                return false;
              }
              throw err;
            }
          },
        });
        window.gBrowser.__bentoTabIsEmptyOverride = true;
      }
    }

    // Firefox can remove progress listeners while a split-view panel browser is
    // already changing remoteness or being torn down. In that state
    // nsIWebProgress.removeProgressListener throws NS_ERROR_FAILURE even
    // though the desired end state ("listener is not attached") is already
    // true. Swallow only that stale-listener failure; all other errors still
    // surface normally.
    try {
      const BrowserCtor = customElements.get('browser');
      const browserProto = BrowserCtor?.prototype || null;
      if (
        browserProto &&
        typeof browserProto.removeProgressListener === 'function' &&
        !browserProto.__bentoRemoveProgressListenerGuard
      ) {
        const originalRemoveProgressListener = browserProto.removeProgressListener;
        bentoCompatNoteNative(
          'MozBrowser.prototype.removeProgressListener',
          originalRemoveProgressListener,
        );
        browserProto.removeProgressListener = function (...args) {
          try {
            return originalRemoveProgressListener.apply(this, args);
          } catch (err) {
            if (isStaleWebProgressRemoveError(err)) {
              return undefined;
            }
            throw err;
          }
        };
        browserProto.__bentoRemoveProgressListenerGuard = true;
      }
    } catch {
      // Best-effort compatibility guard for Firefox chrome internals.
    }

    // Scope tab-close succession to the current workspace's sidebar tabs.
    // Firefox's _findTabToBlurTo (Tabbrowser.sys.mjs) picks "the next
    // visible tab" when the selected tab is closed. In Bento, the global
    // tab list is shared across workspaces, so Firefox's default
    // succession can land on:
    //   (a) a strip panel — promotes it to main, shifts every other
    //       strip slot to fill the gap. Symptom: "strip shifts as if
    //       the main slot itself is closing."
    //   (b) a tab in another workspace (or unassigned) — the new
    //       active is "foreign" and doesn't appear in the current
    //       workspace's sidebar list. Symptom: "the tab that becomes
    //       active is sometimes not one of the tabs in the workspace."
    //
    // Exclude both classes from succession. Firefox's existing fallback
    // chain (successor → owner → next visible → collapsed-group) runs
    // against the filtered set, landing on a current-workspace sidebar
    // tab whenever one exists. If none remain (degenerate case: every
    // other tab is a panel or foreign), fall back to the unfiltered
    // original so we don't strand selectedTab at null.
    //
    // The deferred TabSelect reconcile (see `reconcile` below) is the
    // orthogonal half of this fix: by the time it runs Firefox has set
    // tab.closing, so the reconciler's `resolved` list drops the closing tab
    // instead of re-rendering it as a strip panel for one frame.
    if (
      window.gBrowser &&
      typeof window.gBrowser._findTabToBlurTo === 'function' &&
      !window.gBrowser.__bentoFindTabOverride
    ) {
      bentoCompatNoteNative('gBrowser._findTabToBlurTo', window.gBrowser._findTabToBlurTo);
      const original = window.gBrowser._findTabToBlurTo.bind(window.gBrowser);
      window.gBrowser._findTabToBlurTo = function (aTab, aExcludeTabs = []) {
        const tabTracker = getTabTracker();
        const SessionStore = getSessionStore();
        const haveWorkspaceContext = currentWorkspaceId && SessionStore;
        const havePanelContext = currentPanelTabIds.size > 0 && tabTracker;
        if (haveWorkspaceContext || havePanelContext) {
          const panelExtras = [];
          const foreignExtras = [];
          for (const tab of this.tabs) {
            if (tab === aTab) continue;
            if (havePanelContext) {
              let webExtId = null;
              try {
                webExtId = tabTracker.getId(tab);
              } catch {
                /* tabTracker may transiently not know about a tab */
              }
              if (webExtId !== null && currentPanelTabIds.has(webExtId)) {
                panelExtras.push(tab);
                continue;
              }
            }
            if (haveWorkspaceContext) {
              let wsValue = null;
              try {
                const raw = SessionStore.getCustomTabValue(tab, WORKSPACE_SESSION_KEY);
                if (raw) wsValue = JSON.parse(raw);
              } catch {
                /* tab without value, treat as null (foreign) */
              }
              if (wsValue !== currentWorkspaceId) {
                foreignExtras.push(tab);
              }
            }
          }
          // Preference order:
          //   1. Current-workspace sidebar tab (excludes both panels
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

    // Tear-out hands the new window `aTab.splitview ?? aTab`, and the new
    // window adopts the tab only when that argument is a XUL element
    // (getTabToAdopt in browser-init.js). While the reconciler has a tab marked,
    // `splitview` is Bento's plain-object marker, so the new window silently
    // adopts nothing: the source tab stays put and the new window opens with
    // blank tabs of its own. Firefox reads the element synchronously while it
    // builds the window arguments, so the markers are hidden for that call only
    // and put back right after.
    const hideBentoSplitViewMarkers = (gBrowser) => {
      const hidden = [];
      for (const tab of gBrowser.tabs) {
        const descriptor = Object.getOwnPropertyDescriptor(tab, 'splitview');
        if (descriptor?.value?.kind !== BENTO_SPLIT_KIND) continue;
        hidden.push([tab, descriptor]);
        delete tab.splitview;
      }
      return () => {
        for (const [tab, descriptor] of hidden) {
          if (tab.isConnected && !Object.getOwnPropertyDescriptor(tab, 'splitview')) {
            Object.defineProperty(tab, 'splitview', descriptor);
          }
        }
      };
    };
    const wrapTearOut = (gBrowser, method) => {
      const original = gBrowser[method];
      gBrowser[method] = function (...args) {
        const restoreMarkers = hideBentoSplitViewMarkers(this);
        try {
          return original.apply(this, args);
        } finally {
          restoreMarkers();
        }
      };
    };
    if (
      window.gBrowser &&
      typeof window.gBrowser.replaceTabWithWindow === 'function' &&
      typeof window.gBrowser.replaceTabsWithWindow === 'function' &&
      !window.gBrowser.__bentoTearOutOverride
    ) {
      bentoCompatNoteNative('gBrowser.replaceTabWithWindow', window.gBrowser.replaceTabWithWindow);
      bentoCompatNoteNative('gBrowser.replaceTabsWithWindow', window.gBrowser.replaceTabsWithWindow);
      wrapTearOut(window.gBrowser, 'replaceTabWithWindow');
      wrapTearOut(window.gBrowser, 'replaceTabsWithWindow');
      window.gBrowser.__bentoTearOutOverride = true;
    }

    // Closing the selected tab: Firefox's #beginRemoveTab runs #blurTab,
    // which selects the successor and fires TabSelect (and the tabpanels
    // 'select' event), and only afterwards, in the same synchronous run,
    // sets closing = true on the outgoing tab. A reconcile that ran inside
    // those events would still see the closing tab and render it as a ghost
    // strip panel. Every selection signal therefore queues one microtask:
    // it runs after #beginRemoveTab returns (event.detail.previousTab.closing
    // is set by then) and still before the next paint or task, and it reads
    // the final selectedTab, so several signals for one change coalesce.
    let lastReconciledFor = null;
    let reconcileQueued = false;
    const runReconcile = () => {
      reconcileQueued = false;
      const sel = window.gBrowser?.selectedTab;
      if (!sel || sel === lastReconciledFor) return;
      lastReconciledFor = sel;
      if (shouldDeferReconcileForWorkspaceSwitch(sel)) {
        armWorkspaceSwitchFade();
        armDeferredWorkspaceSwitchWatchdog(sel);
        return;
      }
      reconcilePanelsSplitView(__lastPanelsPayload);
    };
    const reconcile = (_source) => {
      if (reconcileQueued) return;
      reconcileQueued = true;
      queueMicrotask(runReconcile);
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
      // in), then a moment later the title-IPC handler picks up the new
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
      // overwrote the title before chrome read it, the next reconcile
      // re-applies. Idempotent — applyChromeColorMode short-circuits
      // when the attribute already matches.
      if (typeof decoded.uiColorMode === 'string') {
        applyChromeColorMode(decoded.uiColorMode.trim(), decoded.uiColorModeStamp);
      }
      if (typeof decoded.themeId === 'string' && decoded.themeId.trim().length > 0) {
        applyChromeThemeToDocument(document, decoded.themeId.trim());
      }
      // Sidebar collapsed state — toggle a class on the chrome host so
      // CSS narrows the sidebar to a rail showing only favicons and the
      // workspace avatar.
      if (typeof decoded.sidebarCollapsed === 'boolean') {
        applyChromeSidebarCollapsed(decoded.sidebarCollapsed, {
          hidden:
            typeof decoded.sidebarHidden === 'boolean'
              ? decoded.sidebarHidden
              : currentSidebarHidden,
        });
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
      // already reads BENTO_PANELS — see SavedPanelsStore in
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
    // OS-level reduced-motion: skip the fade (and the
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
  // __workspaceSwitchTimer is the cancel function of the wait for the fade-out
  // (afterMotion); the other two are timer ids. The fade and the stabilize window
  // take their lengths from the CSS (measureMotion); only the watchdog is a literal.
  let __workspaceSwitchTimer = null;
  let __workspaceFadeWatchdog = null;
  let __workspaceFadeCleanupTimer = null;
  // The frame that starts the stabilize timer. Cancelled with the timer, so a replaced
  // or cancelled switch cannot start a stale timer later or overwrite a newer one's handle.
  let __workspaceFadeCleanupFrame = null;
  const WORKSPACE_FADE_WATCHDOG_MS = 1500;
  // The element whose opacity transition times the workspace fade (the three fade
  // targets share one CSS rule).
  function workspaceFadeTarget() {
    return (
      document.getElementById('bento-strip-container') ||
      document.getElementById('bento-panel-nav') ||
      window.gBrowser?.tabpanels ||
      null
    );
  }
  // How long layout-transition suppression ('bento-workspace-stabilizing') must last
  // once the fade-in starts: through the fade-in itself and through the reveal layout
  // transitions it hides. Those are switched off while the class is set, so they
  // cannot be measured; their duration is read from the token.
  function workspaceStabilizeMs() {
    const target = workspaceFadeTarget();
    const fade = target ? measureMotion(target, { properties: ['opacity'] }) : null;
    const fadeMs = fade ? fade.ms : MOTION_UNAVAILABLE_CEILING_MS;
    const layoutMs = motionTokenMs('--muxui-semantic-motion-reveal-transition-duration');
    return Math.max(fadeMs, layoutMs) + MOTION_SLACK_MS;
  }
  function cancelWorkspaceFadeCleanup() {
    if (__workspaceFadeCleanupFrame !== null) {
      cancelAnimationFrame(__workspaceFadeCleanupFrame);
      __workspaceFadeCleanupFrame = null;
    }
    if (__workspaceFadeCleanupTimer !== null) {
      clearTimeout(__workspaceFadeCleanupTimer);
      __workspaceFadeCleanupTimer = null;
    }
  }
  function clearWorkspaceFadeClasses() {
    const sc = document.getElementById('bento-strip-container');
    const nav = document.getElementById('bento-panel-nav');
    const tp = window.gBrowser?.tabpanels;
    if (sc) sc.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (nav) nav.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    if (tp) tp.classList.remove('bento-workspace-switching', 'bento-workspace-stabilizing');
    cancelWorkspaceFadeCleanup();
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
      __workspaceFadeCleanupFrame !== null ||
      __workspaceFadeCleanupTimer !== null;
    if (!hadFadeClass && !hadTimer) return;

    if (__workspaceSwitchTimer) {
      __workspaceSwitchTimer();
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
  // The curtain armed for a selection in another workspace lifts when tools answers with a
  // workspace switch (performWorkspaceSwitchFade replaces this timer). If tools never
  // follows, which happens when the selection was not the user's workspace switch, or when
  // a slow switch has not delivered its panels yet, lift it and render the selected tab
  // alone instead of leaving the page hidden. The panel payload held here belongs to the
  // workspace being left, so it must not be drawn around a tab of the workspace being
  // entered; the real payload reconciles as usual when it arrives.
  function armDeferredWorkspaceSwitchWatchdog(deferredTab) {
    if (__workspaceFadeWatchdog) clearTimeout(__workspaceFadeWatchdog);
    __workspaceFadeWatchdog = setTimeout(() => {
      __workspaceFadeWatchdog = null;
      console.warn(
        '[bento-shell-mount] workspace-switch watchdog fired — no workspace switch followed the selection, lifting the curtain',
      );
      clearWorkspaceFadeClasses();
      try {
        if (window.gBrowser?.selectedTab === deferredTab) {
          reconcilePanelsSplitView([]);
        }
      } catch (err) {
        console.warn('[bento-shell-mount] deferred workspace-switch reconcile threw:', err);
      }
    }, WORKSPACE_FADE_WATCHDOG_MS);
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
    if (__workspaceSwitchTimer) {
      __workspaceSwitchTimer();
      __workspaceSwitchTimer = null;
    }
    if (__workspaceFadeWatchdog) clearTimeout(__workspaceFadeWatchdog);
    cancelWorkspaceFadeCleanup();
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
    let swapped = false;
    const swapBehindFade = () => {
      swapped = true;
      __workspaceSwitchTimer = null;
      // Suppress every in-reconcile animation. The fade IS our
      // transition; any layout animation here would tail past the
      // fade-in and the user would see panels sliding into place.
      //  - Clear __mainWidthTransitionForNextReconcile (set above on
      //    wsChanged) so reconcile snaps the main-panel width
      //    instead of running a width transition.
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
        __workspaceFadeCleanupFrame = requestAnimationFrame(() => {
          __workspaceFadeCleanupFrame = null;
          const nav = document.getElementById('bento-panel-nav');
          if (stripContainer) stripContainer.classList.remove('bento-workspace-switching');
          if (nav) nav.classList.remove('bento-workspace-switching');
          if (tp) tp.classList.remove('bento-workspace-switching');
          // Keep layout-transition suppression through the fade-in. If
          // we remove it in the same frame as the opacity class, pending
          // width/flex changes can begin animating under the fade-in and
          // look like the strip is sliding to the destination workspace.
          if (__workspaceFadeCleanupTimer !== null) clearTimeout(__workspaceFadeCleanupTimer);
          __workspaceFadeCleanupTimer = setTimeout(() => {
            __workspaceFadeCleanupTimer = null;
            if (stripContainer) {
              stripContainer.classList.remove('bento-workspace-stabilizing');
            }
            const nav = document.getElementById('bento-panel-nav');
            if (nav) nav.classList.remove('bento-workspace-stabilizing');
            if (tp) tp.classList.remove('bento-workspace-stabilizing');
          }, workspaceStabilizeMs());
          if (__workspaceFadeWatchdog) {
            clearTimeout(__workspaceFadeWatchdog);
            __workspaceFadeWatchdog = null;
          }
        });
      }
    };
    // The fade-out is the CSS opacity transition on the fade targets; swap behind
    // it once it has finished.
    const fadeTarget = workspaceFadeTarget();
    if (fadeTarget) {
      const cancelSwap = afterMotion(
        fadeTarget,
        'swap',
        { properties: ['opacity'] },
        swapBehindFade,
      );
      if (!swapped) __workspaceSwitchTimer = cancelSwap;
    } else {
      swapBehindFade();
    }
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

  // ─── Sidebar push ──────────────────────────────────────────────────────
  // Cmd+S in 'collapse' mode, expanding out of the hidden state and hiding the
  // sidebar in 'hide' mode slide the sidebar and the page as one strip. Layout
  // changes once per toggle and only transform animates: the host keeps its width
  // for the whole slide and holds only the narrow end's layout space through a
  // negative right margin, so the page lays out once at its final geometry;
  // transforms on the host and on the page group (everything in #browser right of
  // the host) hide the difference and move as one. The CSS is in
  // bento-shell-mount.css ("Sidebar push"), the mechanism and its pitfalls in
  // docs/technical/workspaces.md.
  //
  //   collapse  commit margin and transforms, slide, then in one style change snap
  //             the host to the rail and drop the transforms;
  //   hide      the same slide to a narrow end of 0, so the host leaves the window;
  //             the end puts the hidden class on (and the collapsed one, as hide mode
  //             sets both) in the one style change that drops the transforms;
  //   expand    widen the host and commit margin and transforms, slide, then drop
  //             both in one frame so the page lays out once to its narrower
  //             geometry;
  //   show      the expand out of the hidden state: the same, from no layout space.
  //
  // Collapse and expand also counter-translate the shell frame (CSS), so the shell
  // document stays put while the host's right edge moves; hide and show move the
  // host alone, as it is out of the window at the far end. The shell narrows its own
  // layout when its viewport does (railViewport.ts).
  //
  // A collapse or expand in a window with no side panels is a fluid push instead: the
  // main container is all that sits right of the host, so it follows the host's edge
  // every frame (its width, and its page, change with it) rather than sliding a final
  // layout. Everything that moves with the edge then runs off one main-thread clock, a
  // custom property animation, not compositor transforms (CSS: "Fluid push"). Whether a
  // push is fluid is decided here, as it starts, and held by a root attribute, so a
  // panel opening mid-slide cannot change the rules under a running animation.
  const SIDEBAR_PUSH_DELTA_PROP = '--bento-sidebar-push-delta';
  // Everything a push sets on the root, for its end.
  const SIDEBAR_PUSH_PROPS = [
    SIDEBAR_PUSH_DELTA_PROP,
    '--bento-sidebar-push-divider-shift',
    '--bento-sidebar-push-nav-from',
    '--bento-sidebar-push-split-from',
    '--bento-sidebar-push-split-shift',
  ];
  // Left of the divider line when it stands for a strip whose edge is at 0 (the hidden
  // state): the 1 px line sits just before the edge.
  const SIDEBAR_PUSH_DIVIDER_EDGE = -1;
  const SIDEBAR_PUSH_PAGE_CLASS = 'bento-sidebar-push-page';
  const SIDEBAR_PUSH_KEY = 'sidebar-push';
  // Root attribute of a fluid push, alongside SIDEBAR_PUSH_ATTR, and the one animation
  // its host runs (the clock for everything that moves with the edge).
  const SIDEBAR_PUSH_FLUID_ATTR = 'bento-sidebar-push-fluid';
  const SIDEBAR_PUSH_FLUID_ANIMATION = 'bento-sidebar-push-progress';
  const SIDEBAR_PUSH_REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
  const SIDEBAR_PUSH_SLIDE_ANIMATION = {
    collapse: 'bento-sidebar-push-host-collapse',
    hide: 'bento-sidebar-push-host-collapse',
    expand: 'bento-sidebar-push-host-expand',
    show: 'bento-sidebar-push-host-expand',
  };
  // The running push, { host, collapsed, hidden, direction, ... }, or null. hidden is
  // whether the push ends in the hidden state.
  let sidebarPush = null;
  // Width of the collapsed rail in px, measured once from its token (a whole number of
  // pixels, like #bento-shell-host's width: --bento-rail-width in the mount stylesheet).
  let sidebarRailWidthPx = 0;

  function sidebarRailWidth() {
    if (sidebarRailWidthPx > 0) return sidebarRailWidthPx;
    const probe = document.createElementNS(HTML_NS, 'div');
    probe.style.cssText =
      'position:absolute;visibility:hidden;pointer-events:none;height:0;' +
      'width:round(var(--bento-tab-strip-width-collapsed), 1px)';
    document.documentElement.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    if (width > 0) sidebarRailWidthPx = width;
    return width;
  }

  // The width the host gets once it is not collapsed: its own width (inline, written
  // by the splitter drag and the persisted attribute) inside the min/max the sheet
  // pins. Computed instead of measured because an expand must not flush layout
  // before the host and page are in their pushed geometry; a flush at the
  // intermediate one would hand the page's browsers a size they never keep.
  function sidebarExpandedWidth(host) {
    const requested =
      Number.parseFloat(host.style.width) ||
      Number(host.getAttribute('width')) ||
      BENTO_EXPANDED_SIDEBAR_DEFAULT_WIDTH;
    const min = tokenPx(
      '--bento-tab-strip-width-min-effective',
      tokenPx('--bento-tab-strip-width-min', 200),
    );
    const max = tokenPx('--bento-tab-strip-width-max', 600);
    return Math.min(max, Math.max(min, requested));
  }

  // The page group: everything that sits right of the host and moves with the
  // page. That is the in-flow children of #browser after the host (the splitters,
  // a native sidebar, the panel strip), plus the splitter affordance, which is
  // absolutely positioned at the splitter. The overlay hosts and the hidden-sidebar
  // hover zone are absolute and stay put; hidden children are not rendered.
  function sidebarPushPageElements(host) {
    const els = [];
    for (let el = host.nextElementSibling; el; el = el.nextElementSibling) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.position === 'absolute') continue;
      els.push(el);
    }
    // The bookmarks toolbar starts at the strip's left edge (its margin follows it).
    for (const id of ['bento-shell-splitter-affordance', 'PersonalToolbar']) {
      const el = document.getElementById(id);
      if (el) els.push(el);
    }
    return els;
  }

  // The toolbar band follows the sidebar edge as well: Back, Forward, Reload and the
  // panel navigator sit at it, the toolbar's sidebar-coloured segment and the divider
  // line end at it. Their final geometry is committed now, through the hooks the
  // sidebar splitter drag drives (prepare, then sync for the new width), and each
  // slides from where it was; the CSS reads these custom properties. Must run before
  // anything else of the push touches layout: the hooks measure the host as it is.
  // A push out of the hidden state commits the geometry of a shown sidebar, and a hide
  // commits the hidden one (no divider, no offsets). The root split var, which the
  // window and #browser backgrounds read behind the host, is held at the wider of the
  // two so the host never fades over the narrower colour.
  // The divider line sits just left of the strip's left edge. When it is absent at one
  // end (the hidden state) it is treated as at the edge of a strip at 0, so it comes in
  // with the strip's edge on a show and leaves with it on a hide; a hide keeps the line
  // shown at that edge for the slide and settleSidebarPush hides it.
  // Returns { props, rootSplit }: the custom properties to set for the slide and the
  // root split var's final value, or null without the hooks.
  function commitToolbarForSidebarPush(width, finalLayoutNow, hidden = false) {
    if (!syncSidebarChromeDividerForSidebarWidth) return null;
    const root = document.documentElement;
    const divider = document.getElementById('bento-sidebar-chrome-divider');
    const length = (el, name) => Number.parseFloat(el?.style.getPropertyValue(name)) || 0;
    const read = () => ({
      divider: divider && !divider.hidden ? Number.parseFloat(divider.style.left) || 0 : null,
      split: length(document.getElementById('nav-bar'), '--bento-toolbar-divider-x'),
      rootSplit: length(root, '--bento-toolbar-divider-x'),
      nav: length(
        document.getElementById('nav-bar-customization-target'),
        '--bento-toolbar-nav-offset',
      ),
    });
    const from = read();
    const wasHidden = currentSidebarHidden;
    currentSidebarHidden = hidden;
    try {
      prepareSidebarChromeDividerForSidebarResize?.();
      prepareToolbarNavigationForSidebarResize?.();
      prepareBookmarksToolbarForSidebarResize?.();
      syncSidebarChromeDividerForSidebarWidth(width);
      syncToolbarNavigationForSidebarWidth?.(width);
      // The bookmarks toolbar is positioned by its margin and slides with the page
      // group, whose layout is the final one on a collapse or hide and the initial one
      // on an expand (the slide ends at the final layout). So those commit its offset
      // now, and an expand keeps the initial offset and applies the final one when
      // the push settles.
      if (finalLayoutNow) syncBookmarksToolbarForSidebarWidth?.(width);
    } finally {
      currentSidebarHidden = wasHidden;
    }
    // The divider sync hid the line for the hidden end; a hide still needs it to slide.
    if (hidden && divider && from.divider !== null) {
      divider.hidden = false;
      divider.style.left = SIDEBAR_PUSH_DIVIDER_EDGE + 'px';
    }
    const to = read();
    root.style.setProperty(
      '--bento-toolbar-divider-x',
      Math.max(from.rootSplit, to.rootSplit) + 'px',
    );
    const dividerShift =
      (from.divider ?? SIDEBAR_PUSH_DIVIDER_EDGE) - (to.divider ?? SIDEBAR_PUSH_DIVIDER_EDGE);
    return {
      props: {
        '--bento-sidebar-push-divider-shift': dividerShift + 'px',
        '--bento-sidebar-push-nav-from': from.nav + 'px',
        '--bento-sidebar-push-split-from': from.split + 'px',
        '--bento-sidebar-push-split-shift': from.split - to.split + 'px',
      },
      rootSplit: to.rootSplit,
    };
  }

  // Starts the slide for a toggle to `collapsed`. `wasHidden` is the expand out of
  // the hidden state, where the host holds no layout space at all; `hiding` is a hide,
  // which slides the host out to the same 0. Returns false when there is nothing to
  // slide (no measurable rail or distance); the caller then switches instantly.
  function startSidebarPush(host, collapsed, wasHidden, hiding = false) {
    const rail = sidebarRailWidth();
    if (!(rail > 0)) return false;
    // Measured before anything below touches layout. delta is the distance the
    // host's right edge and the page's left edge travel: the host's width (expanded,
    // or the rail's when it is one already) minus the layout space the host holds at
    // the narrow end.
    const hostWidth =
      collapsed || hiding ? host.getBoundingClientRect().width : sidebarExpandedWidth(host);
    const narrowFootprint = hiding || (!collapsed && wasHidden) ? 0 : rail;
    const delta = hostWidth - narrowFootprint;
    if (!(delta >= 1)) return false;

    const root = document.documentElement;
    const direction = hiding ? 'hide' : collapsed ? 'collapse' : wasHidden ? 'show' : 'expand';
    const expands = !collapsed && !hiding;
    const finalWidth = hiding ? 0 : collapsed ? rail : hostWidth;
    // Collapse and expand with no side panels: the main container follows the edge
    // (hide and show, and any window with panels, slide the page group by transform).
    const fluid =
      (direction === 'collapse' || direction === 'expand') &&
      root.getAttribute('bento-no-side-panels') === 'true';
    // Frames queued by an earlier settle (an interrupted slide) would read the
    // translated geometry of this one.
    for (const cancel of sidebarGeometryFrameCancels) cancel();
    const toolbar = commitToolbarForSidebarPush(finalWidth, !expands, hiding);
    // A fluid push lays the page out every frame, so nothing is put on it.
    const pageEls = fluid ? [] : sidebarPushPageElements(host);
    sidebarPush = {
      host,
      collapsed,
      hidden: hiding,
      direction,
      pageEls,
      finalWidth,
      rootSplit: toolbar?.rootSplit,
    };
    root.style.setProperty(SIDEBAR_PUSH_DELTA_PROP, delta + 'px');
    for (const [name, value] of Object.entries(toolbar?.props ?? {})) {
      root.style.setProperty(name, value);
    }
    // An expand or show widens the host now; a collapse or hide keeps it as wide as it
    // is until the slide ends.
    if (expands) host.classList.remove('bento-sidebar-collapsed');
    for (const el of pageEls) el.classList.add(SIDEBAR_PUSH_PAGE_CLASS);
    // The rail colour follows the target, not the settled class: a collapse keeps the host
    // wide until the slide ends and an expand widens it now. In the same style change as
    // the push attribute, so the colour fades from where it was. A hide, whose colour
    // cannot be seen (the sidebar leaves), takes the rail at its end.
    if (!hiding) root.toggleAttribute(SIDEBAR_RAIL_ATTR, collapsed);
    if (fluid) root.setAttribute(SIDEBAR_PUSH_FLUID_ATTR, '');
    root.setAttribute(SIDEBAR_PUSH_ATTR, direction);
    // Read after the styles above: a missing or disabled animation measures 0 and
    // settles at once, with the final state and no frames in between.
    const slideAnimation = fluid
      ? SIDEBAR_PUSH_FLUID_ANIMATION
      : SIDEBAR_PUSH_SLIDE_ANIMATION[direction];
    afterMotion(host, SIDEBAR_PUSH_KEY, { animations: [slideAnimation] }, settleSidebarPush);
    return true;
  }

  // Ends the running push in its final state: the margin, transforms and classes
  // go and the host takes its target width in the same style change. A hide puts the
  // hidden class on in that same change, with its transform transition held off: the
  // host is out of the window at both ends of the switch, and the end state is the
  // one a hide has always had. Also the way to interrupt a push: a new toggle settles
  // the running one first, so no transform, margin or class outlives it.
  function settleSidebarPush() {
    const push = sidebarPush;
    if (!push) return;
    sidebarPush = null;
    const { host, collapsed, hidden, direction, pageEls, finalWidth, rootSplit } = push;
    const root = document.documentElement;
    cancelMotion(host, SIDEBAR_PUSH_KEY);
    if (hidden) {
      host.style.setProperty('transition', 'none');
      host.classList.add('bento-sidebar-hidden');
    }
    host.classList.toggle('bento-sidebar-collapsed', collapsed);
    root.toggleAttribute(SIDEBAR_RAIL_ATTR, collapsed);
    for (const el of pageEls) el.classList.remove(SIDEBAR_PUSH_PAGE_CLASS);
    root.removeAttribute(SIDEBAR_PUSH_ATTR);
    root.removeAttribute(SIDEBAR_PUSH_FLUID_ATTR);
    for (const name of SIDEBAR_PUSH_PROPS) root.style.removeProperty(name);
    // The split the backgrounds behind the host read was held wide for the slide.
    if (rootSplit !== undefined) {
      root.style.setProperty('--bento-toolbar-divider-x', rootSplit + 'px');
    }
    // An expand's (or show's) bookmarks offset, held at the initial one for the slide,
    // in the same frame as the page's final layout.
    if (direction === 'expand' || direction === 'show') {
      syncBookmarksToolbarForSidebarWidth?.(finalWidth);
    }
    if (hidden) {
      // The line that left with the strip's edge is not shown in the hidden state.
      const divider = document.getElementById('bento-sidebar-chrome-divider');
      if (divider) divider.hidden = true;
      void host.offsetWidth;
      host.style.removeProperty('transition');
    }
    syncGeometryAfterSidebarPush();
  }

  // Whether the sidebar is collapsed or sliding toward collapsed: what a toggle flips.
  function isSidebarCollapsedTarget(host) {
    if (sidebarPush) return sidebarPush.collapsed;
    return !!host?.classList.contains('bento-sidebar-collapsed');
  }

  // Whether the sidebar is hidden or sliding toward hidden. The hidden class only
  // lands when a hide slide ends.
  function isSidebarHiddenTarget(host) {
    if (sidebarPush) return sidebarPush.hidden;
    return !!host?.classList.contains('bento-sidebar-hidden');
  }

  // The one refresh of everything that was held off while the push carried
  // transforms: the sidebar divider, toolbar split, toolbar navigation and
  // bookmarks toolbar alignment listen for the settled event, and the flat panel
  // layout, splitters, overlays and strip scrollbar are redone against the final
  // untransformed geometry so the panels end exactly aligned.
  function syncGeometryAfterSidebarPush() {
    finishSidebarChromeDividerSidebarResize?.();
    finishToolbarNavigationSidebarResize?.();
    finishBookmarksToolbarSidebarResize?.();
    window.dispatchEvent(new CustomEvent(BENTO_RESIZE_SETTLED_EVENT));
    try {
      if (!refreshFlatPanelLayoutFromLiveState()) {
        syncInterPanelSplitters();
        updateFlatLayoutOverlayPositions(window.gBrowser?.tabpanels, currentPanelLayoutGeometry);
        updateStripScrollbar();
      }
    } catch (err) {
      console.warn('[bento-shell-mount] sidebar push layout sync failed:', err);
    }
  }

  // `hidden` is where sidebarHidden is heading in the same payload. A toggle into
  // the hidden state is a change of its own, because hide mode keeps the setting
  // collapsed: a sidebar that is a rail already hides with no collapsed change. It
  // slides like a collapse (hidden class at the end, see settleSidebarPush), and
  // applyChromeSidebarHidden, which runs next, leaves the host's class to it. A
  // toggle that stays hidden, the first apply at boot and reduced motion switch
  // instantly.
  function applyChromeSidebarCollapsed(collapsed, { hidden = currentSidebarHidden } = {}) {
    const host = document.getElementById('bento-shell-host');
    if (!host) return;
    const first = !host.__bentoSidebarApplied;
    host.__bentoSidebarApplied = true;
    const hiding = hidden && !isSidebarHiddenTarget(host);
    // BENTO_PANELS carries the setting on every payload; only a change toggles.
    if (collapsed !== isSidebarCollapsedTarget(host) || hiding) {
      settleSidebarPush();
      // After the settle: an interrupted hide has put the class on by now.
      const wasHidden = host.classList.contains('bento-sidebar-hidden');
      const slide =
        !first && (hiding || !hidden) && !window.matchMedia(SIDEBAR_PUSH_REDUCED_MOTION).matches;
      if (!slide || !startSidebarPush(host, collapsed, wasHidden, hiding)) {
        host.classList.toggle('bento-sidebar-collapsed', collapsed);
        document.documentElement.toggleAttribute(SIDEBAR_RAIL_ATTR, collapsed);
      }
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
    // A push settles first unless it is the one this call belongs to: the hide slide
    // (the host's class lands when it ends) or an expand out of the hidden state
    // (both start in applyChromeSidebarCollapsed). A push running the other way, or a
    // hide slide when the sidebar is being shown, ends in place so the change below
    // starts from a plain rail or expanded host.
    if (sidebarPush && sidebarPush.hidden !== currentSidebarHidden) settleSidebarPush();
    document.documentElement.toggleAttribute('bento-sidebar-hidden', currentSidebarHidden);
    if (!currentSidebarHidden) {
      host.classList.remove('bento-sidebar-hidden-revealed');
      document.documentElement.removeAttribute('bento-sidebar-hidden-revealed');
    }
    if (sidebarPush?.hidden) {
      // The hide slide puts the host's class on when it settles. The splitter and its
      // affordance below take their hidden state now: the page lays out at its final
      // geometry for the slide.
      host.__bentoSidebarHiddenApplied = true;
    } else if (!host.__bentoSidebarHiddenApplied) {
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

  function applyChromePanelShadowsEnabled(enabled) {
    window.gBrowser?.tabpanels?.classList.toggle('bento-panel-shadows-disabled', !enabled);
    document
      .getElementById('bento-strip-container')
      ?.classList.toggle('bento-panel-shadows-disabled', !enabled);
  }

  // Receive side of the title IPC (BENTO_* prefixes above). Shell and overlay
  // documents write a sentinel into document.title. For every top-level title
  // change, Firefox's WindowGlobalParent::RecvUpdateDocumentTitle stores the
  // title in the parent and dispatches a chrome-only, bubbling
  // 'pagetitlechanged' event on the embedding <browser> element (tabbrowser
  // uses the same event for tab labels). The event runs synchronously inside
  // that IPC handler, after the parent-side title is updated, so
  // frame.contentTitle is the title that triggered it. DOMTitleChanged is a
  // different event: it fires inside the content process and does not reach
  // chrome for remote frames, which is why it looked unreliable.
  //
  // One capture-phase window listener routes by frame id. Frames created
  // later (the panel trailer), reloaded frames, and frames that change process
  // keep the same <browser> element and id, so nothing needs re-attaching.
  // Each handler below is the body of the interval/rAF poller it replaced, and
  // lastSeen keeps the old per-frame dedupe of repeated titles.
  function attachPaletteCloseListener() {
    // Palette: CLOSE hides it; the SETTINGS prefixes open the Settings palette (the privacy one on
    // the protection level list, a command palette result at its setting), which dismisses it;
    // OPEN_MERGE_PALETTE opens the merge palette, which dismisses it too.
    const handlePaletteFrameTitle = (title) => {
      if (title.startsWith(PALETTE_CLOSE_PREFIX)) hidePalette();
      else if (title.startsWith(MERGE_PALETTE_OPEN_PREFIX)) showMergePalette();
      else if (title.startsWith(SETTINGS_PRIVACY_OPEN_PREFIX)) {
        showSettingsPalette('privacy:level', 'palette');
      } else if (title.startsWith(SETTINGS_OPEN_PREFIX)) showSettingsPalette(undefined, 'palette');
      else if (title.startsWith(SETTINGS_TARGET_OPEN_PREFIX)) handleSettingsTargetTitle(title);
    };

    // Menu overlay: SELECT routes the chosen itemId back to the chrome
    // onSelect handler registered when showChromeMenu was called; CLOSE
    // just hides the overlay (Esc / outside-click in the React menu).
    const handleMenuFrameTitle = (title) => {
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
    };

    // The persistent sidebar shell frame: opens overlays and carries the
    // BENTO_PANELS state payload, so its dispatch order is load-bearing.
    const handleShellFrameTitle = (title) => {
      if (title.startsWith(PALETTE_OPEN_PREFIX)) showPalette();
      else if (title.startsWith(WORKSPACE_PALETTE_OPEN_PREFIX)) showWorkspacePalette();
      else if (title.startsWith(MERGE_PALETTE_OPEN_PREFIX)) showMergePalette();
      else if (title.startsWith(APP_MENU_OPEN_PREFIX)) handleAppMenuOpenTitle(title);
      else if (title.startsWith(DOWNLOADS_OPEN_PREFIX)) handleDownloadsOpenTitle(title);
      else if (title.startsWith(DOWNLOADS_ANCHOR_PREFIX)) handleDownloadsAnchorTitle(title);
      else if (title.startsWith(RAIL_TOOLTIP_PREFIX)) handleRailTooltipTitle(title);
      else if (title.startsWith(ADDRBAR_OPEN_PREFIX)) handleAddrbarOpenTitle(title);
      else if (title.startsWith(SIDEBAR_ADDRESS_SUBMIT_PREFIX)) {
        handleSidebarAddressSubmitTitle(title);
      } else if (title.startsWith(SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX)) {
        handleSidebarAddressBookmarkToggleTitle(title);
      } else if (title.startsWith(SIDEBAR_ADDRESS_IDENTITY_PREFIX)) {
        handleSidebarAddressIdentityTitle(title);
      } else if (title.startsWith(SIDEBAR_ADDRESS_COPY_PREFIX)) {
        handleSidebarAddressCopyTitle(title);
      } else if (title.startsWith(SIDEBAR_ADDRESS_READY_PREFIX)) {
        handleSidebarAddressReadyTitle();
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
    };

    const titleHandlerByFrameId = new Map([
      ['bento-shell-frame', handleShellFrameTitle],
      ['bento-palette-frame', handlePaletteFrameTitle],
      [
        'bento-merge-palette-frame',
        (title) => {
          if (title.startsWith(MERGE_PALETTE_CLOSE_PREFIX)) hideMergePalette();
        },
      ],
      [
        'bento-settings-palette-frame',
        (title) => {
          if (title.startsWith(SETTINGS_PALETTE_CLOSE_PREFIX)) hideSettingsPalette();
          else if (title.startsWith(SETTINGS_BACK_TO_PALETTE_PREFIX)) showPalette();
          else if (title.startsWith(MERGE_PALETTE_OPEN_PREFIX)) showMergePalette();
          else if (title.startsWith(FIREFOX_SEARCH_SETTINGS_OPEN_PREFIX)) {
            hideSettingsPalette();
            openFirefoxSearchSettings();
          }
        },
      ],
      [
        'bento-workspace-palette-frame',
        (title) => {
          if (title.startsWith(WORKSPACE_PALETTE_CLOSE_PREFIX)) {
            hideWorkspacePalette();
          } else if (title.startsWith(CONFIRM_OPEN_PREFIX)) {
            showConfirm();
          }
        },
      ],
      [
        'bento-addrbar-frame',
        (title) => {
          if (title.startsWith(ADDRBAR_CLOSE_PREFIX)) hideAddrbar();
          else if (title.startsWith(ADDRBAR_READY_PREFIX)) handleAddrbarReadyTitle(title);
          else if (title.startsWith(ADDRBAR_NAVIGATE_PREFIX)) handleAddrbarNavigateTitle(title);
        },
      ],
      [
        'bento-confirm-frame',
        (title) => {
          if (title.startsWith(CONFIRM_CLOSE_PREFIX)) hideConfirm();
        },
      ],
      [
        'bento-edit-workspace-frame',
        (title) => {
          if (title.startsWith(EDIT_WORKSPACE_CLOSE_PREFIX)) hideEditWorkspace();
        },
      ],
      [
        'bento-welcome-frame',
        (title) => {
          if (title.startsWith(WELCOME_OPEN_PREFIX)) showWelcome();
          else if (title.startsWith(WELCOME_CLOSE_PREFIX)) hideWelcome();
          else if (title.startsWith(SETTINGS_OPEN_PREFIX)) {
            // The Ready step's Open Settings; the page already marked onboarding finished. Only a
            // showing dialog opens Settings, so a second one during the fade (a double click) is
            // ignored.
            const host = document.getElementById('bento-welcome-host');
            if (host && isWelcomeShowing(host)) {
              hideWelcome();
              showSettingsPalette();
            }
          } else if (title.startsWith(WELCOME_IMPORT_BROWSER_DATA_PREFIX)) {
            __bentoPendingWelcomeResumeStep = parseWelcomeImportResumeStep(title);
            showEmbeddedBrowserImportFromWelcome(parseWelcomeImportHandoff(title));
          } else if (title.startsWith(WELCOME_HANDOFF_PREFIX)) handleWelcomeHandoffTitle(title);
          else if (title.startsWith(WELCOME_IMPORT_SOURCES_REQUEST_PREFIX)) {
            void sendImportSourcesToWelcome();
          } else if (title.startsWith(WELCOME_IMPORT_FIREFOX_ZEN_PREFIX)) {
            __bentoPendingWelcomeResumeStep = parseWelcomeImportResumeStep(
              title,
              WELCOME_IMPORT_FIREFOX_ZEN_PREFIX,
            );
            restartToBrowserImportFromWelcome(true);
          }
        },
      ],
      [
        'bento-embedded-import-frame',
        (title) => {
          if (title.startsWith(EMBEDDED_IMPORT_CLOSE_PREFIX)) closeEmbeddedBrowserImport();
          else if (title.startsWith(EMBEDDED_IMPORT_READY_PREFIX)) {
            handleEmbeddedImportReadyTitle(title);
          } else if (title.startsWith(EMBEDDED_IMPORT_RESTART_PREFIX)) {
            restartToBrowserImportFromWelcome(true);
          }
        },
      ],
      ['bento-menu-frame', handleMenuFrameTitle],
      [
        'bento-workspace-switcher-frame',
        (title) => {
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
        },
      ],
      [
        'bento-panel-trailer-frame',
        (title) => {
          if (title.startsWith(PANEL_TRAILER_CONTEXT_MENU_PREFIX)) {
            handlePanelTrailerContextMenuTitle(title);
          } else if (title.startsWith(PANEL_TRAILER_ADD_BLANK_PREFIX)) {
            addNewPanel();
          }
        },
      ],
      // The tooltip document only announces readiness (handled below).
      ['bento-panel-navigator-tooltip-frame', () => {}],
    ]);
    const lastSeenTitleByFrameId = new Map();

    // A title is only a Bento message if the frame is showing the Bento page
    // it hosts: a moz-extension:// document of the bento-shell add-on, or the
    // chrome:// migration host for the non-remote embedded import frame.
    // Every table frame only ever loads its own page, so this never drops a
    // legitimate title. The add-on host is resolved once, on first success.
    let bentoExtensionHost = null;
    const warnedUnexpectedFrameIds = new Set();
    const isExpectedBentoDocument = (frame) => {
      const uri = frame.currentURI;
      if (!uri) return false;
      if (frame.id === 'bento-embedded-import-frame') {
        return (
          uri.spec === BENTO_EMBEDDED_IMPORT_URL ||
          uri.spec.startsWith(BENTO_EMBEDDED_IMPORT_URL + '?')
        );
      }
      if (!uri.schemeIs('moz-extension')) return false;
      bentoExtensionHost ??= WebExtensionPolicy.getByID(ADDON_ID)?.mozExtensionHostname ?? null;
      return bentoExtensionHost !== null && uri.host === bentoExtensionHost;
    };

    window.addEventListener(
      'pagetitlechanged',
      (event) => {
        // Every tab and panel browser bubbles this event too; only the
        // registered Bento frame ids are read.
        const frame = event.target;
        const handleTitle = titleHandlerByFrameId.get(frame.id);
        if (!handleTitle) return;
        if (!isExpectedBentoDocument(frame)) {
          if (!warnedUnexpectedFrameIds.has(frame.id)) {
            warnedUnexpectedFrameIds.add(frame.id);
            console.warn(
              '[bento-shell-mount] ignoring title from unexpected document in',
              frame.id,
              frame.currentURI?.spec,
            );
          }
          return;
        }
        const title = frame.contentTitle || '';
        if (title === (lastSeenTitleByFrameId.get(frame.id) ?? '')) return;
        lastSeenTitleByFrameId.set(frame.id, title);
        if (title.startsWith(OVERLAY_READY_PREFIX)) {
          overlays.markFrameReady(frame.id);
          return;
        }
        handleTitle(title);
      },
      true,
    );
  }

  // Chrome-side Esc handler — fires regardless of whether focus is in
  // palette content or anywhere else in the chrome window. Capture phase
  // so it wins over any default handler.
  function attachPaletteEscListener() {
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        // Stack precedence (top = highest): menu > confirm > edit-workspace >
        // workspace palette / settings palette > welcome > workspace-switcher > address bar >
        // merge palette > palette. An overlay whose open still waits for its
        // document counts as open: Esc cancels that open instead of letting it
        // appear afterwards. Welcome is mandatory onboarding: consume Esc there
        // without hiding it. Other overlays keep their normal Esc dismissal.
        const consume = (hide) => {
          e.preventDefault();
          e.stopPropagation();
          hide();
        };
        // The menu page handles its own Esc once shown; only a pending open needs this.
        if (overlays.hasPendingOpen('menu')) return consume(hideChromeMenu);
        if (isOverlayOpen('bento-confirm-host', isConfirmVisible, 'confirm')) {
          return consume(hideConfirm);
        }
        if (isOverlayOpen('bento-edit-workspace-host', isEditWorkspaceVisible, 'edit-workspace')) {
          return consume(hideEditWorkspace);
        }
        if (
          isOverlayOpen(
            'bento-workspace-palette-host',
            isWorkspacePaletteVisible,
            'workspace-palette',
          )
        ) {
          return consume(hideWorkspacePalette);
        }
        // The Settings document handles its own Esc (clear the search, a stage back, then close)
        // while its frame has focus. Chrome sees that key first, because the parent process gets
        // the key events of a remote <browser> before the document does, so consuming it here
        // would close Settings from every stage. Chrome takes Esc only for an open still waiting
        // for its document, and when focus is somewhere else in the window.
        if (
          isOverlayOpen('bento-settings-palette-host', isSettingsPaletteVisible, 'settings-palette')
        ) {
          const inSettingsFrame = e.target?.id === 'bento-settings-palette-frame';
          if (inSettingsFrame && !overlays.hasPendingOpen('settings-palette')) return;
          return consume(hideSettingsPalette);
        }
        const embeddedImportHost = document.getElementById('bento-embedded-import-host');
        if (embeddedImportHost && isEmbeddedImportVisible(embeddedImportHost)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (isOverlayOpen('bento-welcome-host', isWelcomeVisible, 'welcome')) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
        if (
          isOverlayOpen(
            'bento-workspace-switcher-host',
            isWorkspaceSwitcherVisible,
            'workspace-switcher',
          )
        ) {
          return consume(hideWorkspaceSwitcher);
        }
        if (isOverlayOpen('bento-addrbar-host', isAddrbarVisible, 'addrbar')) {
          return consume(hideAddrbar);
        }
        if (isOverlayOpen('bento-merge-palette-host', isMergePaletteVisible, 'merge-palette')) {
          return consume(hideMergePalette);
        }
        if (isOverlayOpen('bento-palette-host', isPaletteVisible, 'palette')) {
          consume(hidePalette);
        }
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
        requestAddrbarOpen(e.code === 'KeyT' ? 'newTab' : 'current');
      },
      true,
    );
  }

  function attachOutsideClickDismissListener() {
    window.addEventListener(
      'pointerdown',
      (e) => {
        // A menu still waiting for its document has no host to catch the click: the
        // click is outside it, so it cancels the open. A shown menu closes itself.
        if (overlays.hasPendingOpen('menu')) hideChromeMenu();
        const host = document.getElementById('bento-addrbar-host');
        if (!host || !isOverlayOpen('bento-addrbar-host', isAddrbarVisible, 'addrbar')) return;
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
        'moz-src:///browser/components/sessionstore/SessionStore.sys.mjs',
      );
      __sessionStoreModule = mod.SessionStore;
    } catch (err) {
      console.warn('[bento-shell-mount] SessionStore import failed:', err);
    }
    return __sessionStoreModule;
  }
  function getSessionSaver() {
    try {
      return ChromeUtils.importESModule(
        'moz-src:///browser/components/sessionstore/SessionSaver.sys.mjs',
      ).SessionSaver;
    } catch (err) {
      console.warn('[bento-shell-mount] SessionSaver import failed:', err);
      return null;
    }
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
      const bookmarkEvents = [
        'bookmark-added',
        'bookmark-removed',
        'bookmark-moved',
        'bookmark-url-changed',
      ];
      PlacesUtils.observers.addListener(bookmarkEvents, scheduleSidebarAddressSnapshot);
      // PlacesObservers holds strong process-wide references to JS listeners;
      // remove ours on unload so a closed window is not kept alive until quit.
      window.addEventListener(
        'unload',
        () => PlacesUtils.observers.removeListener(bookmarkEvents, scheduleSidebarAddressSnapshot),
        { once: true },
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
  // closest element with data-bento-main-panel or data-bento-panel-tab-id
  // (stamped on each panel container by the reconciler).
  function getFocusedPanelInfo() {
    const active = document.activeElement;
    if (!active || typeof active.closest !== 'function') return null;
    const panelEl = active.closest('[data-bento-main-panel], [data-bento-panel-tab-id]');
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
    const addonListener = {
      onEnabled(addon) {
        if (addon.id !== ADDON_ID) return;
        reloadFrames();
      },
    };
    AddonManager.addAddonListener(addonListener);
    // AddonManager holds listeners in a process-wide Set, so without this a
    // closed window (captured by reloadFrames) stays alive until quit.
    window.addEventListener('unload', () => AddonManager.removeAddonListener(addonListener), {
      once: true,
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
          'bento-settings-palette-frame',
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
          // An overlay that was never opened has no document to reload; it
          // loads the new add-on when it is first opened.
          const overlayId = overlays.idForFrame(id);
          if (overlayId !== null) {
            if (!overlays.hasStarted(overlayId)) continue;
            overlays.reset(overlayId);
          }
          try {
            frame.reloadWithFlags(Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE);
          } catch (e) {
            console.warn('[bento-shell-mount] reloadWithFlags failed for', id, e);
            frame.removeAttribute('src');
            if (id === 'bento-shell-frame') setBentoShellSrc();
            else if (id === 'bento-palette-frame') setBentoPaletteSrc();
            else if (id === 'bento-workspace-palette-frame') setBentoWorkspacePaletteSrc();
            else if (id === 'bento-merge-palette-frame') setBentoMergePaletteSrc();
            else if (id === 'bento-settings-palette-frame') setBentoSettingsPaletteSrc();
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

  // The sidebar shell and the eager overlays (confirm, edit workspace, workspace
  // switcher) load at startup. The other overlay documents are created at idle
  // once the launch veil lifts or on first use (createOverlayManager).
  setBentoShellSrc();
  overlays.startEager();
  // The welcome resume step comes from the environment of the process that
  // restarted for the browser-data import. Read (and clear) it now, as before,
  // not when the welcome overlay is first created.
  takeBentoWelcomeResumeStep();
  // unifyMainWithStrip() and setupPanelNavigator() re-parent
  // #tabbrowser-tabbox after Tabbrowser.init() created the first tab, so they
  // must use moveNodeBefore (Element.moveBefore) and keep the tab <browser>'s
  // frameloader. A fallback insertBefore recreates the frameloader (a new
  // BrowsingContext with an empty nsIWebProgress) while Tabbrowser's private
  // per-tab progress filter stays on the discarded one: the first tab gets no
  // progress events and removeProgressListener throws NS_ERROR_FAILURE.
  // Firefox 154 exposed the filter through _getTabProgressFilter, which let
  // Bento re-add it; 157 keeps it in a private field, so there is no
  // re-attach safety net. See "Chrome rendering pitfalls" in
  // docs/technical/chrome-panel-rendering.md.

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
    attachHiddenSidebarHoverReveal();
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
    window.addEventListener('resize', (event) => {
      // Firefox 157 delivers resize events from in-process about: pages (Settings)
      // to this listener. Freezing such a page resizes it, which fires another
      // resize and keeps the freeze/thaw cycle running. Only the chrome window's
      // own resizes start the live-resize mode.
      if (event.target !== window) return;
      if (root.getAttribute('bento-window-resizing') !== 'true') {
        beginBentoSettingsAboutLiveResize();
        root.setAttribute('bento-window-resizing', 'true');
      }
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        root.removeAttribute('bento-window-resizing');
        endBentoSettingsAboutLiveResize();
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
  // bento-shell-mount.js boot would throw because the actor is already
  // registered (NotSupportedError in Firefox 154's JSActorService). Guard
  // idempotently.
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
      // Already registered (second window): NotSupportedError, or
      // NS_ERROR_NOT_AVAILABLE on older engines.
      if (err?.name !== 'NotSupportedError' && !String(err).includes('NS_ERROR_NOT_AVAILABLE')) {
        console.warn('[bento-shell-mount] registerContentKeyActor failed:', err);
      }
    }
  }

  // Shell bus relay — register the BentoShellBus JSWindowActor pair, once per
  // process like BentoKey. Firefox partitions BroadcastChannel by
  // privateBrowsingId, so shell documents in a private window cannot reach the
  // shell background that way; the actor carries their bus traffic through the
  // parent-process hub instead (BentoShellBusParent.sys.mjs). It attaches to
  // every moz-extension document; the parent actor accepts only bento-shell
  // documents hosted by a browser window. wantUntrusted is required because the
  // 'bento-bus-up' event is dispatched by the page.
  function registerShellBusActor() {
    try {
      ChromeUtils.registerWindowActor('BentoShellBus', {
        parent: { esModuleURI: 'resource:///actors/BentoShellBusParent.sys.mjs' },
        child: {
          esModuleURI: 'resource:///actors/BentoShellBusChild.sys.mjs',
          events: { 'bento-bus-up': { capture: true, wantUntrusted: true } },
        },
        allFrames: true,
        matches: ['moz-extension://*/*'],
      });
    } catch (err) {
      if (err?.name !== 'NotSupportedError' && !String(err).includes('NS_ERROR_NOT_AVAILABLE')) {
        console.warn('[bento-shell-mount] registerShellBusActor failed:', err);
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
      requestAddrbarOpen(e?.detail?.mode === 'newTab' ? 'newTab' : 'current');
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
          '.bento-subdivision-chooser, [data-bento-panel-tab-id], [data-bento-main-panel]',
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

  // With browser.sessionstore.restore_pinned_tabs_on_demand (prefs/bento.js) Firefox restores
  // pinned tabs without loading them, but as pending tabs with a real browser: only other
  // restored tabs get a lazy one (createTabsForSessionRestore excludes pinned tabs). The
  // WebExtension 'discarded' flag is !linkedPanel, so the sidebar would draw them as loaded, and
  // 'pending' is a chrome attribute that no extension API reports (SessionStore sets the saved
  // address before any load, so Tab.url is no sign). Pending pinned tabs go back to lazy ones
  // here. Panel tabs are skipped when this window already renders them.
  function shouldUnloadRestoredPinnedTab(tab, isRenderedPanel) {
    return (
      tab.pinned &&
      tab.hasAttribute('pending') &&
      !tab.selected &&
      !tab.hasAttribute('soundplaying') &&
      !tab.hasAttribute('sharing') &&
      !isRenderedPanel(tab)
    );
  }

  // Pinned tabs stay pending only while both prefs are true (TabRestoreQueue drains them in
  // turn otherwise, and the ones still queued are pending too), so only then is "pending" a
  // restore-on-demand tab and not one about to load.
  function pinnedRestoreOnDemand() {
    return (
      Services.prefs.getBoolPref('browser.sessionstore.restore_on_demand', true) &&
      Services.prefs.getBoolPref('browser.sessionstore.restore_pinned_tabs_on_demand', false)
    );
  }

  // A pinned panel the window renders must load whichever prefs are set. materializePanelTab
  // reloads a pending tab only when it had to insert the browser or its address is blank. A
  // pinned tab has a real browser and, once SessionStore has set its saved address, a real
  // address, so a panel rendered after that and before the handler below runs would stay blank.
  // A tab without a linkedPanel is a lazy one: materializePanelTab inserts and reloads it.
  function shouldLoadRestoredPinnedPanel(tab, isRenderedPanel) {
    return tab.pinned && tab.hasAttribute('pending') && !!tab.linkedPanel && isRenderedPanel(tab);
  }

  // SessionStore dispatches SSTabRestoring on a tab as the last step of its history restore,
  // which resolves after SSWindowRestored. A browser discarded before that is re-inserted when
  // the restore resolves (#listenForNavigations touches the now lazy browser), so each pinned
  // tab is handled after its own event plus one task. The task lets loads that start inside
  // the dispatch (a lazy browser's reload waits for this same event) clear 'pending' first. The
  // event also fires in a window restored without SSWindowRestored (the macOS last-window
  // reopen). discardBrowser without force refuses a selected, closing or dialog tab itself.
  //
  // A pending tab the window renders as a panel is loaded with reload(): #listenForNavigations
  // is registered in the same step that dispatches the event (earlier a reload is not
  // intercepted), and its OnHistoryReload starts the content restore and clears 'pending'.
  // Every other pending pinned tab is unloaded while restore-on-demand is on.
  function attachRestoredPinnedTabUnload() {
    window.addEventListener('SSTabRestoring', (event) => {
      const tab = event.target;
      if (!tab.pinned) return;
      window.setTimeout(() => {
        try {
          const isRenderedPanel = (t) => currentPanelTabIds.has(getBentoTabId(t));
          if (shouldLoadRestoredPinnedPanel(tab, isRenderedPanel)) {
            tab.linkedBrowser.reload();
          } else if (
            pinnedRestoreOnDemand() &&
            shouldUnloadRestoredPinnedTab(tab, isRenderedPanel)
          ) {
            window.gBrowser.discardBrowser(tab);
          }
        } catch (err) {
          console.warn('[bento-shell-mount] restored pinned tab unload failed:', err);
        }
      }, 0);
    });
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
      bentoCompatNoteNative('PopupNotifications._isActiveBrowser', original);
      // Without the native method the wrapper would throw on every popup.
      if (typeof original !== 'function') return;
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
  attachOutsideClickDismissListener();
  attachTopUrlbarModalListener();
  attachSidebarAddressSnapshotListeners();
  attachPaletteKeybinding();
  attachPaletteEscListener();
  attachPaletteCloseListener();
  attachWorkspaceTabSwitchKeybinding();
  attachTabSelectListener();
  attachWindowCloseHandover();
  attachPanelAcceleratorListener();
  attachWindowResizePerfMode();
  registerContentKeyActor();
  registerShellBusActor();
  attachContentKeyBridgeListener();
  attachPanelFocusTracker();
  attachRestoredPinnedTabUnload();
  patchPopupNotificationsForSplitView();
  ensureExtensionsUIObservers();
  scheduleBentoFirefoxCompatChecks();
})();
