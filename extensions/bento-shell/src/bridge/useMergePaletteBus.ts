// Chrome to merge-palette lifecycle messages.
//
// Chrome owns the visibility of the merge palette frame and tells its document
// when an open or close happened through the BentoMergePaletteLifecycle frame
// script, which posts on this channel. The channel reaches the merge palette
// document of every Bento window, so chrome stamps the message with its window id
// and a receiver ignores other windows' (windowId.ts): a close for window B must
// not reset the merge palette window A is showing.

import { isForThisWindow } from './windowId';

export const MERGE_PALETTE_BUS_NAME = 'bento-merge-palette';

export interface MergePaletteLifecycleEvent {
  type: 'open' | 'close';
  nonce: string;
}

export function subscribeToMergePaletteLifecycle(
  handler: (event: MergePaletteLifecycleEvent) => void,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(MERGE_PALETTE_BUS_NAME);
  channel.addEventListener('message', (message: MessageEvent) => {
    const data = message.data as { type?: unknown; nonce?: unknown; windowId?: unknown } | null;
    if (!data || (data.type !== 'open' && data.type !== 'close')) return;
    if (!isForThisWindow(data.windowId)) return;
    handler({
      type: data.type,
      nonce: typeof data.nonce === 'string' ? data.nonce : String(Date.now()),
    });
  });
  return () => channel.close();
}
