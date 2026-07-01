import { useSidebarAddressStore, type SidebarAddressSnapshot } from '../sidebarAddress';

export function makeSidebarAddressSnapshot(
  overrides: Partial<SidebarAddressSnapshot> = {},
): SidebarAddressSnapshot {
  return {
    windowId: 1,
    bridgeToken: 'story-token',
    snapshotToken: 1,
    tabId: 1,
    url: 'https://example.com/docs/sidebar-address-bar',
    displayUrl: 'example.com/docs/sidebar-address-bar',
    title: 'Sidebar address bar',
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
    ...overrides,
  };
}

export function seedSidebarAddressSnapshot(overrides: Partial<SidebarAddressSnapshot> = {}): void {
  useSidebarAddressStore.getState().applySnapshot(makeSidebarAddressSnapshot(overrides));
}
