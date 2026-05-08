import { useEffect } from 'react';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import Settings from 'lucide-react/dist/esm/icons/settings';
import Command from 'lucide-react/dist/esm/icons/command';
import PanelRightClose from 'lucide-react/dist/esm/icons/panel-right-close';

import { TabList } from './components/TabList/TabList';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher/WorkspaceSwitcher';
import { dispatch, useToolsReady } from './bridge/useToolsPort';
import { useWorkspacesStore } from './state/workspaces';

// Note: the command palette no longer lives in this entry. It runs in its
// own chrome-mounted overlay <browser> (palette.html) so the modal can
// cover the whole browser window. Show/hide is owned by chrome via a key
// binding in src/browser/base/content/bento-shell-mount.js.

function openSettings() {
  // Round-trip through bento-tools (which has reliable browser.tabs access)
  // because the chrome-mounted <browser remote=true remoteType=extension>
  // doesn't get the WebExtensions `browser` global injected, AND
  // window.open opens a new window not a tab (Firefox decides per user
  // prefs). Resolving the URL via location.origin keeps it relative to
  // bento-shell's UUID without needing to ask tools.
  const url = `${location.origin}/dist/settings.html`;
  dispatch({ type: 'tab/openUrl', url });
}

function openCommandPalette() {
  // Sidebar content can't directly call the chrome-side showPalette()
  // (cross-process). Use the same document.title IPC pattern as the
  // palette uses to signal close — chrome listens for DOMTitleChanged on
  // the bento-shell-frame and shows the palette when it sees this prefix.
  // Timestamp suffix ensures successive presses always fire the event
  // (no change = no event).
  const newTitle = `BENTO_OPEN_PALETTE_${Date.now()}`;
  console.log('[App] openCommandPalette: setting title to', newTitle);
  document.title = newTitle;
}

export function App() {
  const ready = useToolsReady();
  const activeWorkspaceColor = useWorkspacesStore((s) =>
    s.activeId ? s.byId[s.activeId]?.color : undefined,
  );

  // Propagate the active workspace's accent palette to <html data-workspace-color>
  // so per-workspace accent tokens (declared in bento-tokens.css) cascade to
  // the entire shell.
  useEffect(() => {
    const html = document.documentElement;
    if (activeWorkspaceColor) html.setAttribute('data-workspace-color', activeWorkspaceColor);
    else html.removeAttribute('data-workspace-color');
  }, [activeWorkspaceColor]);

  const onActivate = (id: number) => dispatch({ type: 'tab/activate', id });
  const onClose = (id: number) => dispatch({ type: 'tab/close', id });
  const onOpenInSidePanel = (id: number) => dispatch({ type: 'panel/add', id });
  const closeSidePanel = () => dispatch({ type: 'panels/clear' });

  return (
    <Column gap="xs" className="bento-shell-app">
      <Row gap="xs" align="center" className="bento-shell-app__header">
        <WorkspaceSwitcher />
        {!ready && (
          <Text variant="text" size="xs" color="muted">
            connecting…
          </Text>
        )}
      </Row>
      <TabList onActivate={onActivate} onClose={onClose} onOpenInSidePanel={onOpenInSidePanel} />
      <Row gap="2xs" align="center" className="bento-shell-app__footer">
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Close side panel"
          onPress={closeSidePanel}
        >
          <Icon icon={PanelRightClose} />
        </IconButton>
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Open command palette (⌘⌥P)"
          onPress={openCommandPalette}
        >
          <Icon icon={Command} />
        </IconButton>
        <IconButton variant="ghost" size="sm" aria-label="Settings" onPress={openSettings}>
          <Icon icon={Settings} />
        </IconButton>
      </Row>
    </Column>
  );
}
