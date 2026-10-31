// The left column: Back to the browser, the spaces (colour dot, name, link count), and "+ Space".
// Below ~1200px the stylesheet folds it to dots; the buttons keep their names for assistive
// technology and a native tooltip.

import { memo, useState } from 'react';
import { Button, Text } from '@muxui/react';
import ChevronLeft from 'lucide-react/dist/esm/icons/chevron-left';
import Plus from 'lucide-react/dist/esm/icons/plus';

import { BentoIcon } from '../primitives';
import { EntityMenu } from './EntityMenu';
import { InlineEditor } from './InlineEditor';
import type { SpaceSummary } from './model';
import { isEditing, type BookmarksAction, type EditTarget } from './types';

export interface SpacesListProps {
  spaces: SpaceSummary[];
  currentId: string | null;
  editing: EditTarget | null;
  send: (action: BookmarksAction) => void;
  onEdit: (target: EditTarget | null) => void;
  onClose: () => void;
  onDeleteSpace: (summary: SpaceSummary) => void;
}

interface SpaceRowProps {
  summary: SpaceSummary;
  selected: boolean;
  renaming: boolean;
  send: (action: BookmarksAction) => void;
  onEdit: (target: EditTarget | null) => void;
  onDeleteSpace: (summary: SpaceSummary) => void;
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
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <li
      className="bento-bookmarks__space"
      data-selected={selected ? 'true' : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {renaming ? (
        <div className="bento-bookmarks__space-main">
          <span className="bento-bookmarks__dot" data-bm-color={space.color} />
          <InlineEditor
            label="Space name"
            initial={space.name}
            selectAll
            onCommit={(text) => {
              const name = text.trim();
              if (name && name !== space.name) {
                send({ type: 'bookmarks/space/update', id: space.id, name });
              }
              onEdit(null);
            }}
            onCancel={() => onEdit(null)}
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
        deleteLabel="Delete space"
        color={space.color}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onRename={() => onEdit({ kind: 'space', id: space.id })}
        onColor={(color) => send({ type: 'bookmarks/space/update', id: space.id, color })}
        onDelete={() => onDeleteSpace(summary)}
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
          <span className="bento-bookmarks__back-label">Browser</span>
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
            onCommit={(text) => {
              const name = text.trim();
              if (name) send({ type: 'bookmarks/space/create', name });
              onEdit(null);
            }}
            onCancel={() => onEdit(null)}
          />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="bento-bookmarks__add"
            aria-label="Add space"
            title="Add space"
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
