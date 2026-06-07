import { memo } from 'react';
import type { MouseEvent } from 'react';
import { IconButton } from '@tale-ui/react/icon-button';

import { usePinnedPanelsStore } from '../../state/pinnedPanels';
import { usePanelFocusStore } from '../../state/panelFocus';
import { useTab } from '../../state/tabs';
import { dispatch } from '../../bridge/useToolsPort';
import type { PinnedPanelEntry } from '@shared/protocol';
import './PinnedPanels.css';

interface PinnedPanelRowProps {
  entry: PinnedPanelEntry;
}

function PinnedPanelRowImpl({ entry }: PinnedPanelRowProps) {
  // useTab returns undefined when the tab isn't in this shell's tab store
  // yet (cross-window — a pin pointing at a tab in another window's
  // gBrowser). The pin is still valid; tools holds the canonical entry.
  // Render a fallback label so the row stays visible and clickable —
  // the activation handler dispatches through bento-tools which has
  // access to every window's tabs.
  const tab = useTab(entry.tabId);
  const focusedTabId = usePanelFocusStore((s) => s.focusedTabId);
  const title = tab?.customTitle || tab?.title || entry.title || entry.url || 'Pinned panel';
  const favIconUrl = tab?.favIconUrl || entry.favIconUrl;
  const isFocused = focusedTabId === entry.tabId;

  const openPinnedPanel = () =>
    dispatch({ type: 'pinnedPanel/open', workspaceId: entry.workspaceId, tabId: entry.tabId });
  const closePinnedPanel = () =>
    dispatch({ type: 'pinnedPanel/close', workspaceId: entry.workspaceId, tabId: entry.tabId });
  const openContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = {
      anchor: { left: event.clientX, top: event.clientY, width: 1, height: 1 },
      pinnedPanel: { workspaceId: entry.workspaceId, tabId: entry.tabId },
      items: [
        { id: 'pinned-panel-remove', label: 'Remove pinned panel' },
        { id: 'pinned-panel-close', label: 'Close pinned panel' },
      ],
    };
    const encoded = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
    document.title = `BENTO_SIDEBAR_CONTEXT_MENU:${Date.now()}:${encoded}`;
  };

  return (
    <IconButton
      className="bento-pinned-panels__button"
      data-bento-focused={isFocused ? 'true' : undefined}
      variant="neutral"
      size="sm"
      aria-label={`Open pinned panel: ${title}`}
      onPress={openPinnedPanel}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          closePinnedPanel();
        }
      }}
      onContextMenu={openContextMenu}
    >
      {favIconUrl ? (
        <img className="bento-pinned-panels__favicon" src={favIconUrl} alt="" />
      ) : (
        <span className="bento-pinned-panels__favicon bento-pinned-panels__favicon--placeholder" />
      )}
    </IconButton>
  );
}

const PinnedPanelRow = memo(PinnedPanelRowImpl);

export function PinnedPanels() {
  const entries = usePinnedPanelsStore((s) => s.entries);
  if (entries.length === 0) return null;
  return (
    <nav className="bento-pinned-panels" aria-label="Pinned panels">
      {entries.map((entry) => (
        <PinnedPanelRow key={`${entry.workspaceId}:${entry.tabId}`} entry={entry} />
      ))}
    </nav>
  );
}
