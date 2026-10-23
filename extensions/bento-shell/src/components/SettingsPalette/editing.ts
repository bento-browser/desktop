// Rules of the editor stages (a number typed in the search field), kept free of React so they
// are tested directly.

import {
  parseNumber,
  presetValues,
  type BooleanSettingKey,
  type EditorSpec,
  type NumberSettingKey,
} from './settingsCatalog';
import type { EditableSettings } from './model';

/** The preset one arrow key press away: the next larger or smaller value, or the first or
 * last when nothing valid is typed. Null at either end of the list. */
export function stepPreset(
  spec: EditorSpec,
  current: number | null,
  direction: 1 | -1,
): number | null {
  const values = presetValues(spec);
  if (direction === 1) {
    return (current === null ? values[0] : values.find((value) => value > current)) ?? null;
  }
  return (
    (current === null ? values.at(-1) : values.filter((value) => value < current).at(-1)) ?? null
  );
}

export function numberChange(key: NumberSettingKey, value: number): Partial<EditableSettings> {
  const change: Partial<Record<NumberSettingKey, number>> = {};
  change[key] = value;
  return change;
}

export function toggleChange(key: BooleanSettingKey, value: boolean): Partial<EditableSettings> {
  const change: Partial<Record<BooleanSettingKey, boolean>> = {};
  change[key] = value;
  return change;
}

export function replaceAt(list: readonly number[], index: number, value: number): number[] {
  return list.map((entry, position) => (position === index ? value : entry));
}

/** Moves one entry by `delta` places; the list is returned unchanged when it cannot move. */
export function moveEntry(list: readonly number[], index: number, delta: -1 | 1): number[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return [...list];
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export function removeAt(list: readonly number[], index: number): number[] {
  return list.filter((_, position) => position !== index);
}

export { parseNumber };
