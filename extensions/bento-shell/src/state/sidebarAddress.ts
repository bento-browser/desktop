import { create } from 'zustand';
import type { AddrbarMode } from '../bridge/useAddrbar';

export type SidebarAddressSecurityKind =
  | 'secure'
  | 'verified'
  | 'insecure'
  | 'mixed'
  | 'internal'
  | 'extension'
  | 'local'
  | 'unknown';

export interface SidebarAddressSnapshot {
  windowId: number | null;
  bridgeToken: string;
  snapshotToken: number;
  tabId: number | null;
  url: string;
  displayUrl: string;
  title: string;
  security: {
    kind: SidebarAddressSecurityKind;
    label: string;
    tooltip: string;
    canOpenIdentity: boolean;
  };
  bookmark: {
    isBookmarked: boolean;
    canBookmark: boolean;
  };
  loading: boolean;
}

/** Chrome's request to open the address palette over the row (see useSidebarAddress.ts). */
export interface SidebarAddressOpenRequest {
  id: number;
  requestId: string;
  mode: AddrbarMode;
}

export interface SidebarAddressCopyResult {
  id: number;
  tabId: number | null;
  url: string;
  snapshotToken: number;
  success: boolean;
}

interface SidebarAddressState {
  snapshot: SidebarAddressSnapshot | null;
  editMode: AddrbarMode | null;
  draftValue: string;
  pendingBookmarkToggleKey: string | null;
  openRequest: SidebarAddressOpenRequest | null;
  /** The address palette is shown anchored over the row; the row fades its border out. */
  paletteOverRow: boolean;
  lastCopyResult: SidebarAddressCopyResult | null;
  applySnapshot: (snapshot: SidebarAddressSnapshot) => void;
  applyCopyResult: (result: Omit<SidebarAddressCopyResult, 'id'>) => void;
  requestOpen: (mode: AddrbarMode, requestId: string) => void;
  setPaletteOverRow: (over: boolean) => void;
  beginEdit: (mode: AddrbarMode, draftValue?: string) => void;
  cancelEdit: () => void;
  setDraft: (value: string) => void;
  setPendingBookmarkToggle: (key: string | null) => void;
  reset: () => void;
}

let nextOpenRequestId = 1;
let nextCopyResultId = 1;

function snapshotDraftValue(snapshot: SidebarAddressSnapshot | null): string {
  return snapshot?.url || '';
}

function isNewerOrEqualSnapshot(
  current: SidebarAddressSnapshot | null,
  next: SidebarAddressSnapshot,
): boolean {
  if (!Number.isFinite(next.snapshotToken) || next.snapshotToken < 0) return false;
  if (!current) return true;
  return next.snapshotToken >= current.snapshotToken;
}

export const useSidebarAddressStore = create<SidebarAddressState>((set, get) => ({
  snapshot: null,
  editMode: null,
  draftValue: '',
  pendingBookmarkToggleKey: null,
  openRequest: null,
  paletteOverRow: false,
  lastCopyResult: null,
  applySnapshot: (snapshot) => {
    const current = get().snapshot;
    if (!isNewerOrEqualSnapshot(current, snapshot)) return;
    set((state) => ({
      snapshot,
      draftValue: state.editMode ? state.draftValue : snapshotDraftValue(snapshot),
      pendingBookmarkToggleKey: null,
    }));
  },
  applyCopyResult: (result) => {
    set({
      lastCopyResult: {
        ...result,
        id: nextCopyResultId,
      },
    });
    nextCopyResultId += 1;
  },
  requestOpen: (mode, requestId) => {
    set({ openRequest: { id: nextOpenRequestId, requestId, mode } });
    nextOpenRequestId += 1;
  },
  setPaletteOverRow: (paletteOverRow) => set({ paletteOverRow }),
  beginEdit: (mode, draftValue) => {
    set({
      editMode: mode,
      draftValue: draftValue ?? (mode === 'newTab' ? '' : snapshotDraftValue(get().snapshot)),
    });
  },
  cancelEdit: () => {
    set({
      editMode: null,
      draftValue: snapshotDraftValue(get().snapshot),
    });
  },
  setDraft: (draftValue) => set({ draftValue }),
  setPendingBookmarkToggle: (pendingBookmarkToggleKey) => set({ pendingBookmarkToggleKey }),
  reset: () =>
    set({
      snapshot: null,
      editMode: null,
      draftValue: '',
      pendingBookmarkToggleKey: null,
      openRequest: null,
      paletteOverRow: false,
      lastCopyResult: null,
    }),
}));
