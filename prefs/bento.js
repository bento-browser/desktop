// Bento Browser — default pref overrides.
//
// Appended to engine/browser/branding/bento/pref/firefox-branding.js by
// scripts/regen-branding.sh after `surfer import` runs. Firefox loads
// firefox-branding.js automatically as default branding prefs, so anything
// here ships as a Bento default (still overridable per-user via about:config).
//
// Privacy-leaning defaults: disable Mozilla services Bento doesn't ship,
// telemetry/crash/study/health reporting off, no sponsored content. Matches
// roughly what Zen, Librewolf, and similar Firefox forks ship.

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

// --- First-run / onboarding noise ----------------------------------------
pref("browser.aboutwelcome.enabled", false);
pref("browser.startup.upgradeDialog.enabled", false);
pref("browser.preferences.moreFromMozilla", false);

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
