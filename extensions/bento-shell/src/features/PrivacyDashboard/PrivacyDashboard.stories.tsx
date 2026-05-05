// PrivacyDashboard visual story. Layer-3 features render their own page-level
// layout; the story just provides a sized container so it doesn't bleed to
// the Ladle viewport edges.

import { PrivacyDashboard } from './PrivacyDashboard';

function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        backgroundColor: 'var(--bento-brand-bg)',
        minHeight: '100vh',
      }}
    >
      {children}
    </div>
  );
}

export const Default = () => (
  <PageFrame>
    <PrivacyDashboard />
  </PageFrame>
);

Default.storyName = 'Default (all sections)';
