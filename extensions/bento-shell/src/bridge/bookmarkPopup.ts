// The shell side of the bookmark popup: the save popover and the toolbar's group, Spaces and
// overflow menus. They all render in one overlay document (bookmarks-popup.html) that chrome shows
// over the whole window, anchored to the rect of the button that asked.
//
//   - A shell document (the sidebar star, the toolbar) sends BENTO_BOOKMARK_POPUP_OPEN with a
//     request whose anchor is in its own frame's CSS px. Chrome translates the anchor to window
//     coordinates, shows the overlay and sends `ui/bookmarkPopup/open` on the shell bus.
//   - The popup document sends BENTO_BOOKMARK_POPUP_CLOSE when it closes, whatever the reason, and
//     chrome hides the overlay again.
//   - The sidebar sends BENTO_BOOKMARKED_TABS so chrome can fill the panel header star.
//
// The titles use the `PREFIX<timestamp>:<base64 JSON>` form chrome parses for the sidebar address
// row. The popup document also tells the other shell documents which popup is up (a doc-to-doc
// notice, as the menu overlay does in useMenuOpen.ts), so the button that opened it can show its
// pressed state.

import { useEffect, useState } from 'react';

import { encodeTitlePayload, sendChromeTitle } from './chromeTitle';
import { isForThisWindow, thisWindowId } from './windowId';

export const BOOKMARK_POPUP_OPEN_PREFIX = 'BENTO_BOOKMARK_POPUP_OPEN:';
export const BOOKMARK_POPUP_CLOSE_PREFIX = 'BENTO_BOOKMARK_POPUP_CLOSE:';
export const BOOKMARKED_TABS_PREFIX = 'BENTO_BOOKMARKED_TABS:';

const SHELL_BUS_NAME = 'bento-shell-bus';
export const BOOKMARK_POPUP_BUS_NAME = 'bento-bookmark-popup-bus';

/** A rectangle in CSS px of the frame it is measured in. */
export type PopupRect = { left: number; top: number; width: number; height: number };

export type BookmarkPopupRequest =
  | { kind: 'edit'; tabId: number; url: string; title: string; anchor: PopupRect }
  | { kind: 'group'; groupId: string; anchor: PopupRect }
  | { kind: 'spaces'; anchor: PopupRect }
  | { kind: 'overflow'; groupIds: string[]; anchor: PopupRect };

/** What a shell document sends: `requestId` answers a chrome request (Cmd+D asking the star). */
export type BookmarkPopupOpenRequest = BookmarkPopupRequest & { requestId?: string };

/** The popup document's view of an open that chrome accepted. */
export interface OpenBookmarkPopup {
  popupId: string;
  request: BookmarkPopupRequest;
}

function titleFor(prefix: string, payload: object): string {
  return `${prefix}${Date.now()}:${encodeTitlePayload(payload)}`;
}

/** Asks chrome to show the popup, anchored to `request.anchor`. A private window or a disabled
 * manager refuses it. */
export function sendBookmarkPopupOpen(request: BookmarkPopupOpenRequest): void {
  sendChromeTitle(titleFor(BOOKMARK_POPUP_OPEN_PREFIX, request));
}

/** Tells chrome the popup `popupId` is closed, so it hides the overlay and returns the focus. */
export function sendBookmarkPopupClose(popupId: string): void {
  sendChromeTitle(titleFor(BOOKMARK_POPUP_CLOSE_PREFIX, { popupId }));
}

/** Tells chrome which tabs (WebExtension ids) of this window are saved, for the panel header star. */
export function sendBookmarkedTabs(tabIds: readonly number[]): void {
  sendChromeTitle(titleFor(BOOKMARKED_TABS_PREFIX, { tabIds }));
}

// ---- Chrome to the popup document ------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isRect = (value: unknown): value is PopupRect =>
  isRecord(value) &&
  [value.left, value.top, value.width, value.height].every(
    (n) => typeof n === 'number' && Number.isFinite(n),
  );

/** The request, or null when it is not one of the four kinds with a usable anchor. A bad payload
 * is dropped: rendering nothing beats crashing the overlay frame. */
export function parseBookmarkPopupRequest(value: unknown): BookmarkPopupRequest | null {
  if (!isRecord(value) || !isRect(value.anchor)) return null;
  const { anchor } = value;
  switch (value.kind) {
    case 'edit':
      return typeof value.tabId === 'number' &&
        typeof value.url === 'string' &&
        typeof value.title === 'string'
        ? { kind: 'edit', tabId: value.tabId, url: value.url, title: value.title, anchor }
        : null;
    case 'group':
      return typeof value.groupId === 'string'
        ? { kind: 'group', groupId: value.groupId, anchor }
        : null;
    case 'spaces':
      return { kind: 'spaces', anchor };
    case 'overflow':
      return Array.isArray(value.groupIds) && value.groupIds.every((id) => typeof id === 'string')
        ? { kind: 'overflow', groupIds: value.groupIds as string[], anchor }
        : null;
    default:
      return null;
  }
}

/**
 * Popup document: follows chrome's `ui/bookmarkPopup/open` on the shell bus, for this window only.
 * Chrome stamps the action with its window id (`__windowId`, as for `menu/open`), because one
 * extension origin serves every window and a BroadcastChannel reaches all of them. The anchor is
 * already in the popup host's coordinates.
 */
export function subscribeToBookmarkPopupOpen(
  handler: (open: OpenBookmarkPopup) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(SHELL_BUS_NAME);
  channel.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isRecord(data) || data.kind !== 'action') return;
    const action = data.action;
    if (!isRecord(action) || action.type !== 'ui/bookmarkPopup/open') return;
    if (!isForThisWindow(action.__windowId)) return;
    const request = parseBookmarkPopupRequest(action.request);
    if (typeof action.popupId !== 'string' || !action.popupId || !request) return;
    handler({ popupId: action.popupId, request });
  });
  return () => channel.close();
}

// ---- Popup document to the other shell documents ---------------------------------------------

/** Which button a popup belongs to: the star, one toolbar group, the Spaces or overflow button. */
export type BookmarkPopupKey = 'edit' | 'spaces' | 'overflow' | `group:${string}`;

export function popupKey(request: BookmarkPopupRequest): BookmarkPopupKey {
  return request.kind === 'group' ? `group:${request.groupId}` : request.kind;
}

interface PopupStateMessage {
  kind: 'opened' | 'closed';
  windowId: number | null;
  key: BookmarkPopupKey;
}

let stateChannel: BroadcastChannel | null = null;
function stateBus(): BroadcastChannel | null {
  if (stateChannel) return stateChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  stateChannel = new BroadcastChannel(BOOKMARK_POPUP_BUS_NAME);
  return stateChannel;
}

/** Popup document to the buttons: the popup for `key` is on screen. Follows the overlay, not the
 * click, so an open that chrome refuses never leaves a button pressed. */
export function notifyBookmarkPopupOpened(key: BookmarkPopupKey): void {
  stateBus()?.postMessage({
    kind: 'opened',
    windowId: thisWindowId,
    key,
  } satisfies PopupStateMessage);
}

/** Popup document to the buttons: the popup for `key` is gone (closed, or replaced by another). */
export function notifyBookmarkPopupClosed(key: BookmarkPopupKey): void {
  stateBus()?.postMessage({
    kind: 'closed',
    windowId: thisWindowId,
    key,
  } satisfies PopupStateMessage);
}

function isPopupStateMessage(data: unknown): data is PopupStateMessage {
  return (
    isRecord(data) &&
    (data.kind === 'opened' || data.kind === 'closed') &&
    typeof data.key === 'string'
  );
}

/** Button documents: the key of the popup this window has open, or null. A close notice only
 * counts for its own key, because the notices of a replaced popup and the open of its successor
 * are not ordered against each other. */
export function useOpenBookmarkPopupKey(): BookmarkPopupKey | null {
  const [open, setOpen] = useState<BookmarkPopupKey | null>(null);
  useEffect(() => {
    const channel = stateBus();
    if (!channel) return;
    const listener = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (!isPopupStateMessage(data) || !isForThisWindow(data.windowId)) return;
      if (data.kind === 'opened') setOpen(data.key);
      else setOpen((current) => (current === data.key ? null : current));
    };
    channel.addEventListener('message', listener);
    return () => channel.removeEventListener('message', listener);
  }, []);
  return open;
}
