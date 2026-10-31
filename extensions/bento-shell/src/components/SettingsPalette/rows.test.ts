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
  pageDescription,
  controlRows,
  rowAriaLabel,
  rowsForStage,
  searchableRows,
  showsFieldRow,
  sliderSpecFor,
  stageLabel,
  statusRows,
  type PaletteRow,
} from './rows';
import { PRIVACY_LEVEL_DETAILS } from '@shared/privacy-levels';
import { ENUM_SPECS, NUMBER_SPECS, PANEL_SIZE_LIMITS, type EnumKey } from './settingsCatalog';
import { ENUM_DESCRIPTIONS, ENUM_OPTION_DESCRIPTIONS, NUMBER_DESCRIPTIONS } from './settingsCopy';
import type { Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

const labels = (rows: readonly PaletteRow[]) => rows.map((row) => row.label);
const find = (rows: readonly PaletteRow[], id: string) => rows.find((row) => row.id === id)!;

describe('control rows', () => {
  it('lists every group of the mock with the current value of each setting', () => {
    const rows = controlRows(REGULAR_MODEL);
    expect([...new Set(rows.map((row) => row.group))]).toEqual([
      'Appearance',
      'Tab appearance',
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

  it('lists the independent tab appearance switches with their saved values', () => {
    const rows = controlRows({
      ...REGULAR_MODEL,
      settings: { ...FIXTURE_SETTINGS, tabStateTintsEnabled: false },
    });
    const appearance = rows.filter((row) => row.group === 'Tab appearance');
    expect(appearance).toEqual([
      expect.objectContaining({
        id: 'setting:tabStateTintsEnabled',
        label: 'Show tab state tints',
        value: 'Off',
        switchOn: false,
        intent: { type: 'toggle', key: 'tabStateTintsEnabled' },
      }),
      expect.objectContaining({
        id: 'setting:customTabStateIconsEnabled',
        label: 'Use custom tab state icons',
        value: 'On',
        switchOn: true,
        intent: { type: 'toggle', key: 'customTabStateIconsEnabled' },
      }),
    ]);
  });

  it('toggles booleans in place and opens a stage for everything else', () => {
    const rows = controlRows(REGULAR_MODEL);
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
    const regular = labels(controlRows(REGULAR_MODEL));
    const priv = labels(controlRows(PRIVATE_MODEL));
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
    expect(controlRows(PRIVATE_MODEL).some((row) => row.group === 'Backup and data')).toBe(false);
    expect(priv).toContain('Protection level');
  });

  it('leaves out the reset in a private window, where tools refuses it', () => {
    expect(controlRows(PRIVATE_MODEL).some((row) => row.id === 'reset:open')).toBe(false);
    expect(searchableRows(PRIVATE_MODEL).some((row) => row.id === 'reset:open')).toBe(false);
    expect(controlRows(REGULAR_MODEL).some((row) => row.id === 'reset:open')).toBe(true);
  });

  it('marks a write in flight on its row', () => {
    const model: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      pending: new Set(['panelShadowsEnabled']),
    };
    expect(find(controlRows(model), 'setting:panelShadowsEnabled').pending).toBe(true);
    expect(find(controlRows(model), 'setting:panelCycleWraparound').pending).toBeFalsy();
  });

  it('shows no privacy rows until privacy and search have loaded', () => {
    expect(
      controlRows({ ...REGULAR_MODEL, privacy: null }).some((row) => row.id.startsWith('privacy:')),
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
    const rows = rowsForStage({ kind: 'number', key: 'tabSleepAfterMinutes' }, REGULAR_MODEL);
    expect(rows.map((row) => `${row.label}${row.note ? ` ${row.note}` : ''}`)).toEqual([
      '1 min Min',
      '5 min',
      '15 min',
      '30 min Default',
      '60 min',
      '120 min',
      '240 min',
      '1440 min Max',
    ]);
    expect(rows[1]!.intent).toEqual({ type: 'applyNumber', value: 5 });
  });

  it('shows no second line under a preset', () => {
    const rows = rowsForStage({ kind: 'number', key: 'tabSleepAfterMinutes' }, REGULAR_MODEL);
    expect(rows.some((row) => row.description !== undefined)).toBe(false);
  });

  it('lists nothing on a slider page: the slider replaces the presets', () => {
    expect(rowsForStage({ kind: 'number', key: 'panelCornerRadiusPx' }, REGULAR_MODEL)).toEqual([]);
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
    expect(editorSpecFor({ kind: 'sizes' })).toBeNull();
  });

  it('gives a slider to the small-range numbers and to no other stage', () => {
    for (const key of [
      'tabSleepKeepAlivePerWorkspace',
      'panelCornerRadiusPx',
      'panelSplitterSizePx',
      'autoBackupMaxCount',
    ] as const) {
      expect(sliderSpecFor({ kind: 'number', key }), key).toMatchObject({
        min: NUMBER_SPECS[key].min,
        max: NUMBER_SPECS[key].max,
      });
    }
    for (const key of [
      'tabSleepAfterMinutes',
      'autoBackupIntervalMinutes',
      'defaultPanelWidthPx',
    ] as const) {
      expect(sliderSpecFor({ kind: 'number', key }), key).toBeNull();
    }
    expect(sliderSpecFor({ kind: 'sizeEdit', index: 0 })).toBeNull();
    expect(sliderSpecFor({ kind: 'sizes' })).toBeNull();
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
    // What the reset does is the page description, so the list holds only the two actions.
    expect(labels(rows)).toEqual(['Cancel', 'Reset Bento settings']);
    expect(rows[0]!.intent).toEqual({ type: 'back' });
    expect(rows[1]).toMatchObject({
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
      status: '23 categories',
    });
  });

  it('describes the editor footers as in the mock', () => {
    expect(footerFor({ kind: 'number', key: 'tabSleepAfterMinutes' }, REGULAR_MODEL, 6)).toEqual({
      hints: ['Type a value', '↑↓ presets', 'Enter keep', 'Esc cancel'],
      status: 'Live preview',
    });
    expect(footerFor({ kind: 'number', key: 'panelCornerRadiusPx' }, REGULAR_MODEL, 0)).toEqual({
      hints: ['←→ adjust', 'Home End min max', 'Enter keep', 'Esc cancel'],
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
    expect(esc({ kind: 'sizeEdit', index: 0 })).toBe('Esc cancel');
  });

  it('offers no arrows on the static shortcuts list', () => {
    expect(footerFor({ kind: 'shortcuts' }, REGULAR_MODEL, 8).hints).toEqual(['Esc back']);
  });

  it('shows the target state on a switch while its write is in flight', () => {
    const off = controlRows(REGULAR_MODEL).find((row) => row.id === 'setting:panelShadowsEnabled');
    const stored = REGULAR_MODEL.settings.panelShadowsEnabled;
    expect(off).toMatchObject({ switchOn: stored, pending: false });
    const writing: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      pending: new Set(['panelShadowsEnabled']),
      pendingTargets: new Map([['panelShadowsEnabled', !stored]]),
    };
    const during = controlRows(writing).find((row) => row.id === 'setting:panelShadowsEnabled');
    expect(during).toMatchObject({ switchOn: !stored, pending: true });
    // The row keeps the stored On or Off as its text value, and only toggle rows carry a switch.
    expect(during?.value).toBe(stored ? 'On' : 'Off');
    expect(
      controlRows(REGULAR_MODEL).find((row) => row.id === 'setting:panelCornerRadiusPx'),
    ).not.toHaveProperty('switchOn');
  });

  it('keeps showing what the write asked for when the stored value already changed', () => {
    // A change notice can store the new value before the reply: the switch is not flipped back.
    const asked = !REGULAR_MODEL.settings.panelShadowsEnabled;
    const broadcast: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      settings: { ...REGULAR_MODEL.settings, panelShadowsEnabled: asked },
      pending: new Set(['panelShadowsEnabled']),
      pendingTargets: new Map([['panelShadowsEnabled', asked]]),
    };
    expect(find(controlRows(broadcast), 'setting:panelShadowsEnabled').switchOn).toBe(asked);
  });

  it('shows the stored state once the write is over, and on a pending key with no target', () => {
    const stored = REGULAR_MODEL.settings.panelShadowsEnabled;
    // A failed write leaves the stored value and no target.
    expect(find(controlRows(REGULAR_MODEL), 'setting:panelShadowsEnabled').switchOn).toBe(stored);
    const noTarget: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      pending: new Set(['panelShadowsEnabled']),
    };
    expect(find(controlRows(noTarget), 'setting:panelShadowsEnabled').switchOn).toBe(stored);
  });

  it('follows the target of an advanced privacy switch too', () => {
    const stored = find(advancedRows(REGULAR_MODEL), 'advanced:remoteSafeBrowsingEnabled');
    const writing: SettingsPaletteModel = {
      ...REGULAR_MODEL,
      pending: new Set(['advanced:remoteSafeBrowsingEnabled']),
      pendingTargets: new Map([['advanced:remoteSafeBrowsingEnabled', !stored.switchOn]]),
    };
    expect(find(advancedRows(writing), 'advanced:remoteSafeBrowsingEnabled').switchOn).toBe(
      !stored.switchOn,
    );
  });

  it('names a switch row with its state, following the state the switch shows', () => {
    const stored = REGULAR_MODEL.settings.panelShadowsEnabled;
    const label = (model: SettingsPaletteModel) =>
      rowAriaLabel(find(controlRows(model), 'setting:panelShadowsEnabled'));
    expect(label(REGULAR_MODEL)).toBe(`Show panel shadows, ${stored ? 'On' : 'Off'}`);
    expect(
      label({
        ...REGULAR_MODEL,
        pending: new Set(['panelShadowsEnabled']),
        pendingTargets: new Map([['panelShadowsEnabled', !stored]]),
      }),
    ).toBe(`Show panel shadows, ${stored ? 'Off' : 'On'}`);
    // Any other row is named by its content.
    expect(
      rowAriaLabel(find(controlRows(REGULAR_MODEL), 'setting:panelCornerRadiusPx')),
    ).toBeUndefined();
  });

  it('shows only a retry while the snapshot is missing', () => {
    expect(statusRows({ kind: 'loading' })).toHaveLength(1);
    const failed = statusRows({ kind: 'error', message: 'No answer' });
    expect(failed.map((row) => row.label)).toEqual(['No answer', 'Try again']);
    expect(failed[1]!.intent).toEqual({ type: 'retry' });
  });
});

describe('page descriptions', () => {
  const stagesWithKeys = (): Stage[] => [
    ...(Object.keys(NUMBER_SPECS) as (keyof typeof NUMBER_SPECS)[]).map((key): Stage => ({
      kind: 'number',
      key,
    })),
    ...(Object.keys(ENUM_SPECS) as EnumKey[]).map((key): Stage => ({ kind: 'enum', key })),
    { kind: 'protection' },
    { kind: 'search' },
    { kind: 'sizes' },
    { kind: 'sizeActions', index: 0 },
    { kind: 'sizeEdit', index: 0 },
    { kind: 'advanced' },
    { kind: 'backups' },
    { kind: 'backupRow', backupId: 'b1', label: 'L' },
    { kind: 'confirm', action: { kind: 'reset' } },
    { kind: 'confirm', action: { kind: 'restore', backupId: 'b1', label: 'L' } },
    { kind: 'confirm', action: { kind: 'delete', backupId: 'b1', label: 'L' } },
  ];

  it('describes every stage where a value or option changes', () => {
    for (const stage of stagesWithKeys()) {
      const text = pageDescription(stage);
      expect(text, JSON.stringify(stage)).toBeTruthy();
    }
  });

  it('leaves the root and the shortcuts without one', () => {
    expect(pageDescription({ kind: 'root' })).toBeNull();
    expect(pageDescription({ kind: 'shortcuts' })).toBeNull();
  });

  it('takes a number page from its spec and the size editor from the size limits', () => {
    expect(pageDescription({ kind: 'number', key: 'tabSleepKeepAlivePerWorkspace' })).toBe(
      NUMBER_DESCRIPTIONS.tabSleepKeepAlivePerWorkspace,
    );
    expect(pageDescription({ kind: 'sizeEdit', index: 0 })).toContain(
      `${PANEL_SIZE_LIMITS.min} to ${PANEL_SIZE_LIMITS.max}`,
    );
  });

  it('writes no em dashes anywhere in the copy', () => {
    const everything = [
      ...stagesWithKeys().map((stage) => pageDescription(stage)),
      ...Object.values(ENUM_OPTION_DESCRIPTIONS).flatMap((lines) => Object.values(lines)),
      ...advancedRows(REGULAR_MODEL).map((row) => row.description),
      ...rowsForStage({ kind: 'protection' }, REGULAR_MODEL).map((row) => row.description),
    ];
    for (const text of everything) expect(text ?? '').not.toContain('\u2014');
  });
});

describe('option lines', () => {
  const lines = (stage: Stage) =>
    rowsForStage(stage, REGULAR_MODEL).map((row) => [row.label, row.description]);

  it('gives every option of a choice stage a line', () => {
    for (const key of Object.keys(ENUM_SPECS) as EnumKey[]) {
      const rows = rowsForStage({ kind: 'enum', key }, REGULAR_MODEL);
      expect(rows.length, key).toBeGreaterThan(1);
      for (const row of rows) expect(row.description, `${key} ${row.label}`).toBeTruthy();
    }
    expect(lines({ kind: 'enum', key: 'httpsOnlyMode' })).toEqual([
      ['Off', expect.stringContaining('over HTTP')],
      ['Always', expect.stringContaining('warns you')],
    ]);
  });

  it('puts each protection level summary under its row and the benefits and caveats in the detail', () => {
    const rows = rowsForStage({ kind: 'protection' }, REGULAR_MODEL);
    for (const level of ['standard', 'enhanced', 'hardened'] as const) {
      const row = find(rows, `level:${level}`);
      expect(row.description).toBe(PRIVACY_LEVEL_DETAILS[level].summary);
      expect(row.detail).toEqual({
        benefits: PRIVACY_LEVEL_DETAILS[level].benefits,
        caveats: PRIVACY_LEVEL_DETAILS[level].caveats,
      });
    }
    expect(find(rows, 'level:custom').description).toContain('cannot be chosen');
    expect(find(rows, 'level:custom').detail).toBeUndefined();
  });

  it('describes every advanced privacy row, and keeps the root search results to one line', () => {
    const rows = advancedRows(REGULAR_MODEL);
    expect(rows).toHaveLength(15);
    for (const row of rows) expect(row.description, row.label).toBeTruthy();
    // The two choices say what their page says.
    expect(find(rows, 'advanced:httpsOnlyMode').description).toBe(ENUM_DESCRIPTIONS.httpsOnlyMode);
    const searched = searchableRows(REGULAR_MODEL).filter((row) => row.id.startsWith('advanced:'));
    expect(searched).toHaveLength(15);
    expect(searched.every((row) => row.description === undefined)).toBe(true);
  });

  it('describes the size actions, the backup rows that start something and a stored backup', () => {
    const actions = rowsForStage({ kind: 'sizeActions', index: 2 }, REGULAR_MODEL);
    for (const row of actions) expect(row.description, row.label).toBeTruthy();
    const backups = rowsForStage({ kind: 'backups' }, REGULAR_MODEL);
    for (const id of ['backup:export', 'backup:import', 'backup:merge']) {
      expect(find(backups, id).description, id).toBeTruthy();
    }
    expect(backups.filter((row) => row.id.startsWith('stored:')).some((r) => r.description)).toBe(
      false,
    );
    const stored = rowsForStage({ kind: 'backupRow', backupId: 'b1', label: 'L' }, REGULAR_MODEL);
    for (const row of stored) expect(row.description, row.label).toBeTruthy();
  });

  it('leaves search engines and the sizes list without a second line', () => {
    for (const stage of [{ kind: 'search' }, { kind: 'sizes' }] as const) {
      expect(rowsForStage(stage, REGULAR_MODEL).some((row) => row.description)).toBe(false);
    }
  });

  it('names a row with a line by its own text, so the line is read as its description', () => {
    const row = find(
      rowsForStage({ kind: 'enum', key: 'uiColorMode' }, REGULAR_MODEL),
      'option:system',
    );
    expect(rowAriaLabel(row)).toBe('Follow system, Current');
    const toggle = find(advancedRows(REGULAR_MODEL), 'advanced:safeBrowsingEnabled');
    expect(rowAriaLabel(toggle)).toBe('Local Safe Browsing, On');
    const choice = find(advancedRows(REGULAR_MODEL), 'advanced:httpsOnlyMode');
    expect(rowAriaLabel(choice)).toBe('HTTPS-only mode, Always');
  });
});

describe('field row', () => {
  const shown = (stage: Stage, model = REGULAR_MODEL) =>
    showsFieldRow(stage, rowsForStage(stage, model).length);

  it('is dropped on a list of four rows or fewer, decided by the count', () => {
    for (const stage of [
      { kind: 'protection' },
      { kind: 'enum', key: 'uiColorMode' },
      { kind: 'enum', key: 'sidebarShortcutBehavior' },
      { kind: 'enum', key: 'webRTCIPHandlingPolicy' },
      { kind: 'enum', key: 'httpsOnlyMode' },
      { kind: 'sizeActions', index: 2 },
      { kind: 'backupRow', backupId: 'b1', label: 'L' },
      { kind: 'confirm', action: { kind: 'reset' } },
    ] as const satisfies readonly Stage[]) {
      expect(rowsForStage(stage, REGULAR_MODEL).length, stage.kind).toBeLessThanOrEqual(4);
      expect(shown(stage), stage.kind).toBe(false);
    }
  });

  it('is kept on the root, in editors and on longer lists', () => {
    expect(showsFieldRow({ kind: 'root' }, 0)).toBe(true);
    for (const stage of [
      { kind: 'number', key: 'panelCornerRadiusPx' },
      { kind: 'sizeEdit', index: 0 },
      { kind: 'advanced' },
      { kind: 'shortcuts' },
      { kind: 'search' },
      { kind: 'sizes' },
    ] as const satisfies readonly Stage[]) {
      expect(shown(stage), stage.kind).toBe(true);
    }
  });

  it('keeps the field while a filter is typed, even when the list shrinks to four rows', () => {
    // A model update (an engine removed in Firefox settings) can drop the unfiltered count
    // while the user has filtered: the field and its Clear button must stay in view.
    const search: Stage = { kind: 'search' };
    expect(showsFieldRow(search, 4)).toBe(false);
    expect(showsFieldRow(search, 4, 'goo')).toBe(true);
    expect(showsFieldRow(search, 4, '')).toBe(false);
  });
});
