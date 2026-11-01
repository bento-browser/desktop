// Bookmark popup stories: the save popover (a page that is already saved, one that is saved by
// opening the popover into the default group, a first run that creates "Unsorted", a failed load)
// and the toolbar's menus (a group, an empty group, a group with a long title and one with many
// links, the Spaces switcher, the overflow). Each story edits a local copy of its fixture through
// `useFakeBookmarks`, so Space, Group, Name and Remove work. The popup is drawn over a dashed box
// that stands for the button that opened it. Closing is counted on <body> (`closeRequests`), and
// "Open in Bookmarks" in `openBookmarksRequests`. Switch Ladle's theme toggle for dark and light.
// Nothing here reaches the tools port or chrome.

import { useState } from 'react';
import { Button } from '@muxui/react';
import type { BookmarksSnapshot } from '@shared/protocol';

import type { BookmarkPopupRequest, PopupRect } from '../../bridge/bookmarkPopup';
import {
  FIRST_RUN_SNAPSHOT,
  LOAD_FAILED_SNAPSHOT,
  MANY_SNAPSHOT,
  SAMPLE_SNAPSHOT,
  SAMPLE_TABS,
  applyFakeAction,
  useFakeBookmarks,
} from '../../state/__fixtures__/bookmarks';
import { BookmarkPopup } from './BookmarkPopup';

const count = (name: string) => {
  document.body.dataset[name] = String(Number(document.body.dataset[name] ?? 0) + 1);
};

/** Where the sidebar star sits in a 1040px window, and a toolbar button near its left edge. */
const STAR: PopupRect = { left: 228, top: 52, width: 24, height: 24 };
const TOOLBAR_BUTTON: PopupRect = { left: 24, top: 52, width: 96, height: 24 };
const TOOLBAR_END: PopupRect = { left: 800, top: 52, width: 112, height: 24 };

/** The button the popup is anchored to. */
function AnchorMock({ anchor }: { anchor: PopupRect }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        ...anchor,
        boxSizing: 'border-box',
        border: '1px dashed var(--muxui-semantic-border-default)',
        borderRadius: 'var(--muxui-semantic-shape-radius-xs)',
      }}
    />
  );
}

function Story({
  request,
  snapshot = SAMPLE_SNAPSHOT,
}: {
  request: BookmarkPopupRequest;
  snapshot?: BookmarksSnapshot;
}) {
  const fake = useFakeBookmarks(snapshot, SAMPLE_TABS);
  const [open, setOpen] = useState(true);
  return (
    <div style={{ minHeight: 560 }}>
      <AnchorMock anchor={request.anchor} />
      {open ? (
        <BookmarkPopup
          request={request}
          snapshot={fake.snapshot}
          send={fake.send}
          onClose={() => {
            count('closeRequests');
            setOpen(false);
          }}
          onOpenBookmarks={() => count('openBookmarksRequests')}
        />
      ) : (
        <Button variant="neutral" size="sm" onActivate={() => setOpen(true)}>
          Open again
        </Button>
      )}
    </div>
  );
}

const edit = (url: string, title: string, tabId = 101): BookmarkPopupRequest => ({
  kind: 'edit',
  tabId,
  url,
  title,
  anchor: STAR,
});

/** The page is already a link (Personal / Reading): the popover edits it. */
export const EditSavedPage = () => (
  <Story request={edit('https://news.ycombinator.com/', 'Hacker News', 150)} />
);

/** A page that is not saved: opening the popover saves it into the default group (the group of
 * the current space's newest link), then the form shows. */
export const EditNewPage = () => (
  <Story request={edit('https://etch.app/signup', 'Sign up | Etch', 101)} />
);

/** A first run has no group: the popover creates "Unsorted" in the space and saves into it. */
export const EditFirstRun = () => (
  <Story
    request={edit('https://etch.app/signup', 'Sign up | Etch', 101)}
    snapshot={FIRST_RUN_SNAPSHOT}
  />
);

/** A link with a very long title: the name field scrolls, the group names truncate. */
export const EditLongTitle = () => (
  <Story
    request={edit(
      'https://gearjunkie.com/climbing/best-chalk-bags-and-the-long-url-that-follows',
      'The complete beginner-to-expert chalk bag roundup',
      150,
    )}
  />
);

/** The store could not read its data: nothing was saved, and Retry asks again. */
export const EditLoadFailed = () => (
  <Story
    request={edit('https://etch.app/signup', 'Sign up | Etch')}
    snapshot={LOAD_FAILED_SNAPSHOT}
  />
);

/** A toolbar group: its links, then Open all in panels and Open in Bookmarks. One link has no
 * icon, so it shows the globe. */
export const GroupMenu = () => (
  <Story request={{ kind: 'group', groupId: 'group-apps', anchor: TOOLBAR_BUTTON }} />
);

/** Titles that are longer than the menu truncate. */
export const GroupMenuLongTitle = () => (
  <Story request={{ kind: 'group', groupId: 'group-gear', anchor: TOOLBAR_BUTTON }} />
);

/** A group with no links: "No links", and Open all in panels is disabled. */
export const GroupMenuEmpty = () => (
  <Story
    request={{ kind: 'group', groupId: 'group-inbox', anchor: TOOLBAR_BUTTON }}
    snapshot={applyFakeAction(SAMPLE_SNAPSHOT, {
      type: 'bookmarks/group/create',
      id: 'group-inbox',
      spaceId: 'space-climbing',
      name: 'Inbox',
    })}
  />
);

/** A group with many links: the menu scrolls inside the window. */
export const GroupMenuManyLinks = () => (
  <Story
    request={{ kind: 'group', groupId: 'group-many-8', anchor: TOOLBAR_BUTTON }}
    snapshot={MANY_SNAPSHOT}
  />
);

/** The Spaces menu at the right end of the toolbar, with a check on the current space. */
export const SpacesMenu = () => <Story request={{ kind: 'spaces', anchor: TOOLBAR_END }} />;

/** The groups that did not fit, each a submenu of its links. */
export const OverflowMenu = () => (
  <Story
    request={{
      kind: 'overflow',
      groupIds: ['group-training', 'group-gear'],
      anchor: { left: 640, top: 52, width: 24, height: 24 },
    }}
  />
);
