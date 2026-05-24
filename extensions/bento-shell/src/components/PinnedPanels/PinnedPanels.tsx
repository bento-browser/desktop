import { memo } from 'react';
import { Text } from '@tale-ui/react/text';
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import X from 'lucide-react/dist/esm/icons/x';

import { usePinnedPanelsStore } from '../../state/pinnedPanels';
import { useTab } from '../../state/tabs';
import { dispatch } from '../../bridge/useToolsPort';
// Pinned panel rows reuse TabRow's BEM classes so the two sidebar
// sections are visually identical by construction. Explicit import so
// Ladle stories for PinnedPanels render correctly without TabRow being
// in the tree (in the real shell App.tsx always mounts TabList, so the
// CSS would be loaded anyway).
import '../TabRow/TabRow.css';
import './PinnedPanels.css';

interface PinnedPanelRowProps {
  workspaceId: string;
  tabId: number;
}

function PinnedPanelRowImpl({ workspaceId, tabId }: PinnedPanelRowProps) {
  // useTab returns undefined when the tab isn't in this shell's tab store
  // yet (cross-window — a pin pointing at a tab in another window's
  // gBrowser). The pin is still valid; tools holds the canonical entry.
  // Render a fallback label so the row stays visible and clickable —
  // the activation handler dispatches through bento-tools which has
  // access to every window's tabs.
  const tab = useTab(tabId);
  const title = tab?.title || 'Pinned panel';
  const favIconUrl = tab?.favIconUrl;
  const onActivate = () => {
    // Workspace switch goes through tools; the panel is NOT activated
    // as the main tab (that would relocate it into the main content
    // slot — see protocol-handler `pinnedPanel/activate`). The chrome-
    // side scroll-into-view + focus is signalled separately via this
    // title-IPC, which chrome retries until the panel element exists
    // (covers the workspace-reconcile delay when crossing workspaces).
    dispatch({ type: 'pinnedPanel/activate', workspaceId, tabId });
    document.title = `BENTO_FOCUS_PANEL:${Date.now()}:${tabId}`;
  };
  const onUnpin = () => dispatch({ type: 'pinnedPanel/remove', workspaceId, tabId });
  return (
    <div
      className="bento-tab-row"
      onClick={onActivate}
      title={title}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onActivate();
        }
      }}
    >
      {favIconUrl ? (
        <img className="bento-tab-row__favicon" src={favIconUrl} alt="" />
      ) : (
        <span className="bento-tab-row__favicon bento-tab-row__favicon--placeholder" />
      )}
      <Text variant="text" size="s" color="muted">
        {title}
      </Text>
      {/* React Aria's IconButton onPress doesn't stop the underlying
       * click from bubbling, so a click on X would also reach the row's
       * onClick and trigger pinnedPanel/activate — switching workspace
       * the moment the user tries to unpin. The wrapper stops the
       * click before it reaches the row. */}
      <div
        className="bento-tab-row__actions"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <IconButton variant="ghost" size="sm" aria-label="Unpin panel" onPress={onUnpin}>
          <Icon icon={X} />
        </IconButton>
      </div>
    </div>
  );
}

const PinnedPanelRow = memo(PinnedPanelRowImpl);

export function PinnedPanels() {
  const entries = usePinnedPanelsStore((s) => s.entries);
  if (entries.length === 0) return null;
  return (
    <div className="bento-pinned-panels">
      <div className="bento-pinned-panels__heading">
        <Text variant="text" size="xs" color="muted">
          Pinned panels
        </Text>
      </div>
      {entries.map((entry) => (
        <div key={`${entry.workspaceId}:${entry.tabId}`} className="bento-pinned-panels__row">
          <PinnedPanelRow workspaceId={entry.workspaceId} tabId={entry.tabId} />
        </div>
      ))}
    </div>
  );
}
