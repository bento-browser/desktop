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

// --- First-run / onboarding noise ----------------------------------------
pref("browser.aboutwelcome.enabled", false);
pref("browser.startup.upgradeDialog.enabled", false);
pref("browser.preferences.moreFromMozilla", false);
