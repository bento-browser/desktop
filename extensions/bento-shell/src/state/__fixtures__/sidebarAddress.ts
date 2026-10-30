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
  // applySnapshot ignores a lower snapshotToken, so reset first or a prior story's snapshot wins.
  useSidebarAddressStore.getState().reset();
  useSidebarAddressStore.getState().applySnapshot(makeSidebarAddressSnapshot(overrides));
}

/** The address palette is shown anchored over the row: the row's border is faded out. */
export function seedPaletteOverRow(): void {
  useSidebarAddressStore.getState().setPaletteOverRow(true);
}
