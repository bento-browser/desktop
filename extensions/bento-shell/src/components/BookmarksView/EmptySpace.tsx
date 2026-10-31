// A space with no groups: a drop zone for tabs, the first steps, and the one-time Firefox import
// offer. Dropping a tab here saves it into a new "Saved tabs" group (useBoardDrag).

import { Button, Text } from '@muxui/react';
import Plus from 'lucide-react/dist/esm/icons/plus';

import { BentoIcon } from '../primitives';

export interface EmptySpaceProps {
  tabCount: number;
  /** Offer the Firefox import (it has not been taken or declined). */
  offerImport: boolean;
  onAddGroup: () => void;
  onSaveTabs: () => void;
  onImport: () => void;
  onDismissImport: () => void;
}

export function EmptySpace({
  tabCount,
  offerImport,
  onAddGroup,
  onSaveTabs,
  onImport,
  onDismissImport,
}: EmptySpaceProps) {
  return (
    <div className="bento-bookmarks__empty" data-bm-drop-zone="empty">
      <div className="bento-bookmarks__empty-box">
        <Text variant="label" size="md">
          Drop tabs here
        </Text>
        <Text variant="body" size="sm" color="muted">
          or start with a group
        </Text>
        <div className="bento-bookmarks__empty-actions">
          <Button variant="neutral" size="sm" onActivate={onAddGroup}>
            <BentoIcon icon={Plus} size="sm" />
            Group
          </Button>
          {tabCount > 0 ? (
            <Button variant="neutral" size="sm" onActivate={onSaveTabs}>
              {`Save ${tabCount} open ${tabCount === 1 ? 'tab' : 'tabs'}`}
            </Button>
          ) : null}
        </div>
        {offerImport ? (
          <div className="bento-bookmarks__empty-import">
            <Text variant="body" size="sm" color="muted">
              Bring in your Firefox bookmarks once. They stay separate afterwards.
            </Text>
            <div className="bento-bookmarks__empty-actions">
              <Button variant="primary" size="sm" onActivate={onImport}>
                Import Firefox bookmarks
              </Button>
              <Button variant="ghost" size="sm" onActivate={onDismissImport}>
                Not now
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
