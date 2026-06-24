// WorkspacePalette visual stories. The chrome host opens this component from
// workspace-palette.html in real Bento; Ladle renders the mounted palette
// directly for layout and state checks.

import { useEffect } from 'react';
import { WorkspacePalette } from './WorkspacePalette';
import { makeTab } from '../../state/__fixtures__/tabs';
import { makeWorkspace, seedMany, seedWorkspaces } from '../../state/__fixtures__/workspaces';
import { useTabsStore } from '../../state/tabs';

export const Default = () => {
  useEffect(() => {
    seedMany();
    useTabsStore
      .getState()
      .applySnapshot([
        makeTab({ id: 1, workspaceId: 'w-personal' }),
        makeTab({ id: 2, workspaceId: 'w-work', active: true }),
        makeTab({ id: 3, workspaceId: 'w-work' }),
      ]);
  }, []);

  return <WorkspacePalette onClose={() => {}} />;
};

Default.storyName = 'Workspace manager';

export const ManyWorkspaces = () => {
  useEffect(() => {
    const workspaces = [
      makeWorkspace({ id: 'w-personal', name: 'Personal', createdAt: 1 }),
      makeWorkspace({ id: 'w-work', name: 'Work', themeId: 'teal', icon: 'W', createdAt: 2 }),
      makeWorkspace({
        id: 'w-research',
        name: 'Research with a longer name',
        themeId: 'forest',
        icon: 'R',
        createdAt: 3,
      }),
      makeWorkspace({ id: 'w-side', name: 'Side project', themeId: 'terracotta', createdAt: 4 }),
      makeWorkspace({ id: 'w-admin', name: 'Admin', themeId: 'antique', createdAt: 5 }),
      makeWorkspace({ id: 'w-read', name: 'Reading', themeId: 'rosewater', createdAt: 6 }),
    ];
    seedWorkspaces(workspaces, 'w-research');
  }, []);

  return <WorkspacePalette onClose={() => {}} />;
};

ManyWorkspaces.storyName = 'Scrollable workspace manager';
