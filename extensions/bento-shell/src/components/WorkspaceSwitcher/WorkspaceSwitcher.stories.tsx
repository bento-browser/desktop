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
import { makeTab } from '../../state/__fixtures__/tabs';
import { useTabsStore } from '../../state/tabs';

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

export const DeleteWithTabs = () => {
  useEffect(() => {
    seedMany();
    // Seed 3 tabs assigned to the active 'w-work' workspace so the menu
    // shows the destructive "Delete Work" item against a non-empty
    // workspace (clicking it in real Bento opens the chrome confirm
    // overlay; in Ladle that overlay isn't mounted so the click just
    // broadcasts on 'bento-confirm-bus' with no visible effect — the
    // dialog itself can be exercised against confirm.html directly).
    useTabsStore
      .getState()
      .applySnapshot([
        makeTab({ id: 1, workspaceId: 'w-work', active: true }),
        makeTab({ id: 2, workspaceId: 'w-work' }),
        makeTab({ id: 3, workspaceId: 'w-work' }),
      ]);
  }, []);
  return (
    <HeaderFrame>
      <WorkspaceSwitcher />
    </HeaderFrame>
  );
};

DeleteWithTabs.storyName = 'Delete workspace with tabs (delete item visible)';

// Note: the Edit-workspace dialog now lives in its own chrome-mounted
// overlay (edit-workspace.html) like palette and confirm. Clicking the
// Edit menu item in Ladle just broadcasts on 'bento-edit-workspace-bus'
// with no visible effect — the form itself can be exercised against
// edit-workspace.html directly.
