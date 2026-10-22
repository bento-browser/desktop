import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEditorSession, LIVE_APPLY_DELAY_MS } from './editorSession';
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
});
