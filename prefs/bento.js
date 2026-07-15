// Bento Browser — default pref overrides.
//
// Appended to engine/browser/branding/bento/pref/firefox-branding.js by
// scripts/regen-branding.sh after `surfer import` runs. Firefox loads
// firefox-branding.js automatically as default branding prefs, so anything
// here ships as a Bento default (still overridable per-user via about:config).
//
// Privacy-leaning defaults: disable Mozilla services Bento doesn't ship,
// telemetry/crash/study/health reporting off, and no sponsored content.

// --- Mozilla services Bento doesn't ship ---------------------------------
pref("extensions.pocket.enabled", false);
pref("identity.fxaccounts.enabled", true);  // keep Sync available; just don't push it
pref("browser.contentblocking.report.lockwise.enabled", false);
pref("browser.contentblocking.report.monitor.enabled", false);
pref("browser.contentblocking.report.vpn.enabled", false);
pref("browser.contentblocking.report.proxy.enabled", false);
pref("browser.contentblocking.report.show_mobile_app", false);
pref("browser.vpn_promo.enabled", false);
pref("browser.promo.focus.enabled", false);

// --- Sponsored / ads in chrome -------------------------------------------
pref("browser.newtabpage.activity-stream.showSponsored", false);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false);
pref("browser.newtabpage.activity-stream.feeds.topsites", true);
pref("browser.newtabpage.activity-stream.feeds.section.highlights", false);
pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);
pref("browser.urlbar.quicksuggest.enabled", false);

// --- Telemetry / data reporting off --------------------------------------
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.unified", false);
pref("toolkit.telemetry.archive.enabled", false);
pref("toolkit.telemetry.bhrPing.enabled", false);
pref("toolkit.telemetry.firstShutdownPing.enabled", false);
pref("toolkit.telemetry.newProfilePing.enabled", false);
pref("toolkit.telemetry.shutdownPingSender.enabled", false);
pref("toolkit.telemetry.updatePing.enabled", false);
pref("toolkit.telemetry.coverage.opt-out", true);
pref("toolkit.coverage.opt-out", true);
pref("toolkit.coverage.endpoint.base", "");
pref("datareporting.healthreport.uploadEnabled", false);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("datareporting.sessions.current.clean", true);

// --- Crash reporting -----------------------------------------------------
// (Crash reporter is also disabled at build time via mozconfig
// --disable-crashreporter; these prefs cover the runtime path too.)
pref("breakpad.reportURL", "");
pref("browser.tabs.crashReporting.sendReport", false);
pref("browser.crashReports.unsubmittedCheck.enabled", false);
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false);

// --- Studies / experiments / Normandy ------------------------------------
pref("app.shield.optoutstudies.enabled", false);
pref("app.normandy.enabled", false);
pref("app.normandy.api_url", "");
pref("messaging-system.rsexperimentloader.enabled", false);
pref("network.allow-experiments", false);

// --- Tracking protection -------------------------------------------------
// Bento ships Firefox Enhanced Tracking Protection at "strict" by default
// (vs "standard" in vanilla Firefox). Strict blocks more cross-site
// trackers and fingerprinters; the user can soften it from the Privacy
// Dashboard or Firefox's about:preferences#privacy. Bento Tools mirrors
// this via browser.privacy.websites.trackingProtectionMode = "always".
pref("browser.contentblocking.category", "strict");
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.globalprivacycontrol.pbmode.enabled", true);
pref("privacy.query_stripping.enabled", true);
pref("privacy.query_stripping.enabled.pbmode", true);
pref("network.cookie.cookieBehavior", 5);
pref("network.cookie.cookieBehavior.pbmode", 5);

// --- Network privacy defaults -------------------------------------------
pref("network.prefetch-next", false);
pref("network.dns.disablePrefetch", true);
pref("network.http.speculative-parallel-limit", 0);
pref("browser.places.speculativeConnect.enabled", false);
pref("network.trr.mode", 5);
pref("browser.search.suggest.enabled", false);
pref("browser.urlbar.suggest.searches", false);

// Keep HTTPS-only as an Enhanced/Hardened feature rather than a Standard
// default so HTTP-only intranet and device-admin pages keep working.
pref("dom.security.https_only_mode", false);
pref("dom.security.https_only_mode_pbm", false);

// Local Safe Browsing checks stay on in Standard, but remote download
// lookups are disabled. Hardened can turn the local checks off too.
pref("browser.safebrowsing.malware.enabled", true);
pref("browser.safebrowsing.phishing.enabled", true);
pref("browser.safebrowsing.downloads.enabled", true);
pref("browser.safebrowsing.downloads.remote.enabled", false);

// Hide remote/AI browser surfaces unless Bento explicitly ships and
// documents one.
pref("browser.ml.enable", false);
pref("browser.ml.chat.enabled", false);

// --- First-run / onboarding noise ----------------------------------------
pref("browser.aboutwelcome.enabled", false);
pref("browser.startup.upgradeDialog.enabled", false);
pref("browser.preferences.moreFromMozilla", false);
pref("browser.migrate.zen.enabled", true);

// --- Session restore ------------------------------------------------------
// Restore the previous session on launch. Bento is workspaces-first and
// the per-tab workspace assignment (via browser.sessions.setTabValue +
// bento.workspaceId) only matters if Firefox's SessionStore actually
// brings tabs back across restarts. Default 1 = home page; 3 = previous
// session. Without this, every Bento launch starts with an empty tab
// and the per-workspace tab/panel restore mechanism has nothing to
// rehydrate.
pref("browser.startup.page", 3);

// --- Chrome defaults ------------------------------------------------------
// Firefox defaults to showing the bookmarks toolbar only on about:newtab.
// Bento's shell uses its own vertical/navigation surfaces, so keep the native
// bookmarks toolbar hidden unless users explicitly turn it back on.
pref("browser.toolbars.bookmarks.visibility", "never");

// Hide Firefox's native horizontal tab strip through Firefox's
// TabBarVisibility hidden-tabs titlebar state. Bento's visible tabs remain
// owned by the bento-shell sidebar.
pref("bento.chrome.hideNativeTabs", true);

// Disable the macOS two-finger trackpad swipe-back/forward history gesture.
// Bento panels each have their own back/forward controls in the per-panel
// header, so the gesture is redundant; in practice it misfires often during
// horizontal trackpad scrolls over panel content. Users who want it back can
// restore the Firefox defaults in about:config:
//   browser.gesture.swipe.left  = "Browser:BackOrBackDuplicate"
//   browser.gesture.swipe.right = "Browser:ForwardOrForwardDuplicate"
pref("browser.gesture.swipe.left", "");
pref("browser.gesture.swipe.right", "");

// Native split-view UI is hidden via patches/window-sync/04-splitview-
// disable.patch — each of Firefox's three `browser.tabs.splitView.enabled`
// read sites is hardcoded to false:
//   - tabbrowser.js: tab context menu's "Move Tab to Split View",
//     "Separate Tabs", "Reverse Tab Order" entries
//   - nsContextMenu.sys.mjs: link context menu's "Open in Split View"
//   - tab.js: alt-click-to-split on tab elements
// Each of these routes bypasses bento-tools' PanelStore and would
// produce untracked splits with no workspace persistence; Bento panels
// use the underlying split-view machinery directly. Hardcoded rather
// than pref-gated because a user flipping the pref back on would
// silently re-expose the conflicting entry points.

// --- Bento window sync ---------------------------------------------------
// The synced/unsynced concept (BrowserWindowTracker patch, the
// `bento-synced-window` / `bento-unsynced-window` attribute on chrome
// documentElement, container inheritance from opener on unsynced
// windows, the Cmd+Shift+Alt+N command, tear-out → unsynced) is
// foundational behaviour and not pref-gated. New windows are synced
// by default; Cmd+Shift+Alt+N and tab tear-out always produce
// unsynced windows with the opener's container inherited.

// Last-tab close behaviour is patched directly into tabbrowser.js (see
// patches/window-sync/03-tabbrowser-close-last-tab.patch) instead of going
// through browser.tabs.closeWindowWithLastTab. bento-tools' tabs.onRemoved
// handler is the sole authority on what happens when the last tab in a
// workspace is removed — promote a panel into the main slot, delete the
// workspace and switch the window to the next available one, or close
// the window. Hardcoded rather than pref-gated because a user flipping
// the pref back to its Firefox default of true would silently break
// workspace promotion and produce surprise window closures.

// --- Web compatibility ----------------------------------------------------
// Keep Bento identifiable as Bento while also advertising Firefox compatibility
// in the UA string. AMO and some Firefox-specific sites key browser support off
// the Firefox token before they expose extension-install affordances.
pref("general.useragent.compatMode.firefox", true);

// --- Bento UI shell mount -------------------------------------------------
// (extensions.webextensions.uuids isn't honored for built-in addons —
// the chrome resolver script reads the assigned UUID at runtime instead.)

// --- Bento M2 prefs -------------------------------------------------------
// Documented here for visibility on the Privacy Dashboard and as the source
// of truth for default behavior. The bento-tools extension can't read prefs
// directly without an experiment API, so these values are mirrored as
// constants in the relevant TS modules (SleepPolicy.ts, etc.) for now.
pref("bento.workspace.default", "personal");
pref("bento.panels.minWidth", 240);
pref("bento.tabs.sleep.afterMinutes", 30);
pref("bento.commandPalette.enabled", true);

// --- Update-check defaults ------------------------------------------------
// Firefox's BrowserGlue.sys.mjs reads `app.update.checkInstallTime.days`
// unconditionally during background-update scheduling. Vanilla Firefox ships
// it via firefox.js; Bento's branding/prefs pipeline doesn't carry that one
// through, so the read throws NS_ERROR_UNEXPECTED at every startup. Set the
// Firefox default explicitly to silence the noise. (Bento doesn't currently
// ship auto-updates, but the BrowserGlue path runs anyway.)
pref("app.update.checkInstallTime.days", 63);

// --- Developer iteration --------------------------------------------------
// Bypass HTTP cache whenever DevTools/Browser Toolbox is open so reloads
// of the chrome-mounted shell pick up fresh dist/ files without needing
// reloadWithFlags. End users never have DevTools open, so this has zero
// production effect.
pref("devtools.cache.disabled", true);

// Skip the Browser Toolbox 'Incoming Connection' prompt on every --jsdebugger
// launch. Same dev-only zero-impact-for-end-users tradeoff. Note that
// disabling this prompt only matters when chrome.debugger.remote-enabled
// is on (which --jsdebugger turns on temporarily for the session).
pref("devtools.debugger.prompt-connection", false);
