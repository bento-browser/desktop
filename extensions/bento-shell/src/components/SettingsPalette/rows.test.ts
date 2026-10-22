import { describe, expect, it } from 'vitest';
import {
  FIXTURE_BACKUP,
  FIXTURE_IMPORT_PREVIEW,
  FIXTURE_SETTINGS,
  PRIVATE_MODEL,
  REGULAR_MODEL,
} from '../../state/__fixtures__/settingsPalette';
import {
  advancedRows,
  confirmCopy,
  editorSpecFor,
  filterRows,
  footerFor,
  formatBackupDate,
  isFilterable,
  rootRows,
  rowsForStage,
  searchableRows,
  stageLabel,
  statusRows,
  type PaletteRow,
} from './rows';
import { PANEL_SIZE_LIMITS } from './settingsCatalog';
import type { Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

const labels = (rows: readonly PaletteRow[]) => rows.map((row) => row.label);
const find = (rows: readonly PaletteRow[], id: string) => rows.find((row) => row.id === id)!;

describe('root rows', () => {
  it('lists every group of the mock with the current value of each setting', () => {
    const rows = rootRows(REGULAR_MODEL);
    expect([...new Set(rows.map((row) => row.group))]).toEqual([
      'Appearance',
      'Performance',
      'Workspaces',
      'Panels',
      'Privacy and search',
      'Backup and data',
      'Keyboard shortcuts',
      'Reset Bento',
    ]);
    expect(find(rows, 'setting:uiColorMode').value).toBe('Follow system');
    expect(find(rows, 'setting:tabSleepEnabled').value).toBe('On');
    expect(find(rows, 'setting:tabSleepAfterMinutes').value).toBe('30 min');
    expect(find(rows, 'setting:tabSleepKeepAlivePerWorkspace').value).toBe('3');
    expect(find(rows, 'setting:panelCycleWraparound').value).toBe('Off');
    expect(find(rows, 'setting:customPanelSizes').value).toBe('320, 480, 640, 768, 1280');
    expect(find(rows, 'privacy:level').value).toBe('Standard');
    expect(find(rows, 'privacy:search').value).toBe('DuckDuckGo');
  });

  it('toggles booleans in place and opens a stage for everything else', () => {
    const rows = rootRows(REGULAR_MODEL);
    expect(find(rows, 'setting:tabSleepEnabled').intent).toEqual({
      type: 'toggle',
      key: 'tabSleepEnabled',
    });
    expect(find(rows, 'setting:tabSleepAfterMinutes').intent).toEqual({
      type: 'push',
      stage: { kind: 'number', key: 'tabSleepAfterMinutes' },
    });
    expect(find(rows, 'reset:open').intent).toEqual({
      type: 'push',
      stage: { kind: 'confirm', action: { kind: 'reset' } },
    });
    expect(find(rows, 'reset:open').tone).toBe('danger');
  });

  it('leaves out backup management and the automatic backup preferences in a private window', () => {
    const regular = labels(rootRows(REGULAR_MODEL));
    const priv = labels(rootRows(PRIVATE_MODEL));
    for (const label of [
      'Automatic backups',
      'Backup interval',
      'Backups to retain',
      'Merge browser session',
    ]) {
      expect(regular).toContain(label);
      expect(priv).not.toContain(label);
    }
    expect(priv).not.toContain('Export, import and stored backups');
    expect(rootRows(PRIVATE_MODEL).some((row) => row.group === 'Backup and data')).toBe(false);
    expect(priv).toContain('Protection level');
  });

  it('leaves out the reset in a private window, where tools refuses it', () => {
    expect(rootRows(PRIVATE_MODEL).some((row) => row.id === 'reset:open')).toBe(false);
    expect(searchableRows(PRIVATE_MODEL).some((row) => row.id === 'reset:open')).toBe(false);
    expect(rootRows(REGULAR_MODEL).some((row) => row.id === 'reset:open')).toBe(true);
  });

  it('marks a write in flight on its row', () => {
    const model: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      pending: new Set(['panelShadowsEnabled']),
    };
    expect(find(rootRows(model), 'setting:panelShadowsEnabled').pending).toBe(true);
    expect(find(rootRows(model), 'setting:panelCycleWraparound').pending).toBeFalsy();
  });

  it('shows no privacy rows until privacy and search have loaded', () => {
    expect(
      rootRows({ ...REGULAR_MODEL, privacy: null }).some((row) => row.id.startsWith('privacy:')),
    ).toBe(false);
  });
});

describe('search', () => {
  it('reaches advanced privacy keys and shortcuts from the root', () => {
    const rows = searchableRows(REGULAR_MODEL);
    expect(labels(filterRows(rows, 'fingerprint'))).toContain('Resist fingerprinting');
    expect(labels(filterRows(rows, 'webrtc'))).toEqual(
      expect.arrayContaining(['WebRTC peer connections', 'WebRTC IP handling']),
    );
    const shortcut = filterRows(rows, 'command palette');
    expect(shortcut.map((row) => row.label)).toContain('Open command palette');
    expect(shortcut[0]!.intent).toEqual({ type: 'push', stage: { kind: 'shortcuts' } });
  });

  it('needs every word of the query and matches values, groups and keywords', () => {
    const rows = searchableRows(REGULAR_MODEL);
    expect(labels(filterRows(rows, 'panel shadows'))).toEqual(['Show panel shadows']);
    expect(labels(filterRows(rows, 'duckduckgo'))).toEqual(['Default search engine']);
    expect(labels(filterRows(rows, 'tab sleep'))).toEqual(
      expect.arrayContaining(['Sleep idle tabs', 'Sleep tabs after']),
    );
    expect(filterRows(rows, 'zzzz')).toEqual([]);
    expect(filterRows(rows, '   ')).toHaveLength(rows.length);
  });

  it('does not offer backup rows to a private window', () => {
    expect(labels(filterRows(searchableRows(PRIVATE_MODEL), 'backup'))).toEqual([]);
  });
});

describe('number stages', () => {
  it('lists presets with Min, Default and Max markers and applies the value', () => {
    const rows = rowsForStage({ kind: 'number', key: 'panelCornerRadiusPx' }, REGULAR_MODEL);
    expect(rows.map((row) => `${row.label}${row.note ? ` ${row.note}` : ''}`)).toEqual([
      '0 px Min',
      '8 px',
      '12 px Default',
      '16 px',
      '24 px',
      '36 px Max',
    ]);
    expect(rows[1]!.intent).toEqual({ type: 'applyNumber', value: 8 });
  });

  it('has an editor for numbers, panel size entries and nothing else', () => {
    expect(editorSpecFor({ kind: 'number', key: 'panelCornerRadiusPx' })).toMatchObject({
      min: 0,
      max: 36,
    });
    expect(editorSpecFor({ kind: 'sizeEdit', index: 0 })).toMatchObject({
      min: PANEL_SIZE_LIMITS.min,
      max: PANEL_SIZE_LIMITS.max,
    });
    expect(editorSpecFor({ kind: 'text', key: 'defaultWorkspaceName' })).toBeNull();
    expect(editorSpecFor({ kind: 'sizes' })).toBeNull();
  });
});

describe('choice stages', () => {
  it('marks the current color mode and applies a choice as a settings change', () => {
    const rows = rowsForStage({ kind: 'enum', key: 'uiColorMode' }, REGULAR_MODEL);
    expect(rows.map((row) => [row.label, row.radio])).toEqual([
      ['Light', 'off'],
      ['Dark', 'off'],
      ['Follow system', 'on'],
    ]);
    expect(rows[1]!.intent).toEqual({ type: 'change', changes: { uiColorMode: 'dark' } });
  });

  it('sends the privacy choices as advanced privacy changes', () => {
    const rows = rowsForStage({ kind: 'enum', key: 'httpsOnlyMode' }, REGULAR_MODEL);
    expect(rows.find((row) => row.radio === 'on')?.label).toBe('Always');
    expect(rows[0]!.intent).toEqual({ type: 'advanced', key: 'httpsOnlyMode', value: 'never' });
  });

  it('shows the benefits and caveats of each protection level and a custom level that cannot be chosen', () => {
    const rows = rowsForStage({ kind: 'protection' }, REGULAR_MODEL);
    expect(labels(rows)).toEqual(['Standard', 'Enhanced', 'Hardened', 'Custom']);
    expect(rows[1]!.detail?.benefits.length).toBeGreaterThan(0);
    expect(rows[1]!.detail?.caveats.length).toBeGreaterThan(0);
    expect(rows[1]!.intent).toEqual({ type: 'setProtection', level: 'enhanced' });
    expect(rows[3]).toMatchObject({ info: true, note: 'Detected only', intent: { type: 'none' } });
    const custom: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      privacy: { ...REGULAR_MODEL.privacy!, protectionLevel: 'custom' },
    };
    expect(
      rowsForStage({ kind: 'protection' }, custom).find((row) => row.radio === 'on')?.label,
    ).toBe('Custom');
  });

  it('lists search engines with a way to Firefox search settings', () => {
    const rows = rowsForStage({ kind: 'search' }, REGULAR_MODEL);
    expect(labels(rows)).toEqual([
      'DuckDuckGo',
      'Google',
      'Bing',
      'Wikipedia (en)',
      'Manage search engines',
    ]);
    expect(rows[0]).toMatchObject({ radio: 'on', note: 'Current' });
    expect(rows[1]!.intent).toEqual({ type: 'setSearch', id: 'google' });
    expect(rows.at(-1)).toMatchObject({
      trail: '↗',
      intent: { type: 'link', target: 'firefoxSearch' },
    });
  });
});

describe('custom panel sizes', () => {
  it('lists the sizes with an add row, and stops adding at the limit', () => {
    const rows = rowsForStage({ kind: 'sizes' }, REGULAR_MODEL);
    expect(labels(rows)).toEqual(['320 px', '480 px', '640 px', '768 px', '1280 px', 'Add size']);
    expect(rows.at(-1)).toMatchObject({ value: '640 px', trail: '+', intent: { type: 'addSize' } });
    const full: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      settings: { ...FIXTURE_SETTINGS, customPanelSizes: Array.from({ length: 64 }, () => 320) },
    };
    expect(rowsForStage({ kind: 'sizes' }, full).at(-1)).toMatchObject({
      value: 'Limit reached',
      info: true,
      intent: { type: 'none' },
    });
  });

  it('offers only the moves that exist', () => {
    expect(labels(rowsForStage({ kind: 'sizeActions', index: 0 }, REGULAR_MODEL))).toEqual([
      'Edit size',
      'Move down',
      'Remove',
    ]);
    expect(labels(rowsForStage({ kind: 'sizeActions', index: 4 }, REGULAR_MODEL))).toEqual([
      'Edit size',
      'Move up',
      'Remove',
    ]);
    const middle = rowsForStage({ kind: 'sizeActions', index: 2 }, REGULAR_MODEL);
    expect(labels(middle)).toEqual(['Edit size', 'Move up', 'Move down', 'Remove']);
    expect(middle[1]).toMatchObject({
      value: 'To position 2',
      intent: { type: 'moveSize', index: 2, delta: -1 },
    });
    expect(middle[2]!.value).toBe('To position 4');
    expect(middle[3]).toMatchObject({ tone: 'danger', intent: { type: 'removeSize', index: 2 } });
  });
});

describe('advanced privacy and shortcuts', () => {
  it('lists the 15 keys in the mock order; two open a choice and the rest toggle', () => {
    const rows = advancedRows(REGULAR_MODEL);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toMatchObject({ label: 'Local Safe Browsing', value: 'On', switchOn: true });
    expect(find(rows, 'advanced:remoteSafeBrowsingEnabled')).toMatchObject({
      value: 'Off',
      intent: { type: 'toggleAdvanced', key: 'remoteSafeBrowsingEnabled', current: false },
    });
    expect(find(rows, 'advanced:webRTCIPHandlingPolicy')).toMatchObject({
      value: 'Default',
      trail: '›',
      intent: { type: 'push', stage: { kind: 'enum', key: 'webRTCIPHandlingPolicy' } },
    });
    expect(find(rows, 'advanced:httpsOnlyMode').value).toBe('Always');
  });

  it('lists the shortcuts read-only with the corrected command palette keys', () => {
    const rows = rowsForStage({ kind: 'shortcuts' }, REGULAR_MODEL);
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => row.info)).toBe(true);
    expect(rows.find((row) => row.label === 'Open command palette')?.value).toBe(
      'Cmd/Ctrl + Alt + P',
    );
  });
});

describe('backups', () => {
  it('offers export, import and merge, then the stored backups with a legacy marker', () => {
    const rows = rowsForStage({ kind: 'backups' }, REGULAR_MODEL);
    expect(labels(rows).slice(0, 3)).toEqual([
      'Export Bento data',
      'Import Bento data',
      'Merge browser session',
    ]);
    expect(find(rows, 'backup:export').value).toBe('4 workspaces');
    expect(find(rows, 'backup:merge')).toMatchObject({
      trail: '↗',
      intent: { type: 'link', target: 'mergePalette' },
    });
    const stored = rows.filter((row) => row.id.startsWith('stored:'));
    expect(stored.filter((row) => !row.info)).toHaveLength(FIXTURE_BACKUP.backups.length);
    const warning = stored.filter((row) => row.tone === 'warning');
    expect(warning).toHaveLength(1);
    expect(warning[0]!.label).toBe(
      'This backup predates private-data filtering. Its privacy safety is unknown.',
    );
  });

  it('shows the import preview with Import and Cancel instead of the export rows', () => {
    const model: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      importPreview: { fileName: 'b.json', validationToken: 't', preview: FIXTURE_IMPORT_PREVIEW },
    };
    const rows = rowsForStage({ kind: 'backups' }, model);
    expect(find(rows, 'import:file').value).toBe('b.json');
    expect(find(rows, 'import:confirm').label).toBe('Import 4 workspaces and 37 tabs');
    expect(find(rows, 'import:confirm').intent).toEqual({ type: 'confirmImport' });
    expect(find(rows, 'import:cancel').intent).toEqual({ type: 'cancelImport' });
    expect(rows.some((row) => row.id === 'backup:export')).toBe(false);
  });

  it('says so when nothing is stored', () => {
    const model: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      backup: { ...FIXTURE_BACKUP, backups: [] },
    };
    expect(find(rowsForStage({ kind: 'backups' }, model), 'stored:empty')).toMatchObject({
      info: true,
    });
  });

  it('opens restore and delete from a stored backup, each behind a confirmation', () => {
    const rows = rowsForStage({ kind: 'backupRow', backupId: 'b1', label: 'L' }, REGULAR_MODEL);
    expect(labels(rows)).toEqual(['Restore…', 'Delete…']);
    // Neither row runs anything: each opens the confirm stage, whose last row runs it.
    expect(rows[0]!.intent).toEqual({
      type: 'push',
      stage: { kind: 'confirm', action: { kind: 'restore', backupId: 'b1', label: 'L' } },
    });
    expect(rows[1]).toMatchObject({
      tone: 'danger',
      intent: {
        type: 'push',
        stage: { kind: 'confirm', action: { kind: 'delete', backupId: 'b1', label: 'L' } },
      },
    });
  });

  it('formats a backup date like the mock, in 24-hour local time', () => {
    expect(formatBackupDate(new Date(2026, 9, 22, 14, 30).getTime())).toBe('22 Oct 2026, 14:30');
    expect(formatBackupDate(new Date(2026, 8, 2, 0, 5).getTime())).toBe('02 Sep 2026, 00:05');
  });
});

describe('confirmations', () => {
  it('asks the reset question with Cancel first and the danger action last', () => {
    const rows = rowsForStage({ kind: 'confirm', action: { kind: 'reset' } }, REGULAR_MODEL);
    expect(labels(rows)).toEqual([
      'This restores Bento settings, privacy protection, and search to their defaults.',
      'Onboarding opens again from Welcome.',
      'Cancel',
      'Reset Bento settings',
    ]);
    expect(rows[2]!.intent).toEqual({ type: 'back' });
    expect(rows[3]).toMatchObject({
      tone: 'danger',
      intent: { type: 'confirm', action: { kind: 'reset' } },
    });
  });

  it('marks the confirm row pending while the operation runs', () => {
    const model: SettingsPaletteModel = { ...REGULAR_MODEL, pending: new Set(['reset']) };
    expect(
      rowsForStage({ kind: 'confirm', action: { kind: 'reset' } }, model).at(-1)!.pending,
    ).toBe(true);
  });

  it('words restore as non-destructive and delete as destructive', () => {
    expect(confirmCopy({ kind: 'restore', backupId: 'b', label: 'L' }).danger).toBe(false);
    expect(confirmCopy({ kind: 'delete', backupId: 'b', label: 'L' }).danger).toBe(true);
  });
});

describe('stage chrome', () => {
  it('labels every stage and filters only the lists that can be searched', () => {
    expect(stageLabel({ kind: 'sizeActions', index: 2 }, REGULAR_MODEL)).toBe('640 px');
    expect(
      stageLabel({ kind: 'backupRow', backupId: 'b', label: '22 Oct 2026, 14:30' }, REGULAR_MODEL),
    ).toBe('22 Oct 2026, 14:30');
    expect(isFilterable({ kind: 'root' })).toBe(true);
    expect(isFilterable({ kind: 'number', key: 'panelCornerRadiusPx' })).toBe(false);
    expect(isFilterable({ kind: 'protection' })).toBe(false);
  });

  it('puts the private window line in the root footer, and no backup count', () => {
    expect(footerFor({ kind: 'root' }, PRIVATE_MODEL, 20).note).toBe(
      'Backup management is unavailable in private windows.',
    );
    expect(footerFor({ kind: 'root' }, REGULAR_MODEL, 23)).toMatchObject({
      note: undefined,
      status: '23 settings',
    });
  });

  it('describes the editor footers as in the mock', () => {
    expect(footerFor({ kind: 'number', key: 'panelCornerRadiusPx' }, REGULAR_MODEL, 6)).toEqual({
      hints: ['Type a value', '↑↓ presets', 'Enter keep', 'Esc cancel'],
      status: 'Live preview',
    });
    expect(footerFor({ kind: 'sizes' }, REGULAR_MODEL, 6).status).toBe('5 of 64 sizes');
    expect(footerFor({ kind: 'sizeActions', index: 2 }, REGULAR_MODEL, 4).status).toBe(
      'Size 3 of 5',
    );
  });

  it('tells Backups that Esc cancels a waiting import before it goes back', () => {
    const waiting: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      importPreview: { fileName: 'b.json', validationToken: 't', preview: FIXTURE_IMPORT_PREVIEW },
    };
    expect(footerFor({ kind: 'backups' }, REGULAR_MODEL, 4).hints.at(-1)).toBe('Esc back');
    expect(footerFor({ kind: 'backups' }, waiting, 4).hints.at(-1)).toBe('Esc cancel import');
  });

  it('says what Esc does in the state the palette is in', () => {
    const esc = (stage: Stage, query = '', model = REGULAR_MODEL) =>
      footerFor(stage, model, 4, query).hints.at(-1);
    expect(esc({ kind: 'root' })).toBe('Esc close');
    expect(esc({ kind: 'root' }, 'radius')).toBe('Esc clear');
    expect(esc({ kind: 'advanced' })).toBe('Esc back');
    expect(esc({ kind: 'advanced' }, 'web')).toBe('Esc clear');
    expect(esc({ kind: 'number', key: 'panelCornerRadiusPx' })).toBe('Esc cancel');
    expect(esc({ kind: 'text', key: 'defaultWorkspaceName' })).toBe('Esc cancel');
    expect(esc({ kind: 'sizeEdit', index: 0 })).toBe('Esc cancel');
  });

  it('offers no arrows on the static shortcuts list', () => {
    expect(footerFor({ kind: 'shortcuts' }, REGULAR_MODEL, 8).hints).toEqual(['Esc back']);
  });

  it('shows the target state on a switch while its write is in flight', () => {
    const off = rootRows(REGULAR_MODEL).find((row) => row.id === 'setting:panelShadowsEnabled');
    const stored = REGULAR_MODEL.settings.panelShadowsEnabled;
    expect(off).toMatchObject({ switchOn: stored, pending: false });
    const writing: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      pending: new Set(['panelShadowsEnabled']),
    };
    const during = rootRows(writing).find((row) => row.id === 'setting:panelShadowsEnabled');
    expect(during).toMatchObject({ switchOn: !stored, pending: true });
    // The row keeps the stored On or Off as its text value, and only toggle rows carry a switch.
    expect(during?.value).toBe(stored ? 'On' : 'Off');
    expect(
      rootRows(REGULAR_MODEL).find((row) => row.id === 'setting:panelCornerRadiusPx'),
    ).not.toHaveProperty('switchOn');
  });

  it('shows only a retry while the snapshot is missing', () => {
    expect(statusRows({ kind: 'loading' })).toHaveLength(1);
    const failed = statusRows({ kind: 'error', message: 'No answer' });
    expect(failed.map((row) => row.label)).toEqual(['No answer', 'Try again']);
    expect(failed[1]!.intent).toEqual({ type: 'retry' });
  });
});
