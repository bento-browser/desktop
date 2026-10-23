import { describe, expect, it } from 'vitest';
import { ADVANCED_PRIVACY_RULES, EDITABLE_SETTING_RULES } from '@shared/settings-rules';
import {
  ADVANCED_PRIVACY_SPECS,
  BOOLEAN_SPECS,
  NUMBER_SPECS,
  PANEL_SIZE_EDITOR,
  PANEL_SIZE_LIMITS,
  SHORTCUTS,
  SLIDER_MAX_SPAN,
  parseNumber,
  presetMarker,
  presetValues,
  usesSlider,
} from './settingsCatalog';

const editable: Record<
  string,
  (typeof EDITABLE_SETTING_RULES)[keyof typeof EDITABLE_SETTING_RULES]
> = EDITABLE_SETTING_RULES;

describe('catalog against the tools rules', () => {
  it('has the rule bounds for every number', () => {
    for (const spec of Object.values(NUMBER_SPECS)) {
      const rule = editable[spec.key];
      expect(rule, spec.key).toMatchObject({ type: 'integer', min: spec.min, max: spec.max });
    }
  });

  it('covers every integer and boolean setting of the rules', () => {
    const keysOf = (type: string) =>
      Object.entries(editable)
        .filter(([, rule]) => rule.type === type)
        .map(([key]) => key)
        .sort();
    expect(Object.keys(NUMBER_SPECS).sort()).toEqual(keysOf('integer'));
    expect(Object.keys(BOOLEAN_SPECS).sort()).toEqual(keysOf('boolean'));
  });

  it('matches the custom size and name limits', () => {
    expect(EDITABLE_SETTING_RULES.customPanelSizes).toMatchObject({
      min: PANEL_SIZE_LIMITS.min,
      max: PANEL_SIZE_LIMITS.max,
      maxItems: PANEL_SIZE_LIMITS.maxItems,
    });
  });

  it('lists every advanced privacy key of the rules once', () => {
    expect(ADVANCED_PRIVACY_SPECS.map((spec) => spec.key).sort()).toEqual(
      Object.keys(ADVANCED_PRIVACY_RULES).sort(),
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

describe('sliders', () => {
  it('go to the settings with a range of at most 50 and to no wider one', () => {
    const sliders = Object.values(NUMBER_SPECS)
      .filter(usesSlider)
      .map((spec) => spec.key)
      .sort();
    expect(sliders).toEqual([
      'autoBackupMaxCount',
      'panelCornerRadiusPx',
      'panelSplitterSizePx',
      'tabSleepKeepAlivePerWorkspace',
    ]);
    expect(usesSlider({ min: 0, max: SLIDER_MAX_SPAN })).toBe(true);
    expect(usesSlider({ min: 0, max: SLIDER_MAX_SPAN + 1 })).toBe(false);
    expect(usesSlider(PANEL_SIZE_EDITOR)).toBe(false);
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
