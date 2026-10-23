import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorSession, LIVE_APPLY_DELAY_MS, LIVE_SLIDE_INTERVAL_MS } from './editorSession';
import type { EditableSettings } from './model';
import { PANEL_SIZE_EDITOR } from './settingsCatalog';
import type { Stage } from './stageStack';
import type { SettingsPaletteModel } from './types';

const modelWith = (settings: Partial<EditableSettings>): SettingsPaletteModel =>
  ({ settings: { customPanelSizes: [400, 500], ...settings } }) as unknown as SettingsPaletteModel;

const numberSpec = { ...PANEL_SIZE_EDITOR, min: 0, max: 40 };
const radiusStage: Stage = { kind: 'number', key: 'panelCornerRadiusPx' };

describe('createEditorSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const open = (settings: Partial<EditableSettings> = { panelCornerRadiusPx: 12 }) => {
    const model = modelWith(settings);
    const update = vi.fn();
    const session = createEditorSession({ model: () => model, update });
    session.begin(radiusStage, model);
    return { session, update };
  };

  it('applies a typed number after the pause and not before', () => {
    const { session, update } = open();
    session.type('24', numberSpec);
    vi.advanceTimersByTime(LIVE_APPLY_DELAY_MS - 1);
    expect(update).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(update).toHaveBeenCalledWith({ panelCornerRadiusPx: 24 });
  });

  it('a revert stops the pending apply, so nothing is sent after the palette is hidden', () => {
    const { session, update } = open();
    session.type('24', numberSpec);
    session.revert();
    vi.advanceTimersByTime(LIVE_APPLY_DELAY_MS * 5);
    expect(update).not.toHaveBeenCalled();
  });

  it('a revert puts back the starting value once, and a second revert sends nothing', () => {
    const { session, update } = open();
    session.type('24', numberSpec);
    vi.advanceTimersByTime(LIVE_APPLY_DELAY_MS);
    session.revert();
    expect(update).toHaveBeenLastCalledWith({ panelCornerRadiusPx: 12 });
    update.mockClear();
    // The next show reverts again: with the session gone it cannot overwrite a value saved since.
    session.revert();
    vi.advanceTimersByTime(LIVE_APPLY_DELAY_MS * 5);
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a committed value and does not revert it', () => {
    const { session, update } = open();
    expect(session.commit(30)).toBe(true);
    expect(update).toHaveBeenCalledWith({ panelCornerRadiusPx: 30 });
    update.mockClear();
    session.revert();
    expect(update).not.toHaveBeenCalled();
  });

  it('keeps a preset that was taken with a click, whether or not an arrow previewed it', () => {
    const { session, update } = open();
    expect(session.commit(5)).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenLastCalledWith({ panelCornerRadiusPx: 5 });
    // Esc afterwards finds no session: the kept value is not put back to the starting one.
    session.revert();
    expect(update).toHaveBeenCalledTimes(1);

    const previewed = open();
    previewed.session.apply(8);
    expect(previewed.session.commit(8)).toBe(true);
    expect(previewed.update).toHaveBeenCalledTimes(1);
    previewed.session.revert();
    expect(previewed.update).toHaveBeenCalledTimes(1);
  });

  it('sends nothing for a click on the preset the stage started with', () => {
    const { session, update } = open();
    expect(session.commit(12)).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it('puts back a size list entry edited live', () => {
    const model = modelWith({ customPanelSizes: [400, 500] });
    const update = vi.fn();
    const session = createEditorSession({ model: () => model, update });
    session.begin({ kind: 'sizeEdit', index: 1 }, model);
    session.apply(520);
    expect(update).toHaveBeenLastCalledWith({ customPanelSizes: [400, 520] });
    session.revert();
    expect(update).toHaveBeenLastCalledWith({ customPanelSizes: [400, 500] });
  });

  describe('a slider', () => {
    it('applies the first change at once and sends only the latest of a quick run', () => {
      const { session, update } = open();
      session.slide(13);
      expect(update).toHaveBeenCalledTimes(1);
      expect(update).toHaveBeenLastCalledWith({ panelCornerRadiusPx: 13 });
      // A drag across the range: the steps in between never go out.
      for (const value of [14, 15, 16, 17, 18, 19, 20]) {
        vi.advanceTimersByTime(5);
        session.slide(value);
      }
      expect(update).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(LIVE_SLIDE_INTERVAL_MS);
      expect(update).toHaveBeenCalledTimes(2);
      expect(update).toHaveBeenLastCalledWith({ panelCornerRadiusPx: 20 });
    });

    it('keeps to a few writes a second over a long drag', () => {
      const { session, update } = open({ panelCornerRadiusPx: 0 });
      for (let value = 1; value <= 36; value++) {
        vi.advanceTimersByTime(10);
        session.slide(value);
      }
      vi.advanceTimersByTime(LIVE_SLIDE_INTERVAL_MS);
      // 36 steps over 360 ms: a first write, one per interval, and the last value.
      expect(update.mock.calls.length).toBeLessThanOrEqual(6);
      expect(update).toHaveBeenLastCalledWith({ panelCornerRadiusPx: 36 });
    });

    it('Enter after a drag keeps the final value even while its write is still waiting', () => {
      const { session, update } = open();
      session.slide(13);
      vi.advanceTimersByTime(5);
      session.slide(22);
      expect(session.commit(22)).toBe(true);
      expect(update).toHaveBeenLastCalledWith({ panelCornerRadiusPx: 22 });
      vi.advanceTimersByTime(LIVE_SLIDE_INTERVAL_MS * 5);
      expect(update).toHaveBeenCalledTimes(2);
      session.revert();
      expect(update).toHaveBeenCalledTimes(2);
    });

    it('Esc after a drag puts back the opening value and drops the waiting write', () => {
      const { session, update } = open({ panelCornerRadiusPx: 12 });
      session.slide(13);
      vi.advanceTimersByTime(5);
      session.slide(30);
      session.revert();
      vi.advanceTimersByTime(LIVE_SLIDE_INTERVAL_MS * 5);
      expect(update.mock.calls).toEqual([
        [{ panelCornerRadiusPx: 13 }],
        [{ panelCornerRadiusPx: 12 }],
      ]);
    });

    it('Esc before anything was sent sends nothing', () => {
      const { session, update } = open();
      session.revert();
      expect(update).not.toHaveBeenCalled();
    });

    it('sends nothing when the thumb comes back to the value it started with and is kept', () => {
      const { session, update } = open({ panelCornerRadiusPx: 12 });
      expect(session.commit(12)).toBe(true);
      expect(update).not.toHaveBeenCalled();
    });

    it('does nothing without a session', () => {
      const update = vi.fn();
      const session = createEditorSession({ model: () => null, update });
      session.slide(5);
      vi.advanceTimersByTime(LIVE_SLIDE_INTERVAL_MS * 2);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
