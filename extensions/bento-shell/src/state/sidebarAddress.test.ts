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

  it('orders open requests', () => {
    useSidebarAddressStore.getState().requestOpen('current', 'r1');
    const first = useSidebarAddressStore.getState().openRequest;
    useSidebarAddressStore.getState().requestOpen('current', 'r2');
    const second = useSidebarAddressStore.getState().openRequest;

    expect(first?.id).toBeLessThan(second?.id ?? 0);
    expect(second?.requestId).toBe('r2');
  });

  it('keeps the palette-over-row flag until it is cleared or the store resets', () => {
    expect(useSidebarAddressStore.getState().paletteOverRow).toBe(false);
    useSidebarAddressStore.getState().setPaletteOverRow(true);
    useSidebarAddressStore.getState().applySnapshot(snapshot(1));
    expect(useSidebarAddressStore.getState().paletteOverRow).toBe(true);
    useSidebarAddressStore.getState().reset();
    expect(useSidebarAddressStore.getState().paletteOverRow).toBe(false);
  });

  it('tracks pending bookmark toggles until the next accepted snapshot', () => {
    useSidebarAddressStore.getState().setPendingBookmarkToggle('10:https://example.com');
    expect(useSidebarAddressStore.getState().pendingBookmarkToggleKey).toBe(
      '10:https://example.com',
    );
    useSidebarAddressStore.getState().applySnapshot(snapshot(1));
    expect(useSidebarAddressStore.getState().pendingBookmarkToggleKey).toBeNull();
  });

  it('records copy results in arrival order', () => {
    useSidebarAddressStore.getState().applyCopyResult({
      tabId: 10,
      url: 'https://example.com',
      snapshotToken: 1,
      success: true,
    });
    const first = useSidebarAddressStore.getState().lastCopyResult;
    useSidebarAddressStore.getState().applyCopyResult({
      tabId: 10,
      url: 'https://example.com',
      snapshotToken: 1,
      success: true,
    });
    const second = useSidebarAddressStore.getState().lastCopyResult;

    expect(first?.id).toBeLessThan(second?.id ?? 0);
    expect(second).toMatchObject({
      tabId: 10,
      url: 'https://example.com',
      snapshotToken: 1,
      success: true,
    });
  });
});
