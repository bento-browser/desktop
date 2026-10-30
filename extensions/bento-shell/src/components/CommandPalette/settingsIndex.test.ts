import { describe, expect, it } from 'vitest';
import { PRIVATE_MODEL, REGULAR_MODEL } from '../../state/__fixtures__/settingsPalette';
import { controlRows } from '../SettingsPalette/rows';
import { resolveSettingsTarget } from '../SettingsPalette/targets';
import { SETTINGS_INDEX } from './settingsIndex';

/** Control rows that are not settings to search for: the reset, and the merge that has its own command. */
const NOT_INDEXED = new Set(['reset:open', 'backup:merge']);

describe('settings index of the command palette', () => {
  it('offers tab appearance search targets only in demo builds', () => {
    expect(
      SETTINGS_INDEX.filter((entry) => entry.group === 'Tab appearance').map(({ id }) => id),
    ).toEqual(
      __BENTO_SOFTCAST_DEMO__
        ? ['setting:tabStateTintsEnabled', 'setting:customTabStateIconsEnabled']
        : [],
    );
  });

  it('lists the flat controls of the Settings palette, with their labels and groups', () => {
    const rows = controlRows(REGULAR_MODEL).filter((row) => !NOT_INDEXED.has(row.id));
    expect(SETTINGS_INDEX.map(({ id, label, group }) => ({ id, label, group }))).toEqual(
      rows.map(({ id, label, group }) => ({ id, label, group })),
    );
  });

  it('marks exactly the rows a private window does not have', () => {
    const privateIds = new Set(controlRows(PRIVATE_MODEL).map((row) => row.id));
    for (const entry of SETTINGS_INDEX) {
      expect(privateIds.has(entry.id), entry.id).toBe(entry.regularOnly !== true);
    }
  });

  it('opens at a place the Settings palette knows for every entry', () => {
    for (const entry of SETTINGS_INDEX) {
      expect(resolveSettingsTarget(entry.id), entry.id).not.toBeNull();
    }
  });
});
