// Bookmarks toolbar stories: the strip in the 30px row chrome gives it. The default space, many
// groups that overflow, long names that truncate, an empty space, a narrow window, a pressed
// button, and the states that show nothing (no snapshot, a failed load). The last story wires the
// buttons to the real popup component over a fake store, so every menu can be opened. Elsewhere a
// button press is counted on <body> (`popupRequests`, with the last kind in `lastPopup`). Switch
// Ladle's theme toggle for dark and light. Nothing here reaches the tools port or chrome.

import { useState, type ReactNode } from 'react';
import type { BookmarksSnapshot } from '@shared/protocol';

import {
  popupKey,
  type BookmarkPopupKey,
  type BookmarkPopupRequest,
} from '../../bridge/bookmarkPopup';
import {
  EMPTY_SPACE_SNAPSHOT,
  LOAD_FAILED_SNAPSHOT,
  LONG_NAMES_SNAPSHOT,
  MANY_SNAPSHOT,
  SAMPLE_SNAPSHOT,
  useFakeBookmarks,
} from '../../state/__fixtures__/bookmarks';
import { BookmarkPopup } from '../BookmarkPopup/BookmarkPopup';
import { BookmarksToolbar } from './BookmarksToolbar';

/**
 * The bookmarks toolbar row, 30px high, in a rounded strip `width` px wide (chrome draws the strip
 * with the same translucent tint).
 */
function Row({ width, children }: { width: number; children: ReactNode }) {
  return (
    <div
      style={{
        width,
        height: 30,
        display: 'flex',
        overflow: 'clip',
        borderRadius: 'var(--radius-l)',
        background: 'var(--bento-bookmarks-toolbar-fill)',
      }}
    >
      {children}
    </div>
  );
}

const countPress = (request: BookmarkPopupRequest) => {
  document.body.dataset.popupRequests = String(
    Number(document.body.dataset.popupRequests ?? 0) + 1,
  );
  document.body.dataset.lastPopup = request.kind;
};

function Story({
  snapshot,
  width = 1000,
  openKey = null,
}: {
  snapshot: BookmarksSnapshot | null;
  width?: number;
  openKey?: BookmarkPopupKey | null;
}) {
  return (
    <Row width={width}>
      <BookmarksToolbar snapshot={snapshot} openKey={openKey} onOpenPopup={countPress} />
    </Row>
  );
}

/** The Climbing space: four groups and the space button at the right. */
export const Default = () => <Story snapshot={SAMPLE_SNAPSHOT} />;

/** Nine groups in 1000px: the ones that do not fit are behind the overflow button. */
export const ManyGroups = () => <Story snapshot={MANY_SNAPSHOT} />;

/** Names that are longer than a button truncate. */
export const LongNames = () => <Story snapshot={LONG_NAMES_SNAPSHOT} />;

/** A space with no link: a hint, and the space button still switches spaces. */
export const EmptySpace = () => <Story snapshot={EMPTY_SPACE_SNAPSHOT} />;

/** A narrow window: the overflow button takes the groups that do not fit. Resize the frame by
 * changing the story width in the toolbar of this file. */
export const Narrow = () => <Story snapshot={SAMPLE_SNAPSHOT} width={360} />;

/** The button whose menu is open is pressed. */
export const GroupPressed = () => <Story snapshot={SAMPLE_SNAPSHOT} openKey="group:group-gyms" />;

export const SpacesPressed = () => <Story snapshot={SAMPLE_SNAPSHOT} openKey="spaces" />;

export const OverflowPressed = () => (
  <Story snapshot={MANY_SNAPSHOT} width={640} openKey="overflow" />
);

/** Before the first snapshot nothing shows. */
export const NoSnapshot = () => <Story snapshot={null} />;

/** A failed load shows nothing either, and no button that could not work. */
export const LoadFailed = () => <Story snapshot={LOAD_FAILED_SNAPSHOT} />;

/** The toolbar and the popup together: press a group, the Spaces button or the overflow button. */
export const WithPopups = () => {
  const fake = useFakeBookmarks(MANY_SNAPSHOT);
  const [popup, setPopup] = useState<BookmarkPopupRequest | null>(null);
  return (
    <div style={{ minHeight: 480 }}>
      <Row width={720}>
        <BookmarksToolbar
          snapshot={fake.snapshot}
          openKey={popup ? popupKey(popup) : null}
          onOpenPopup={setPopup}
        />
      </Row>
      {popup ? (
        <BookmarkPopup
          key={popupKey(popup)}
          request={popup}
          snapshot={fake.snapshot}
          send={fake.send}
          onClose={() => setPopup(null)}
          onOpenBookmarks={() => {
            document.body.dataset.openBookmarksRequests = String(
              Number(document.body.dataset.openBookmarksRequests ?? 0) + 1,
            );
          }}
        />
      ) : null}
    </div>
  );
};
