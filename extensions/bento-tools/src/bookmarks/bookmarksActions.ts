// Routes the `bookmarks/` shell actions to BookmarksStore. The protocol handler calls this
// after its private-window check, so nothing here runs for a private window.
import type { Action, Event } from '@shared/protocol';
import type { BookmarksStore } from './BookmarksStore';

export type BookmarksAction = Extract<Action, { type: `bookmarks/${string}` }>;

export function isBookmarksAction(action: Action): action is BookmarksAction {
  return action.type.startsWith('bookmarks/');
}

export interface BookmarksActionContext {
  bookmarks: BookmarksStore;
  /** Sends an event to the window that asked, in its audience. */
  reply: (event: Event) => void;
  /** Runs another shell action as if the same window had sent it. */
  run: (action: Action) => void;
}

export function handleBookmarksAction(
  action: BookmarksAction,
  { bookmarks, reply, run }: BookmarksActionContext,
): void {
  switch (action.type) {
    case 'bookmarks/requestSnapshot':
      reply({ type: 'bookmarks/snapshot', snapshot: bookmarks.snapshot() });
      return;
    case 'bookmarks/space/create':
      bookmarks.createSpace(action.name);
      return;
    case 'bookmarks/space/update':
      bookmarks.updateSpace(action.id, { name: action.name, color: action.color });
      return;
    case 'bookmarks/space/delete':
      bookmarks.deleteSpace(action.id);
      return;
    case 'bookmarks/space/select':
      bookmarks.selectSpace(action.id);
      return;
    case 'bookmarks/group/create':
      bookmarks.createGroup(action.spaceId, action.name);
      return;
    case 'bookmarks/group/update':
      bookmarks.updateGroup(action.id, { name: action.name, color: action.color });
      return;
    case 'bookmarks/group/delete':
      bookmarks.deleteGroup(action.id);
      return;
    case 'bookmarks/group/move':
      bookmarks.moveGroup(action.id, action.spaceId, action.beforeId);
      return;
    case 'bookmarks/item/create':
      bookmarks.createItem(action.groupId, action.beforeId, action.item);
      return;
    case 'bookmarks/item/update':
      bookmarks.updateItem(action.id, {
        title: action.title,
        url: action.url,
        text: action.text,
        done: action.done,
      });
      return;
    case 'bookmarks/item/delete':
      bookmarks.deleteItem(action.id);
      return;
    case 'bookmarks/item/move':
      bookmarks.moveItem(action.id, action.groupId, action.beforeId);
      return;
    case 'bookmarks/item/open': {
      const url = bookmarks.linkUrl(action.id);
      if (!url) return;
      // The same actions the address bar and the saved-panel favicons send.
      run(
        action.where === 'panel'
          ? { type: 'panel/openAt', url, sourceTabId: null, position: 'end' }
          : { type: 'tab/openUrl', url, active: true },
      );
      return;
    }
    case 'bookmarks/tabs/save':
      void bookmarks.saveTabs(action.spaceId, action.groupId, action.tabIds);
      return;
    case 'bookmarks/import/firefox':
      void bookmarks.importFirefox();
      return;
    case 'bookmarks/import/dismiss':
      bookmarks.dismissImport();
      return;
    default: {
      const unhandled: never = action;
      console.warn('[bento-tools] unhandled bookmarks action:', unhandled);
    }
  }
}
