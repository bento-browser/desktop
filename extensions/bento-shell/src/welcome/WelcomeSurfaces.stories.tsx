// Visual states for the welcome tray and privacy summary. The real welcome
// renders them inside a Mux Dialog (surface-raised); the frame below uses the
// same surface so the cell and well fills read against it as they do in the shell.

import type { ReactNode } from 'react';
import Download from 'lucide-react/dist/esm/icons/download';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';
import { PRIVACY_LEVELS, PRIVACY_LEVEL_DETAILS } from '@shared/privacy-levels';

import { BentoTray, PrivacySummary } from './WelcomeSurfaces';
import './welcome.css';

function DialogFrame({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div
      style={{
        boxSizing: 'border-box',
        width,
        padding: 'var(--space-l)',
        borderRadius: 'var(--radius-l)',
        border: '1px solid var(--muxui-semantic-border-subtle)',
        background: 'var(--muxui-semantic-surface-raised)',
      }}
    >
      {children}
    </div>
  );
}

export const Tray = () => (
  <DialogFrame width={560}>
    <BentoTray
      icon={Sparkles}
      eyebrow="First box"
      boxes={[
        ['Main', 'Your active page'],
        ['Panels', 'Useful pages beside it'],
        ['Workspaces', 'Task-specific boxes'],
        ['Theme', 'A visual identity per box'],
      ]}
    />
  </DialogFrame>
);

Tray.storyName = 'Tray (hero cell + four cells)';

export const TrayNarrow = () => (
  <DialogFrame width={320}>
    <BentoTray
      icon={Download}
      eyebrow="Import"
      boxes={[
        ['Bookmarks', 'Saved places'],
        ['History', 'Recent trails'],
        ['Passwords', 'Logins'],
        ['Profiles', 'Other browsers'],
      ]}
    />
  </DialogFrame>
);

TrayNarrow.storyName = 'Tray (narrow, long labels wrap)';

export const PrivacySummaryLevels = () => (
  <DialogFrame width={420}>
    <div style={{ display: 'grid', gap: 'var(--space-s)' }}>
      {PRIVACY_LEVELS.map((level) => (
        <PrivacySummary key={level.id} detail={PRIVACY_LEVEL_DETAILS[level.id]} />
      ))}
    </div>
  </DialogFrame>
);

PrivacySummaryLevels.storyName = 'Privacy summary (all levels)';
