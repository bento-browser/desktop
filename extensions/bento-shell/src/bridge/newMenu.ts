// Open state of the sidebar's New menu.
//
// The menu is rendered by chrome in the menu overlay (BENTO_SIDEBAR_CONTEXT_MENU),
// so the sidebar cannot see it. It does hear two things: chrome's `menu/open`
// bus action when the overlay shows any menu, and the overlay's close notice
// (useMenuOpen.ts). Chrome passes the request's `items` through unchanged, so
// the New menu is recognized by its item ids; no other menu has exactly these.
//
// The store follows the overlay, not the click: the state is set when the menu
// appears, so an open that chrome cancels while the overlay is still loading
// never leaves the button filled, and any later menu/open replaces it.

import { useUiStore } from '../state/ui';
import type { ChromeMenuItem } from '../menu/ChromeMenu';
import { subscribeToMenuClosed, subscribeToMenuOpen } from './useMenuOpen';

export const NEW_MENU_ITEMS = [
  { id: 'new-tab', label: 'New tab' },
  { id: 'new-panel', label: 'New panel' },
] satisfies ChromeMenuItem[];

const idsOf = (items: ChromeMenuItem[]) => items.map((item) => item.id).join();
const NEW_MENU_IDS = idsOf(NEW_MENU_ITEMS);

const isNewMenu = (items: ChromeMenuItem[]) => idsOf(items) === NEW_MENU_IDS;

/** Mirrors whether the New menu is up into the UI store; returns an unsubscribe. */
export function trackNewMenuOpen(): () => void {
  const { setNewMenuContextId } = useUiStore.getState();
  const stopOpen = subscribeToMenuOpen(({ contextId, items }) =>
    setNewMenuContextId(isNewMenu(items) ? contextId : null),
  );
  // The two buses are unordered against each other: a notice for an older menu
  // can land after the open of a newer one, so it only counts for its own menu.
  const stopClosed = subscribeToMenuClosed((contextId) => {
    if (useUiStore.getState().newMenuContextId === contextId) setNewMenuContextId(null);
  });
  return () => {
    stopOpen();
    stopClosed();
  };
}
