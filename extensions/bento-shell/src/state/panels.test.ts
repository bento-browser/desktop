import { beforeEach, describe, expect, it } from 'vitest';
import { usePanelsStore } from './panels';

describe('panels store', () => {
  beforeEach(() => {
    usePanelsStore.setState({ byWorkspace: new Map(), hydratedWorkspaces: new Set() });
  });

  it('keeps the same state when applied ids are unchanged', () => {
    const { apply } = usePanelsStore.getState();
    apply('w1', [1, 2]);
    const before = usePanelsStore.getState().byWorkspace;
    apply('w1', [1, 2, 2]);
    expect(usePanelsStore.getState().byWorkspace).toBe(before);
  });

  it('replaces the map when the order or membership differs', () => {
    const { apply } = usePanelsStore.getState();
    apply('w1', [1, 2]);
    const first = usePanelsStore.getState().byWorkspace;
    apply('w1', [2, 1]);
    const reordered = usePanelsStore.getState().byWorkspace;
    expect(reordered).not.toBe(first);
    expect([...reordered.get('w1')!]).toEqual([2, 1]);
    apply('w1', [2, 3]);
    const changed = usePanelsStore.getState().byWorkspace;
    expect(changed).not.toBe(reordered);
    expect([...changed.get('w1')!]).toEqual([2, 3]);
  });
});
