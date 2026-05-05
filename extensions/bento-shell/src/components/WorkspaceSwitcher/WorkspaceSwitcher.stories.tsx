// WorkspaceSwitcher visual stories. Open the menu in each story to verify
// the popover styling, accent dots, and active-row indicator render correctly.

import { useEffect } from 'react';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import {
  seedDefault,
  seedEmpty,
  seedLongName,
  seedMany,
} from '../../state/__fixtures__/workspaces';

function HeaderFrame({ children, width = 240 }: { children: React.ReactNode; width?: number }) {
  return (
    <div
      style={{
        width,
        backgroundColor: 'var(--bento-brand-bg)',
        padding: 'var(--space-xs)',
      }}
    >
      {children}
    </div>
  );
}

export const SingleWorkspace = () => {
  useEffect(() => {
    seedDefault();
  }, []);
  return (
    <HeaderFrame>
      <WorkspaceSwitcher />
    </HeaderFrame>
  );
};

SingleWorkspace.storyName = 'Single workspace (first boot)';

export const MultipleWorkspaces = () => {
  useEffect(() => {
    seedMany();
  }, []);
  return (
    <HeaderFrame>
      <WorkspaceSwitcher />
    </HeaderFrame>
  );
};

MultipleWorkspaces.storyName = '3 workspaces (Work active)';

export const LongName = () => {
  useEffect(() => {
    seedLongName();
  }, []);
  return (
    <HeaderFrame>
      <WorkspaceSwitcher />
    </HeaderFrame>
  );
};

LongName.storyName = 'Long workspace name (truncation)';

export const NoActiveWorkspace = () => {
  useEffect(() => {
    seedEmpty();
  }, []);
  return (
    <HeaderFrame>
      <WorkspaceSwitcher />
    </HeaderFrame>
  );
};

NoActiveWorkspace.storyName = 'Empty (no workspaces — fallback state)';
