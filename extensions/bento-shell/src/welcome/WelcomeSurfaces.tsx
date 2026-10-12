// Welcome surfaces that main.tsx shares with Ladle. main.tsx runs the tools
// port and mounts React at import time, so a story cannot import it.

import { Text } from '@muxui/react';
import type { LucideIcon } from 'lucide-react/dist/lucide-react';
import type { PrivacyLevelDetails } from '@shared/privacy-levels';

import { Column } from '../components/primitives/BentoColumn';
import { BentoIcon } from '../components/primitives/BentoIcon';

/** Decorative 3-column tray: the active step's hero cell plus four label/detail cells. */
export function BentoTray({
  icon,
  eyebrow,
  boxes,
}: {
  icon: LucideIcon;
  eyebrow: string;
  boxes: readonly (readonly [string, string])[];
}) {
  return (
    <div className="bento-welcome__tray" aria-hidden="true">
      <div className="bento-welcome__tray-cell bento-welcome__tray-cell--hero">
        <span className="bento-welcome__tray-icon">
          <BentoIcon icon={icon} size="lg" />
        </span>
        <Text variant="label" size="md">
          {eyebrow}
        </Text>
        <Text variant="body" size="sm" color="muted">
          Bento keeps the browser surface divided into useful, durable compartments.
        </Text>
      </div>
      {boxes.map(([label, detail]) => (
        <div className="bento-welcome__tray-cell" key={`${label}-${detail}`}>
          <Text variant="label" size="sm">
            {label}
          </Text>
          <Text variant="body" size="xs" color="muted">
            {detail}
          </Text>
        </div>
      ))}
    </div>
  );
}

/** Tinted well under the privacy level picker describing the selected level. */
export function PrivacySummary({ detail }: { detail: PrivacyLevelDetails }) {
  return (
    <Column gap="2xs" className="bento-welcome__privacy-summary">
      <Text variant="label" size="sm">
        {detail.label}
      </Text>
      <Text variant="body" size="sm" color="muted">
        {detail.bestFor}
      </Text>
      <Text variant="body" size="sm" color="muted">
        Benefit: {detail.benefits[0]}
      </Text>
      <Text variant="body" size="sm" color="muted">
        Caveat: {detail.caveats[0]}
      </Text>
    </Column>
  );
}
