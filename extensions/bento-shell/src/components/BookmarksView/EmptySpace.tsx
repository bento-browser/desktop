// A space with no groups: a drop zone for tabs, the first steps, and the one-time Firefox import
// offer. Dropping a tab here saves it into a new "Saved tabs" group (useBoardDrag). The "Group"
// button becomes the name field right here, because the board's own "+ Group" column does not
// exist until the space has a group.

import { Button, Text } from '@muxui/react';

import { AddGroup } from './AddGroup';
import type { EditHandler, EditTarget } from './types';

export interface EmptySpaceProps {
  tabCount: number;
  /** Offer the Firefox import (it has not been taken or declined). */
  offerImport: boolean;
  editing: EditTarget | null;
  onEdit: EditHandler;
  onCreateGroup: (name: string, viaKeyboard: boolean) => void;
  onSaveTabs: () => void;
  onImport: () => void;
  onDismissImport: () => void;
}

export function EmptySpace({
  tabCount,
  offerImport,
  editing,
  onEdit,
  onCreateGroup,
  onSaveTabs,
  onImport,
  onDismissImport,
}: EmptySpaceProps) {
  return (
    <div className="bento-bookmarks__empty" data-bm-drop-zone="empty" data-bm-board>
      <div className="bento-bookmarks__empty-box">
        <Text variant="label" size="md">
          Drop tabs here
        </Text>
        <Text variant="body" size="sm" color="muted">
          or start with a group
        </Text>
        <div className="bento-bookmarks__empty-actions">
          <AddGroup
            editing={editing}
            onEdit={onEdit}
            onCreate={onCreateGroup}
            buttonVariant="neutral"
          />
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
