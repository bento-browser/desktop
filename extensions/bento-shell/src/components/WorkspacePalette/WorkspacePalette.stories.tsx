// WorkspacePalette visual stories. The chrome host opens this component from
// workspace-palette.html in real Bento; Ladle renders the mounted palette
// directly for layout and state checks.

import { useEffect } from 'react';
import { WorkspacePalette } from './WorkspacePalette';
import { makeTab } from '../../state/__fixtures__/tabs';
import { makeWorkspace, seedMany, seedWorkspaces } from '../../state/__fixtures__/workspaces';
import { useTabsStore } from '../../state/tabs';
import { BENTO_THEMES } from '../../theme/presets';

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
      makeWorkspace({ id: 'w-personal', name: 'Personal', icon: '🏠', createdAt: 1 }),
      makeWorkspace({ id: 'w-work', name: 'Work', themeId: 'teal', icon: '💼', createdAt: 2 }),
      makeWorkspace({
        id: 'w-research',
        name: 'Research with a longer name',
        themeId: 'forest',
        icon: '🔬',
        createdAt: 3,
      }),
      makeWorkspace({ id: 'w-side', name: 'Side project', themeId: 'terracotta', createdAt: 4 }),
      makeWorkspace({
        id: 'w-admin',
        name: 'Admin',
        themeId: 'antique',
        icon: 'Ops',
        createdAt: 5,
      }),
      makeWorkspace({
        id: 'w-read',
        name: 'Reading',
        themeId: 'rosewater',
        icon: '📚',
        createdAt: 6,
      }),
    ];
    seedWorkspaces(workspaces, 'w-research');
  }, []);

  return <WorkspacePalette onClose={() => {}} />;
};

ManyWorkspaces.storyName = 'Scrollable workspace manager';

export const AllThemeWorkspaces = () => {
  useEffect(() => {
    const workspaces = BENTO_THEMES.map((theme, index) =>
      makeWorkspace({
        id: `w-theme-${theme.id}`,
        name:
          theme.id === 'mountain-meadow'
            ? 'Mountain Meadow workspace with a name that should truncate'
            : `${theme.name} workspace`,
        themeId: theme.id,
        icon: index % 3 === 0 ? '⭐' : index % 3 === 1 ? undefined : theme.name[0],
        createdAt: index + 1,
      }),
    );
    seedWorkspaces(workspaces, 'w-theme-mountain-meadow');
  }, []);

  return <WorkspacePalette onClose={() => {}} />;
};

AllThemeWorkspaces.storyName = 'All workspace themes';

export const IconStates = () => {
  useEffect(() => {
    seedWorkspaces(
      [
        makeWorkspace({ id: 'w-emoji', name: 'Emoji icon workspace', icon: '🚀', createdAt: 1 }),
        makeWorkspace({ id: 'w-empty', name: 'Workspace without an icon', createdAt: 2 }),
        makeWorkspace({
          id: 'w-legacy-letter',
          name: 'Legacy single-letter icon',
          icon: 'W',
          themeId: 'teal',
          createdAt: 3,
        }),
        makeWorkspace({
          id: 'w-legacy-word',
          name: 'Legacy multi-character icon with a long workspace name',
          icon: 'Ops',
          themeId: 'forest',
          createdAt: 4,
        }),
      ],
      'w-emoji',
    );
  }, []);

  return <WorkspacePalette onClose={() => {}} />;
};

IconStates.storyName = 'Workspace icon states';
