// Visual states for the PanelTrailer chrome-overlay component.
// The real shell mounts this inside a moz-extension iframe at the end of
// the chrome panel strip; the story renders it inside a fixed-width box
// that approximates the trailer's outer host so favicon-row growth +
// hover-tooltip placement can be eyeballed without running the browser.

import { useEffect } from 'react';
import { PanelTrailer } from './PanelTrailer';
import {
  MANY_SAVED_PANELS,
  SAMPLE_SAVED_PANELS,
  seedEmptySavedPanels,
  seedSavedPanels,
} from '../../state/__fixtures__/savedPanels';
import { useSavedPanelsStore } from '../../state/savedPanels';

function TrailerFrame({ children, width }: { children: React.ReactNode; width: number }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        width,
        height: 56,
        background: 'var(--bento-brand-bg)',
        borderRadius: 'var(--radius-m)',
        border: '1px dashed var(--bento-border-color-subtle, var(--neutral-30))',
      }}
    >
      {children}
    </div>
  );
}

const NOOP = () => {};

export const Empty = () => {
  useEffect(() => {
    seedEmptySavedPanels();
  }, []);
  const items = useSavedPanelsStore((s) => s.items);
  return (
    <TrailerFrame width={80}>
      <PanelTrailer items={items} onAddBlank={NOOP} onOpenSaved={NOOP} />
    </TrailerFrame>
  );
};

Empty.storyName = 'Empty (only "+" visible)';

export const ThreeSaved = () => {
  useEffect(() => {
    seedSavedPanels(SAMPLE_SAVED_PANELS);
  }, []);
  const items = useSavedPanelsStore((s) => s.items);
  return (
    <TrailerFrame width={200}>
      <PanelTrailer items={items} onAddBlank={NOOP} onOpenSaved={NOOP} />
    </TrailerFrame>
  );
};

ThreeSaved.storyName = 'Three saved (typical use)';

export const ManySaved = () => {
  useEffect(() => {
    seedSavedPanels(MANY_SAVED_PANELS);
  }, []);
  const items = useSavedPanelsStore((s) => s.items);
  return (
    <TrailerFrame width={600}>
      <PanelTrailer items={items} onAddBlank={NOOP} onOpenSaved={NOOP} />
    </TrailerFrame>
  );
};

ManySaved.storyName = 'Many saved (trailer growth)';

export const LongTitleTooltip = () => {
  useEffect(() => {
    seedSavedPanels([MANY_SAVED_PANELS.find((m) => m.title.startsWith('A very long'))!]);
  }, []);
  const items = useSavedPanelsStore((s) => s.items);
  return (
    <TrailerFrame width={120}>
      <PanelTrailer items={items} onAddBlank={NOOP} onOpenSaved={NOOP} />
    </TrailerFrame>
  );
};

LongTitleTooltip.storyName = 'Long title (tooltip readability)';

export const NarrowFrame = () => {
  useEffect(() => {
    seedSavedPanels(SAMPLE_SAVED_PANELS);
  }, []);
  const items = useSavedPanelsStore((s) => s.items);
  return (
    <TrailerFrame width={96}>
      <PanelTrailer items={items} onAddBlank={NOOP} onOpenSaved={NOOP} />
    </TrailerFrame>
  );
};

NarrowFrame.storyName = 'Narrow frame (buttons clipped on right)';
