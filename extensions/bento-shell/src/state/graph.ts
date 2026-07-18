import { create } from 'zustand';
import type {
  PrivateWindowLiveGraphSlice,
  ProfileGraphSlice,
  RegularLiveGraphSlice,
  TargetedGraphEvent,
} from '@shared/shell-client-protocol';
import { usePanelsStore } from './panels';
import { usePinnedPanelsStore } from './pinnedPanels';
import { useSavedPanelsStore } from './savedPanels';
import { useTabFoldersStore } from './tabFolders';
import { useTabsStore } from './tabs';
import { useWorkspacesStore } from './workspaces';

interface GraphTuple {
  backendInstanceId: string;
  publicationId: string;
  graphRevision: number;
}

interface GraphState {
  profile: ProfileGraphSlice | null;
  regularLive: RegularLiveGraphSlice | null;
  privateLiveByWindow: Record<number, PrivateWindowLiveGraphSlice>;
  tuple: GraphTuple | null;
  apply(event: TargetedGraphEvent): 'applied' | 'already-applied' | 'resync-required';
}

function sameTuple(left: GraphTuple | null, right: GraphTuple): boolean {
  return (
    left?.backendInstanceId === right.backendInstanceId &&
    left.publicationId === right.publicationId &&
    left.graphRevision === right.graphRevision
  );
}

/** Canonical atomic graph mirror. Existing focused stores are hydrated from it. */
export const useGraphStore = create<GraphState>((set, get) => ({
  profile: null,
  regularLive: null,
  privateLiveByWindow: {},
  tuple: null,
  apply: (event) => {
    const tuple = {
      backendInstanceId: event.backendInstanceId,
      publicationId: event.publicationId,
      graphRevision: event.graphRevision,
    };
    if (sameTuple(get().tuple, tuple)) return 'already-applied';
    if (event.type === 'graph/resync-required') return 'resync-required';
    if (event.type === 'graph/regular-snapshot') {
      set({ profile: event.profile, regularLive: event.live, tuple });
      return 'applied';
    }
    set((state) => ({
      profile: event.profile,
      privateLiveByWindow: {
        ...state.privateLiveByWindow,
        [event.live.windowId]: event.live,
      },
      tuple,
    }));
    return 'applied';
  },
}));

export function applyGraphProjection(event: TargetedGraphEvent, boundWindowId: number): string {
  if (event.type === 'graph/resync-required') return 'resync-required';
  const disposition = useGraphStore.getState().apply(event);
  if (disposition === 'resync-required') return disposition;
  if (disposition === 'already-applied') return disposition;

  if (event.type === 'graph/regular-snapshot') {
    useWorkspacesStore
      .getState()
      .applySnapshot(event.profile.workspaces, event.live.activeId, event.live.activeIdByWindow);
    useSavedPanelsStore.getState().apply(event.profile.savedPanels);
    useTabsStore.getState().applySnapshot(event.live.tabs);
    useTabFoldersStore.getState().applySnapshot(event.live.tabFolders);
    usePinnedPanelsStore.getState().applySnapshot(event.live.pinnedPanels);
    for (const panels of event.live.panelsByWorkspace) {
      usePanelsStore.getState().apply(panels.workspaceId, panels.tabIds);
    }
    return disposition;
  }

  if (event.live.windowId !== boundWindowId) return 'resync-required';
  useWorkspacesStore.getState().applySnapshot(event.profile.workspaces, null, {
    [boundWindowId]: event.live.activeWorkspaceId ?? '',
  });
  useSavedPanelsStore.getState().apply(event.profile.savedPanels);
  useTabsStore.getState().applySnapshot(event.live.tabs);
  useTabFoldersStore.getState().applySnapshot(event.live.tabFolders);
  usePinnedPanelsStore.getState().applySnapshot(event.live.pinnedPanels);
  for (const panels of event.live.panelsByWorkspace) {
    usePanelsStore.getState().apply(panels.workspaceId, panels.tabIds);
  }
  return disposition;
}
