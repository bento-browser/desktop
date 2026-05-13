// Story-side bus priming. The App reads useToolsReady() and renders
// "connecting…" in the header until a `tools/booted` event lands on the
// bento-shell-bus BroadcastChannel. In Ladle there's no bento-tools
// background to send that event, so the indicator never clears unless we
// fake it.
//
// initToolsPort() opens useToolsPort's BroadcastChannel listener (without
// it, our post on a separate channel is delivered to nothing). Then we
// open a second channel on the same name and post the booted event —
// useToolsPort receives it, flips state.ready=true, and the App
// re-renders without the connecting indicator.
//
// useToolsPort's handler will then dispatch tabs/workspaces/settings
// requestSnapshot actions back onto the bus; nothing in Ladle listens to
// those, so they're harmless console noise. Call this AFTER seeding the
// stores — if the requestSnapshot dispatches did somehow get answered,
// the answer would replace whatever was seeded.

import { initToolsPort } from '../../bridge/useToolsPort';

export function markToolsBootedForStory(): void {
  if (typeof BroadcastChannel === 'undefined') return;
  initToolsPort();
  const ch = new BroadcastChannel('bento-shell-bus');
  ch.postMessage({ kind: 'event', event: { type: 'tools/booted' } });
  ch.close();
}
