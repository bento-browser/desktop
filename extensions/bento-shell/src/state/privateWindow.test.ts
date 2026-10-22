import { describe, expect, it } from 'vitest';
import { activeWorkspaceIsPrivate } from './privateWindow';
import { seedDefault, seedPrivate } from './__fixtures__/workspaces';
import { useWorkspacesStore } from './workspaces';

describe('activeWorkspaceIsPrivate', () => {
  it('is false when the active workspace is a regular one', () => {
    seedDefault();
    expect(activeWorkspaceIsPrivate(useWorkspacesStore.getState(), null)).toBe(false);
  });

  it('is true when the active workspace is the temporary Private one', () => {
    seedPrivate();
    expect(activeWorkspaceIsPrivate(useWorkspacesStore.getState(), null)).toBe(true);
  });

  it('is false before any workspace has arrived', () => {
    useWorkspacesStore.getState().applySnapshot([], null, {});
    expect(activeWorkspaceIsPrivate(useWorkspacesStore.getState(), null)).toBe(false);
  });
});
