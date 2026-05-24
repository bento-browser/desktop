// Fake workspace data for Ladle stories — seeds useWorkspacesStore so
// layer-2 components can be exercised in isolation without needing
// bento-tools or storage.local.

import type { Workspace } from '@shared/protocol';
import { useWorkspacesStore } from '../workspaces';

export function makeWorkspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  const { id, ...rest } = overrides;
  return {
    id,
    name: 'Workspace',
    createdAt: 0,
    ...rest,
  };
}

export function seedWorkspaces(
  workspaces: Workspace[],
  activeId: string | null,
  activeIdByWindow: Record<number, string> = {},
): void {
  useWorkspacesStore.getState().applySnapshot(workspaces, activeId, activeIdByWindow);
}

export function seedDefault(): Workspace[] {
  const workspaces: Workspace[] = [
    makeWorkspace({ id: 'w-personal', name: 'Personal', createdAt: 1 }),
  ];
  seedWorkspaces(workspaces, 'w-personal');
  return workspaces;
}

export function seedMany(): Workspace[] {
  const workspaces: Workspace[] = [
    makeWorkspace({ id: 'w-personal', name: 'Personal', createdAt: 1 }),
    makeWorkspace({ id: 'w-work', name: 'Work', themeId: 'teal', createdAt: 2 }),
    makeWorkspace({ id: 'w-side', name: 'Side project', themeId: 'terracotta', createdAt: 3 }),
  ];
  seedWorkspaces(workspaces, 'w-work');
  return workspaces;
}

export function seedLongName(): Workspace[] {
  const workspaces: Workspace[] = [
    makeWorkspace({
      id: 'w-long',
      name: 'A very long workspace name that needs to truncate',
      themeId: 'rosewater',
      createdAt: 1,
    }),
  ];
  seedWorkspaces(workspaces, 'w-long');
  return workspaces;
}

export function seedEmpty(): void {
  seedWorkspaces([], null);
}
