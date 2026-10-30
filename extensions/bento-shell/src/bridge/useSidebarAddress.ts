import { useEffect, useMemo } from 'react';
import type { AddrbarMode } from './useAddrbar';
import { encodeTitlePayload } from './useAddrbar';
import { useCurrentWindowId } from './useToolsPort';
import { useSidebarAddressStore, type SidebarAddressSnapshot } from '../state/sidebarAddress';
import { sendChromeTitle } from './chromeTitle';

export const SIDEBAR_ADDRESS_BUS_NAME = 'bento-sidebar-address-bus';
export const SIDEBAR_ADDRESS_SUBMIT_PREFIX = 'BENTO_SIDEBAR_ADDRESS_SUBMIT:';
export const SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX = 'BENTO_SIDEBAR_ADDRESS_BOOKMARK_TOGGLE:';
export const SIDEBAR_ADDRESS_IDENTITY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_IDENTITY:';
export const SIDEBAR_ADDRESS_COPY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_COPY:';
export const SIDEBAR_ADDRESS_READY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_READY:';

export type SidebarAddressBusMessage =
  | (SidebarAddressSnapshot & { kind: 'snapshot'; messageId?: number })
  | {
      kind: 'copy-result';
      windowId: number | null;
      bridgeToken: string;
      messageId?: number;
      tabId: number | null;
      url: string;
      snapshotToken: number;
      success: boolean;
    }
  | {
      /**
       * Chrome asks the row to open the address palette over it (Cmd+L, Cmd+E). The row
       * answers with BENTO_OPEN_ADDRBAR carrying `requestId`: anchored while it is shown,
       * otherwise without an anchor so chrome opens the centered palette.
       */
      kind: 'open-request';
      windowId: number | null;
      bridgeToken: string;
      messageId?: number;
      requestId: string;
      mode: AddrbarMode;
    }
  | {
      /**
       * Chrome shows the address palette anchored over the row (`open: true`, as its fade-in
       * starts) or starts hiding it, or opens it centred (`open: false`). The row fades its
       * border out while the palette is over it, so the two borders cross-fade.
       */
      kind: 'palette-over-row';
      windowId: number | null;
      bridgeToken: string;
      messageId?: number;
      open: boolean;
    };

export interface SidebarAddressScope {
  windowId: number | null;
  bridgeToken: string | null;
}

export interface SidebarAddressSubmitPayload extends SidebarAddressScope {
  value: string;
  mode: AddrbarMode;
  searchEngineId?: string;
}

export interface SidebarAddressBookmarkTogglePayload extends SidebarAddressScope {
  tabId: number | null;
  url: string;
  snapshotToken: number;
  title?: string;
}

export interface SidebarAddressCopyPayload extends SidebarAddressScope {
  tabId: number | null;
  url: string;
  snapshotToken: number;
}

export interface SidebarAddressIdentityPayload extends SidebarAddressScope {
  tabId: number | null;
  url: string;
  snapshotToken: number;
  anchorRect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
}

function readHashParam(name: string): string | null {
  try {
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const params = new URLSearchParams(hash);
    const raw = params.get(name);
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

export function readSidebarBridgeTokenFromHash(): string | null {
  return readHashParam('bentoSidebarAddressBridgeToken');
}

export function shouldAcceptSidebarAddressMessage(
  message: unknown,
  expected: SidebarAddressScope,
): message is SidebarAddressBusMessage {
  if (!message || typeof message !== 'object') return false;
  const data = message as Partial<SidebarAddressBusMessage>;
  if (
    data.kind !== 'snapshot' &&
    data.kind !== 'open-request' &&
    data.kind !== 'copy-result' &&
    data.kind !== 'palette-over-row'
  ) {
    return false;
  }
  if (!expected.bridgeToken || typeof data.bridgeToken !== 'string') return false;
  if (data.bridgeToken !== expected.bridgeToken) return false;
  if (expected.windowId !== null) return data.windowId === expected.windowId;
  return data.windowId === null;
}

/** Applies a message that already passed `shouldAcceptSidebarAddressMessage` to the store. */
export function applySidebarAddressBusMessage(data: SidebarAddressBusMessage): void {
  const store = useSidebarAddressStore.getState();
  if (data.kind === 'snapshot') {
    store.applySnapshot(data);
  } else if (data.kind === 'copy-result') {
    store.applyCopyResult({
      tabId: data.tabId,
      url: data.url,
      snapshotToken: data.snapshotToken,
      success: data.success,
    });
  } else if (data.kind === 'palette-over-row') {
    store.setPaletteOverRow(data.open === true);
  } else if (typeof data.requestId === 'string' && data.requestId) {
    store.requestOpen(data.mode, data.requestId);
  }
}

function signalScopedSidebarAddressCommand(prefix: string, payload: object): void {
  sendChromeTitle(`${prefix}${Date.now()}:${encodeTitlePayload(JSON.stringify(payload))}`);
}

export function signalSidebarAddressSubmit(payload: SidebarAddressSubmitPayload): void {
  signalScopedSidebarAddressCommand(SIDEBAR_ADDRESS_SUBMIT_PREFIX, payload);
}

export function signalSidebarAddressBookmarkToggle(
  payload: SidebarAddressBookmarkTogglePayload,
): void {
  signalScopedSidebarAddressCommand(SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX, payload);
}

export function signalSidebarAddressCopy(payload: SidebarAddressCopyPayload): void {
  signalScopedSidebarAddressCommand(SIDEBAR_ADDRESS_COPY_PREFIX, payload);
}

export function signalSidebarAddressIdentity(payload: SidebarAddressIdentityPayload): void {
  signalScopedSidebarAddressCommand(SIDEBAR_ADDRESS_IDENTITY_PREFIX, payload);
}

/**
 * Tells chrome this document listens on the address channel. Chrome sends the channel nothing
 * that queues, and a new document (load, reload, re-created frame) starts with the state its
 * store defaults to, so chrome sends again what the document should show, such as the palette
 * being over the row, only on this title.
 */
export function signalSidebarAddressReady(): void {
  sendChromeTitle(`${SIDEBAR_ADDRESS_READY_PREFIX}${Date.now()}`);
}

export function useSidebarAddressBridge(): SidebarAddressScope {
  const windowId = useCurrentWindowId();
  const bridgeToken = useMemo(() => readSidebarBridgeTokenFromHash(), []);

  useEffect(() => {
    if (!bridgeToken || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(SIDEBAR_ADDRESS_BUS_NAME);
    const listener = (event: MessageEvent) => {
      const { data } = event;
      if (!shouldAcceptSidebarAddressMessage(data, { windowId, bridgeToken })) return;
      applySidebarAddressBusMessage(data);
    };
    channel.addEventListener('message', listener);
    // After the listener, and again once the window id resolves: a message for another window id
    // is dropped, so the first announcement can come before chrome's messages are accepted.
    signalSidebarAddressReady();
    return () => {
      channel.removeEventListener('message', listener);
      channel.close();
    };
  }, [bridgeToken, windowId]);

  return { windowId, bridgeToken };
}
