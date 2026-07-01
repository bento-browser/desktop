import type { AddrbarNavigatePayload } from '@shared/protocol';

export type AddrbarMode = 'current' | 'newTab';

export const ADDRBAR_BUS_NAME = 'bento-addrbar-bus';
export const ADDRBAR_OPEN_PREFIX = 'BENTO_OPEN_ADDRBAR:';
export const ADDRBAR_CLOSE_PREFIX = 'BENTO_CLOSE_ADDRBAR';
export const ADDRBAR_READY_PREFIX = 'BENTO_ADDRBAR_READY';
export const ADDRBAR_NAVIGATE_PREFIX = 'BENTO_ADDRBAR_NAVIGATE';

export interface AddrbarAnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AddrbarPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AddrbarOpenOptions {
  anchorRect?: AddrbarAnchorRect;
  clipboardUrl?: string;
}

interface OpenMessage {
  kind: 'open';
  openId?: string;
  mode: AddrbarMode;
  initialQuery?: string;
  suppressFocus?: boolean;
  clipboardUrl?: string;
  placement?: AddrbarPlacement;
}

type BusMessage = OpenMessage;

let channel: BroadcastChannel | null = null;

function bus(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(ADDRBAR_BUS_NAME);
  return channel;
}

export function encodeTitlePayload(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function signalAddrbarClose(): void {
  document.title = `${ADDRBAR_CLOSE_PREFIX}_${Date.now()}`;
}

export function signalAddrbarReady(openId: string): void {
  document.title = `${ADDRBAR_READY_PREFIX}:${encodeTitlePayload(
    JSON.stringify({ openId, timestamp: Date.now() }),
  )}`;
}

export function signalAddrbarOpen(
  mode: AddrbarMode,
  initialQuery = '',
  options: AddrbarOpenOptions = {},
): void {
  document.title = `${ADDRBAR_OPEN_PREFIX}${Date.now()}:${encodeTitlePayload(
    JSON.stringify({
      mode,
      initialQuery,
      ...(options.anchorRect ? { anchorRect: options.anchorRect } : {}),
      ...(options.clipboardUrl ? { clipboardUrl: options.clipboardUrl } : {}),
    }),
  )}`;
}

export function signalAddrbarNavigate(value: string | AddrbarNavigatePayload): void {
  const payload =
    typeof value === 'string'
      ? value
      : JSON.stringify({ value: value.value, searchEngineId: value.searchEngineId });
  document.title = `${ADDRBAR_NAVIGATE_PREFIX}_${Date.now()}:${encodeTitlePayload(payload)}`;
}

export function subscribeToAddrbarOpenRequests(
  handler: (
    mode: AddrbarMode,
    initialQuery?: string,
    options?: {
      openId?: string;
      suppressFocus?: boolean;
      clipboardUrl?: string;
      placement?: AddrbarPlacement;
    },
  ) => void,
): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as BusMessage | undefined;
    if (data?.kind === 'open') {
      handler(data.mode, data.initialQuery, {
        openId: typeof data.openId === 'string' ? data.openId : '',
        suppressFocus: data.suppressFocus === true,
        clipboardUrl: typeof data.clipboardUrl === 'string' ? data.clipboardUrl : '',
        placement: data.placement,
      });
    }
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
