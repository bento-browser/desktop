import { describe, expect, it } from 'vitest';
import { enterActivatesHighlight, movesHighlight } from './enterOnHighlight';

/** An input whose `aria-activedescendant` is `activeId`, in a document that holds `rowIds`. */
function input(activeId: string | null, rowIds: string[]) {
  return {
    getAttribute: (name: string) => (name === 'aria-activedescendant' ? activeId : null),
    ownerDocument: { getElementById: (id: string) => (rowIds.includes(id) ? { id } : null) },
  };
}

describe('enterActivatesHighlight', () => {
  it('leaves Enter to Mux while a row is highlighted', () => {
    expect(enterActivatesHighlight(input('row-3', ['row-1', 'row-3']))).toBe(true);
  });

  it('keeps Enter for the caller when no row is highlighted', () => {
    expect(enterActivatesHighlight(input(null, ['row-1']))).toBe(false);
    expect(enterActivatesHighlight(input('', ['row-1']))).toBe(false);
  });

  it('ignores a highlight the filter has since removed', () => {
    expect(enterActivatesHighlight(input('row-9', ['row-1']))).toBe(false);
  });

  it('keeps Enter for the caller when the highlight was not moved on purpose', () => {
    const auto = input('row-1', ['row-1']);
    expect(enterActivatesHighlight(auto, false)).toBe(false);
    expect(enterActivatesHighlight(auto, true)).toBe(true);
  });
});

describe('movesHighlight', () => {
  const press = (key: string, extra: { isComposing?: boolean; meta?: boolean } = {}) => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: extra.meta ?? false,
    shiftKey: false,
    nativeEvent: { isComposing: extra.isComposing ?? false },
  });

  it('counts the keys React Aria navigates the list with', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']) {
      expect(movesHighlight(press(key))).toBe(true);
    }
  });

  it('ignores other keys and keys that belong to an IME composition', () => {
    for (const key of ['Enter', 'ArrowLeft', 'ArrowRight', 'a']) {
      expect(movesHighlight(press(key))).toBe(false);
    }
    expect(movesHighlight(press('ArrowDown', { isComposing: true }))).toBe(false);
  });

  it('ignores a navigation key while a modifier is held', () => {
    expect(movesHighlight(press('ArrowDown', { meta: true }))).toBe(false);
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const) {
      expect(movesHighlight({ ...press('PageDown'), [modifier]: true })).toBe(false);
    }
  });
});
