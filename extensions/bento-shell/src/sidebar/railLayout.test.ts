import { describe, expect, it, vi } from 'vitest';
import { finishAdded, tabRowShifts } from './railLayout';

describe('tabRowShifts', () => {
  // Measured in Ladle: a plain row moves 2.5 px right, its tail retracts 253 px; the
  // folder indent is 19.8 px and the rail drops it.
  const plain = { x: 2.5, y: 0, tail: 253 };
  const indented = { x: -17.3, y: 0, tail: 233.2 };

  it('derives indented rows from a plain row', () => {
    expect(tabRowShifts(plain, null, 19.8)).toEqual({
      plain,
      indented: { x: 2.5 - 19.8, y: 0, tail: 253 - 19.8 },
    });
  });

  it('derives plain rows when the window holds only folder children', () => {
    expect(tabRowShifts(null, indented, 19.8)).toEqual({
      plain: { x: -17.3 + 19.8, y: 0, tail: 233.2 + 19.8 },
      indented,
    });
  });

  it('keeps both when both were measured', () => {
    expect(tabRowShifts(plain, indented, 0)).toEqual({ plain, indented });
  });

  it('is zero with no tab rows', () => {
    expect(tabRowShifts(null, null, 19.8).plain).toEqual({ x: 0, y: 0, tail: 0 });
  });
});

describe('finishAdded', () => {
  const animation = (animationName: string) => ({ animationName, finish: vi.fn() });

  it('prepares a newly mounted pane, then finishes its phase animations but not the hold', () => {
    const move = animation('bento-rail-to');
    const fade = animation('bento-rail-out');
    const hold = animation('bento-rail-hold');
    const pane = { getAnimations: vi.fn(() => [move, fade, hold]) };
    const prepare = vi.fn(() => {
      // The offsets are written before the animations are read.
      expect(pane.getAnimations).not.toHaveBeenCalled();
    });
    finishAdded([pane as unknown as Node], prepare);
    expect(prepare).toHaveBeenCalledWith(pane);
    expect(pane.getAnimations).toHaveBeenCalledWith({ subtree: true });
    expect(move.finish).toHaveBeenCalled();
    expect(fade.finish).toHaveBeenCalled();
    expect(hold.finish).not.toHaveBeenCalled();
  });

  it('leaves animations that are not the rail keyframes running', () => {
    const spinner = {
      animationName: 'muxui-progress-spin',
      finish: vi.fn(() => {
        throw new Error('InvalidStateError: infinite animation');
      }),
    };
    const slide = animation('bento-tab-list-exit-to-left');
    const move = animation('bento-rail-to');
    const row = { getAnimations: vi.fn(() => [spinner, slide, move]) };
    finishAdded([row as unknown as Node], vi.fn());
    expect(spinner.finish).not.toHaveBeenCalled();
    expect(slide.finish).not.toHaveBeenCalled();
    expect(move.finish).toHaveBeenCalled();
  });

  it('ignores text nodes', () => {
    const prepare = vi.fn();
    finishAdded([{ nodeType: 3 } as unknown as Node], prepare);
    expect(prepare).not.toHaveBeenCalled();
  });
});
