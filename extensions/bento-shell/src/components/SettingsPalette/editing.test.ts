import { describe, expect, it } from 'vitest';
import {
  moveEntry,
  numberChange,
  parseName,
  removeAt,
  replaceAt,
  stepPreset,
  toggleChange,
} from './editing';
import { NUMBER_SPECS, PANEL_SIZE_EDITOR } from './settingsCatalog';

describe('parseName', () => {
  it('trims and refuses an empty or too long name', () => {
    expect(parseName('  Work ')).toEqual({ ok: true, value: 'Work' });
    expect(parseName('   ')).toMatchObject({ ok: false });
    expect(parseName('x'.repeat(1024))).toMatchObject({ ok: true });
    expect(parseName('x'.repeat(1025))).toMatchObject({ ok: false });
  });
});

describe('stepPreset', () => {
  const spec = NUMBER_SPECS.panelCornerRadiusPx; // 0 8 12 16 24 36

  it('moves to the next larger or smaller preset', () => {
    expect(stepPreset(spec, 12, 1)).toBe(16);
    expect(stepPreset(spec, 12, -1)).toBe(8);
    expect(stepPreset(spec, 13, 1)).toBe(16);
    expect(stepPreset(spec, 13, -1)).toBe(12);
  });

  it('starts from the first or last preset when nothing valid is typed', () => {
    expect(stepPreset(spec, null, 1)).toBe(0);
    expect(stepPreset(spec, null, -1)).toBe(36);
  });

  it('stops at the ends', () => {
    expect(stepPreset(spec, 36, 1)).toBeNull();
    expect(stepPreset(spec, 0, -1)).toBeNull();
  });

  it('has no default marker for a size list entry', () => {
    expect(stepPreset(PANEL_SIZE_EDITOR, 640, 1)).toBe(768);
    expect(stepPreset(PANEL_SIZE_EDITOR, 120, -1)).toBeNull();
  });
});

describe('size list edits', () => {
  it('replaces, removes and moves entries without changing the input', () => {
    const sizes = [320, 480, 640];
    expect(replaceAt(sizes, 1, 500)).toEqual([320, 500, 640]);
    expect(removeAt(sizes, 0)).toEqual([480, 640]);
    expect(moveEntry(sizes, 2, -1)).toEqual([320, 640, 480]);
    expect(moveEntry(sizes, 0, 1)).toEqual([480, 320, 640]);
    expect(sizes).toEqual([320, 480, 640]);
  });

  it('leaves the list alone when an entry cannot move', () => {
    expect(moveEntry([1, 2], 0, -1)).toEqual([1, 2]);
    expect(moveEntry([1, 2], 1, 1)).toEqual([1, 2]);
    expect(moveEntry([1, 2], 5, 1)).toEqual([1, 2]);
  });
});

describe('change builders', () => {
  it('make a one key change', () => {
    expect(numberChange('panelCornerRadiusPx', 24)).toEqual({ panelCornerRadiusPx: 24 });
    expect(toggleChange('panelShadowsEnabled', false)).toEqual({ panelShadowsEnabled: false });
  });
});
