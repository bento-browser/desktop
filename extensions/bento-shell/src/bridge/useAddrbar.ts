import type { AddrbarNavigatePayload } from '@shared/protocol';
import { sendChromeTitle } from './chromeTitle';
import { isForThisWindow } from './windowId';

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

/**
 * Where the anchored popup sits, in the address bar document's coordinates (chrome
 * computes it from the row rect). `anchorWidth` and `anchorHeight` are the row's box,
 * which the popup's top-left corner shares, so the grow starts from it.
 */
export interface AddrbarPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  anchorWidth: number;
  anchorHeight: number;
}

export interface AddrbarOpenOptions {
  anchorRect?: AddrbarAnchorRect;
  clipboardUrl?: string;
  /** Answers a chrome open request (useSidebarAddress.ts); chrome drops an answer it no longer waits for. */
  requestId?: string;
}

interface OpenMessage {
  kind: 'open';
  /** The chrome window the open is for; chrome stamps it (windowId.ts). */
  windowId?: number | null;
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
  sendChromeTitle(`${ADDRBAR_CLOSE_PREFIX}_${Date.now()}`);
}

export function signalAddrbarReady(openId: string): void {
  sendChromeTitle(
    `${ADDRBAR_READY_PREFIX}:${encodeTitlePayload(JSON.stringify({ openId, timestamp: Date.now() }))}`,
  );
}

export function signalAddrbarOpen(
  mode: AddrbarMode,
  initialQuery = '',
  options: AddrbarOpenOptions = {},
): void {
  sendChromeTitle(
    `${ADDRBAR_OPEN_PREFIX}${Date.now()}:${encodeTitlePayload(
      JSON.stringify({
        mode,
        initialQuery,
        ...(options.anchorRect ? { anchorRect: options.anchorRect } : {}),
        ...(options.clipboardUrl ? { clipboardUrl: options.clipboardUrl } : {}),
        ...(options.requestId ? { requestId: options.requestId } : {}),
      }),
    )}`,
  );
}

export function signalAddrbarNavigate(value: string | AddrbarNavigatePayload): void {
  const payload =
    typeof value === 'string'
      ? value
      : JSON.stringify({ value: value.value, searchEngineId: value.searchEngineId });
  sendChromeTitle(`${ADDRBAR_NAVIGATE_PREFIX}_${Date.now()}:${encodeTitlePayload(payload)}`);
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
    if (data?.kind === 'open' && isForThisWindow(data.windowId)) {
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
