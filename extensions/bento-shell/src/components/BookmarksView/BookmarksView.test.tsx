import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  EMPTY_SPACE_SNAPSHOT,
  LOAD_FAILED_SNAPSHOT,
  SAMPLE_SNAPSHOT,
  SAMPLE_TABS,
} from '../../state/__fixtures__/bookmarks';
import { AddGroup } from './AddGroup';
import BookmarksView, { type BookmarksViewProps } from './BookmarksView';

const render = (props: Partial<BookmarksViewProps> = {}) =>
  renderToStaticMarkup(
    <BookmarksView
      snapshot={SAMPLE_SNAPSHOT}
      openTabs={SAMPLE_TABS}
      send={() => {}}
      onClose={() => {}}
      {...props}
    />,
  );

describe('a failed load', () => {
  const markup = render({ snapshot: LOAD_FAILED_SNAPSHOT });

  it('shows the notice with Retry instead of an editable board', () => {
    expect(markup).toContain('Bookmarks couldn&#x27;t load');
    expect(markup).toContain('Retry');
    expect(markup).toContain('role="alert"');
    for (const editable of ['Add space', 'Add group', 'bento-bookmarks__boards', 'Open tabs']) {
      expect(markup).not.toContain(editable);
    }
  });

  it('shows the board again for a ready snapshot', () => {
    expect(render()).not.toContain('Bookmarks couldn&#x27;t load');
  });
});

describe('the first group of an empty space', () => {
  it('is a "Group" button in the empty space until it is clicked', () => {
    const markup = render({ snapshot: EMPTY_SPACE_SNAPSHOT });
    expect(markup).toContain('data-bm-drop-zone="empty"');
    expect(markup).toContain('data-bm-add-group');
  });

  it('becomes a name field there, capped like the stored name', () => {
    const markup = render({
      snapshot: EMPTY_SPACE_SNAPSHOT,
      initialEditing: { kind: 'add-group' },
    });
    expect(markup).toContain('aria-label="Group name"');
    expect(markup).toContain('maxLength="1024"');
    expect(markup).not.toContain('data-bm-add-group');
  });

  it('creates the group on Enter and hands the focus back on a key, not on blur', () => {
    const onCreate = vi.fn();
    const onEdit = vi.fn();
    const field = AddGroup({
      editing: { kind: 'add-group' },
      onEdit,
      onCreate,
      buttonVariant: 'neutral',
    }) as ReactElement<{
      onCommit(text: string, reason: 'enter' | 'blur'): void;
      onCancel(): void;
    }>;

    field.props.onCommit('  Gyms ', 'enter');
    expect(onCreate).toHaveBeenLastCalledWith('Gyms', true);
    expect(onEdit).toHaveBeenLastCalledWith(null, true);

    field.props.onCommit('Parks', 'blur');
    expect(onCreate).toHaveBeenLastCalledWith('Parks', false);
    expect(onEdit).toHaveBeenLastCalledWith(null, false);

    onCreate.mockClear();
    field.props.onCommit('   ', 'enter');
    expect(onCreate).not.toHaveBeenCalled();

    field.props.onCancel();
    expect(onEdit).toHaveBeenLastCalledWith(null, true);
  });
});

describe('keyboard alternatives to dragging', () => {
  it('give every row one More actions menu and no other action buttons', () => {
    const markup = render();
    // 18 links, 2 notes and 2 to-dos each have one hover action: the menu trigger.
    expect(markup.match(/data-bm-actions="1"/g)).toHaveLength(22);
    expect(markup.match(/data-bm-item-menu/g)).toHaveLength(22);
    expect(markup.match(/aria-label="More actions"/g)).toHaveLength(22);
    for (const direct of ['Open in panel', 'Open in tab', 'Edit', 'Delete', 'Move']) {
      expect(markup).not.toContain(`aria-label="${direct}"`);
    }
  });

  it('give every column header a menu that can hold Move left and Move right', () => {
    const markup = render();
    expect(markup).toContain('aria-label="Actions for Gyms"');
    expect(markup.match(/data-bm-menu-trigger/g)).toHaveLength(4 + SAMPLE_SNAPSHOT.spaces.length);
  });

  it('give each open tab in the drawer a focusable Save to group menu', () => {
    const markup = render({ initialDrawerOpen: true });
    expect(markup.match(/data-bm-actions="1"/g)).toHaveLength(22 + SAMPLE_TABS.length);
    expect(markup).toContain('aria-label="Save Moon Board"');
  });

  it('leave search results without hover actions, so their text is not masked', () => {
    const markup = render({ initialQuery: 'gear' });
    expect(markup).toContain('bento-bookmarks__result-group');
    expect(markup).not.toContain('data-bm-actions');
  });
});
