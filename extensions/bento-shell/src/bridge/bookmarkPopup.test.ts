import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installFakeChromeTitle } from './fakeChromeTitle';
import { FakeBroadcastChannel, installFakeNetwork, postRaw } from './overlayTestKit';
import {
  BOOKMARKED_TABS_PREFIX,
  BOOKMARK_POPUP_BUS_NAME,
  BOOKMARK_POPUP_CLOSE_PREFIX,
  BOOKMARK_POPUP_OPEN_PREFIX,
  parseBookmarkPopupRequest,
  popupKey,
  sendBookmarkPopupClose,
  sendBookmarkPopupOpen,
  sendBookmarkedTabs,
} from './bookmarkPopup';

const ANCHOR = { left: 10, top: 20, width: 30, height: 24 };

/** The JSON a title carries after `<prefix><timestamp>:`, as chrome decodes it. */
function payloadOf(title: string, prefix: string): unknown {
  const tail = title.slice(prefix.length);
  const encoded = tail.slice(tail.indexOf(':') + 1);
  return JSON.parse(decodeURIComponent(escape(atob(encoded))));
}

beforeEach(() => {
  installFakeNetwork();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('titles to chrome', () => {
  it('carry the request, the popup id and the tab ids as base64 JSON after a timestamp', () => {
    const chrome = installFakeChromeTitle();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    sendBookmarkPopupOpen({
      kind: 'edit',
      tabId: 7,
      url: 'https://example.com/é',
      title: 'Café',
      anchor: ANCHOR,
      requestId: 'r1',
    });
    sendBookmarkPopupClose('popup-1');
    sendBookmarkedTabs([3, 9]);
    chrome.settle();

    const [open, close, tabs] = chrome.observed;
    expect(open).toMatch(new RegExp(`^${BOOKMARK_POPUP_OPEN_PREFIX}1000:`));
    expect(payloadOf(open!, BOOKMARK_POPUP_OPEN_PREFIX)).toEqual({
      kind: 'edit',
      tabId: 7,
      url: 'https://example.com/é',
      title: 'Café',
      anchor: ANCHOR,
      requestId: 'r1',
    });
    expect(close).toMatch(new RegExp(`^${BOOKMARK_POPUP_CLOSE_PREFIX}1000:`));
    expect(payloadOf(close!, BOOKMARK_POPUP_CLOSE_PREFIX)).toEqual({ popupId: 'popup-1' });
    expect(tabs).toMatch(new RegExp(`^${BOOKMARKED_TABS_PREFIX}1000:`));
    expect(payloadOf(tabs!, BOOKMARKED_TABS_PREFIX)).toEqual({ tabIds: [3, 9] });
  });
});

describe('parseBookmarkPopupRequest', () => {
  it('accepts the four kinds with their fields', () => {
    const requests = [
      { kind: 'edit', tabId: 1, url: 'https://a.test/', title: 'A', anchor: ANCHOR },
      { kind: 'group', groupId: 'g1', anchor: ANCHOR },
      { kind: 'spaces', anchor: ANCHOR },
      { kind: 'overflow', groupIds: ['g1', 'g2'], anchor: ANCHOR },
    ];
    for (const request of requests) expect(parseBookmarkPopupRequest(request)).toEqual(request);
  });

  it('drops what cannot be drawn', () => {
    for (const bad of [
      null,
      'edit',
      { kind: 'spaces' },
      { kind: 'spaces', anchor: { left: 1, top: 2, width: 3 } },
      { kind: 'spaces', anchor: { ...ANCHOR, top: Number.NaN } },
      { kind: 'group', anchor: ANCHOR },
      { kind: 'edit', tabId: '1', url: 'u', title: 't', anchor: ANCHOR },
      { kind: 'overflow', groupIds: [1], anchor: ANCHOR },
      { kind: 'unknown', anchor: ANCHOR },
    ]) {
      expect(parseBookmarkPopupRequest(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('popupKey', () => {
  it('names the button a popup belongs to', () => {
    expect(popupKey({ kind: 'group', groupId: 'g1', anchor: ANCHOR })).toBe('group:g1');
    expect(popupKey({ kind: 'spaces', anchor: ANCHOR })).toBe('spaces');
    expect(popupKey({ kind: 'overflow', groupIds: [], anchor: ANCHOR })).toBe('overflow');
    expect(
      popupKey({ kind: 'edit', tabId: 1, url: 'https://a.test/', title: 'A', anchor: ANCHOR }),
    ).toBe('edit');
  });
});

describe('subscribeToBookmarkPopupOpen', () => {
  const action = (overrides: object = {}) => ({
    kind: 'action',
    action: {
      type: 'ui/bookmarkPopup/open',
      popupId: 'p1',
      request: { kind: 'spaces', anchor: ANCHOR },
      ...overrides,
    },
  });

  it('delivers an open for this window and ignores another window, other actions and bad payloads', async () => {
    vi.stubGlobal('location', { hash: '#bentoWindowId=1' });
    vi.resetModules();
    const { subscribeToBookmarkPopupOpen } = await import('./bookmarkPopup');
    const handler = vi.fn();
    subscribeToBookmarkPopupOpen(handler);

    postRaw('bento-shell-bus', action({ __windowId: 2 }));
    postRaw('bento-shell-bus', action({ __windowId: 1, popupId: '' }));
    postRaw(
      'bento-shell-bus',
      action({ __windowId: 1, request: { kind: 'group', anchor: ANCHOR } }),
    );
    postRaw('bento-shell-bus', {
      kind: 'action',
      action: { type: 'menu/open', __windowId: 1 },
    });
    expect(handler).not.toHaveBeenCalled();

    postRaw('bento-shell-bus', action({ __windowId: 1 }));
    expect(handler).toHaveBeenCalledExactlyOnceWith({
      popupId: 'p1',
      request: { kind: 'spaces', anchor: ANCHOR },
    });
  });
});

describe('popup state notices', () => {
  it('go to the other shell documents of the same window, tagged with the key', async () => {
    vi.stubGlobal('location', { hash: '#bentoWindowId=3' });
    vi.resetModules();
    const popup = await import('./bookmarkPopup');
    const seen: unknown[] = [];
    new FakeBroadcastChannel(BOOKMARK_POPUP_BUS_NAME).addEventListener('message', (event) =>
      seen.push(event.data),
    );

    popup.notifyBookmarkPopupOpened('edit');
    popup.notifyBookmarkPopupClosed('edit');

    expect(seen).toEqual([
      { kind: 'opened', windowId: 3, key: 'edit' },
      { kind: 'closed', windowId: 3, key: 'edit' },
    ]);
  });
});
