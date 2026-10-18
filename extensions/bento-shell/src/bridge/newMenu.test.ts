// The sidebar's New button shows its open fill from two bus messages: chrome's
// `menu/open` and the menu overlay's close notice. These use the real bridge
// modules on an in-memory channel network, one module set per document.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeNetwork, postRaw } from './overlayTestKit';

const SHELL_BUS = 'bento-shell-bus';
const NEW_ITEMS = [{ id: 'new-tab' }, { id: 'new-panel' }];
const TAB_ITEMS = [{ id: 'new-tab' }, { id: 'reopen-closed-tab' }, { id: 'select-all-tabs' }];
const ANCHOR = { left: 0, top: 0, width: 1, height: 1 };

beforeEach(() => {
  installFakeNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Loads the bridge of one shell document in chrome window `windowId`. */
async function loadDocument(windowId: number) {
  vi.stubGlobal('location', { hash: `#bentoWindowId=${windowId}` });
  vi.resetModules();
  const [{ useUiStore }, newMenu, menu] = await Promise.all([
    import('../state/ui'),
    import('./newMenu'),
    import('./useMenuOpen'),
  ]);
  return {
    contextId: () => useUiStore.getState().newMenuContextId,
    track: newMenu.trackNewMenuOpen,
    /** The menu overlay announces that its menu closed. */
    closed: menu.notifyMenuClosed,
  };
}

/** Chrome shows a menu, as showChromeMenu does. */
function chromeOpens(contextId: string, items: { id: string }[], windowId = 1) {
  postRaw(SHELL_BUS, {
    kind: 'action',
    action: { type: 'menu/open', contextId, items, anchor: ANCHOR, __windowId: windowId },
  });
}

describe('New menu open state', () => {
  it('is set while the New menu is up and cleared when the overlay reports it closed', async () => {
    const sidebar = await loadDocument(1);
    const overlay = await loadDocument(1);
    sidebar.track();

    chromeOpens('m_a', NEW_ITEMS);
    expect(sidebar.contextId()).toBe('m_a');

    overlay.closed('m_a');
    expect(sidebar.contextId()).toBeNull();
  });

  it('is cleared when another menu replaces the New menu', async () => {
    const sidebar = await loadDocument(1);
    sidebar.track();

    chromeOpens('m_a', NEW_ITEMS);
    chromeOpens('m_b', TAB_ITEMS);

    expect(sidebar.contextId()).toBeNull();
  });

  it('ignores the close notice of an older menu that lands after a newer New menu opened', async () => {
    const sidebar = await loadDocument(1);
    const overlay = await loadDocument(1);
    sidebar.track();

    chromeOpens('m_a', NEW_ITEMS);
    chromeOpens('m_b', NEW_ITEMS);
    overlay.closed('m_a');

    expect(sidebar.contextId()).toBe('m_b');
  });

  it('ignores menus and notices of another window', async () => {
    const sidebar = await loadDocument(1);
    const otherOverlay = await loadDocument(2);
    sidebar.track();

    chromeOpens('m_other', NEW_ITEMS, 2);
    expect(sidebar.contextId()).toBeNull();

    chromeOpens('m_a', NEW_ITEMS, 1);
    otherOverlay.closed('m_a');
    expect(sidebar.contextId()).toBe('m_a');
  });

  it('stops following the buses once unsubscribed', async () => {
    const sidebar = await loadDocument(1);
    const stop = sidebar.track();

    stop();
    chromeOpens('m_a', NEW_ITEMS);

    expect(sidebar.contextId()).toBeNull();
  });
});
