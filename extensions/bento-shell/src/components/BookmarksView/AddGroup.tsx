// The "+ Group" control: a button that becomes a name field. It is the trailing column of a board
// and the "Group" button of an empty space, so a space with no groups can get its first one.
// Creating is the caller's (`onCreate`), because it sends the create with a client id and follows
// up on it.

import type { ComponentProps } from 'react';
import { Button } from '@muxui/react';
import Plus from 'lucide-react/dist/esm/icons/plus';
import { BOOKMARK_LIMITS } from '@shared/protocol';

import { BentoIcon } from '../primitives';
import { InlineEditor } from './InlineEditor';
import { isEditing, type EditHandler, type EditTarget } from './types';

export interface AddGroupProps {
  editing: EditTarget | null;
  onEdit: EditHandler;
  /** `viaKeyboard` is true when Enter answered the field. */
  onCreate: (name: string, viaKeyboard: boolean) => void;
  buttonVariant: ComponentProps<typeof Button>['variant'];
  buttonClassName?: string;
}

export function AddGroup({
  editing,
  onEdit,
  onCreate,
  buttonVariant,
  buttonClassName,
}: AddGroupProps) {
  if (isEditing(editing, { kind: 'add-group' })) {
    return (
      <InlineEditor
        label="Group name"
        placeholder="Group name"
        maxLength={BOOKMARK_LIMITS.name}
        onCommit={(text, reason) => {
          const name = text.trim();
          if (name) onCreate(name, reason === 'enter');
          onEdit(null, reason === 'enter');
        }}
        onCancel={() => onEdit(null, true)}
      />
    );
  }
  return (
    <Button
      variant={buttonVariant}
      size="sm"
      className={buttonClassName}
      aria-label="Add group"
      data-bm-add-group
      onActivate={() => onEdit({ kind: 'add-group' })}
    >
      <BentoIcon icon={Plus} size="sm" />
      Group
    </Button>
  );
}
