// Layer-3 feature: Settings.
//
// User-configurable Bento settings. Reads/writes the SettingsStore in
// bento-tools via the dispatch bus. Tale UI primitives (Card, Switch,
// NumberField, TextField, Button) compose into a single-column form.
//
// The Privacy access point is a Button that opens privacy.html in the same
// origin (no chrome touchpoint needed; it's just a moz-extension URL).

import { Card } from '@tale-ui/react/card';
import { Switch } from '@tale-ui/react/switch';
import { NumberField } from '@tale-ui/react/number-field';
import { TextField } from '@tale-ui/react/text-field';
import { Button } from '@tale-ui/react/button';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { Icon } from '@tale-ui/react/icon';
import ExternalLink from 'lucide-react/dist/esm/icons/external-link';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';
import Download from 'lucide-react/dist/esm/icons/download';

import { useSettingsStore } from '../../state/settings';
import { dispatch } from '../../bridge/useToolsPort';
import './Settings.css';

function update<K extends keyof import('@shared/protocol').BentoSettings>(
  key: K,
  value: import('@shared/protocol').BentoSettings[K],
) {
  dispatch({ type: 'settings/update', changes: { [key]: value } });
}

function openPrivacyDashboard() {
  // Same origin (moz-extension://<uuid>/dist/privacy.html). Resolving
  // relative to the current page works because Settings + Privacy live
  // under the same dist/ directory.
  window.open('./privacy.html', '_blank');
}

function openMigrationWizard() {
  // Round-trip through bento-tools so the chrome process can call
  // MigrationUtils.showMigrationWizard. The Settings page shares the
  // bento-shell-bus with the sidebar; the sidebar (sole owner of
  // chrome-IPC via document.title) translates this into the
  // BENTO_OPEN_MIGRATION_<ts> sentinel that the chrome script polls
  // for. See protocol.ts → 'chrome/openMigrationWizard'.
  dispatch({ type: 'chrome/openMigrationWizard' });
}

export function Settings() {
  const settings = useSettingsStore((s) => s.current);

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
              step={5}
              isDisabled={!settings.tabSleepEnabled}
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
              isDisabled={!settings.tabSleepEnabled}
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
          <Column gap="2xs">
            <Text variant="heading" size="m">
              Import data
            </Text>
            <Text variant="text" size="s" color="muted">
              Bring your bookmarks, history, saved passwords, and form data over from another
              browser. Bento uses Firefox&rsquo;s built-in migration wizard, which supports Chrome,
              Edge, Safari, Brave, and other Firefox profiles.
            </Text>
          </Column>
        </Card.Header>
        <Card.Body>
          <Button variant="neutral" onPress={openMigrationWizard}>
            <Icon icon={Download} size="sm" />
            Import data from another browser
          </Button>
        </Card.Body>
      </Card.Root>

      <Card.Root>
        <Card.Header>
          <Column gap="2xs">
            <Text variant="heading" size="m">
              Privacy
            </Text>
            <Text variant="text" size="s" color="muted">
              Bento ships with telemetry, sponsored content, and Mozilla service promos disabled.
              View the full list of preferences and their shipped values.
            </Text>
          </Column>
        </Card.Header>
        <Card.Body>
          <Button variant="neutral" onPress={openPrivacyDashboard}>
            Open Privacy Dashboard
            <Icon icon={ExternalLink} size="sm" />
          </Button>
        </Card.Body>
      </Card.Root>

      <Row gap="s" align="center" className="bento-settings__footer">
        <Button variant="ghost" onPress={() => dispatch({ type: 'settings/reset' })}>
          <Icon icon={RotateCcw} size="sm" />
          Reset to defaults
        </Button>
      </Row>
    </Column>
  );
}
