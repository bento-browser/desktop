import { describe, expect, it } from 'vitest';
import { PRIVATE_MODEL, REGULAR_MODEL } from '../../state/__fixtures__/settingsPalette';
import { ROOT_TARGET, resolveSettingsTarget, targetForModel } from './targets';

describe('settings targets', () => {
  it('opens a number, choice or name setting on its own list', () => {
    expect(resolveSettingsTarget('setting:panelCornerRadiusPx')).toEqual({
      stages: [
        { kind: 'root' },
        { kind: 'category', id: 'panels' },
        { kind: 'number', key: 'panelCornerRadiusPx' },
      ],
      query: '',
    });
    expect(resolveSettingsTarget('setting:uiColorMode')?.stages.at(-1)).toEqual({
      kind: 'enum',
      key: 'uiColorMode',
    });
    // A setting this build no longer has is not a target: it opens the first list.
    expect(resolveSettingsTarget('setting:defaultWorkspaceName')).toBeNull();
  });

  it('opens the privacy rows on their lists', () => {
    expect(resolveSettingsTarget('privacy:level')?.stages.at(-1)).toEqual({ kind: 'protection' });
    expect(resolveSettingsTarget('privacy:search')?.stages.at(-1)).toEqual({ kind: 'search' });
    expect(resolveSettingsTarget('privacy:advanced')?.stages.at(-1)).toEqual({ kind: 'advanced' });
  });

  it('puts a switch, which has no list, first by typing its label into its category', () => {
    expect(resolveSettingsTarget('setting:panelShadowsEnabled')).toEqual({
      stages: [{ kind: 'root' }, { kind: 'category', id: 'panels' }],
      query: 'Show panel shadows',
    });
    expect(resolveSettingsTarget('advanced:resistFingerprinting')).toEqual({
      stages: [{ kind: 'root' }, { kind: 'category', id: 'privacy' }, { kind: 'advanced' }],
      query: 'Resist fingerprinting',
    });
  });

  it('refuses an id the palette does not have, including inherited property names', () => {
    for (const id of [
      '',
      'constructor',
      'toString',
      'setting:nope',
      'setting:constructor',
      'advanced:nope',
      'reset:open',
    ]) {
      expect(resolveSettingsTarget(id), id).toBeNull();
    }
  });
});

describe('ready-model target availability', () => {
  const target = (id: string) => resolveSettingsTarget(id) ?? ROOT_TARGET;

  it('keeps valid ready targets, including their queries and detail ancestors', () => {
    for (const id of [
      'setting:panelShadowsEnabled',
      'setting:panelCornerRadiusPx',
      'setting:customPanelSizes',
      'privacy:level',
      'privacy:search',
      'privacy:advanced',
      'advanced:httpsOnlyMode',
      'privacy:manage-search',
      'backup:open',
      'setting:autoBackupEnabled',
      'setting:autoBackupMaxCount',
      'shortcuts:open',
    ]) {
      const requested = target(id);
      expect(targetForModel(requested, REGULAR_MODEL), id).toBe(requested);
    }
    expect(targetForModel(target('setting:uiColorMode'), PRIVATE_MODEL)).toEqual(
      target('setting:uiColorMode'),
    );
  });

  it('accepts both tab appearance switches in regular and private windows', () => {
    for (const id of ['setting:tabStateTintsEnabled', 'setting:customTabStateIconsEnabled']) {
      const requested = target(id);
      expect(targetForModel(requested, REGULAR_MODEL), id).toBe(requested);
      expect(targetForModel(requested, PRIVATE_MODEL), id).toBe(requested);
    }
  });

  it('rejects private backup targets, including number and backup detail ancestors', () => {
    for (const id of [
      'setting:autoBackupEnabled',
      'setting:autoBackupIntervalMinutes',
      'setting:autoBackupMaxCount',
      'backup:open',
    ]) {
      expect(targetForModel(target(id), PRIVATE_MODEL), id).toBe(ROOT_TARGET);
    }
  });

  it('rejects every privacy route when either required model is missing', () => {
    for (const missing of [{ privacy: null }, { search: null }]) {
      const model = { ...REGULAR_MODEL, ...missing };
      for (const id of [
        'privacy:level',
        'privacy:search',
        'privacy:advanced',
        'privacy:manage-search',
        'advanced:resistFingerprinting',
        'advanced:httpsOnlyMode',
      ]) {
        expect(targetForModel(target(id), model), id).toBe(ROOT_TARGET);
      }
      const valid = target('setting:panelCornerRadiusPx');
      expect(targetForModel(valid, model)).toBe(valid);
    }
  });
});
