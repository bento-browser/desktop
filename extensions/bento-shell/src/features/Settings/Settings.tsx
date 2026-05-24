// Layer-3 feature: Settings.
//
// User-configurable Bento settings. Reads/writes the SettingsStore in
// bento-tools via the dispatch bus. Tale UI primitives (Card, Switch,
// NumberField, TextField, Button) compose into a single-column form.
//
// The Privacy section is the three controls Firefox does NOT expose in
// about:preferences UI (resist fingerprinting, network prediction,
// WebRTC peer connection). Tracking protection, clear-browsing-data,
// and the full prefs inventory live in Firefox's own about:preferences
// — Bento doesn't duplicate them. See plans/bento-browser-features.md
// and the repo README for the complete list of shipped privacy defaults.

import { useEffect, useState } from 'react';
import { Card } from '@tale-ui/react/card';
import { Switch } from '@tale-ui/react/switch';
import { NumberField } from '@tale-ui/react/number-field';
import { TextField } from '@tale-ui/react/text-field';
import { Button } from '@tale-ui/react/button';
import { IconButton } from '@tale-ui/react/icon-button';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { Icon } from '@tale-ui/react/icon';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Keyboard from 'lucide-react/dist/esm/icons/keyboard';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';

import { useSettingsStore } from '../../state/settings';
import { usePrivacyStore } from '../../state/privacy';
import { dispatch, initToolsPort } from '../../bridge/useToolsPort';
import { ShortcutsDialog } from './ShortcutsDialog';
import './Settings.css';

function update<K extends keyof import('@shared/protocol').BentoSettings>(
  key: K,
  value: import('@shared/protocol').BentoSettings[K],
) {
  dispatch({ type: 'settings/update', changes: { [key]: value } });
}

export function Settings() {
  const settings = useSettingsStore((s) => s.current);
  const privacy = usePrivacyStore((s) => s.settings);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Request a fresh privacy snapshot on mount. Tools doesn't push
  // privacy/changed deltas (settings rarely change without explicit user
  // action), so the snapshot we get is the current truth at mount time;
  // any toggle we dispatch below triggers a fresh snapshot via tools'
  // .finally() handler.
  useEffect(() => {
    initToolsPort();
    dispatch({ type: 'privacy/requestSnapshot' });
  }, []);

  if (!settings) {
    return (
      <Column gap="m" align="center" className="bento-settings bento-settings--loading">
        <Text variant="text" size="m" color="muted">
          Loading settings…
        </Text>
      </Column>
    );
  }

  return (
    <Column gap="l" className="bento-settings">
      <Column gap="xs" className="bento-settings__header">
        <Text variant="display" size="m" as="h1">
          Settings
        </Text>
        <Text variant="text" size="m" color="muted">
          Configure how Bento behaves. Changes save automatically.
        </Text>
      </Column>

      <Card.Root>
        <Card.Header>
          <Column gap="2xs">
            <Text variant="heading" size="m">
              Performance
            </Text>
            <Text variant="text" size="s" color="muted">
              Idle tabs are unloaded to free memory. Pinned tabs and the active tab in each
              workspace stay loaded.
            </Text>
          </Column>
        </Card.Header>
        <Card.Body>
          <Column gap="m">
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Text>Sleep idle tabs</Text>
              <Switch.Root
                isSelected={settings.tabSleepEnabled}
                onChange={(v) => update('tabSleepEnabled', v)}
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>
            <NumberField.Root
              value={settings.tabSleepAfterMinutes}
              onChange={(v) => update('tabSleepAfterMinutes', v)}
              minValue={1}
              maxValue={1440}
              step={1}
              formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
              isDisabled={!settings.tabSleepEnabled}
              className="bento-settings__number-field"
            >
              <NumberField.Label>Sleep after (minutes)</NumberField.Label>
              <NumberField.Group>
                <NumberField.Decrement />
                <NumberField.Input />
                <NumberField.Increment />
              </NumberField.Group>
              <NumberField.Description>
                A tab must be untouched for this many minutes before it sleeps.
              </NumberField.Description>
            </NumberField.Root>
            <NumberField.Root
              value={settings.tabSleepKeepAlivePerWorkspace}
              onChange={(v) => update('tabSleepKeepAlivePerWorkspace', v)}
              minValue={1}
              maxValue={50}
              step={1}
              formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
              isDisabled={!settings.tabSleepEnabled}
              className="bento-settings__number-field"
            >
              <NumberField.Label>Keep alive per workspace</NumberField.Label>
              <NumberField.Group>
                <NumberField.Decrement />
                <NumberField.Input />
                <NumberField.Increment />
              </NumberField.Group>
              <NumberField.Description>
                The most recently active N tabs in each workspace never sleep.
              </NumberField.Description>
            </NumberField.Root>
          </Column>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Text variant="heading" size="m">
            Workspaces
          </Text>
        </Card.Header>
        <Card.Body>
          <TextField.Root
            value={settings.defaultWorkspaceName}
            onChange={(v) => update('defaultWorkspaceName', v)}
          >
            <TextField.Label>Default workspace name</TextField.Label>
            <TextField.Input />
            <TextField.Description>
              Used when Bento creates the first workspace on a fresh profile. Existing workspaces
              keep their names.
            </TextField.Description>
          </TextField.Root>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Text variant="heading" size="m">
            Panels
          </Text>
        </Card.Header>
        <Card.Body>
          <Column gap="l">
            <NumberField.Root
              value={settings.defaultPanelWidthPx}
              onChange={(v) => {
                if (!Number.isFinite(v) || v <= 0) return;
                update('defaultPanelWidthPx', Math.round(v));
              }}
              minValue={200}
              maxValue={2400}
              step={1}
              formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
              className="bento-settings__number-field"
            >
              <NumberField.Label>Default new panel width (px)</NumberField.Label>
              <NumberField.Group>
                <NumberField.Decrement />
                <NumberField.Input />
                <NumberField.Increment />
              </NumberField.Group>
              <NumberField.Description>
                Width applied to new panels before you drag their splitter. Existing panels keep
                their stored widths.
              </NumberField.Description>
            </NumberField.Root>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Column gap="3xs" style={{ flex: 1 }}>
                <Text>Wrap arrow-key cycling at the ends</Text>
                <Text variant="text" size="s" color="muted">
                  When on, pressing the Right arrow past the Add-panel button cycles back to the
                  main content slot. When off, the Add-panel button is the rightmost stop.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.panelCycleWraparound}
                onChange={(v) => update('panelCycleWraparound', v)}
                aria-label="Wrap arrow-key cycling at the ends"
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Column gap="3xs" style={{ flex: 1 }}>
                <Text>Panel shadows</Text>
                <Text variant="text" size="s" color="muted">
                  Show the outer shadows around panels in the split-view strip.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.panelShadowsEnabled}
                onChange={(v) => update('panelShadowsEnabled', v)}
                aria-label="Panel shadows"
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>
            <Column gap="2xs">
              <Text>Custom panel sizes (px)</Text>
              <Text variant="text" size="s" color="muted">
                Presets shown in each side panel header&rsquo;s kebab menu. Clicking a size resizes
                only that panel.
              </Text>
            </Column>
            <Column gap="xs">
              {(settings.customPanelSizes ?? []).map((px, i) => (
                <Row key={i} gap="xs" align="end">
                  <NumberField.Root
                    value={px}
                    onChange={(v) => {
                      // Skip NaN (occurs when the input is cleared mid-edit)
                      // so we don't persist garbage; the user's next keystroke
                      // will dispatch a valid number.
                      if (!Number.isFinite(v) || v <= 0) return;
                      const next = [...(settings.customPanelSizes ?? [])];
                      next[i] = Math.round(v);
                      update('customPanelSizes', next);
                    }}
                    minValue={120}
                    maxValue={2400}
                    step={1}
                    formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
                    aria-label={`Custom panel size ${i + 1}`}
                    className="bento-settings__number-field"
                  >
                    <NumberField.Group>
                      <NumberField.Decrement />
                      <NumberField.Input />
                      <NumberField.Increment />
                    </NumberField.Group>
                  </NumberField.Root>
                  <IconButton
                    variant="ghost"
                    aria-label={`Remove size ${px} px`}
                    onPress={() => {
                      const next = (settings.customPanelSizes ?? []).filter((_, j) => j !== i);
                      update('customPanelSizes', next);
                    }}
                  >
                    <Icon icon={Trash2} />
                  </IconButton>
                </Row>
              ))}
              <Row>
                <Button
                  variant="neutral"
                  size="sm"
                  onPress={() => {
                    const next = [...(settings.customPanelSizes ?? []), 480];
                    update('customPanelSizes', next);
                  }}
                >
                  <Icon icon={Plus} size="sm" />
                  Add size
                </Button>
              </Row>
            </Column>
          </Column>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Column gap="2xs">
            <Text variant="heading" size="m">
              Privacy
            </Text>
            <Text variant="text" size="s" color="muted">
              Bento ships with telemetry, sponsored content, crash reporting, studies, and Mozilla
              service promos disabled by default. Tracking protection runs at &lsquo;strict&rsquo;.
              Use Firefox&rsquo;s Settings (about:preferences#privacy) for tracking protection,
              clearing browsing data, and the full preference list. The three controls below are
              prefs Firefox doesn&rsquo;t expose in its UI.
            </Text>
          </Column>
        </Card.Header>
        <Card.Body>
          {privacy === null ? (
            <Text variant="text" size="s" color="muted">
              Loading privacy settings…
            </Text>
          ) : (
            <Column gap="m">
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Column gap="3xs" style={{ flex: 1 }}>
                  <Text>Resist fingerprinting</Text>
                  <Text variant="text" size="s" color="muted">
                    Spoof browser characteristics to make tracking by fingerprint harder. May break
                    some sites.
                  </Text>
                </Column>
                <Switch.Root
                  isSelected={privacy.resistFingerprinting}
                  onChange={(v) =>
                    dispatch({ type: 'privacy/setResistFingerprinting', enabled: v })
                  }
                  aria-label="Resist fingerprinting"
                >
                  <Switch.Thumb />
                </Switch.Root>
              </Row>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Column gap="3xs" style={{ flex: 1 }}>
                  <Text>Network prediction</Text>
                  <Text variant="text" size="s" color="muted">
                    DNS / TCP prefetching for hovered links. Faster loads, but contacts servers you
                    didn&rsquo;t click.
                  </Text>
                </Column>
                <Switch.Root
                  isSelected={privacy.networkPrediction}
                  onChange={(v) => dispatch({ type: 'privacy/setNetworkPrediction', enabled: v })}
                  aria-label="Network prediction"
                >
                  <Switch.Thumb />
                </Switch.Root>
              </Row>
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <Column gap="3xs" style={{ flex: 1 }}>
                  <Text>WebRTC peer connections</Text>
                  <Text variant="text" size="s" color="muted">
                    Required for video calls and some real-time apps. Off plugs the WebRTC IP-leak
                    vector but breaks Meet, Discord call, etc.
                  </Text>
                </Column>
                <Switch.Root
                  isSelected={privacy.peerConnection}
                  onChange={(v) => dispatch({ type: 'privacy/setPeerConnection', enabled: v })}
                  aria-label="WebRTC peer connections"
                >
                  <Switch.Thumb />
                </Switch.Root>
              </Row>
            </Column>
          )}
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Column gap="2xs">
            <Text variant="heading" size="m">
              Keyboard shortcuts
            </Text>
            <Text variant="text" size="s" color="muted">
              Reference for the Bento-specific hotkeys (workspaces, panels, command palette).
              Standard Firefox shortcuts continue to work.
            </Text>
          </Column>
        </Card.Header>
        <Card.Body>
          <Row>
            <Button variant="neutral" onPress={() => setShortcutsOpen(true)}>
              <Icon icon={Keyboard} size="sm" />
              View shortcuts
            </Button>
          </Row>
        </Card.Body>
      </Card.Root>

      <Row gap="s" align="center" className="bento-settings__footer">
        <Button variant="ghost" onPress={() => dispatch({ type: 'settings/reset' })}>
          <Icon icon={RotateCcw} size="sm" />
          Reset to defaults
        </Button>
      </Row>

      <ShortcutsDialog isOpen={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </Column>
  );
}
