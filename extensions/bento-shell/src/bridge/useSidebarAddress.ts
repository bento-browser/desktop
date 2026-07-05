import { useEffect, useMemo } from 'react';
import type { AddrbarMode } from './useAddrbar';
import { encodeTitlePayload } from './useAddrbar';
import { useCurrentWindowId } from './useToolsPort';
import { useSidebarAddressStore, type SidebarAddressSnapshot } from '../state/sidebarAddress';

export const SIDEBAR_ADDRESS_BUS_NAME = 'bento-sidebar-address-bus';
export const SIDEBAR_ADDRESS_SUBMIT_PREFIX = 'BENTO_SIDEBAR_ADDRESS_SUBMIT:';
export const SIDEBAR_ADDRESS_BOOKMARK_TOGGLE_PREFIX = 'BENTO_SIDEBAR_ADDRESS_BOOKMARK_TOGGLE:';
export const SIDEBAR_ADDRESS_IDENTITY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_IDENTITY:';
export const SIDEBAR_ADDRESS_COPY_PREFIX = 'BENTO_SIDEBAR_ADDRESS_COPY:';

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
      kind: 'focus';
      windowId: number | null;
      bridgeToken: string;
      messageId?: number;
      mode: AddrbarMode;
      initialQuery?: string;
      clipboardUrl?: string;
      selectAll?: boolean;
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
  if (data.kind !== 'snapshot' && data.kind !== 'focus' && data.kind !== 'copy-result') {
    return false;
  }
  if (!expected.bridgeToken || typeof data.bridgeToken !== 'string') return false;
  if (data.bridgeToken !== expected.bridgeToken) return false;
  if (expected.windowId !== null) return data.windowId === expected.windowId;
  return data.windowId === null;
}

function signalScopedSidebarAddressCommand(prefix: string, payload: object): void {
  document.title = `${prefix}${Date.now()}:${encodeTitlePayload(JSON.stringify(payload))}`;
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

export function useSidebarAddressBridge(): SidebarAddressScope {
  const windowId = useCurrentWindowId();
  const bridgeToken = useMemo(() => readSidebarBridgeTokenFromHash(), []);

  useEffect(() => {
    if (!bridgeToken || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(SIDEBAR_ADDRESS_BUS_NAME);
    const listener = (event: MessageEvent) => {
      const { data } = event;
      if (!shouldAcceptSidebarAddressMessage(data, { windowId, bridgeToken })) return;
      if (data.kind === 'snapshot') {
        useSidebarAddressStore.getState().applySnapshot(data);
      } else if (data.kind === 'copy-result') {
        useSidebarAddressStore.getState().applyCopyResult({
          tabId: data.tabId,
          url: data.url,
          snapshotToken: data.snapshotToken,
          success: data.success,
        });
      } else {
        useSidebarAddressStore
          .getState()
          .requestFocus(
            data.mode,
            data.initialQuery || '',
            data.selectAll !== false,
            typeof data.clipboardUrl === 'string' ? data.clipboardUrl : '',
          );
      }
    };
    channel.addEventListener('message', listener);
    return () => {
      channel.removeEventListener('message', listener);
      channel.close();
    };
  }, [bridgeToken, windowId]);

  return { windowId, bridgeToken };
}
