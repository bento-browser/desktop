import { describe, expect, it } from 'vitest';

import {
  EMPTY_SPACE_SNAPSHOT,
  LOAD_FAILED_SNAPSHOT,
  SAMPLE_SNAPSHOT,
} from '../../state/__fixtures__/bookmarks';
import { toolbarModel, visibleGroupCount } from './model';

describe('toolbarModel', () => {
  it('lists the groups of the current space and counts its links', () => {
    const model = toolbarModel(SAMPLE_SNAPSHOT);
    expect(model?.space.name).toBe('Climbing');
    expect(model?.groups.map((group) => group.name)).toEqual([
      'Bouldering apps',
      'Gyms',
      'Training',
      'Gear',
    ]);
    expect(model?.linkCount).toBe(6 + 5 + 4 + 3);
  });

  it('has no groups and no links in an empty space', () => {
    const model = toolbarModel(EMPTY_SPACE_SNAPSHOT);
    expect(model?.space.name).toBe('Trip planning');
    expect(model?.groups).toEqual([]);
    expect(model?.linkCount).toBe(0);
  });

  it('falls back to the first space when the remembered one is gone', () => {
    const model = toolbarModel({ ...SAMPLE_SNAPSHOT, lastSpaceId: 'missing' });
    expect(model?.space.name).toBe('Personal');
  });

  it('shows nothing before a snapshot, after a failed load, or without a space', () => {
    expect(toolbarModel(null)).toBeNull();
    expect(toolbarModel(LOAD_FAILED_SNAPSHOT)).toBeNull();
    expect(
      toolbarModel({ ...SAMPLE_SNAPSHOT, spaces: [], groups: [], lastSpaceId: null }),
    ).toBeNull();
  });
});

describe('visibleGroupCount', () => {
  const widths = [80, 80, 80, 80];

  it('keeps every button, with no overflow button, when they all fit', () => {
    // 4 x 80 + 3 x 4 = 332
    expect(visibleGroupCount(widths, 332, 4, 24)).toBe(4);
    expect(visibleGroupCount([], 100, 4, 24)).toBe(0);
  });

  it('moves the buttons that do not fit behind the overflow button', () => {
    // 331 does not hold four; the overflow button (24 + one gap) leaves 303: three need 252, four 332.
    expect(visibleGroupCount(widths, 331, 4, 24)).toBe(3);
    // room = 200 - 28 = 172: two need 164, three 248.
    expect(visibleGroupCount(widths, 200, 4, 24)).toBe(2);
  });

  it('moves every button when not even one fits beside the overflow button', () => {
    expect(visibleGroupCount(widths, 90, 4, 24)).toBe(0);
    expect(visibleGroupCount(widths, 0, 4, 24)).toBe(0);
  });
});
