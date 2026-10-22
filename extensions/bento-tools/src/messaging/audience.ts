// Audiences for events sent to the shell documents (see AudienceEvent in
// @shared/shell-client-protocol): the shell background fans an event out to the
// documents of regular windows, or to the private documents of one window, so a
// private window's tabs and Private workspace never reach a regular document.

import type { TabDelta } from '@shared/protocol';
import type { AudienceEvent } from '@shared/shell-client-protocol';
import { isEphemeralWorkspaceId } from '../workspaces/ephemeral';

export type Audience = AudienceEvent['audience'];

export function audienceMessage(audience: Audience, event: AudienceEvent['event']): AudienceEvent {
  return { type: 'audience/event', audience, event };
}

interface DeltaClassifier {
  /** The private window a queued tab delta is about, or undefined (regular tab). */
  privateWindowOf(delta: TabDelta): number | undefined;
}

/** Splits a tab delta batch into the part regular documents may see and one part
 * per private window. Order within each part is kept. */
export function partitionTabDeltas(
  tabs: DeltaClassifier,
  deltas: TabDelta[],
): { regular: TabDelta[]; privateByWindow: Map<number, TabDelta[]> } {
  const regular: TabDelta[] = [];
  const privateByWindow = new Map<number, TabDelta[]>();
  for (const delta of deltas) {
    const windowId = tabs.privateWindowOf(delta);
    if (windowId === undefined) {
      regular.push(delta);
      continue;
    }
    const bucket = privateByWindow.get(windowId);
    if (bucket) bucket.push(delta);
    else privateByWindow.set(windowId, [delta]);
  }
  return { regular, privateByWindow };
}

interface PrivateWorkspaceOwners {
  /** The private window a Private workspace belongs to, or null (also once it is gone). */
  privateWindowOf(workspaceId: string): number | null;
}

/**
 * Builds an event about `workspaceId` (the build awaits) and sends it to the one audience
 * that may see it: the Private workspace's window, or the regular documents.
 *
 * The audience is decided before the build starts and checked again when it ends. A
 * private window can close in between, which forgets the workspace; looking the audience up
 * afterwards would find no owner and call a Private workspace regular, leaking its tab
 * URLs and titles to every regular window. An ephemeral workspace whose window is gone
 * sends nothing, and `build` may return null for nothing to send.
 */
export async function sendWorkspaceEvent<T>(
  owners: PrivateWorkspaceOwners,
  workspaceId: string,
  build: () => Promise<T | null>,
  send: (audience: Audience, value: T) => void,
): Promise<void> {
  const privateWindowId = owners.privateWindowOf(workspaceId);
  if (privateWindowId === null && isEphemeralWorkspaceId(workspaceId)) return;
  const audience: Audience = privateWindowId === null ? 'regular' : { privateWindowId };
  const value = await build();
  if (value === null) return;
  if (privateWindowId !== null && owners.privateWindowOf(workspaceId) !== privateWindowId) return;
  send(audience, value);
}
