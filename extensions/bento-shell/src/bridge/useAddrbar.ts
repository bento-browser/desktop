import type { AddrbarNavigatePayload } from '@shared/protocol';

export type AddrbarMode = 'current' | 'newTab';

export const ADDRBAR_BUS_NAME = 'bento-addrbar-bus';
export const ADDRBAR_CLOSE_PREFIX = 'BENTO_CLOSE_ADDRBAR';
export const ADDRBAR_NAVIGATE_PREFIX = 'BENTO_ADDRBAR_NAVIGATE';

interface OpenMessage {
  kind: 'open';
  mode: AddrbarMode;
  initialQuery?: string;
  suppressFocus?: boolean;
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
    options?: { suppressFocus?: boolean },
  ) => void,
): () => void {
  const ch = bus();
  if (!ch) return () => {};
  const listener = (e: MessageEvent) => {
    const data = e.data as BusMessage | undefined;
    if (data?.kind === 'open') {
      handler(data.mode, data.initialQuery, { suppressFocus: data.suppressFocus === true });
    }
  };
  ch.addEventListener('message', listener);
  return () => ch.removeEventListener('message', listener);
}
