import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ADVANCED_PRIVACY_SPECS,
  BOOLEAN_SPECS,
  MAX_WORKSPACE_NAME_LENGTH,
  NUMBER_SPECS,
  PANEL_SIZE_LIMITS,
  SHORTCUTS,
  parseNumber,
  presetMarker,
  presetValues,
} from './settingsCatalog';

interface ContractSetting {
  type: string;
  min?: number;
  max?: number;
  maxItems?: number;
  maxLength?: number;
}

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../_shared/native-preferences-contract.json', import.meta.url)),
    'utf8',
  ),
) as {
  editableSettings: Record<string, ContractSetting>;
  advancedPrivacy: Record<string, ContractSetting>;
};

describe('catalog against the tools contract', () => {
  it('has the contract bounds for every number', () => {
    for (const spec of Object.values(NUMBER_SPECS)) {
      const bounds = contract.editableSettings[spec.key];
      expect(bounds, spec.key).toMatchObject({ type: 'integer', min: spec.min, max: spec.max });
    }
  });

  it('covers every integer, boolean and enum setting of the contract', () => {
    const integers = Object.entries(contract.editableSettings)
      .filter(([, setting]) => setting.type === 'integer')
      .map(([key]) => key)
      .sort();
    expect(Object.keys(NUMBER_SPECS).sort()).toEqual(integers);
    const booleans = Object.entries(contract.editableSettings)
      .filter(([, setting]) => setting.type === 'boolean')
      .map(([key]) => key)
      .sort();
    expect(Object.keys(BOOLEAN_SPECS).sort()).toEqual(booleans);
  });

  it('matches the custom size and name limits', () => {
    expect(contract.editableSettings.customPanelSizes).toMatchObject({
      min: PANEL_SIZE_LIMITS.min,
      max: PANEL_SIZE_LIMITS.max,
      maxItems: PANEL_SIZE_LIMITS.maxItems,
    });
    expect(contract.editableSettings.defaultWorkspaceName?.maxLength).toBe(
      MAX_WORKSPACE_NAME_LENGTH,
    );
  });

  it('lists every advanced privacy key of the contract once', () => {
    expect(ADVANCED_PRIVACY_SPECS.map((spec) => spec.key).sort()).toEqual(
      Object.keys(contract.advancedPrivacy).sort(),
    );
  });

  it('keeps every default and preset inside its bounds', () => {
    for (const spec of Object.values(NUMBER_SPECS)) {
      for (const value of [spec.defaultValue, ...spec.presets]) {
        expect(value, `${spec.key} ${value}`).toBeGreaterThanOrEqual(spec.min);
        expect(value, `${spec.key} ${value}`).toBeLessThanOrEqual(spec.max);
      }
    }
  });
});

describe('parseNumber', () => {
  const bounds = { min: 0, max: 36 };

  it('accepts whole numbers inside the bounds, edges included', () => {
    expect(parseNumber('24', bounds)).toEqual({ ok: true, value: 24 });
    expect(parseNumber(' 0 ', bounds)).toEqual({ ok: true, value: 0 });
    expect(parseNumber('36', bounds)).toEqual({ ok: true, value: 36 });
  });

  it('refuses instead of clamping', () => {
    expect(parseNumber('37', bounds)).toMatchObject({ ok: false });
    expect(parseNumber('', bounds)).toMatchObject({ ok: false });
    expect(parseNumber('1.5', bounds)).toMatchObject({ ok: false });
    expect(parseNumber('-1', bounds)).toMatchObject({ ok: false });
    expect(parseNumber('1e1', bounds)).toMatchObject({ ok: false });
    expect(parseNumber('12px', bounds)).toMatchObject({ ok: false });
  });

  it('names the allowed range in the reason', () => {
    expect(parseNumber('99', bounds)).toEqual({ ok: false, reason: 'Use 0 to 36' });
  });
});

describe('presets', () => {
  it('lists bounds, default and suggestions once, ascending, with markers', () => {
    const spec = NUMBER_SPECS.panelCornerRadiusPx;
    expect(presetValues(spec)).toEqual([0, 8, 12, 16, 24, 36]);
    expect(presetMarker(spec, 0)).toBe('Min');
    expect(presetMarker(spec, 12)).toBe('Default');
    expect(presetMarker(spec, 36)).toBe('Max');
    expect(presetMarker(spec, 8)).toBeUndefined();
  });
});

describe('shortcuts copy', () => {
  it('says the command palette is Cmd/Ctrl + Alt + P', () => {
    expect(SHORTCUTS.find((entry) => entry.label === 'Open command palette')?.keys).toBe(
      'Cmd/Ctrl + Alt + P',
    );
    expect(SHORTCUTS.some((entry) => entry.keys.includes('K'))).toBe(false);
  });
});
