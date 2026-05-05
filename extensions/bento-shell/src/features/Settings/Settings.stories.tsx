// Settings visual stories. Layer-3 feature — provides its own page-level
// layout, so the story just sizes a container.

import { useEffect } from 'react';
import { Settings } from './Settings';
import { seedDefault, seedDisabledSleep, seedLoading } from '../../state/__fixtures__/settings';

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ backgroundColor: 'var(--bento-brand-bg)', minHeight: '100vh' }}>{children}</div>
  );
}

export const Default = () => {
  useEffect(() => seedDefault(), []);
  return (
    <PageFrame>
      <Settings />
    </PageFrame>
  );
};

Default.storyName = 'Default (sleep enabled)';

export const SleepDisabled = () => {
  useEffect(() => seedDisabledSleep(), []);
  return (
    <PageFrame>
      <Settings />
    </PageFrame>
  );
};

SleepDisabled.storyName = 'Sleep disabled (NumberFields dim)';

export const Loading = () => {
  useEffect(() => seedLoading(), []);
  return (
    <PageFrame>
      <Settings />
    </PageFrame>
  );
};

Loading.storyName = 'Loading (no snapshot from tools yet)';
