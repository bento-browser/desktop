import { describe, expect, it } from 'vitest';
import { ADVANCED_PRIVACY_SPECS, BOOLEAN_SPECS, ENUM_SPECS, NUMBER_SPECS } from './settingsCatalog';
import * as copy from './settingsCopy';

/** Every string of the module, however nested. */
function allText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(allText);
  return [];
}

describe('Settings copy', () => {
  it('describes every number, choice and advanced row of the catalog, and no other', () => {
    expect(Object.keys(copy.NUMBER_DESCRIPTIONS).sort()).toEqual(Object.keys(NUMBER_SPECS).sort());
    expect(Object.keys(copy.ENUM_DESCRIPTIONS).sort()).toEqual(Object.keys(ENUM_SPECS).sort());
    expect(Object.keys(copy.ADVANCED_DESCRIPTIONS).sort()).toEqual(
      ADVANCED_PRIVACY_SPECS.map((spec) => spec.key).sort(),
    );
  });

  it('describes only switches of the catalog, and the Bookmarks manager says its shortcut and what Off keeps', () => {
    for (const key of Object.keys(copy.TOGGLE_DESCRIPTIONS))
      expect(BOOLEAN_SPECS).toHaveProperty(key);
    expect(copy.TOGGLE_DESCRIPTIONS.bookmarksEnabled).toContain('Cmd/Ctrl+Shift+O');
    expect(copy.TOGGLE_DESCRIPTIONS.bookmarksEnabled).toContain('keeps your saved bookmarks');
  });

  it('has a line for each option of each choice, and no other', () => {
    for (const spec of Object.values(ENUM_SPECS)) {
      expect(Object.keys(copy.ENUM_OPTION_DESCRIPTIONS[spec.key]).sort(), spec.key).toEqual(
        spec.options.map((option) => option.value).sort(),
      );
    }
  });

  it('gives the two Advanced choices the text of their pages', () => {
    expect(copy.ADVANCED_DESCRIPTIONS.httpsOnlyMode).toBe(copy.ENUM_DESCRIPTIONS.httpsOnlyMode);
    expect(copy.ADVANCED_DESCRIPTIONS.webRTCIPHandlingPolicy).toBe(
      copy.ENUM_DESCRIPTIONS.webRTCIPHandlingPolicy,
    );
  });

  it('is plain: no em dashes, no empty text, no double spaces', () => {
    const lines = allText(copy);
    expect(lines.length).toBeGreaterThan(50);
    for (const line of lines) {
      expect(line, line).not.toBe('');
      expect(line, line).not.toContain('—');
      expect(line, line).not.toContain('  ');
      expect(line, line).toMatch(/[.]$/);
    }
  });
});
