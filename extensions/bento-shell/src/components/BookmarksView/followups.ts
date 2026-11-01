// Things to do once an action the view sent shows in a snapshot: select the space that was just
// created, scroll to the row that was just saved, put the focus back on a row that moved. The
// actions carry client ids (actions.ts), so each follow-up names the id it waits for, and a
// snapshot that holds it is the proof. Other changes never trigger one.

import type { BookmarksSnapshot } from '@shared/protocol';

export interface Followup {
  /** True once the snapshot shows what the action did. */
  ready: (snapshot: BookmarksSnapshot) => boolean;
  run: () => void;
}

/** Any of these ids is a space, group or item of the snapshot. */
export const exists =
  (ids: readonly string[]) =>
  (snapshot: BookmarksSnapshot): boolean =>
    ids.some(
      (id) =>
        snapshot.items.some((item) => item.id === id) ||
        snapshot.groups.some((group) => group.id === id) ||
        snapshot.spaces.some((space) => space.id === id),
    );

/** The item sits in `groupId` just before `beforeId` (last when null). */
export const itemPlacedAt =
  (id: string, groupId: string, beforeId: string | null) =>
  (snapshot: BookmarksSnapshot): boolean => {
    const siblings = snapshot.items.filter((item) => item.groupId === groupId);
    const index = siblings.findIndex((item) => item.id === id);
    return index !== -1 && (siblings[index + 1]?.id ?? null) === beforeId;
  };

/** The group sits in `spaceId` just before `beforeId` (last when null). */
export const groupPlacedAt =
  (id: string, spaceId: string, beforeId: string | null) =>
  (snapshot: BookmarksSnapshot): boolean => {
    const siblings = snapshot.groups.filter((group) => group.spaceId === spaceId);
    const index = siblings.findIndex((group) => group.id === id);
    return index !== -1 && (siblings[index + 1]?.id ?? null) === beforeId;
  };

/** Runs the follow-ups the snapshot has made ready, and returns the ones still waiting. */
export function settleFollowups(
  pending: readonly Followup[],
  snapshot: BookmarksSnapshot,
): Followup[] {
  const waiting: Followup[] = [];
  for (const followup of pending) {
    if (followup.ready(snapshot)) followup.run();
    else waiting.push(followup);
  }
  return waiting;
}
