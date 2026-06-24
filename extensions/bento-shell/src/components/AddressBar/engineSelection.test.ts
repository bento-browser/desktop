import { describe, expect, it } from 'vitest';
import { applyDefaultEngineIfClean, chooseEngine, resetEngineSelection } from './engineSelection';

describe('address bar engine selection', () => {
  it('applies late default snapshots while the selection is clean', () => {
    const initial = resetEngineSelection(null);

    expect(applyDefaultEngineIfClean(initial, 'ddg')).toEqual({
      selectedSearchEngineId: 'ddg',
      engineSelectionDirty: false,
    });
  });

  it('does not overwrite a dirty user-selected engine with a late snapshot', () => {
    const selected = chooseEngine(resetEngineSelection('ddg'), 'google');

    expect(applyDefaultEngineIfClean(selected, 'ddg')).toEqual({
      selectedSearchEngineId: 'google',
      engineSelectionDirty: true,
    });
  });

  it('resets to the latest default on a new open', () => {
    const selected = chooseEngine(resetEngineSelection('ddg'), 'google');

    expect(selected.engineSelectionDirty).toBe(true);
    expect(resetEngineSelection('ddg')).toEqual({
      selectedSearchEngineId: 'ddg',
      engineSelectionDirty: false,
    });
  });
});
