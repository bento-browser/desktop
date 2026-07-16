import { useState } from 'react';
import { Column } from '@tale-ui/react/column';

import { WorkspaceThemePicker } from './WorkspaceThemePicker';

export const Default = () => {
  const [themeId, setThemeId] = useState('standard-blueprint');

  return (
    <Column gap="m" style={{ padding: 'var(--space-l)' }}>
      <WorkspaceThemePicker
        workspaceName="Workspace 2"
        selectedThemeId={themeId}
        onThemeChange={setThemeId}
      />
    </Column>
  );
};

Default.storyName = 'Default';

export const LongWorkspaceName = () => {
  const [themeId, setThemeId] = useState('monochrome-mountain-meadow');

  return (
    <Column gap="m" style={{ padding: 'var(--space-l)' }}>
      <WorkspaceThemePicker
        workspaceName="Research workspace with an intentionally long name"
        selectedThemeId={themeId}
        onThemeChange={setThemeId}
      />
    </Column>
  );
};

LongWorkspaceName.storyName = 'Long workspace name';
