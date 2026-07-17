// Layer-3 feature: Settings.
//
// User-configurable Bento settings. Reads/writes the SettingsStore in
// bento-tools via the dispatch bus. Tale UI primitives (Card, Switch,
// NumberField, TextField, Button) compose into responsive bento-style groups.
//
// The Privacy section is the three controls Firefox does NOT expose in
// about:preferences UI (resist fingerprinting, network prediction,
// WebRTC peer connection). Tracking protection, clear-browsing-data,
// and the full prefs inventory live in Firefox's own about:preferences
// — Bento doesn't duplicate them. See plans/bento-browser-features.md
// and the repo README for the complete list of shipped privacy defaults.

import { type DragEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Card } from '@tale-ui/react/card';
import { Switch } from '@tale-ui/react/switch';
import { NumberField } from '@tale-ui/react/number-field';
import { TextField } from '@tale-ui/react/text-field';
import { Select } from '@tale-ui/react/select';
import { Disclosure } from '@tale-ui/react/disclosure';
import { Slider } from '@tale-ui/react/slider';
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
import GripVertical from 'lucide-react/dist/esm/icons/grip-vertical';

import type {
  PrivacyAdvancedKey,
  PrivacyProtectionLevel,
  SearchEngineId,
  SelectablePrivacyProtectionLevel,
  SidebarShortcutBehavior,
} from '@shared/protocol';
import { PRIVACY_LEVELS, PRIVACY_LEVEL_DETAILS, privacyLevelLabel } from '@shared/privacy-levels';
import { useSettingsStore } from '../../state/settings';
import { usePrivacyStore } from '../../state/privacy';
import { dispatch, initToolsPort } from '../../bridge/useToolsPort';
import { ShortcutsDialog } from './ShortcutsDialog';
import { BackupSection } from './BackupSection';
import './Settings.css';

const EMPTY_CUSTOM_PANEL_SIZES: number[] = [];
const PANEL_CORNER_RADIUS_MIN = 0;
const PANEL_CORNER_RADIUS_MAX = 36;
const PANEL_SPLITTER_SIZE_MIN = 6;
const PANEL_SPLITTER_SIZE_MAX = 36;

interface CustomSizeFlipSnapshot {
  rects: Map<string, DOMRect>;
  expectedKeys: string[];
}

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

function isSidebarShortcutBehavior(value: unknown): value is SidebarShortcutBehavior {
  return value === 'collapse' || value === 'hide';
}

function customSizeKey(sizes: number[], index: number): string {
  const px = sizes[index];
  let occurrence = 0;
  for (let i = 0; i <= index; i++) {
    if (sizes[i] === px) occurrence++;
  }
  return `${px}:${occurrence}`;
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function moveSizeToFilteredSlot(sizes: number[], fromIndex: number, slot: number): number[] | null {
  if (fromIndex < 0 || fromIndex >= sizes.length) return null;
  const next = [...sizes];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return null;
  if (slot < 0 || slot > next.length) return null;
  if (slot === fromIndex) return null;
  next.splice(slot, 0, moved);
  return next;
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
  const [customSizeDragIndex, setCustomSizeDragIndex] = useState<number | null>(null);
  const [customSizeDropTarget, setCustomSizeDropTarget] = useState<{
    slot: number;
    top: number;
  } | null>(null);
  const customSizeListRef = useRef<HTMLDivElement | null>(null);
  const customSizeFlipSnapshotRef = useRef<CustomSizeFlipSnapshot | null>(null);
  const customPanelSizes = settings?.customPanelSizes ?? EMPTY_CUSTOM_PANEL_SIZES;

  // Request a fresh privacy snapshot on mount. Tools doesn't push
  // privacy/changed deltas (settings rarely change without explicit user
  // action), so the snapshot we get is the current truth at mount time;
  // any toggle we dispatch below triggers a fresh snapshot via tools'
  // .finally() handler.
  useEffect(() => {
    initToolsPort();
    dispatch({ type: 'privacy/requestSnapshot' });
  }, []);

  useLayoutEffect(() => {
    const pending = customSizeFlipSnapshotRef.current;
    if (!pending) return;
    const currentKeys = customPanelSizes.map((_, index) => customSizeKey(customPanelSizes, index));
    if (!sameStringArray(currentKeys, pending.expectedKeys)) return;
    customSizeFlipSnapshotRef.current = null;

    const list = customSizeListRef.current;
    if (!list) return;
    const moved: Array<{ row: HTMLElement; dy: number }> = [];
    for (const row of list.querySelectorAll<HTMLElement>('.bento-settings__custom-size-row')) {
      const key = row.dataset.customSizeKey;
      if (!key) continue;
      const oldRect = pending.rects.get(key);
      if (!oldRect) continue;
      const newRect = row.getBoundingClientRect();
      const dy = oldRect.top - newRect.top;
      if (Math.abs(dy) < 1) continue;
      moved.push({ row, dy });
    }
    if (moved.length === 0) return;
    for (const { row, dy } of moved) {
      row.style.transition = 'none';
      row.style.transform = `translateY(${dy}px)`;
    }
    void list.offsetHeight;
    requestAnimationFrame(() => {
      for (const { row } of moved) {
        row.style.transition = 'transform var(--bento-duration-base) var(--bento-easing-standard)';
        row.style.transform = '';
        const cleanup = (event?: TransitionEvent) => {
          if (event && event.propertyName !== 'transform') return;
          row.style.transition = '';
          row.removeEventListener('transitionend', cleanup);
        };
        row.addEventListener('transitionend', cleanup);
        window.setTimeout(() => cleanup(), 400);
      }
    });
  }, [customPanelSizes]);

  if (!settings) {
    return (
      <Column gap="m" align="center" className="bento-settings bento-settings--loading">
        <Text variant="text" size="m" color="muted">
          Loading settings…
        </Text>
      </Column>
    );
  }

  const clearCustomSizeDrag = () => {
    setCustomSizeDragIndex(null);
    setCustomSizeDropTarget(null);
  };
  const getCustomSizeDropTarget = (list: HTMLDivElement, clientY: number) => {
    if (customSizeDragIndex === null) return;
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('.bento-settings__custom-size-row'),
    ).filter((row) => Number(row.dataset.customSizeIndex) !== customSizeDragIndex);
    if (rows.length === 0) return null;
    let slot = 0;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (clientY > rect.top + rect.height / 2) slot++;
      else break;
    }
    if (slot === customSizeDragIndex) return null;
    const listRect = list.getBoundingClientRect();
    let top: number;
    if (slot <= 0) {
      const first = rows[0];
      if (!first) return null;
      top = first.getBoundingClientRect().top;
    } else if (slot >= rows.length) {
      const last = rows[rows.length - 1];
      if (!last) return null;
      top = last.getBoundingClientRect().bottom;
    } else {
      const previous = rows[slot - 1];
      const next = rows[slot];
      if (!previous || !next) return null;
      const previousRect = previous.getBoundingClientRect();
      const nextRect = next.getBoundingClientRect();
      top = previousRect.bottom + (nextRect.top - previousRect.bottom) / 2;
    }
    top = top - listRect.top + list.scrollTop;
    return { slot, top };
  };
  const onCustomSizeListDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (customSizeDragIndex === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setCustomSizeDropTarget(getCustomSizeDropTarget(event.currentTarget, event.clientY) ?? null);
  };
  const stageCustomSizeFlip = (list: HTMLDivElement, nextSizes: number[]) => {
    const rects = new Map<string, DOMRect>();
    for (const row of list.querySelectorAll<HTMLElement>('.bento-settings__custom-size-row')) {
      const key = row.dataset.customSizeKey;
      if (key) rects.set(key, row.getBoundingClientRect());
    }
    customSizeFlipSnapshotRef.current = {
      rects,
      expectedKeys: nextSizes.map((_, index) => customSizeKey(nextSizes, index)),
    };
  };
  const onCustomSizeListDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const fromIndex = customSizeDragIndex;
    if (fromIndex === null) {
      clearCustomSizeDrag();
      return;
    }
    const target =
      customSizeDropTarget ?? getCustomSizeDropTarget(event.currentTarget, event.clientY);
    const next = target ? moveSizeToFilteredSlot(customPanelSizes, fromIndex, target.slot) : null;
    if (next) {
      stageCustomSizeFlip(event.currentTarget, next);
      update('customPanelSizes', next);
    }
    clearCustomSizeDrag();
  };
  const onCustomSizeListDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setCustomSizeDropTarget(null);
  };

  return (
    <Column gap="l" className="bento-settings">
      <Column gap="xs" className="bento-settings__header">
        <Text variant="heading" size="m" as="h1">
          Settings
        </Text>
        <Text variant="text" size="m" color="muted">
          Configure how Bento behaves. Changes save automatically.
        </Text>
      </Column>

      <div className="bento-settings__grid">
        <div className="bento-settings__stack">
          <Card.Root className="bento-settings__tile bento-settings__tile--performance">
            <Card.Header>
              <Column gap="2xs">
                <Text variant="title" size="m">
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

          <Card.Root className="bento-settings__tile">
            <Card.Header>
              <Column gap="2xs">
                <Text variant="title" size="m">
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
                      Select Standard, Enhanced, or Hardened to apply that preset. Bento shows
                      Custom when live settings differ from every preset.
                    </Text>
                    <ProtectionLevelDetailList current={privacy.protectionLevel} />
                  </Column>

                  <Select.Root
                    placeholder="Select search engine"
                    selectedKey={privacy.defaultSearchEngine}
                    onSelectionChange={(key) => {
                      if (typeof key !== 'string') return;
                      dispatch({
                        type: 'privacy/setDefaultSearchEngine',
                        id: key as SearchEngineId,
                      });
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
                          'Checks locally downloaded phishing, malware, and dangerous-download blocklists without sending download-specific metadata.',
                        )}
                        {advancedBoolean(
                          'remoteSafeBrowsingEnabled',
                          privacy.remoteSafeBrowsingEnabled,
                          'Remote download reputation checks',
                          'Security-first option. For eligible downloads not resolved locally, sends download and redirect URLs, the original referrer when available, file name, size, SHA-256, locale, and signing or certificate metadata to Google Safe Browsing for a verdict.',
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
                            dispatch({
                              type: 'privacy/setAdvanced',
                              key: 'httpsOnlyMode',
                              value: key,
                            });
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
        </div>

        <div className="bento-settings__stack">
          <Card.Root className="bento-settings__tile bento-settings__tile--narrow">
            <Card.Header>
              <Text variant="title" size="m">
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
                  Used when Bento creates the first workspace on a fresh profile. Existing
                  workspaces keep their names.
                </TextField.Description>
              </TextField.Root>
            </Card.Body>
          </Card.Root>

          <Card.Root className="bento-settings__tile bento-settings__tile--narrow">
            <Card.Header>
              <Column gap="2xs">
                <Text variant="title" size="m">
                  Keyboard shortcuts
                </Text>
                <Text variant="text" size="s" color="muted">
                  Searchable reference for Bento hotkeys and standard Firefox tab shortcuts.
                </Text>
              </Column>
            </Card.Header>
            <Card.Body>
              <Column gap="m">
                <Row>
                  <Button variant="neutral" onPress={() => setShortcutsOpen(true)}>
                    <Icon icon={Keyboard} size="sm" />
                    View shortcuts
                  </Button>
                </Row>
                <Select.Root
                  placeholder="Select sidebar shortcut behavior"
                  selectedKey={settings.sidebarShortcutBehavior}
                  onSelectionChange={(key) => {
                    if (!isSidebarShortcutBehavior(key)) return;
                    update('sidebarShortcutBehavior', key);
                  }}
                >
                  <Select.Label>Cmd/Ctrl+S sidebar action</Select.Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Icon />
                  </Select.Trigger>
                  <Select.Popover>
                    <Select.ListBox>
                      <Select.Item id="collapse" textValue="Collapse to narrow rail">
                        Collapse to narrow rail
                      </Select.Item>
                      <Select.Item id="hide" textValue="Hide, reveal on edge hover">
                        Hide, reveal on edge hover
                      </Select.Item>
                    </Select.ListBox>
                  </Select.Popover>
                </Select.Root>
                <Text variant="text" size="s" color="muted">
                  Chooses the minimized sidebar state used by Cmd/Ctrl+S.
                </Text>
              </Column>
            </Card.Body>
          </Card.Root>

          <BackupSection />
        </div>

        <div className="bento-settings__stack">
          <Card.Root className="bento-settings__tile bento-settings__tile--panel">
            <Card.Header>
              <Text variant="title" size="m">
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
                    Width applied to new panels before you drag their splitter. Also used as the
                    minimum main content width in fresh panel layouts. Existing panels keep their
                    stored widths.
                  </NumberField.Description>
                </NumberField.Root>
                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Column gap="3xs" style={{ flex: 1 }}>
                    <Text>Wrap panel shortcut cycling at the ends</Text>
                    <Text variant="text" size="s" color="muted">
                      When on, Cmd/Ctrl+Shift+Right past the Add-panel button cycles back to the
                      main content slot. When off, the Add-panel button is the rightmost stop.
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
                <Column gap="3xs">
                  <Slider.Root
                    value={settings.panelCornerRadiusPx}
                    onChange={(value) => {
                      if (Array.isArray(value)) return;
                      update('panelCornerRadiusPx', Math.round(value));
                    }}
                    minValue={PANEL_CORNER_RADIUS_MIN}
                    maxValue={PANEL_CORNER_RADIUS_MAX}
                    step={1}
                    className="bento-settings__panel-radius-slider"
                  >
                    <Slider.Header>
                      <Slider.Label>Panel roundness</Slider.Label>
                      <Slider.Output />
                    </Slider.Header>
                    <Slider.Control>
                      <Slider.Track>
                        <Slider.Indicator />
                        <Slider.Thumb />
                      </Slider.Track>
                    </Slider.Control>
                  </Slider.Root>
                  <Text variant="text" size="s" color="muted">
                    Changes the rounded corners on Bento panel frames and their focus rings.
                  </Text>
                </Column>
                <Column gap="3xs">
                  <Slider.Root
                    value={settings.panelSplitterSizePx}
                    onChange={(value) => {
                      if (Array.isArray(value)) return;
                      update('panelSplitterSizePx', Math.round(value));
                    }}
                    minValue={PANEL_SPLITTER_SIZE_MIN}
                    maxValue={PANEL_SPLITTER_SIZE_MAX}
                    step={1}
                    className="bento-settings__panel-splitter-slider"
                  >
                    <Slider.Header>
                      <Slider.Label>Panel gaps</Slider.Label>
                      <Slider.Output />
                    </Slider.Header>
                    <Slider.Control>
                      <Slider.Track>
                        <Slider.Indicator />
                        <Slider.Thumb />
                      </Slider.Track>
                    </Slider.Control>
                  </Slider.Root>
                  <Text variant="text" size="s" color="muted">
                    Controls the drag target and visual gap between Bento panels.
                  </Text>
                </Column>
                <Column gap="2xs">
                  <Text>Custom panel sizes (px)</Text>
                  <Text variant="text" size="s" color="muted">
                    Presets shown in each side panel header&rsquo;s kebab menu. Clicking a size
                    resizes only that panel.
                  </Text>
                </Column>
                <Column
                  gap="xs"
                  ref={customSizeListRef}
                  role="list"
                  aria-label="Custom panel sizes"
                  className="bento-settings__custom-size-list"
                  data-dragging={customSizeDragIndex !== null ? 'true' : undefined}
                  onDragOver={onCustomSizeListDragOver}
                  onDrop={onCustomSizeListDrop}
                  onDragLeave={onCustomSizeListDragLeave}
                >
                  {customPanelSizes.map((px, i) => (
                    <Row
                      key={customSizeKey(customPanelSizes, i)}
                      gap="xs"
                      align="end"
                      role="listitem"
                      className="bento-settings__custom-size-row"
                      data-custom-size-index={i}
                      data-custom-size-key={customSizeKey(customPanelSizes, i)}
                      data-dragging={customSizeDragIndex === i ? 'true' : undefined}
                    >
                      <Row
                        align="center"
                        justify="center"
                        draggable
                        title="Drag to reorder"
                        aria-label={`Drag ${px} px custom panel size to reorder`}
                        className="bento-settings__custom-size-grip"
                        onDragStart={(event) => {
                          event.dataTransfer.effectAllowed = 'move';
                          try {
                            event.dataTransfer.setData(
                              'application/x-bento-panel-size-index',
                              String(i),
                            );
                          } catch {
                            // React state carries the source index; the dataTransfer marker is best-effort.
                          }
                          setCustomSizeDragIndex(i);
                          setCustomSizeDropTarget(null);
                        }}
                        onDragEnd={clearCustomSizeDrag}
                      >
                        <Icon icon={GripVertical} size="sm" />
                      </Row>
                      <NumberField.Root
                        value={px}
                        onChange={(v) => {
                          // Skip NaN (occurs when the input is cleared mid-edit)
                          // so we don't persist garbage; the user's next keystroke
                          // will dispatch a valid number.
                          if (!Number.isFinite(v) || v <= 0) return;
                          const next = [...customPanelSizes];
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
                          const next = customPanelSizes.filter((_, j) => j !== i);
                          update('customPanelSizes', next);
                        }}
                      >
                        <Icon icon={Trash2} />
                      </IconButton>
                    </Row>
                  ))}
                  {customSizeDropTarget ? (
                    <div
                      role="presentation"
                      aria-hidden="true"
                      className="bento-settings__custom-size-drop-indicator"
                      style={{ top: customSizeDropTarget.top }}
                    />
                  ) : null}
                  <Row>
                    <Button
                      variant="neutral"
                      size="sm"
                      onPress={() => {
                        const next = [...customPanelSizes, 480];
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
        </div>
      </div>

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
