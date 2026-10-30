import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactElement } from 'react';
import { IconButton, Text, Tooltip } from '@muxui/react';
import Command from 'lucide-react/dist/esm/icons/command';
import Download from 'lucide-react/dist/esm/icons/download';
import Menu from 'lucide-react/dist/esm/icons/menu';
import PanelLeftClose from 'lucide-react/dist/esm/icons/panel-left-close';
import PanelLeftOpen from 'lucide-react/dist/esm/icons/panel-left-open';

import { TabList } from './components/TabList/TabList';
import { PinnedPanels } from './components/PinnedPanels/PinnedPanels';
import { PrivateBand } from './components/PrivateBand/PrivateBand';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher/WorkspaceSwitcher';
import { SidebarAddressBar } from './components/SidebarAddressBar/SidebarAddressBar';
import { ColorModeCycle } from './components/ColorModeCycle/ColorModeCycle';
import { dispatch, useCurrentWindowId, useToolsReady } from './bridge/useToolsPort';
import { startWelcomeRequests } from './bridge/useWelcome';
import { useWorkspaceTheme } from './theme/useWorkspaceTheme';
import { useSettingsStore } from './state/settings';
import { useTabsStore } from './state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from './state/workspaces';
import { getPanelIdsForWorkspace, usePanelsStore } from './state/panels';
import { useWorkspaceFolders } from './state/tabFolders';
import { useUiStore } from './state/ui';
import { usePrivateWindow } from './state/privateWindow';
import type { UiColorModePref } from '@shared/protocol';
import { BentoIcon } from './components/primitives/BentoIcon';
import { Row } from './components/primitives/BentoRow';
import { MergeProgressCard } from './components/MergeProgressCard/MergeProgressCard';
import { SidebarCards } from './components/SidebarCards/SidebarCards';
import { encodeTitlePayload, sendChromeTitle } from './bridge/chromeTitle';
import { NEW_MENU_ITEMS, trackNewMenuOpen } from './bridge/newMenu';
import { observeRailViewport, setRailAttribute } from './sidebar/railViewport';
import { createRailTransition, type RailTransition } from './sidebar/railTransition';
import { createRailTransitionDom } from './sidebar/railLayout';
import './sidebar/railTransition.css';
import { observeFooterButtonEdges, type FooterButtonEdges } from './sidebar/footerAnchor';
import { startSoftcastDemo } from './dev/initSoftcastDemo';

// Note: the command palette no longer lives in this entry. It runs in its
// own chrome-mounted overlay <browser> (palette.html) so the modal can
// cover the whole browser window. Show/hide is owned by chrome via a key
// binding in src/browser/base/content/bento-shell-mount.js.

const UI_COLOR_MODE_ORDER: readonly UiColorModePref[] = ['light', 'dark', 'system'];

function FooterTooltip({
  label,
  disabled = false,
  children,
}: {
  label: string;
  disabled?: boolean;
  children: ReactElement;
}) {
  if (disabled) return <>{children}</>;
  return <Tooltip content={label} delay={400} placement="top" offset={8} trigger={children} />;
}

/**
 * The footer's colour mode button. It reads the saved mode itself: read in `App`, a flip
 * re-rendered the whole sidebar (every tab row) at the moment the change arrived, which delays
 * the sidebar's part of the flip fade in proportion to the tab count.
 */
function FooterColorModeCycle() {
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);
  return (
    <ColorModeCycle
      value={uiColorMode}
      onChange={(next: UiColorModePref) =>
        dispatch({ type: 'settings/update', changes: { uiColorMode: next } })
      }
      modes={UI_COLOR_MODE_ORDER}
      surfaceLabel="Bento UI"
    />
  );
}

function signalScrollToMain() {
  sendChromeTitle(`BENTO_SCROLL_TO_MAIN_${Date.now()}`);
}

function openCommandPalette() {
  // Sidebar content can't directly call the chrome-side showPalette()
  // (cross-process). Use the same document.title IPC pattern as the
  // palette uses to signal close — chrome listens for DOMTitleChanged on
  // the bento-shell-frame and shows the palette when it sees this prefix.
  // Timestamp suffix ensures successive presses always fire the event
  // (no change = no event).
  const newTitle = `BENTO_OPEN_PALETTE_${Date.now()}`;
  sendChromeTitle(newTitle);
}

function openMergePalette() {
  const newTitle = `BENTO_OPEN_MERGE_PALETTE_${Date.now()}`;
  sendChromeTitle(newTitle);
}

function sidebarAnchorPayload(anchorRect: DOMRect | null) {
  return {
    anchor: anchorRect
      ? {
          left: anchorRect.left,
          top: anchorRect.top,
          width: anchorRect.width,
          height: anchorRect.height,
        }
      : null,
  };
}

function openFirefoxAppMenu(anchorRect: DOMRect | null) {
  sendChromeTitle(
    `BENTO_OPEN_APP_MENU:${Date.now()}:${encodeTitlePayload(sidebarAnchorPayload(anchorRect))}`,
  );
}

// Where the Downloads button is, for Firefox's own downloads opens. A click on the
// button sends its rect with the open instead.
function reportDownloadsAnchor(edges: FooterButtonEdges) {
  sendChromeTitle(`BENTO_DOWNLOADS_ANCHOR:${Date.now()}:${encodeTitlePayload({ anchor: edges })}`);
}

function openFirefoxDownloads(anchorRect: DOMRect | null) {
  sendChromeTitle(
    `BENTO_OPEN_DOWNLOADS:${Date.now()}:${encodeTitlePayload(sidebarAnchorPayload(anchorRect))}`,
  );
}

interface SidebarMenuItem {
  id: string;
  label?: string;
  items?: SidebarMenuItem[];
  kind?: 'separator';
  isDisabled?: boolean;
}

function openSidebarContextMenuInChrome(payload: object) {
  sendChromeTitle(`BENTO_SIDEBAR_CONTEXT_MENU:${Date.now()}:${encodeTitlePayload(payload)}`);
}

export function App() {
  const ready = useToolsReady();
  // A private window has one temporary workspace and stores nothing: no workspace switcher
  // (the Private band takes its place), no pinned panels, no workspace or folder moves.
  const isPrivate = usePrivateWindow();
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const tabsById = useTabsStore((s) => s.byId);
  const activeTabId = useTabsStore((s) => s.activeId);
  const folders = useWorkspaceFolders(activeWorkspaceId);
  const workspacesById = useWorkspacesStore((s) => s.byId);
  const workspaceIds = useWorkspacesStore((s) => s.orderedIds);
  useEffect(() => {
    if (typeof __BENTO_SOFTCAST_DEMO__ === 'undefined' || !__BENTO_SOFTCAST_DEMO__) return;
    if (
      ready &&
      windowId !== null &&
      activeWorkspaceId &&
      workspacesById[activeWorkspaceId] &&
      useTabsStore.getState().hydrated &&
      !isPrivate
    ) {
      startSoftcastDemo(windowId, activeWorkspaceId);
    }
  }, [ready, windowId, activeWorkspaceId, workspacesById, tabsById, isPrivate]);
  const activePanelIds = usePanelsStore((s) => getPanelIdsForWorkspace(s, activeWorkspaceId));
  const activePanelsHydrated = usePanelsStore((s) =>
    activeWorkspaceId ? s.hydratedWorkspaces.has(activeWorkspaceId) : false,
  );
  const hasNoSidePanels = activePanelsHydrated && activePanelIds.size === 0;
  // Per-workspace theme. Mirrors the active workspace's themeId onto
  // <html data-bento-theme="..."> so the scoped theme rules in
  // theme/presets/<id>.css apply to the shell. Chrome receives the active
  // workspace theme through the same BENTO_PANELS payload that carries
  // uiColorMode, so first-paint theme/color updates stay atomic.
  useWorkspaceTheme();
  // First-run welcome trigger. The settings snapshot lands a moment after
  // the tools port connects; once it does and welcomeSeen=false, signal
  // chrome to show the welcome overlay (chrome-mounted, full-window scrim
  // — implemented via the welcome.html overlay frame). welcome.html also
  // emits the same open signal from its own settings mirror so cold-start
  // title races do not make first-run onboarding depend only on the
  // sidebar frame.
  //
  // startWelcomeRequests repeats the request for about a second. The repeats
  // predate the shared title writer, when a BENTO_PANELS write could displace
  // the first request; they are now only a safeguard, harmless because chrome's
  // showWelcome() is idempotent, and stop when welcomeSeen flips true.
  const welcomeShouldShow = useSettingsStore((s) => s.current !== null && !s.current.welcomeSeen);
  useEffect(() => {
    if (!welcomeShouldShow) return;
    return startWelcomeRequests();
  }, [welcomeShouldShow]);

  // Lets the New button show its open fill while its chrome-rendered menu is up.
  useEffect(trackNewMenuOpen, []);

  useEffect(() => {
    const channel = new BroadcastChannel('bento-shell-bus');
    channel.addEventListener('message', (message) => {
      const data = message.data;
      if (!data || data.kind !== 'action') return;
      const action = data.action as { type?: string; target?: unknown };
      if (action.type !== 'ui/renameRequest') return;
      const target = action.target as { kind?: unknown; id?: unknown };
      if (target?.kind === 'tab' && typeof target.id === 'number') {
        useUiStore.getState().requestRename({ kind: 'tab', id: target.id });
      } else if (target?.kind === 'folder' && typeof target.id === 'string') {
        useUiStore.getState().requestRename({ kind: 'folder', id: target.id });
      }
    });
    return () => channel.close();
  }, []);

  const onActivate = (id: number) => {
    dispatch({ type: 'tab/activate', id });
    // Signal chrome to scroll the panel strip back to the main slot.
    // Fires for EVERY tab-row click, including re-clicks on the
    // already-active tab — Firefox suppresses TabSelect for the
    // already-active tab, so chrome's TabSelect-driven reconcile
    // never runs for that case and the strip stays stuck wherever
    // the user last scrolled it. Title sentinel covers the gap.
    signalScrollToMain();
  };
  const onClose = (id: number) => dispatch({ type: 'tab/close', id });
  const onCloseSelected = (ids: number[]) => dispatch({ type: 'tabs/close', ids });
  const onOpenNewMenu = (anchorRect: DOMRect) => {
    openSidebarContextMenuInChrome({
      anchor: {
        left: anchorRect.left,
        top: anchorRect.top,
        width: anchorRect.width,
        height: anchorRect.height,
      },
      placement: 'bottom start',
      tabId: null,
      items: NEW_MENU_ITEMS,
    });
  };
  const onOpenInSidePanel = (id: number) => dispatch({ type: 'panel/add', id });
  const downloadsButtonRef = useRef<HTMLButtonElement>(null);
  const appMenuButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const footer = downloadsButtonRef.current?.closest('.bento-shell-app__footer');
    if (!footer) return;
    return observeFooterButtonEdges(
      footer,
      () => downloadsButtonRef.current,
      reportDownloadsAnchor,
    );
  }, []);
  const onOpenFirefoxDownloads = () => {
    openFirefoxDownloads(downloadsButtonRef.current?.getBoundingClientRect() ?? null);
  };
  const onOpenFirefoxAppMenu = () => {
    openFirefoxAppMenu(appMenuButtonRef.current?.getBoundingClientRect() ?? null);
  };
  const openSidebarContextMenu = (
    event: React.MouseEvent,
    tabId: number | null,
    selectedTabIds: number[] = [],
    visualTabOrder: number[] = [],
    folderId?: string,
  ) => {
    event.preventDefault();
    const items: SidebarMenuItem[] = [
      { id: 'new-tab', label: 'New tab' },
      { id: 'reopen-closed-tab', label: 'Reopen closed tab' },
      { id: 'select-all-tabs', label: 'Select all tabs' },
    ];
    if (folderId) {
      const folder = folders.find((candidate) => candidate.id === folderId);
      const folderWorkspaceItems = workspaceIds.map((workspaceId) => {
        const workspace = workspacesById[workspaceId];
        return {
          id: `move-folder-to-workspace:${workspaceId}`,
          label: workspace?.name ?? 'Untitled workspace',
          isDisabled: folder?.workspaceId === workspaceId,
        };
      });
      items.push(
        { id: 'sep-folder-actions', kind: 'separator' },
        { id: 'rename-folder', label: 'Rename folder' },
        {
          id: 'move-folder-to-workspace',
          label: 'Move folder to workspace',
          items: folderWorkspaceItems,
        },
        { id: 'delete-folder', label: 'Delete folder' },
      );
      openSidebarContextMenuInChrome({
        anchor: { left: event.clientX, top: event.clientY, width: 1, height: 1 },
        tabId: null,
        folderId,
        items,
      });
      return;
    }
    const tab = tabId !== null ? tabsById[tabId] : null;
    const targetTabIds =
      tabId === null
        ? []
        : Array.from(
            new Set(
              (selectedTabIds.length > 0 ? selectedTabIds : [tabId]).filter((id) => tabsById[id]),
            ),
          );
    const isBatch = targetTabIds.length > 1;
    let closeTabsAboveIds: number[] = [];
    let closeTabsBelowIds: number[] = [];
    let closeOtherTabIds: number[] = [];
    if (tabId !== null) {
      const folderItems = folders.map((folder) => ({
        id: `move-to-folder:${folder.id}`,
        label: folder.name,
        isDisabled: targetTabIds.every((id) => tabsById[id]?.folderId === folder.id),
      }));
      const anyTargetInFolder = targetTabIds.some((id) => tabsById[id]?.folderId);
      const allTargetsPinned =
        targetTabIds.length > 0 && targetTabIds.every((id) => tabsById[id]?.pinned);
      const workspaceItems = workspaceIds.map((workspaceId) => {
        const workspace = workspacesById[workspaceId];
        return {
          id: `move-to-workspace:${workspaceId}`,
          label: workspace?.name ?? 'Untitled workspace',
          isDisabled: targetTabIds.every((id) => tabsById[id]?.workspaceId === workspaceId),
        };
      });
      const tabOrderIndex = visualTabOrder.indexOf(tabId);
      closeTabsAboveIds = tabOrderIndex >= 0 ? visualTabOrder.slice(0, tabOrderIndex) : [];
      closeTabsBelowIds = tabOrderIndex >= 0 ? visualTabOrder.slice(tabOrderIndex + 1) : [];
      closeOtherTabIds = visualTabOrder.filter(
        (id) => id !== tabId && tabsById[id] && !tabsById[id].pinned,
      );
      items.push({ id: 'sep-tab-actions', kind: 'separator' });
      if (!isBatch) items.push({ id: 'new-tab-below', label: 'New tab below' });
      if (!isBatch) items.push({ id: 'rename-tab', label: 'Rename tab' });
      if (isBatch) {
        items.push({ id: 'reload-selected-tabs', label: `Reload ${targetTabIds.length} tabs` });
        if (!isPrivate) {
          items.push({
            id: 'move-selected-to-new-workspace',
            label: `Move ${targetTabIds.length} tabs to new workspace`,
          });
        }
      } else {
        items.push(
          { id: 'reload-tab', label: 'Reload tab' },
          {
            id: 'unload-tab',
            label: 'Unload tab',
            isDisabled: Boolean(tab?.active || tab?.discarded),
          },
          { id: 'toggle-muted', label: tab?.muted ? 'Unmute tab' : 'Mute tab' },
          { id: 'toggle-pin', label: tab?.pinned ? 'Unpin tab' : 'Pin tab' },
        );
        if (tabId !== activeTabId) {
          items.push({ id: 'open-in-side-panel', label: 'Convert to panel' });
        }
      }
      if (!isPrivate && workspaceItems.length > 0) {
        items.push({
          id: 'move-to-workspace',
          label: isBatch ? 'Move selected tabs to workspace' : 'Move to workspace',
          items: workspaceItems,
        });
      }
      if (!isPrivate && !allTargetsPinned) {
        items.push({
          id: 'move-to-folder',
          label: isBatch ? 'Move selected tabs to folder' : 'Move to folder',
          items: [
            ...folderItems,
            ...(folderItems.length > 0
              ? [{ id: 'sep-move-to-folder-new', kind: 'separator' as const }]
              : []),
            { id: 'move-to-folder:new', label: 'New folder' },
            ...(anyTargetInFolder
              ? [{ id: 'move-to-folder:none', label: 'Remove from folder' }]
              : []),
          ],
        });
      }
      if (!isBatch) {
        items.push(
          { id: 'sep-close-tab', kind: 'separator' },
          {
            id: 'close-multiple-tabs',
            label: 'Close multiple tabs',
            items: [
              {
                id: 'close-tabs-above',
                label: 'Close tabs above',
                isDisabled: closeTabsAboveIds.length === 0,
              },
              {
                id: 'close-tabs-below',
                label: 'Close tabs below',
                isDisabled: closeTabsBelowIds.length === 0,
              },
              {
                id: 'close-other-tabs',
                label: 'Close other tabs',
                isDisabled: closeOtherTabIds.length === 0,
              },
            ],
          },
          { id: 'close-tab', label: 'Close tab' },
        );
      } else {
        items.push(
          { id: 'sep-close-tabs', kind: 'separator' },
          { id: 'close-selected-tabs', label: `Close ${targetTabIds.length} selected tabs` },
        );
      }
    }
    openSidebarContextMenuInChrome({
      anchor: { left: event.clientX, top: event.clientY, width: 1, height: 1 },
      tabId,
      tabIndex: tab?.index,
      tabIds: targetTabIds,
      closeMultipleTabIds:
        tabId !== null && !isBatch
          ? {
              above: closeTabsAboveIds,
              below: closeTabsBelowIds,
              other: closeOtherTabIds,
            }
          : undefined,
      newFolderId: crypto.randomUUID(),
      items,
    });
  };
  const onRootContextMenu = (event: React.MouseEvent) => {
    openSidebarContextMenu(event, null);
  };
  const onTabContextMenu = (
    id: number,
    event: React.MouseEvent<HTMLDivElement>,
    selectedIds: number[],
    visualTabOrder: number[],
  ) => {
    openSidebarContextMenu(event, id, selectedIds, visualTabOrder);
  };
  const onFolderContextMenu = (id: string, event: React.MouseEvent<HTMLDivElement>) => {
    openSidebarContextMenu(event, null, [], [], id);
  };
  const onReorder = (id: number, anchorId: number, before: boolean) => {
    // Title-IPC to chrome rather than browser.tabs.move via bento-tools.
    // browser.tabs.move runs Firefox's moveTabTo, which transforms the
    // element through `element = element.splitview` when the tab has a
    // splitview marker. Bento panels assign every active tab a plain-
    // object .splitview marker that isn't a MozTabSplitViewWrapper, so
    // #handleTabMove then throws "Can only move a tab, tab group, or
    // split view within the tab bar". gBrowser.moveTabBefore /
    // moveTabAfter (called from chrome via this title-IPC) operate on
    // the original element reference and skip the transformation, so
    // dragging works for active/main-panel tabs too.
    sendChromeTitle(
      `BENTO_TAB_MOVE:${Date.now()}:${id}:${anchorId}:${before ? 'before' : 'after'}`,
    );
  };
  const sidebarCollapsedSetting = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  const sidebarHidden = useSettingsStore((s) => s.current?.sidebarHidden ?? false);
  const sidebarCollapsed = sidebarHidden || sidebarCollapsedSetting;
  const toggleSidebarCollapsed = () => {
    dispatch({
      type: 'settings/update',
      changes: sidebarHidden
        ? { sidebarHidden: false, sidebarCollapsed: false }
        : { sidebarHidden: false, sidebarCollapsed: !sidebarCollapsed },
    });
  };

  // The rail visuals (TabRow, WorkspaceSwitcher, footer layout, ...) key off
  // data-bento-collapsed on <html>, and that follows the width the shell is
  // rendered at, not the setting above. Chrome narrows #bento-shell-host to the
  // rail at its own point in the sidebar slide (see "Sidebar collapse" in
  // docs/technical/workspaces.md), and the shell switches layout in the same
  // frame its viewport does. The setting only drives the semantic parts
  // (labels, icon, tooltips) and starts the collapse and expand choreography
  // (sidebar/railTransition.ts), which runs between the flip and that switch.
  const appRef = useRef<HTMLDivElement>(null);
  const railTransitionRef = useRef<RailTransition | null>(null);
  useLayoutEffect(() => {
    const root = appRef.current;
    if (!root) return;
    const transition = createRailTransition(createRailTransitionDom(root));
    railTransitionRef.current = transition;
    const stop = observeRailViewport(root, transition.viewport);
    return () => {
      stop();
      transition.dispose();
      railTransitionRef.current = null;
      setRailAttribute(false);
    };
  }, []);
  // Before paint, so a collapse's first frame is already the phase's.
  const settingsLoaded = useSettingsStore((s) => s.current !== null);
  useLayoutEffect(() => {
    if (!settingsLoaded) return;
    railTransitionRef.current?.setting({
      collapsed: sidebarCollapsedSetting,
      hidden: sidebarHidden,
    });
  }, [settingsLoaded, sidebarCollapsedSetting, sidebarHidden]);

  return (
    <div
      ref={appRef}
      className={
        hasNoSidePanels ? 'bento-shell-app bento-shell-app--no-side-panels' : 'bento-shell-app'
      }
      onContextMenu={onRootContextMenu}
    >
      {!isPrivate && <PinnedPanels />}
      <div className="bento-shell-app__main">
        {!ready && (
          <Row gap="xs" align="center" className="bento-shell-app__header">
            <Text variant="body" size="xs" color="muted">
              connecting…
            </Text>
          </Row>
        )}
        {isPrivate ? (
          <div className="bento-shell-app__workspace-switcher bento-shell-app__workspace-switcher--private">
            <PrivateBand rail={sidebarCollapsed} />
          </div>
        ) : (
          <div className="bento-shell-app__workspace-switcher">
            <WorkspaceSwitcher />
          </div>
        )}
        <SidebarAddressBar />
        <div className="bento-shell-app__list-region">
          <TabList
            onActivate={onActivate}
            onClose={onClose}
            onCloseSelected={onCloseSelected}
            onOpenNewMenu={onOpenNewMenu}
            onOpenInSidePanel={onOpenInSidePanel}
            onTabContextMenu={onTabContextMenu}
            onFolderContextMenu={onFolderContextMenu}
            onReorder={onReorder}
          />
          <SidebarCards>
            <MergeProgressCard rail={sidebarCollapsed} onOpen={openMergePalette} />
          </SidebarCards>
        </div>
        <Row gap="4xs" align="center" className="bento-shell-app__footer">
          {/* Collapse/expand toggle. DOM order matters: this is the FIRST
              child so flex-direction:column-reverse in collapsed mode pins
              it to the bottom of the vertical stack (= same on-screen
              position as the leftmost slot of the expanded horizontal row).
              That's the explicit UX requirement — clicking expand should
              land at the same cursor position as clicking collapse. */}
          <FooterTooltip
            label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            disabled={sidebarCollapsed}
          >
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onActivate={toggleSidebarCollapsed}
            >
              <BentoIcon icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose} />
            </IconButton>
          </FooterTooltip>
          <FooterTooltip label="Open command palette" disabled={sidebarCollapsed}>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Open command palette (⌘⌥P)"
              onActivate={openCommandPalette}
            >
              <BentoIcon icon={Command} />
            </IconButton>
          </FooterTooltip>
          <FooterTooltip label="Color mode" disabled={sidebarCollapsed}>
            <FooterColorModeCycle />
          </FooterTooltip>
          <FooterTooltip label="Firefox menu" disabled={sidebarCollapsed}>
            <IconButton
              ref={appMenuButtonRef}
              variant="ghost"
              size="sm"
              aria-label="Open Firefox menu"
              onActivate={onOpenFirefoxAppMenu}
            >
              <BentoIcon icon={Menu} />
            </IconButton>
          </FooterTooltip>
          <FooterTooltip label="Downloads" disabled={sidebarCollapsed}>
            <IconButton
              ref={downloadsButtonRef}
              variant="ghost"
              size="sm"
              aria-label="Downloads"
              onActivate={onOpenFirefoxDownloads}
            >
              <BentoIcon icon={Download} />
            </IconButton>
          </FooterTooltip>
        </Row>
      </div>
    </div>
  );
}
