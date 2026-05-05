// Layer-3 feature: PrivacyDashboard.
//
// M1 placeholder — read-only listing of the privacy prefs Bento ships
// (defined in /prefs/bento.js, appended to firefox-branding.js + firefox.js
// at build time). Visualizes the "off by default" posture so users can verify
// without grepping the source.
//
// Future (M2+): live wire to browser.privacy.* + browser.experiments to
// reflect runtime state and let the user toggle.

import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import './PrivacyDashboard.css';

interface PrefRow {
  name: string;
  description: string;
  /** What Bento ships this as. 'off' = privacy-protective; 'on' = enabled. */
  status: 'off' | 'on';
}

interface PrefSection {
  title: string;
  intro: string;
  prefs: PrefRow[];
}

// Mirrors prefs/bento.js — keep manually in sync. Listed here for visibility,
// not as the source of truth (the actual values come from the engine's
// firefox.js / firefox-branding.js at runtime).
const SECTIONS: PrefSection[] = [
  {
    title: 'Telemetry & data reporting',
    intro: 'Bento sends no usage telemetry, health pings, or coverage data to Mozilla.',
    prefs: [
      {
        name: 'toolkit.telemetry.enabled',
        description: 'Usage telemetry collection',
        status: 'off',
      },
      {
        name: 'toolkit.telemetry.unified',
        description: 'Unified telemetry pipeline',
        status: 'off',
      },
      {
        name: 'datareporting.healthreport.uploadEnabled',
        description: 'Firefox Health Report upload',
        status: 'off',
      },
      {
        name: 'datareporting.policy.dataSubmissionEnabled',
        description: 'Data submission policy',
        status: 'off',
      },
    ],
  },
  {
    title: 'Crash reporting',
    intro:
      'The crash reporter is disabled at build time (mozconfig --disable-crashreporter). Runtime prefs cover the in-product paths too.',
    prefs: [
      {
        name: 'browser.tabs.crashReporting.sendReport',
        description: 'Tab crash report submission',
        status: 'off',
      },
      {
        name: 'browser.crashReports.unsubmittedCheck.enabled',
        description: 'Background check for unsubmitted reports',
        status: 'off',
      },
    ],
  },
  {
    title: 'Studies & experiments',
    intro:
      'Normandy and Shield studies are off — Mozilla cannot ship behavior changes to your browser.',
    prefs: [
      { name: 'app.shield.optoutstudies.enabled', description: 'Shield Studies', status: 'off' },
      { name: 'app.normandy.enabled', description: 'Normandy experiment runner', status: 'off' },
      {
        name: 'messaging-system.rsexperimentloader.enabled',
        description: 'Remote Settings experiment loader',
        status: 'off',
      },
    ],
  },
  {
    title: 'Sponsored content',
    intro:
      'No sponsored shortcuts on the new tab page, no sponsored URL bar suggestions, no contentblocking-report promos.',
    prefs: [
      {
        name: 'browser.newtabpage.activity-stream.showSponsored',
        description: 'Sponsored stories on the new tab page',
        status: 'off',
      },
      {
        name: 'browser.urlbar.suggest.quicksuggest.sponsored',
        description: 'Sponsored URL bar suggestions',
        status: 'off',
      },
      {
        name: 'browser.urlbar.quicksuggest.enabled',
        description: 'Firefox Suggest (Quick Suggest)',
        status: 'off',
      },
    ],
  },
  {
    title: 'Mozilla services Bento does not ship',
    intro: 'Pocket, VPN promos, Firefox Monitor / Lockwise / Relay reports are all hidden.',
    prefs: [
      { name: 'extensions.pocket.enabled', description: 'Pocket integration', status: 'off' },
      { name: 'browser.vpn_promo.enabled', description: 'Mozilla VPN promotion', status: 'off' },
      {
        name: 'browser.contentblocking.report.monitor.enabled',
        description: 'Firefox Monitor in protections panel',
        status: 'off',
      },
    ],
  },
];

export function PrivacyDashboard() {
  return (
    <Column gap="l" className="bento-privacy">
      <Column gap="xs" className="bento-privacy__header">
        <Text variant="display" size="m" as="h1">
          Privacy
        </Text>
        <Text variant="text" size="m" color="muted">
          Bento ships with telemetry, sponsored content, and Mozilla service promos disabled by
          default. This page lists the prefs and their shipped values.
        </Text>
      </Column>

      {SECTIONS.map((section) => (
        <Column key={section.title} gap="s" className="bento-privacy__section">
          <Text variant="heading" size="m" as="h2">
            {section.title}
          </Text>
          <Text variant="text" size="s" color="muted">
            {section.intro}
          </Text>
          <Column gap="2xs" className="bento-privacy__prefs">
            {section.prefs.map((pref) => (
              <Row key={pref.name} gap="s" align="center" className="bento-privacy__pref">
                <span
                  className={`bento-privacy__status bento-privacy__status--${pref.status}`}
                  aria-label={pref.status === 'off' ? 'Disabled' : 'Enabled'}
                >
                  {pref.status === 'off' ? 'OFF' : 'ON'}
                </span>
                <Column gap="3xs" className="bento-privacy__pref-info">
                  <Text variant="text" size="s">
                    {pref.description}
                  </Text>
                  <Text variant="mono" size="xs" color="muted">
                    {pref.name}
                  </Text>
                </Column>
              </Row>
            ))}
          </Column>
        </Column>
      ))}

      <Text variant="text" size="xs" color="muted" className="bento-privacy__footer">
        Source of truth: <code>prefs/bento.js</code> in the bento-browser repository.
      </Text>
    </Column>
  );
}
