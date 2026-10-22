import { useEffect, useState } from 'react';
import { Button, Popover, Text } from '@muxui/react';
import VenetianMask from 'lucide-react/dist/esm/icons/venetian-mask';

import { BentoIcon, Column } from '../primitives';
import { useRailTooltip } from '../MergeProgressCard/railTooltip';
import './PrivateBand.css';

export const PRIVATE_BAND_TITLE = 'Private';
export const PRIVATE_BAND_SUMMARY = 'Nothing here is saved.';
export const PRIVATE_NOTE_TITLE = 'Private window';
export const PRIVATE_NOTE_BODY = 'Tabs and panels are not saved. Closing the window discards them.';

export interface PrivateBandProps {
  /**
   * The sidebar is the narrow rail: the band is a glyph-only block. The note would be
   * clipped by the rail's frame, so it shows in the chrome-side tooltip overlay beside the
   * block instead (railTooltip.ts). The layout follows the shell's own width in CSS; this
   * only switches how the note opens, like the merge card's.
   */
  rail?: boolean;
  /** Starts with the note open (stories). */
  defaultNoteOpen?: boolean;
}

/**
 * The mark of a private window, in the place the workspace switcher takes in a regular
 * one: an inverted block reading "Private" over "Nothing here is saved.". Activating it
 * opens a read-only note. A private window has one temporary workspace, so there is
 * nothing to switch, create or edit here.
 */
export function PrivateBand({ rail = false, defaultNoteOpen = false }: PrivateBandProps) {
  const [noteOpen, setNoteOpen] = useState(defaultNoteOpen);
  useEffect(() => {
    if (rail) setNoteOpen(false);
  }, [rail]);
  const tooltip = useRailTooltip(rail, { label: PRIVATE_NOTE_TITLE, detail: PRIVATE_NOTE_BODY });

  const button = (
    <Button
      variant="ghost"
      className="bento-private-band__button"
      aria-label={rail ? `${PRIVATE_NOTE_TITLE}. ${PRIVATE_NOTE_BODY}` : undefined}
    >
      <BentoIcon icon={VenetianMask} size="lg" className="bento-private-band__icon" />
      <span className="bento-private-band__text">
        <Text variant="label" size="sm" truncate className="bento-private-band__title">
          {PRIVATE_BAND_TITLE}
        </Text>
        <Text variant="body" size="xs" truncate className="bento-private-band__summary">
          {PRIVATE_BAND_SUMMARY}
        </Text>
      </span>
    </Button>
  );

  return (
    <div className="bento-private-band" {...tooltip}>
      {rail ? (
        button
      ) : (
        <Popover
          open={noteOpen}
          onOpenChange={setNoteOpen}
          modal={false}
          placement="bottom-start"
          offset={4}
          aria-label={PRIVATE_NOTE_TITLE}
          className="bento-private-band__note"
          trigger={button}
        >
          <Column gap="4xs">
            <Text variant="label" size="sm">
              {PRIVATE_NOTE_TITLE}
            </Text>
            <Text variant="body" size="sm" color="muted">
              {PRIVATE_NOTE_BODY}
            </Text>
          </Column>
        </Popover>
      )}
    </div>
  );
}
