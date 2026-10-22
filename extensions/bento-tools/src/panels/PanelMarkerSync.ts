import type { PanelStore } from './PanelStore';
import { isEphemeralWorkspaceId } from '../workspaces/ephemeral';
import {
  clearDevtoolsPanelMarker,
  clearPanelMarker,
  setDevtoolsPanelMarker,
  setPanelMarker,
  type PanelMarker,
} from './SessionMarker';

type MarkerPanels = Pick<
  PanelStore,
  | 'getVisiblePanelIds'
  | 'isDevtoolsPanel'
  | 'getPanelRestoreLocation'
  | 'getPanelKey'
  | 'workspacesWithPersistedUrls'
  | 'dropPersistedPanel'
>;

export interface PanelMarkerSync {
  /**
   * Remembers the layout key a restored panel's marker carried, the first time it is read, for a
   * workspace that still has persisted entries to apply. A later read of the same tab keeps the
   * first key.
   */
  captureKey(tabId: number, marker: PanelMarker): void;
  /** The key `captureKey` kept for the tab, until `releaseKeys` drops it. */
  capturedKey(tabId: number): string | undefined;
  /** Drops the remembered keys once the persisted entries are bound. */
  releaseKeys(tabIds: Iterable<number>): void;
  /**
   * A tab was removed. Its remembered key goes either way. When the user closed it, the entry
   * its panel was restored for goes too, from the workspace's persisted entries and layout, so
   * applying them does not open the panel again. When its window is closing the entry stays: the
   * entries are what the next start restores the window's panels from.
   */
  tabRemoved(tabId: number, removeInfo: { isWindowClosing: boolean }): void;
  /**
   * Rewrites the session marker of every panel in the workspace with its current slot and
   * persisted layout key. Does nothing while the workspace still has persisted entries to apply.
   */
  sync(workspaceId: string): void;
}

/**
 * The session markers of a workspace's panels, kept equal to its layout. A panel's key is its
 * position in the layout, so the markers are rewritten whenever panels come, go or move, and a
 * restart binds each persisted entry to the tab that carries its key (`planPanelRestore`).
 *
 * Until a workspace's persisted entries are applied (`restorePanelsForWorkspace`), its layout
 * holds only the panels that came back with their markers, in marker order, and its numbering is
 * not the entries'. Rewriting the markers from it would give them keys that match no entry, or
 * the wrong one, and the entries stay in storage unchanged while their panels cannot be read: two
 * restarts later a top and a bottom panel would swap. So an unapplied workspace keeps the markers
 * it has; the sync that follows the apply writes the final keys.
 */
export function createPanelMarkerSync(panels: MarkerPanels): PanelMarkerSync {
  const keyByTabId = new Map<number, { workspaceId: string; panelKey: string }>();
  const hasUnappliedEntries = (workspaceId: string) =>
    panels.workspacesWithPersistedUrls().includes(workspaceId);

  return {
    captureKey(tabId, marker) {
      if (!marker.panelKey || keyByTabId.has(tabId)) return;
      if (!hasUnappliedEntries(marker.workspaceId)) return;
      keyByTabId.set(tabId, { workspaceId: marker.workspaceId, panelKey: marker.panelKey });
    },
    capturedKey: (tabId) => keyByTabId.get(tabId)?.panelKey,
    releaseKeys(tabIds) {
      for (const tabId of tabIds) keyByTabId.delete(tabId);
    },
    tabRemoved(tabId, { isWindowClosing }) {
      const captured = keyByTabId.get(tabId);
      keyByTabId.delete(tabId);
      if (captured && !isWindowClosing) {
        panels.dropPersistedPanel(captured.workspaceId, captured.panelKey);
      }
    },
    sync(workspaceId) {
      // A private window's Private workspace leaves no session marker.
      if (isEphemeralWorkspaceId(workspaceId)) return;
      if (hasUnappliedEntries(workspaceId)) return;
      for (const tabId of panels.getVisiblePanelIds(workspaceId)) {
        if (panels.isDevtoolsPanel(workspaceId, tabId)) {
          void clearPanelMarker(tabId);
          void setDevtoolsPanelMarker(tabId, workspaceId);
          continue;
        }
        void clearDevtoolsPanelMarker(tabId);
        void setPanelMarker(tabId, workspaceId, {
          ...panels.getPanelRestoreLocation(workspaceId, tabId),
          panelKey: panels.getPanelKey(workspaceId, tabId),
        });
      }
    },
  };
}
