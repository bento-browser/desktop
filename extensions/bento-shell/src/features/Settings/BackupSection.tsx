import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@tale-ui/react/card';
import { Switch } from '@tale-ui/react/switch';
import { NumberField } from '@tale-ui/react/number-field';
import { Button } from '@tale-ui/react/button';
import { IconButton } from '@tale-ui/react/icon-button';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { Icon } from '@tale-ui/react/icon';
import Download from 'lucide-react/dist/esm/icons/download';
import Upload from 'lucide-react/dist/esm/icons/upload';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw';

import type { BentoExportSchema, ImportSummary } from '@shared/protocol';
import { useSettingsStore } from '../../state/settings';
import { useWorkspacesStore } from '../../state/workspaces';
import { useBackupStore } from '../../state/backup';
import { dispatch } from '../../bridge/useToolsPort';
import { validateExportSchema } from './validateExport';
import './BackupSection.css';

function update<K extends keyof import('@shared/protocol').BentoSettings>(
  key: K,
  value: import('@shared/protocol').BentoSettings[K],
) {
  dispatch({ type: 'settings/update', changes: { [key]: value } });
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ImportPreview {
  data: BentoExportSchema;
  workspaceCount: number;
  tabCount: number;
  panelCount: number;
  hasSettings: boolean;
  hasSavedPanels: boolean;
}

function parseImportFile(json: string): ImportPreview | null {
  try {
    const raw = JSON.parse(json);
    const data = validateExportSchema(raw);
    if (!data) return null;
    return {
      data,
      workspaceCount: data.workspaces.length,
      tabCount: data.workspaces.reduce((s, w) => s + w.tabs.length, 0),
      panelCount: data.workspaces.reduce((s, w) => s + w.panels.length, 0),
      hasSettings: data.settings !== undefined && Object.keys(data.settings).length > 0,
      hasSavedPanels: data.savedPanels.length > 0,
    };
  } catch {
    return null;
  }
}

export function BackupSection() {
  const settings = useSettingsStore((s) => s.current);
  const orderedIds = useWorkspacesStore((s) => s.orderedIds);
  const byId = useWorkspacesStore((s) => s.byId);
  const workspaces = orderedIds
    .map((id) => byId[id])
    .filter((w): w is NonNullable<typeof w> => w != null);
  const backups = useBackupStore((s) => s.backups);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [exportSelection, setExportSelection] = useState<Set<string>>(new Set());
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importSettings, setImportSettings] = useState(false);
  const [importSavedPanels, setImportSavedPanels] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const [parseError, setParseError] = useState(false);

  useEffect(() => {
    dispatch({ type: 'backup/requestList' });
  }, []);

  useEffect(() => {
    function onExportReady(e: Event) {
      const { json, filename } = (e as CustomEvent<{ json: string; filename: string }>).detail;
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
    function onComplete(e: Event) {
      const summary = (e as CustomEvent<ImportSummary>).detail;
      setImportStatus(
        `Imported ${summary.workspacesCreated} workspace${summary.workspacesCreated !== 1 ? 's' : ''}, ` +
          `${summary.tabsOpened} tab${summary.tabsOpened !== 1 ? 's' : ''}, ` +
          `${summary.panelsRestored} panel${summary.panelsRestored !== 1 ? 's' : ''}` +
          `${summary.settingsApplied ? ', settings applied' : ''}.`,
      );
      setImportPreview(null);
      dispatch({ type: 'backup/requestList' });
    }
    function onError(e: Event) {
      setImportStatus(`Import failed: ${(e as CustomEvent<string>).detail}`);
      setImportPreview(null);
    }
    window.addEventListener('bento-export-ready', onExportReady);
    window.addEventListener('bento-import-complete', onComplete);
    window.addEventListener('bento-import-error', onError);
    return () => {
      window.removeEventListener('bento-export-ready', onExportReady);
      window.removeEventListener('bento-import-complete', onComplete);
      window.removeEventListener('bento-import-error', onError);
    };
  }, []);

  const handleExportAll = useCallback(() => {
    dispatch({ type: 'backup/export' });
  }, []);

  const handleExportSelected = useCallback(() => {
    if (exportSelection.size === 0) return;
    dispatch({ type: 'backup/export', workspaceIds: Array.from(exportSelection) });
  }, [exportSelection]);

  const toggleExportWorkspace = useCallback((id: string) => {
    setExportSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleFileSelect = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParseError(false);
    setImportStatus(null);
    const reader = new FileReader();
    reader.onload = () => {
      const preview = parseImportFile(reader.result as string);
      if (preview) {
        setImportPreview(preview);
        setImportSettings(false);
        setImportSavedPanels(false);
        setReplaceExisting(false);
      } else {
        setParseError(true);
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  const handleImportConfirm = useCallback(() => {
    if (!importPreview) return;
    setImportStatus(null);
    dispatch({
      type: 'backup/import',
      data: importPreview.data,
      options: { importSettings, importSavedPanels, replaceExisting },
    });
  }, [importPreview, importSettings, importSavedPanels, replaceExisting]);

  if (!settings) return null;

  return (
    <Card.Root>
      <Card.Header>
        <Column gap="2xs">
          <Text variant="heading" size="m">
            Backup &amp; export
          </Text>
          <Text variant="text" size="s" color="muted">
            Export workspaces to a JSON file or restore from automatic backups. The exported file
            contains your tab URLs, titles, panel layout, and settings.
          </Text>
        </Column>
      </Card.Header>
      <Card.Body>
        <Column gap="l">
          <Column gap="s">
            <Text variant="label" size="m">
              Export
            </Text>
            <Row gap="s">
              <Button variant="neutral" onPress={handleExportAll}>
                <Icon icon={Download} size="sm" />
                Export all workspaces
              </Button>
            </Row>
            {workspaces.length > 1 && (
              <Column gap="xs" className="bento-backup__ws-select">
                <Text variant="text" size="s" color="muted">
                  Or select specific workspaces:
                </Text>
                {workspaces.map((ws) => (
                  <Row
                    key={ws.id}
                    gap="s"
                    align="center"
                    style={{ justifyContent: 'space-between' }}
                  >
                    <Text variant="text" size="s">
                      {ws.icon ? `${ws.icon} ${ws.name}` : ws.name}
                    </Text>
                    <Switch.Root
                      isSelected={exportSelection.has(ws.id)}
                      onChange={() => toggleExportWorkspace(ws.id)}
                      aria-label={`Include ${ws.name}`}
                    >
                      <Switch.Thumb />
                    </Switch.Root>
                  </Row>
                ))}
                <Row>
                  <Button
                    variant="neutral"
                    size="sm"
                    isDisabled={exportSelection.size === 0}
                    onPress={handleExportSelected}
                  >
                    <Icon icon={Download} size="sm" />
                    Export selected ({exportSelection.size})
                  </Button>
                </Row>
              </Column>
            )}
          </Column>

          <Column gap="s">
            <Text variant="label" size="m">
              Import
            </Text>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
            <Row gap="s">
              <Button variant="neutral" onPress={handleFileSelect}>
                <Icon icon={Upload} size="sm" />
                Import from file
              </Button>
            </Row>
            {parseError && (
              <Text variant="text" size="s" color="muted">
                Invalid file. Expected a Bento export JSON file.
              </Text>
            )}
            {importPreview && (
              <Column gap="s" className="bento-backup__preview">
                <Text variant="text" size="s">
                  {importPreview.workspaceCount} workspace
                  {importPreview.workspaceCount !== 1 ? 's' : ''}, {importPreview.tabCount} tab
                  {importPreview.tabCount !== 1 ? 's' : ''}, {importPreview.panelCount} panel
                  {importPreview.panelCount !== 1 ? 's' : ''}
                </Text>
                <Column gap="3xs">
                  {importPreview.data.workspaces.map((ws) => (
                    <Text key={ws.id} variant="text" size="s" color="muted">
                      {ws.icon ? `${ws.icon} ` : ''}
                      {ws.name} — {ws.tabs.length} tab
                      {ws.tabs.length !== 1 ? 's' : ''}, {ws.panels.length} panel
                      {ws.panels.length !== 1 ? 's' : ''}
                    </Text>
                  ))}
                </Column>
                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Column gap="3xs" style={{ flex: 1 }}>
                    <Text variant="text" size="s">
                      Replace all existing workspaces
                    </Text>
                    <Text variant="text" size="s" color="muted">
                      Imports the backup first, then removes current workspaces and tabs.
                    </Text>
                  </Column>
                  <Switch.Root isSelected={replaceExisting} onChange={setReplaceExisting}>
                    <Switch.Thumb />
                  </Switch.Root>
                </Row>
                {importPreview.hasSettings && (
                  <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text variant="text" size="s">
                      Apply settings from export
                    </Text>
                    <Switch.Root isSelected={importSettings} onChange={setImportSettings}>
                      <Switch.Thumb />
                    </Switch.Root>
                  </Row>
                )}
                {importPreview.hasSavedPanels && (
                  <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text variant="text" size="s">
                      Import saved panels ({importPreview.data.savedPanels.length})
                    </Text>
                    <Switch.Root isSelected={importSavedPanels} onChange={setImportSavedPanels}>
                      <Switch.Thumb />
                    </Switch.Root>
                  </Row>
                )}
                <Row gap="s">
                  <Button variant="primary" size="sm" onPress={handleImportConfirm}>
                    Import
                  </Button>
                  <Button variant="neutral" size="sm" onPress={() => setImportPreview(null)}>
                    Cancel
                  </Button>
                </Row>
              </Column>
            )}
            {importStatus && (
              <Text variant="text" size="s" color="muted">
                {importStatus}
              </Text>
            )}
          </Column>

          <Column gap="s">
            <Text variant="label" size="m">
              Automatic backups
            </Text>
            <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <Column gap="3xs" style={{ flex: 1 }}>
                <Text>Backup workspaces automatically</Text>
                <Text variant="text" size="s" color="muted">
                  Periodic snapshots stored in the browser profile. Restored as new workspaces.
                </Text>
              </Column>
              <Switch.Root
                isSelected={settings.autoBackupEnabled}
                onChange={(v) => update('autoBackupEnabled', v)}
                aria-label="Automatic backups"
              >
                <Switch.Thumb />
              </Switch.Root>
            </Row>
            <Row gap="m">
              <NumberField.Root
                value={settings.autoBackupIntervalMinutes}
                onChange={(v) => {
                  if (!Number.isFinite(v) || v < 5) return;
                  update('autoBackupIntervalMinutes', Math.round(v));
                }}
                minValue={5}
                maxValue={1440}
                step={5}
                formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
                isDisabled={!settings.autoBackupEnabled}
                className="bento-settings__number-field"
              >
                <NumberField.Label>Interval (minutes)</NumberField.Label>
                <NumberField.Group>
                  <NumberField.Decrement />
                  <NumberField.Input />
                  <NumberField.Increment />
                </NumberField.Group>
              </NumberField.Root>
              <NumberField.Root
                value={settings.autoBackupMaxCount}
                onChange={(v) => {
                  if (!Number.isFinite(v) || v < 1) return;
                  update('autoBackupMaxCount', Math.round(v));
                }}
                minValue={1}
                maxValue={20}
                step={1}
                formatOptions={{ useGrouping: false, maximumFractionDigits: 0 }}
                isDisabled={!settings.autoBackupEnabled}
                className="bento-settings__number-field"
              >
                <NumberField.Label>Keep (max)</NumberField.Label>
                <NumberField.Group>
                  <NumberField.Decrement />
                  <NumberField.Input />
                  <NumberField.Increment />
                </NumberField.Group>
              </NumberField.Root>
            </Row>
          </Column>

          {backups.length > 0 && (
            <Column gap="s">
              <Text variant="label" size="m">
                Stored backups
              </Text>
              <Column gap="xs">
                {backups.map((b) => (
                  <Row
                    key={b.id}
                    gap="s"
                    align="center"
                    style={{ justifyContent: 'space-between' }}
                    className="bento-backup__entry"
                  >
                    <Column gap="3xs" style={{ flex: 1, minWidth: 0 }}>
                      <Text variant="text" size="s">
                        {formatDate(b.createdAt)}
                      </Text>
                      <Text variant="text" size="s" color="muted">
                        {b.workspaceCount} workspace{b.workspaceCount !== 1 ? 's' : ''},{' '}
                        {b.tabCount} tab{b.tabCount !== 1 ? 's' : ''}
                      </Text>
                    </Column>
                    <Row gap="xs">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Restore backup"
                        onPress={() => dispatch({ type: 'backup/restore', backupId: b.id })}
                      >
                        <Icon icon={RotateCcw} size="sm" />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Delete backup"
                        onPress={() => dispatch({ type: 'backup/delete', backupId: b.id })}
                      >
                        <Icon icon={Trash2} size="sm" />
                      </IconButton>
                    </Row>
                  </Row>
                ))}
              </Column>
            </Column>
          )}
        </Column>
      </Card.Body>
    </Card.Root>
  );
}
