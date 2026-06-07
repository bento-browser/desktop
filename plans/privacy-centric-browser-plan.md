# Privacy-Centric Browser Plan

## Summary

Add privacy as a first-class Bento product surface using a `Standard` default plus
a Settings and onboarding protection slider with stronger `Enhanced` and
`Hardened` levels. The default remains compatibility-conscious; breakier
protections are explicit choices.

This plan incorporates transferable privacy patterns from:

- Helium: ungoogled-style removal of background service surfaces, disabled
  reporting/field-trial services, reduced Google dependencies, and bundled
  content blocking.
- Waterfox: Firefox-fork positioning around no telemetry, strong content
  blocking, privacy-preserving DNS/network defaults, and minimal data collection.
- LibreWolf: explicit hardened Firefox prefs, bundled uBlock Origin, strict ETP,
  RFP, dFPI/TCP, URL tracking stripping, cleanup-on-exit options, privacy search
  defaults, and a documented override model.

## Sources And Confidence

- Helium README: <https://github.com/imputnet/helium/blob/main/README.md>
- Helium build flags: <https://github.com/imputnet/helium/blob/main/flags.gn>
- Helium patch series: <https://github.com/imputnet/helium/blob/main/patches/series>
- Waterfox README: <https://github.com/BrowserWorks/waterfox/blob/current/README.md>
- Waterfox privacy commitments: <https://www.waterfox.com/docs/policies/privacy-commitments/>
- Waterfox features: <https://www.waterfox.com/features/>
- Waterfox mozconfig: <https://github.com/BrowserWorks/waterfox/blob/current/.mozconfig>
- LibreWolf features: <https://librewolf.net/docs/features/>
- LibreWolf settings docs: <https://librewolf.net/docs/settings/>
- LibreWolf source README: <https://codeberg.org/librewolf/source>
- LibreWolf settings repository: <https://codeberg.org/librewolf/settings>

Confidence: high for LibreWolf and Helium settings because their source files
state the concrete prefs, flags, and patch names. Confidence: medium for
Waterfox defaults because public docs say telemetry is disabled at browser level,
and mozconfigs export `MOZ_TELEMETRY_REPORTING=` and disable crash reporter, but
the current `browser/app/profile/firefox.js` still contains some inherited
Firefox telemetry prefs set true. Treat Waterfox as a product posture and build
configuration reference, not as prefs to copy blindly.

## Product Decisions

- Ship `Standard` as the default protection level.
- Add a protection slider in Bento Settings with `Standard`, `Enhanced`, and
  `Hardened`.
- Show `Custom` when advanced privacy toggles diverge from a predefined level.
- Add the same slider to onboarding so users can opt into more hardening before
  first browsing.
- Bundle upstream uBlock Origin, not a Bento fork, with pinned version, hash,
  and license documentation.
- Keep Safe Browsing local phishing and malware list checks in `Standard`.
- Disable remote Safe Browsing download checks by default.
- Do not make Tor, anonymity, VPN, or no-network claims.

## Existing Bento Baseline

Bento already has these privacy-leaning defaults in `prefs/bento.js`:

- Mozilla telemetry, coverage, health report, data submission, crash reporting,
  studies, Normandy, and experiment loader disabled.
- Pocket disabled.
- Sponsored new-tab and urlbar suggestions disabled.
- Firefox Enhanced Tracking Protection category set to `strict`.
- Mozilla service promos disabled.
- Firefox Sync remains available, but is not promoted.
- Bento Settings exposes runtime toggles for:
  - `privacy.resistFingerprinting`
  - `browser.privacy.network.networkPredictionEnabled`
  - `browser.privacy.network.peerConnectionEnabled`

The new work should preserve these and replace the small Privacy card with a
more complete privacy-level model.

## Protection Levels

### Standard

Goal: stronger than Firefox defaults, low breakage.

Prefs and runtime settings:

- Keep telemetry, studies, crash reporting, sponsored suggestions, and Mozilla
  promos disabled.
- Keep `browser.contentblocking.category = "strict"`.
- Set cookie behavior to Total Cookie Protection style behavior:
  `reject_trackers_and_partition_foreign`.
- Enable Global Privacy Control.
- Enable query stripping on share and default query stripping lists where
  available.
- Disable Quick Suggest sponsored and nonsponsored results.
- Disable Quick Suggest data collection.
- Disable trending/weather/Yelp/Fakespot/market/urlbar remote suggestions.
- Disable search SERP telemetry categorization.
- Disable network prediction, DNS prefetch, link prefetch, speculative
  connections, and early-hints preconnect.
- Disable hyperlink auditing.
- Keep WebRTC peer connections enabled.
- Keep WebRTC IP policy at Firefox default unless user moves up a level.
- Keep RFP off.
- Keep HTTPS-only off or private-window-only, matching current Firefox
  compatibility expectations.
- Keep local Safe Browsing phishing and malware list checks enabled.
- Disable remote Safe Browsing download checks.
- Keep DoH off by default, but expose a provider selector in advanced settings.
- Bundle and enable uBlock Origin, including private windows.

### Enhanced

Goal: visible hardening with moderate site-breakage risk.

Includes Standard plus:

- Enable `privacy.resistFingerprinting`.
- Enable HTTPS-only mode for all windows.
- Set WebRTC IP policy to `disable_non_proxied_udp`.
- Keep WebRTC peer connections enabled for calls.
- Trim cross-origin referrers to scheme, host, and port.
- Disable form history and form autofill.
- Disable password saving prompts by default, with advanced re-enable.
- Keep disk cache enabled.
- Keep WebGL enabled.
- Keep DRM enabled unless the user disables it.

### Hardened

Goal: LibreWolf-style hardening, high breakage risk.

Includes Enhanced plus:

- Enable RFP letterboxing.
- Disable WebRTC peer connections.
- Disable disk cache.
- Clear cookies/site data/cache on shutdown.
- Disable WebGL, WebGPU, and PDF WebGPU.
- Disable DRM/EME and GMP provider updates.
- Disable built-in password manager and autofill.
- Enable first-party isolation where compatible with Bento's workspace model.
- Empty Safe Browsing remote provider/update URLs.
- Disable geolocation OS provider usage unless the user grants site permission
  and explicitly enables location services.
- Disable PDF scripting.
- Disable private attribution.
- Disable AI/ML browser features and related UI surfaces.
- Disable Firefox account toolbar promo surfaces.

### Custom

Custom is not directly selectable. Bento shows it when one or more advanced
privacy controls no longer match the active level preset.

## Runtime Control Surface

Use `browser.privacy.*` from `bento-tools` when available:

- `browser.privacy.network.networkPredictionEnabled`
- `browser.privacy.network.peerConnectionEnabled`
- `browser.privacy.network.webRTCIPHandlingPolicy`
- `browser.privacy.network.httpsOnlyMode`
- `browser.privacy.network.globalPrivacyControl`
- `browser.privacy.services.passwordSavingEnabled`
- `browser.privacy.websites.hyperlinkAuditingEnabled`
- `browser.privacy.websites.referrersEnabled`
- `browser.privacy.websites.resistFingerprinting`
- `browser.privacy.websites.firstPartyIsolate`
- `browser.privacy.websites.trackingProtectionMode`
- `browser.privacy.websites.cookieConfig`

For prefs not exposed through WebExtension APIs, add a small whitelisted
WebExtension experiment for `bento-tools`.

## New `bentoPrefs` Experiment

Add `extensions/bento-tools/experiments/bento-prefs/`.

Expose only:

- `getMany(names: string[]): Promise<Record<string, unknown>>`
- `setMany(values: Record<string, boolean | number | string>): Promise<void>`
- `clearMany(names: string[]): Promise<void>`

The experiment must reject any pref not in a static allowlist. The allowlist is
only the privacy-level prefs Bento owns. Do not expose generic pref write access
to the UI.

Use the experiment for:

- Safe Browsing provider and remote download prefs.
- Query stripping list and allowlist prefs.
- DNS prefetch, link prefetch, speculative connection prefs not covered by
  `browser.privacy`.
- Disk cache prefs.
- Shutdown sanitization prefs.
- WebGL/WebGPU prefs.
- DRM/EME/GMP prefs.
- PDF scripting prefs.
- AI/ML feature prefs.
- New-tab, urlbar, sponsored, and remote suggestion prefs not already covered.
- Normandy/Nimbus/Glean/data-reporting lock-style defensive prefs, where
  runtime verification is useful.

## Data Model

Update `extensions/_shared/protocol.ts`:

```ts
export type PrivacyProtectionLevel = 'standard' | 'enhanced' | 'hardened' | 'custom';
```

Add to `BentoSettings`:

```ts
privacyProtectionLevel: PrivacyProtectionLevel;
```

Expand `PrivacySettings` to include the effective level and enough values for
the Settings UI to render the current state:

```ts
export interface PrivacySettings {
  protectionLevel: PrivacyProtectionLevel;
  resistFingerprinting: boolean;
  networkPrediction: boolean;
  peerConnection: boolean;
  webRTCIPHandlingPolicy: string;
  httpsOnlyMode: string;
  globalPrivacyControl: boolean;
  passwordSaving: boolean;
  hyperlinkAuditing: boolean;
  referrersEnabled: boolean;
  firstPartyIsolate: boolean;
  trackingProtectionMode: string;
  cookieBehavior: string;
}
```

Add actions:

```ts
| { type: 'privacy/setProtectionLevel'; level: PrivacyProtectionLevel }
| { type: 'privacy/setAdvancedToggle'; key: PrivacyAdvancedKey; value: boolean | string }
```

Keep the current individual privacy actions only if they remain useful during
migration. Otherwise replace them with `privacy/setAdvancedToggle`.

## Tools Implementation

Add `extensions/bento-tools/src/privacy/ProtectionLevels.ts`.

Contents:

- `PRIVACY_LEVELS`: source-of-truth level definitions.
- `applyPrivacyLevel(level)`: writes `browser.privacy.*` and `bentoPrefs`
  values.
- `readPrivacySnapshot()`: reads current values from both surfaces.
- `detectPrivacyLevel(snapshot)`: returns `standard`, `enhanced`, `hardened`,
  or `custom`.
- `PRIVACY_PREF_ALLOWLIST`: pref names the experiment may write.

Update `protocol-handler.ts`:

- `privacy/requestSnapshot` calls `readPrivacySnapshot`.
- `privacy/setProtectionLevel` applies the level, updates
  `SettingsStore.privacyProtectionLevel`, then emits a fresh snapshot.
- Advanced toggles apply only the requested setting, set
  `privacyProtectionLevel = 'custom'`, then emit a fresh snapshot.
- All writes should catch and report per-setting failures in console warnings,
  but still emit a snapshot so the UI reflects reality.

Update `SettingsStore.ts`:

- Add default `privacyProtectionLevel: 'standard'`.
- Bump storage `VERSION`.
- Migration behavior:
  - Existing profiles with no privacy-level field get `standard`.
  - If existing RFP/network/WebRTC values differ from `standard` when first
    snapshot is read, tools may show `custom`.

## Settings UI

Replace the current Privacy card in
`extensions/bento-shell/src/features/Settings/Settings.tsx`.

New UI:

- Protection slider with `Standard`, `Enhanced`, `Hardened`.
- Breakage copy tied to each level:
  - Standard: "Low site breakage"
  - Enhanced: "Some sites may ask for permissions or behave differently"
  - Hardened: "Some logins, calls, video, maps, DRM, and WebGL apps may break"
- Effective-state rows:
  - Tracking protection
  - Cookies/site data
  - Fingerprinting
  - Network prediction
  - WebRTC
  - HTTPS-only
  - Referrers and link pings
  - Safe Browsing
  - uBlock Origin
- Advanced disclosure with individual toggles.
- Link/button to open Firefox `about:preferences#privacy` for full native
  controls.

Tale UI requirements:

- Before implementation, use Tale UI `plan_ui`.
- Check component APIs for `Slider` or `ToggleButtonGroup`, `Disclosure`,
  `Switch`, `Banner`, `Card`, `Text`, `Row`, and `Column`.
- Add or update Ladle stories for Settings privacy states.

## Onboarding UI

Update `extensions/bento-shell/src/welcome/main.tsx`:

- Add a `privacy` onboarding step after `import`.
- Show the same three protection levels.
- Default selected value is `standard`.
- Dispatch `settings/update` and `privacy/setProtectionLevel` when the user
  chooses a level.
- Persist the step using the existing `bento-welcome-step` mechanism.
- Do not mark `welcomeSeen=true` until the final step.

Update `welcome.css`:

- Add layout styles for the level selector.
- Preserve mobile constraints and avoid text overflow.

## Bundled uBlock Origin

Add `extensions/vendor/ublock-origin/`:

- Pinned XPI.
- `README.md` containing source URL, version, hash, update procedure, license,
  and verification notes.

Add import/build wiring:

- During `pnpm run import` or Surfer import, copy the XPI into Firefox
  distribution extension location or install it as a built-in extension if that
  is the established Surfer path.
- Ensure private browsing access is enabled by policy where possible.
- Ensure users can disable or remove it.
- Do not fork uBO unless a later plan justifies maintaining filter/UI changes.

Add policy or default extension settings:

- Install uBO normally.
- Do not block user-installed extensions.
- Do not use LibreWolf's extension firewall as a default. It is too break-prone
  and blocks legitimate extension updates.

## Pref Baseline Additions

Update `prefs/bento.js` for `Standard` defaults:

- GPC:
  - `privacy.globalprivacycontrol.enabled`
  - `privacy.globalprivacycontrol.pbmode.enabled`
  - `privacy.globalprivacycontrol.functionality.enabled`
- Network prediction/prefetch/speculative connections:
  - `network.predictor.enabled`
  - `network.prefetch-next`
  - `network.dns.disablePrefetch`
  - `network.dns.disablePrefetchFromHTTPS`
  - `network.http.speculative-parallel-limit`
  - `network.early-hints.preconnect.max_connections`
  - `browser.places.speculativeConnect.enabled`
  - `browser.urlbar.speculativeConnect.enabled`
- Search/urlbar remote suggestion surfaces:
  - trending/weather/Yelp/Fakespot/market feature gates
  - SERP telemetry categorization
  - Quick Suggest data collection
- Safe Browsing remote download checks:
  - keep phishing/malware list checks enabled in Standard
  - disable `browser.safebrowsing.downloads.remote.*`
- Query stripping:
  - enable built-in query stripping prefs where available
  - use LibreWolf/Brave strip list as default if current Firefox version accepts
    `privacy.query_stripping.strip_list`
- Defensive no-telemetry additions:
  - Glean add-on ping scheduler prefs if present
  - private attribution off
  - AI/ML browser feature prefs off unless Bento explicitly ships an AI feature

## Documentation

Update:

- `docs/core-functionality.md`
- `docs/core-functionality-technical.md`
- `docs/firefox-core-touchpoints.md`

Add:

- `docs/privacy.md`

`docs/privacy.md` should include:

- Protection-level table.
- What Bento disables by default.
- What each higher level may break.
- uBO bundled-extension policy.
- Safe Browsing behavior.
- DoH behavior.
- Known network calls that remain, with why they exist.
- Source attribution to Helium, Waterfox, and LibreWolf.

## Firefox Core Touchpoints

Record these in `docs/firefox-core-touchpoints.md`:

- New `prefs/bento.js` privacy defaults.
- New WebExtension experiment for whitelisted pref access.
- uBO bundled extension installation/copy path.
- Any policy file added for extension installation.

Do not patch Firefox core for privacy level behavior unless a required setting
cannot be controlled by prefs, policy, WebExtension API, or the whitelisted
experiment.

## Tests

Unit tests:

- `ProtectionLevels` maps each level to expected `browser.privacy` settings.
- `ProtectionLevels` maps each level to expected whitelisted prefs.
- `detectPrivacyLevel` returns exact levels when values match.
- `detectPrivacyLevel` returns `custom` when one relevant value diverges.
- Migration from older settings adds `privacyProtectionLevel: 'standard'`.
- Protocol handler applies level, persists setting, emits snapshot.
- Failed pref writes still emit snapshot.

Build/type checks:

- `pnpm --filter @bento/tools test`
- `pnpm --filter @bento/tools typecheck`
- `pnpm --filter @bento/shell typecheck`
- `pnpm run ext:build`
- `pnpm run size` if UI chunks grow materially.

Manual browser verification:

- Fresh profile opens onboarding and shows `Standard`.
- Choosing `Enhanced` or `Hardened` in onboarding persists after restart.
- Settings slider reflects current level.
- Advanced toggle divergence shows `Custom`.
- uBO appears installed, enabled, and available in private windows.
- `about:config` values match each selected level.
- `about:telemetry` has no collected measurements.
- `about:studies` has no active studies.
- Common compatibility checks:
  - Google login
  - GitHub
  - video call site
  - streaming DRM site
  - WebGL test site
  - HTTP-only site
  - maps/geolocation site
- Startup network audit shows no telemetry, Normandy, Pocket, Contile,
  Quick Suggest, or sponsored new-tab calls.

## Rollout

Phase 1:

- Add `Standard` pref baseline.
- Add privacy level data model.
- Add runtime level applier.
- Add Settings slider.
- Add onboarding step.
- Add docs.

Phase 2:

- Bundle uBO with pinned install path and documentation.
- Add uBO verification to build/manual checklist.

Phase 3:

- Add optional DoH provider selector.
- Add more granular advanced controls.
- Consider per-site WebGL handling only if Hardened users need a safer
  compatibility path.

## Non-Goals

- No Tor mode.
- No VPN.
- No anonymity claims.
- No Chromium patch porting.
- No broad generic pref editor.
- No default extension firewall.
- No forced removal of Firefox Sync; keep it available, but not promoted.
