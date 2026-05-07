// Layer-3 feature: PrivacyDashboard.
//
// Three-part page:
//   1. Live controls — Switch + ToggleButtonGroup wired to bento-tools'
//      browser.privacy.* reader/writer. Round-trips through the bus on
//      every change; tools replies with a fresh privacy/snapshot so the
//      UI always reflects the actual stored value (no optimistic state).
//   2. Quick actions — "Clear browsing data" routes through bento-tools'
//      browser.browsingData.remove; "Open Firefox privacy settings"
//      opens about:preferences#privacy in a new tab.
//   3. Shipped defaults inventory — the existing read-only listing of
//      prefs Bento sets in prefs/bento.js, kept manually in sync. Useful
//      as a "what does Bento turn off out of the box" reference.

import { useEffect, useState } from 'react';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { Switch } from '@tale-ui/react/switch';
import { ToggleButtonGroup } from '@tale-ui/react/toggle-group';
import { ToggleButton } from '@tale-ui/react/toggle-button';
import { Button } from '@tale-ui/react/button';
import { Banner } from '@tale-ui/react/banner';

import { dispatch, initToolsPort } from '../../bridge/useToolsPort';
import { usePrivacyStore } from '../../state/privacy';
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

type ToastState = { kind: 'success' | 'error'; message: string } | null;

export function PrivacyDashboard() {
  const settings = usePrivacyStore((s) => s.settings);
  const [toast, setToast] = useState<ToastState>(null);

  // Connect to the bus and request the current privacy snapshot. The
  // bus listener (useToolsPort) routes the reply into usePrivacyStore.
  useEffect(() => {
    initToolsPort();
    dispatch({ type: 'privacy/requestSnapshot' });
  }, []);

  // browsingData/cleared events are surfaced as a one-shot DOM event
  // (see useToolsPort). Render a toast and auto-clear after 3s.
  useEffect(() => {
    function handle(e: Event) {
      const detail = (e as CustomEvent<{ ok: boolean; error?: string }>).detail;
      if (detail.ok) setToast({ kind: 'success', message: 'Browsing data cleared.' });
      else
        setToast({
          kind: 'error',
          message: 'Could not clear browsing data: ' + (detail.error ?? 'unknown error'),
        });
    }
    window.addEventListener('bento:browsingDataCleared', handle);
    return () => window.removeEventListener('bento:browsingDataCleared', handle);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const onSetTracking = (keys: Iterable<unknown>) => {
    // ToggleButtonGroup with selectionMode="single" emits a Selection
    // (Set-like). Pull the first key — it's our mode value.
    const first = [...(keys as Iterable<string>)][0];
    if (first === 'always' || first === 'never' || first === 'private_browsing') {
      dispatch({ type: 'privacy/setTrackingProtection', mode: first });
    }
  };
  const onSetRfp = (enabled: boolean) =>
    dispatch({ type: 'privacy/setResistFingerprinting', enabled });
  const onSetNetPred = (enabled: boolean) =>
    dispatch({ type: 'privacy/setNetworkPrediction', enabled });
  const onSetWebRtc = (enabled: boolean) =>
    dispatch({ type: 'privacy/setPeerConnection', enabled });

  const clearBrowsingData = () => {
    dispatch({
      type: 'browsingData/clear',
      since: 0,
      // Conservative default — clear browsing-shape data, leave
      // passwords + form data alone (those are higher-stakes; user can
      // do that explicitly from Firefox's settings if needed).
      dataTypes: {
        cache: true,
        cookies: true,
        history: true,
        downloads: true,
        formData: false,
        indexedDB: true,
        localStorage: true,
        passwords: false,
        pluginData: true,
        serviceWorkers: true,
      },
    });
  };

  const openFirefoxPrivacySettings = () => {
    dispatch({ type: 'tab/openUrl', url: 'about:preferences#privacy' });
  };

  return (
    <Column gap="l" className="bento-privacy">
      <Column gap="xs" className="bento-privacy__header">
        <Text variant="display" size="m" as="h1">
          Privacy
        </Text>
        <Text variant="text" size="m" color="muted">
          Bento ships with telemetry, sponsored content, and Mozilla service promos disabled by
          default. Use the controls below to adjust the live settings; the inventory further down
          lists the prefs Bento turns off out of the box.
        </Text>
      </Column>

      {toast && (
        <Banner.Root variant={toast.kind === 'success' ? 'success' : 'error'}>
          <Banner.Title>{toast.message}</Banner.Title>
        </Banner.Root>
      )}

      <Column gap="s" className="bento-privacy__section">
        <Text variant="heading" size="m" as="h2">
          Live controls
        </Text>
        {settings === null ? (
          <Column gap="2xs">
            <div className="bento-privacy__skeleton" />
            <div className="bento-privacy__skeleton" />
            <div className="bento-privacy__skeleton" />
          </Column>
        ) : (
          <Column gap="s">
            <Row gap="m" align="center" className="bento-privacy__control">
              <Column gap="3xs" className="bento-privacy__control-info">
                <Text variant="text" size="m">
                  Tracking protection
                </Text>
                <Text variant="text" size="s" color="muted">
                  Block cross-site trackers, fingerprinters, cryptominers. Bento ships this on
                  Always.
                </Text>
              </Column>
              <ToggleButtonGroup
                aria-label="Tracking protection mode"
                selectionMode="single"
                selectedKeys={new Set([settings.trackingProtectionMode])}
                onSelectionChange={onSetTracking}
              >
                <ToggleButton id="always">Always</ToggleButton>
                <ToggleButton id="private_browsing">Private only</ToggleButton>
                <ToggleButton id="never">Never</ToggleButton>
              </ToggleButtonGroup>
            </Row>

            <Row gap="m" align="center" className="bento-privacy__control">
              <Column gap="3xs" className="bento-privacy__control-info">
                <Text variant="text" size="m">
                  Resist fingerprinting
                </Text>
                <Text variant="text" size="s" color="muted">
                  Spoof browser characteristics to make tracking by fingerprint harder. May break
                  some sites.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.resistFingerprinting}
                onChange={onSetRfp}
                aria-label="Resist fingerprinting"
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>

            <Row gap="m" align="center" className="bento-privacy__control">
              <Column gap="3xs" className="bento-privacy__control-info">
                <Text variant="text" size="m">
                  Network prediction
                </Text>
                <Text variant="text" size="s" color="muted">
                  DNS/TCP prefetching for hovered links. Faster loads, but contacts servers you did
                  not click.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.networkPrediction}
                onChange={onSetNetPred}
                aria-label="Network prediction"
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>

            <Row gap="m" align="center" className="bento-privacy__control">
              <Column gap="3xs" className="bento-privacy__control-info">
                <Text variant="text" size="m">
                  WebRTC peer connections
                </Text>
                <Text variant="text" size="s" color="muted">
                  Required for video calls and some real-time apps. Off plugs the WebRTC IP-leak
                  vector but breaks Meet, Discord call, etc.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.peerConnection}
                onChange={onSetWebRtc}
                aria-label="WebRTC peer connections"
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>
          </Column>
        )}
      </Column>

      <Column gap="s" className="bento-privacy__section">
        <Text variant="heading" size="m" as="h2">
          Quick actions
        </Text>
        <Row gap="s" className="bento-privacy__actions">
          <Button variant="primary" onPress={clearBrowsingData}>
            Clear browsing data
          </Button>
          <Button variant="neutral" onPress={openFirefoxPrivacySettings}>
            Open Firefox privacy settings
          </Button>
        </Row>
        <Text variant="text" size="xs" color="muted">
          Clear removes cache, cookies, history, downloads, IndexedDB, localStorage, and service
          workers across all time. Saved passwords and form data are left alone.
        </Text>
      </Column>

      <Column gap="s" className="bento-privacy__section">
        <Text variant="heading" size="m" as="h2">
          Shipped defaults
        </Text>
        <Text variant="text" size="s" color="muted">
          Listed for transparency. The actual values come from{' '}
          <Text variant="mono" size="xs">
            prefs/bento.js
          </Text>{' '}
          at build time and can be inspected via about:config.
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
