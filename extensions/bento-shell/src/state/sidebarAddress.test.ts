import { beforeEach, describe, expect, it } from 'vitest';
import { useSidebarAddressStore, type SidebarAddressSnapshot } from './sidebarAddress';

function snapshot(snapshotToken: number, url = 'https://example.com'): SidebarAddressSnapshot {
  return {
    windowId: 1,
    bridgeToken: 'token',
    snapshotToken,
    tabId: 10,
    url,
    displayUrl: url,
    title: 'Example',
    security: {
      kind: 'secure',
      label: 'Secure',
      tooltip: 'Connection secure',
      canOpenIdentity: true,
    },
    bookmark: {
      isBookmarked: false,
      canBookmark: true,
    },
    loading: false,
  };
}

describe('sidebar address store', () => {
  beforeEach(() => {
    useSidebarAddressStore.getState().reset();
  });

  it('rejects stale snapshots', () => {
    useSidebarAddressStore.getState().applySnapshot(snapshot(2, 'https://new.example'));
    useSidebarAddressStore.getState().applySnapshot(snapshot(1, 'https://old.example'));

    expect(useSidebarAddressStore.getState().snapshot?.url).toBe('https://new.example');
  });

  it('keeps current edits stable while fresh snapshots land', () => {
    useSidebarAddressStore.getState().applySnapshot(snapshot(1, 'https://example.com'));
    useSidebarAddressStore.getState().beginEdit('current');
    useSidebarAddressStore.getState().setDraft('typed');
    useSidebarAddressStore.getState().applySnapshot(snapshot(2, 'https://other.example'));

    expect(useSidebarAddressStore.getState().draftValue).toBe('typed');
    expect(useSidebarAddressStore.getState().snapshot?.url).toBe('https://other.example');
  });

  it('orders focus requests and initializes new-tab drafts empty', () => {
    useSidebarAddressStore.getState().applySnapshot(snapshot(1, 'https://example.com'));
    useSidebarAddressStore.getState().requestFocus('current');
    const first = useSidebarAddressStore.getState().focusRequest;
    useSidebarAddressStore.getState().requestFocus('newTab');
    const second = useSidebarAddressStore.getState().focusRequest;

    expect(first?.id).toBeLessThan(second?.id ?? 0);
    expect(second?.mode).toBe('newTab');
    expect(useSidebarAddressStore.getState().draftValue).toBe('');
  });

  it('tracks pending bookmark toggles until the next accepted snapshot', () => {
    useSidebarAddressStore.getState().setPendingBookmarkToggle('10:https://example.com');
    expect(useSidebarAddressStore.getState().pendingBookmarkToggleKey).toBe(
      '10:https://example.com',
    );
    useSidebarAddressStore.getState().applySnapshot(snapshot(1));
    expect(useSidebarAddressStore.getState().pendingBookmarkToggleKey).toBeNull();
  });
});
