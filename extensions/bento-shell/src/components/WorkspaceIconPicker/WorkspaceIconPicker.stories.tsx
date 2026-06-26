import { useState } from 'react';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';

import { WorkspaceIconField } from './WorkspaceIconPicker';

function StoryFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 320, padding: 'var(--space-m)', background: 'var(--neutral-5)' }}>
      {children}
    </div>
  );
}

function StatefulField({
  name,
  initialValue,
  fallback,
}: {
  name: string;
  initialValue?: string | undefined;
  fallback: string;
}) {
  const [value, setValue] = useState<string | undefined>(initialValue);
  return (
    <Row gap="s" align="center">
      <WorkspaceIconField
        workspaceName={name}
        value={value}
        fallback={fallback}
        onIconChange={setValue}
      />
      <Text variant="text" size="s">
        {name}
      </Text>
    </Row>
  );
}

export const Fallback = () => (
  <StoryFrame>
    <StatefulField name="Research" fallback="R" />
  </StoryFrame>
);

export const Emoji = () => (
  <StoryFrame>
    <StatefulField name="Travel" initialValue="✈️" fallback="T" />
  </StoryFrame>
);

export const LegacyCustom = () => (
  <StoryFrame>
    <StatefulField name="Operations" initialValue="Ops" fallback="O" />
  </StoryFrame>
);

LegacyCustom.storyName = 'Legacy custom icon';

export const StateMatrix = () => (
  <StoryFrame>
    <Column gap="s">
      <StatefulField name="Fallback" fallback="F" />
      <StatefulField name="Emoji" initialValue="🚀" fallback="E" />
      <StatefulField name="Legacy custom" initialValue="Ops" fallback="L" />
    </Column>
  </StoryFrame>
);

StateMatrix.storyName = 'Icon field states';
