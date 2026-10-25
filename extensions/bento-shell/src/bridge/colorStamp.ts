// The order stamp of the saved colour mode (ColorStamp in _shared/protocol.ts), as the sidebar
// follows it: it rides from tools' settings events into every panels payload for chrome, which
// drops a payload older than the mode it has already applied. bento-shell-mount.js applies the
// same rule to what it receives; keep the two in step.

import type { ColorStamp } from '@shared/protocol';

/**
 * The stamp the sidebar keeps after tools sent `incoming`. Inside one run a lower sequence
 * (a replay of an older event) never replaces a higher one. A different run always replaces it:
 * tools restarted while this document survived, and the new run's stamp is the producer's
 * truth even if its sequence or clock is lower.
 */
export function followColorStamp(recorded: ColorStamp | null, incoming: ColorStamp): ColorStamp {
  if (recorded && recorded.run === incoming.run && incoming.seq < recorded.seq) return recorded;
  return incoming;
}
