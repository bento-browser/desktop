// The left column: "Back to browser", the spaces (colour dot, name, link count), and "+ Space".
// Below ~1200px the stylesheet folds it to dots and the Back button to its arrow; the buttons keep
// their names for assistive technology and a native tooltip. A right-click on a space opens the
// view's context menu (contextMenuModel.ts), which holds the same items as the space's "..." menu.

import { memo } from 'react';
import { Button, Text } from '@muxui/react';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { BOOKMARK_LIMITS } from '@shared/protocol';

import { BentoIcon } from '../primitives';
import { EntityMenu } from './EntityMenu';
import { InlineEditor } from './InlineEditor';
import { spaceEntries, type SpaceHandlers } from './menuEntries';
import type { SpaceSummary } from './model';
import { isEditing, type EditTarget } from './types';

export interface SpacesListProps extends SpaceHandlers {
  spaces: SpaceSummary[];
  currentId: string | null;
  editing: EditTarget | null;
  /** Adds a space (the caller sends the create and selects it once it exists). */
  onCreate: (name: string) => void;
  onClose: () => void;
}

interface SpaceRowProps extends SpaceHandlers {
  summary: SpaceSummary;
  selected: boolean;
  renaming: boolean;
}

const SpaceRow = memo(function SpaceRow({
  summary,
  selected,
  renaming,
  send,
  onEdit,
  onDeleteSpace,
}: SpaceRowProps) {
  const { space, linkCount } = summary;
  return (
    <li
      className="bento-bookmarks__space"
      data-bm-space-id={space.id}
      data-selected={selected ? 'true' : undefined}
    >
      {renaming ? (
        <div className="bento-bookmarks__space-main">
          <span className="bento-bookmarks__dot" data-bm-color={space.color} />
          <InlineEditor
            label="Space name"
            initial={space.name}
            selectAll
            maxLength={BOOKMARK_LIMITS.name}
            onCommit={(text, reason) => {
              const name = text.trim();
              if (name && name !== space.name) {
                send({ type: 'bookmarks/space/update', id: space.id, name });
              }
              onEdit(null, reason === 'enter');
            }}
            onCancel={() => onEdit(null, true)}
          />
        </div>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="bento-bookmarks__space-main"
          aria-current={selected ? 'true' : undefined}
          title={space.name}
          onActivate={() => send({ type: 'bookmarks/space/select', id: space.id })}
        >
          <span className="bento-bookmarks__dot" data-bm-color={space.color} />
          <Text variant="body" size="sm" truncate className="bento-bookmarks__space-name">
            {space.name}
          </Text>
          <Text variant="body" size="sm" color="muted" className="bento-bookmarks__count">
            {linkCount}
          </Text>
        </Button>
      )}
      <EntityMenu
        label={`Actions for ${space.name}`}
        entries={spaceEntries(summary, { send, onEdit, onDeleteSpace })}
      />
    </li>
  );
});

export function SpacesList({
  spaces,
  currentId,
  editing,
  send,
  onEdit,
  onCreate,
  onClose,
  onDeleteSpace,
}: SpacesListProps) {
  const adding = isEditing(editing, { kind: 'add-space' });
  return (
    <nav className="bento-bookmarks__spaces" aria-label="Spaces">
      <div className="bento-bookmarks__spaces-head">
        <Button
          variant="neutral"
          size="sm"
          className="bento-bookmarks__back"
          aria-label="Back to browser"
          title="Back to browser"
          onActivate={onClose}
        >
          <BentoIcon icon={ChevronLeft} size="sm" />
          <span className="bento-bookmarks__back-label">Back to browser</span>
        </Button>
      </div>
      <ul className="bento-bookmarks__space-list">
        {spaces.map((summary) => (
          <SpaceRow
            key={summary.space.id}
            summary={summary}
            selected={summary.space.id === currentId}
            renaming={isEditing(editing, { kind: 'space', id: summary.space.id })}
            send={send}
            onEdit={onEdit}
            onDeleteSpace={onDeleteSpace}
          />
        ))}
      </ul>
      <div className="bento-bookmarks__spaces-foot">
        {adding ? (
          <InlineEditor
            label="Space name"
            placeholder="Space name"
            maxLength={BOOKMARK_LIMITS.name}
            onCommit={(text, reason) => {
              const name = text.trim();
              if (name) onCreate(name);
              onEdit(null, reason === 'enter');
            }}
            onCancel={() => onEdit(null, true)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="bento-bookmarks__add"
            aria-label="Add space"
            title="Add space"
            data-bm-add-space
            onActivate={() => onEdit({ kind: 'add-space' })}
          >
            <BentoIcon icon={Plus} size="sm" />
            <span className="bento-bookmarks__add-label">Space</span>
          </Button>
        )}
      </div>
    </nav>
  );
}
