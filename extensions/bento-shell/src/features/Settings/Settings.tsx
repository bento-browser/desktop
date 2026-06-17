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
import { Select } from '@tale-ui/react/select';
import { Disclosure } from '@tale-ui/react/disclosure';
import { ToggleButtonGroup } from '@tale-ui/react/toggle-group';
import { ToggleButton } from '@tale-ui/react/toggle-button';
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

import type {
  PrivacyAdvancedKey,
  PrivacyProtectionLevel,
  SearchEngineId,
  SelectablePrivacyProtectionLevel,
} from '@shared/protocol';
import { PRIVACY_LEVELS, PRIVACY_LEVEL_DETAILS, privacyLevelLabel } from '@shared/privacy-levels';
import { useSettingsStore } from '../../state/settings';
import { usePrivacyStore } from '../../state/privacy';
import { dispatch, initToolsPort } from '../../bridge/useToolsPort';
import { ShortcutsDialog } from './ShortcutsDialog';
import { BackupSection } from './BackupSection';
import './Settings.css';

function update<K extends keyof import('@shared/protocol').BentoSettings>(
  key: K,
  value: import('@shared/protocol').BentoSettings[K],
) {
  dispatch({ type: 'settings/update', changes: { [key]: value } });
}

function firstSelectedKey(keys: unknown): string | null {
  if (keys === 'all') return null;
  if (!(keys instanceof Set)) return null;
  const first = Array.from(keys)[0];
  return typeof first === 'string' ? first : null;
}

function advancedBoolean(key: PrivacyAdvancedKey, value: boolean, label: string, detail: string) {
  return (
    <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
      <Column gap="3xs" style={{ flex: 1 }}>
        <Text>{label}</Text>
        <Text variant="text" size="s" color="muted">
          {detail}
        </Text>
      </Column>
      <Switch.Root
        isSelected={value}
        onChange={(next) => dispatch({ type: 'privacy/setAdvanced', key, value: next })}
        aria-label={label}
      >
        <Switch.Thumb />
      </Switch.Root>
    </Row>
  );
}

function ProtectionLevelDetailList({ current }: { current: PrivacyProtectionLevel }) {
  return (
    <Disclosure.Root>
      <Disclosure.Trigger>Protection level details</Disclosure.Trigger>
      <Disclosure.Panel>
        <Column gap="m" className="bento-settings__protection-details">
          {PRIVACY_LEVELS.map((level) => {
            const detail = PRIVACY_LEVEL_DETAILS[level.id];
            return (
              <Column
                gap="xs"
                className="bento-settings__protection-detail"
                data-active={current === level.id ? 'true' : undefined}
                key={level.id}
              >
                <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <Text variant="label" size="m">
                    {detail.label}
                  </Text>
                  {current === level.id ? (
                    <Text variant="label" size="s" color="accent">
                      Current
                    </Text>
                  ) : null}
                </Row>
                <Text variant="text" size="s" color="muted">
                  {detail.bestFor}
                </Text>
                <Column gap="2xs">
                  <Text variant="label" size="s">
                    Benefits
                  </Text>
                  {detail.benefits.map((benefit) => (
                    <Text variant="text" size="s" color="muted" key={benefit}>
                      - {benefit}
                    </Text>
                  ))}
                </Column>
                <Column gap="2xs">
                  <Text variant="label" size="s">
                    Caveats
                  </Text>
                  {detail.caveats.map((caveat) => (
                    <Text variant="text" size="s" color="muted" key={caveat}>
                      - {caveat}
                    </Text>
                  ))}
                </Column>
              </Column>
            );
          })}
          <Column gap="2xs" className="bento-settings__protection-detail">
            <Text variant="label" size="m">
              Custom
            </Text>
            <Text variant="text" size="s" color="muted">
              Bento shows Custom when live privacy settings no longer exactly match Standard,
              Enhanced, or Hardened. Your manual settings stay in place until you select a preset.
            </Text>
          </Column>
        </Column>
      </Disclosure.Panel>
    </Disclosure.Root>
  );
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
                Width applied to new panels before you drag their splitter. Also used as the minimum
                main content width in fresh panel layouts. Existing panels keep their stored widths.
              </NumberField.Description>
            </NumberField.Root>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Column gap="3xs" style={{ flex: 1 }}>
                <Text>Wrap panel shortcut cycling at the ends</Text>
                <Text variant="text" size="s" color="muted">
                  When on, Cmd/Ctrl+Shift+Right past the Add-panel button cycles back to the main
                  content slot. When off, the Add-panel button is the rightmost stop.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.panelCycleWraparound}
                onChange={(v) => update('panelCycleWraparound', v)}
                aria-label="Wrap panel shortcut cycling at the ends"
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
              Bento disables telemetry, sponsored content, crash reporting, studies, remote
              suggestions, and speculative connections by default.
            </Text>
            {privacy ? (
              <Text variant="label" size="s" color="accent">
                Current protection level: {privacyLevelLabel(privacy.protectionLevel)}
              </Text>
            ) : null}
          </Column>
        </Card.Header>
        <Card.Body>
          {privacy === null ? (
            <Text variant="text" size="s" color="muted">
              Loading privacy settings…
            </Text>
          ) : (
            <Column gap="l">
              <Column gap="xs">
                <Text variant="label" size="s" color="muted">
                  Protection level
                </Text>
                <ToggleButtonGroup
                  aria-label="Privacy protection level"
                  selectionMode="single"
                  selectedKeys={new Set([privacy.protectionLevel])}
                  onSelectionChange={(keys) => {
                    const next = firstSelectedKey(keys);
                    if (!next || next === 'custom') return;
                    dispatch({
                      type: 'privacy/setProtectionLevel',
                      level: next as SelectablePrivacyProtectionLevel,
                    });
                  }}
                  className="bento-settings__privacy-levels"
                >
                  {PRIVACY_LEVELS.map((level) => (
                    <ToggleButton id={level.id} key={level.id} size="md">
                      {level.label}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
                <Text variant="text" size="s" color="muted">
                  Select Standard, Enhanced, or Hardened to apply that preset. Bento shows Custom
                  when live settings differ from every preset.
                </Text>
                <ProtectionLevelDetailList current={privacy.protectionLevel} />
              </Column>

              <Select.Root
                placeholder="Select search engine"
                selectedKey={privacy.defaultSearchEngine}
                onSelectionChange={(key) => {
                  if (typeof key !== 'string') return;
                  dispatch({ type: 'privacy/setDefaultSearchEngine', id: key as SearchEngineId });
                }}
              >
                <Select.Label>Default search engine</Select.Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Icon />
                </Select.Trigger>
                <Select.Popover>
                  <Select.ListBox>
                    {privacy.availableSearchEngines.map((engine) => (
                      <Select.Item id={engine.id} textValue={engine.name} key={engine.id}>
                        {engine.name}
                      </Select.Item>
                    ))}
                  </Select.ListBox>
                </Select.Popover>
              </Select.Root>

              <Disclosure.Root>
                <Disclosure.Trigger>Advanced privacy controls</Disclosure.Trigger>
                <Disclosure.Panel>
                  <Column gap="m" className="bento-settings__advanced-privacy">
                    {advancedBoolean(
                      'safeBrowsingEnabled',
                      privacy.safeBrowsingEnabled,
                      'Local Safe Browsing checks',
                      'Checks phishing, malware, and download blocklists. Remote download checks stay off in Standard and Enhanced.',
                    )}
                    {advancedBoolean(
                      'resistFingerprinting',
                      privacy.resistFingerprinting,
                      'Resist fingerprinting',
                      'Spoofs browser characteristics. This improves anti-fingerprinting but can break some sites.',
                    )}
                    {advancedBoolean(
                      'letterboxing',
                      privacy.letterboxing,
                      'Letterboxing',
                      'Rounds the content viewport size while resist fingerprinting is active.',
                    )}
                    {advancedBoolean(
                      'networkPrediction',
                      privacy.networkPrediction,
                      'Network prediction',
                      'DNS, TCP, and link prefetching. Faster loads can contact servers before a click.',
                    )}
                    {advancedBoolean(
                      'peerConnection',
                      privacy.peerConnection,
                      'WebRTC peer connections',
                      'Required for video calls and some real-time apps. Turning this off blocks that surface.',
                    )}
                    <Select.Root
                      placeholder="Select WebRTC policy"
                      selectedKey={privacy.webRTCIPHandlingPolicy}
                      onSelectionChange={(key) => {
                        if (typeof key !== 'string') return;
                        dispatch({
                          type: 'privacy/setAdvanced',
                          key: 'webRTCIPHandlingPolicy',
                          value: key,
                        });
                      }}
                    >
                      <Select.Label>WebRTC IP handling</Select.Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Icon />
                      </Select.Trigger>
                      <Select.Popover>
                        <Select.ListBox>
                          <Select.Item id="default" textValue="Default">
                            Default
                          </Select.Item>
                          <Select.Item
                            id="disable_non_proxied_udp"
                            textValue="Disable non-proxied UDP"
                          >
                            Disable non-proxied UDP
                          </Select.Item>
                        </Select.ListBox>
                      </Select.Popover>
                    </Select.Root>
                    <Select.Root
                      placeholder="Select HTTPS-only mode"
                      selectedKey={privacy.httpsOnlyMode}
                      onSelectionChange={(key) => {
                        if (typeof key !== 'string') return;
                        dispatch({ type: 'privacy/setAdvanced', key: 'httpsOnlyMode', value: key });
                      }}
                    >
                      <Select.Label>HTTPS-only mode</Select.Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Icon />
                      </Select.Trigger>
                      <Select.Popover>
                        <Select.ListBox>
                          <Select.Item id="never" textValue="Off">
                            Off
                          </Select.Item>
                          <Select.Item id="always" textValue="All windows">
                            All windows
                          </Select.Item>
                        </Select.ListBox>
                      </Select.Popover>
                    </Select.Root>
                    {advancedBoolean(
                      'drmEnabled',
                      privacy.drmEnabled,
                      'DRM protected content',
                      'Allows Widevine-protected streaming sites to play.',
                    )}
                    {advancedBoolean(
                      'diskCacheEnabled',
                      privacy.diskCacheEnabled,
                      'Disk cache',
                      'Stores cached page resources on disk for faster repeat loads.',
                    )}
                    {advancedBoolean(
                      'webglEnabled',
                      privacy.webglEnabled,
                      'WebGL',
                      'Required by many maps, games, design tools, and 3D demos.',
                    )}
                    {advancedBoolean(
                      'webgpuEnabled',
                      privacy.webgpuEnabled,
                      'WebGPU',
                      'Newer graphics and compute API used by some advanced web apps.',
                    )}
                    {advancedBoolean(
                      'passwordSavingEnabled',
                      privacy.passwordSavingEnabled,
                      'Password saving',
                      'Allows Firefox password manager prompts and saved logins.',
                    )}
                    {advancedBoolean(
                      'formHistoryEnabled',
                      privacy.formHistoryEnabled,
                      'Form history',
                      'Stores non-password form entries for autocomplete.',
                    )}
                    {advancedBoolean(
                      'sanitizeOnShutdown',
                      privacy.sanitizeOnShutdown,
                      'Clear cookies and cache on shutdown',
                      'Clears cookies, offline site data, and cache when Bento closes.',
                    )}
                  </Column>
                </Disclosure.Panel>
              </Disclosure.Root>
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

      <BackupSection />

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
