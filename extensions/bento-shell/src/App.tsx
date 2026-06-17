import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { IconButton } from '@tale-ui/react/icon-button';
import { Icon } from '@tale-ui/react/icon';
import { Tooltip } from '@tale-ui/react/tooltip';
import Settings from 'lucide-react/dist/esm/icons/settings';
import Command from 'lucide-react/dist/esm/icons/command';
import PanelLeftClose from 'lucide-react/dist/esm/icons/panel-left-close';
import PanelLeftOpen from 'lucide-react/dist/esm/icons/panel-left-open';

import { TabList } from './components/TabList/TabList';
import { PinnedPanels } from './components/PinnedPanels/PinnedPanels';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher/WorkspaceSwitcher';
import { ColorModeCycle } from './components/ColorModeCycle/ColorModeCycle';
import { dispatch, useCurrentWindowId, useToolsReady } from './bridge/useToolsPort';
import { requestWelcome } from './bridge/useWelcome';
import { useWorkspaceTheme } from './theme/useWorkspaceTheme';
import { useSettingsStore } from './state/settings';
import { useTabsStore } from './state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from './state/workspaces';
import { useWorkspaceFolders } from './state/tabFolders';
import { useUiStore } from './state/ui';
import type { UiColorModePref } from '@shared/protocol';

// Note: the command palette no longer lives in this entry. It runs in its
// own chrome-mounted overlay <browser> (palette.html) so the modal can
// cover the whole browser window. Show/hide is owned by chrome via a key
// binding in src/browser/base/content/bento-shell-mount.js.

const UI_COLOR_MODE_ORDER: readonly UiColorModePref[] = ['light', 'dark', 'system'];

function FooterTooltip({
  label,
  isDisabled = false,
  children,
}: {
  label: string;
  isDisabled?: boolean;
  children: ReactNode;
}) {
  if (isDisabled) return <>{children}</>;
  return (
    <Tooltip.Root delay={400}>
      {children}
      <Tooltip.Popup placement="top" offset={8}>
        <Tooltip.Arrow />
        {label}
      </Tooltip.Popup>
    </Tooltip.Root>
  );
}

function openSettings() {
  // Round-trip through bento-tools (which has reliable browser.tabs access)
  // because the chrome-mounted <browser remote=true remoteType=extension>
  // doesn't get the WebExtensions `browser` global injected, AND
  // window.open opens a new window not a tab (Firefox decides per user
  // prefs). Resolving the URL via location.origin keeps it relative to
  // bento-shell's UUID without needing to ask tools.
  //
  // focusExisting: Settings is a singleton — repeated clicks should
  // bring the existing tab forward rather than stack duplicates inside
  // the workspace.
  const url = `${location.origin}/dist/settings.html`;
  dispatch({ type: 'tab/openUrl', url, focusExisting: true });
}

function openCommandPalette() {
  // Sidebar content can't directly call the chrome-side showPalette()
  // (cross-process). Use the same document.title IPC pattern as the
  // palette uses to signal close — chrome listens for DOMTitleChanged on
  // the bento-shell-frame and shows the palette when it sees this prefix.
  // Timestamp suffix ensures successive presses always fire the event
  // (no change = no event).
  const newTitle = `BENTO_OPEN_PALETTE_${Date.now()}`;
  document.title = newTitle;
}

interface SidebarMenuItem {
  id: string;
  label?: string;
  items?: SidebarMenuItem[];
  kind?: 'separator';
  isDisabled?: boolean;
}

function encodeSidebarMenuPayload(payload: object): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

export function App() {
  const ready = useToolsReady();
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const tabsById = useTabsStore((s) => s.byId);
  const activeTabId = useTabsStore((s) => s.activeId);
  const folders = useWorkspaceFolders(activeWorkspaceId);
  const workspacesById = useWorkspacesStore((s) => s.byId);
  const workspaceIds = useWorkspacesStore((s) => s.orderedIds);
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
  // Why the retry loop: requestWelcome() sets document.title =
  // BENTO_OPEN_WELCOME_<ts>, which the chrome poll picks up. But the
  // `panels/sync` event handler in useToolsPort ALSO writes document.title
  // (BENTO_PANELS:...) and lands moments later on cold boot — stomping
  // the welcome title before the 200ms chrome poll can see it. On
  // Alt+Shift+R there's no fresh panels broadcast so welcome wins on
  // first try. Five attempts × 200ms = 1s window covers the cold-boot
  // race; chrome's showWelcome() is idempotent so re-firing is a no-op
  // once it's visible. Loop stops automatically when welcomeSeen flips
  // true (effect cleanup) — no risk of looping forever.
  const welcomeShouldShow = useSettingsStore((s) => s.current !== null && !s.current.welcomeSeen);
  useEffect(() => {
    if (!welcomeShouldShow) return;
    let attempts = 0;
    const fire = () => {
      requestWelcome();
      attempts += 1;
      if (attempts >= 5) clearInterval(handle);
    };
    fire();
    const handle = setInterval(fire, 200);
    return () => clearInterval(handle);
  }, [welcomeShouldShow]);

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
    document.title = `BENTO_SCROLL_TO_MAIN_${Date.now()}`;
  };
  const onClose = (id: number) => dispatch({ type: 'tab/close', id });
  const onCloseSelected = (ids: number[]) => dispatch({ type: 'tabs/close', ids });
  const onCreateTab = () => dispatch({ type: 'tab/create' });
  const onCreatePanel = () =>
    dispatch({ type: 'panel/openAt', url: 'about:newtab', sourceTabId: null, position: 'end' });
  const onOpenInSidePanel = (id: number) => dispatch({ type: 'panel/add', id });
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
      document.title = `BENTO_SIDEBAR_CONTEXT_MENU:${Date.now()}:${encodeSidebarMenuPayload({
        anchor: { left: event.clientX, top: event.clientY, width: 1, height: 1 },
        tabId: null,
        folderId,
        items,
      })}`;
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
        items.push({
          id: 'move-selected-to-new-workspace',
          label: `Move ${targetTabIds.length} tabs to new workspace`,
        });
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
      if (workspaceItems.length > 0) {
        items.push({
          id: 'move-to-workspace',
          label: isBatch ? 'Move selected tabs to workspace' : 'Move to workspace',
          items: workspaceItems,
        });
      }
      if (!allTargetsPinned) {
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
    document.title = `BENTO_SIDEBAR_CONTEXT_MENU:${Date.now()}:${encodeSidebarMenuPayload({
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
    })}`;
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
    document.title = `BENTO_TAB_MOVE:${Date.now()}:${id}:${anchorId}:${before ? 'before' : 'after'}`;
  };
  const uiColorMode = useSettingsStore((s) => s.current?.uiColorMode);
  const sidebarCollapsed = useSettingsStore((s) => s.current?.sidebarCollapsed ?? false);
  const setUiColorMode = (next: UiColorModePref) =>
    dispatch({ type: 'settings/update', changes: { uiColorMode: next } });
  const toggleSidebarCollapsed = () =>
    dispatch({ type: 'settings/update', changes: { sidebarCollapsed: !sidebarCollapsed } });

  // Mirror sidebarCollapsed onto the shell document's <html> via a data
  // attribute so CSS rules (TabRow, WorkspaceSwitcher, footer layout)
  // can react. The chrome side gets the same flag via title-IPC and
  // applies it to #bento-shell-host to actually shrink the rail.
  useEffect(() => {
    const html = document.documentElement;
    if (sidebarCollapsed) html.setAttribute('data-bento-collapsed', 'true');
    else html.removeAttribute('data-bento-collapsed');
  }, [sidebarCollapsed]);

  // Footer cross-fade. The footer's flex-direction snaps from row to
  // column-reverse when collapse toggles — discrete CSS property,
  // can't transition. To hide the snap behind a fade, snap opacity to
  // 0 SYNCHRONOUSLY before the browser paints (via useLayoutEffect),
  // then transition back to 1 on the next frame. The new layout is
  // never seen at full opacity — the first paint after the toggle is
  // already at opacity 0, then fades in.
  //
  // Duration is intentionally LONGER than the host-width transition
  // (200ms) so the buttons keep fading in after the rail has settled
  // — gives the eye time to register the new layout instead of
  // snapping into focus the instant the rail stops moving.
  //
  // Skip the very first run (when prevCollapsed.current is undefined)
  // so the boot doesn't briefly fade — initial render shows the
  // restored state without animation.
  const footerRef = useRef<HTMLDivElement>(null);
  const prevCollapsed = useRef<boolean | undefined>(undefined);
  useLayoutEffect(() => {
    const isFirstRun = prevCollapsed.current === undefined;
    const changed = prevCollapsed.current !== sidebarCollapsed;
    prevCollapsed.current = sidebarCollapsed;
    if (isFirstRun || !changed) return;
    const footer = footerRef.current;
    if (!footer) return;
    // Fade-in duration; matches a hypothetical --bento-duration-xslow.
    // If the design system grows that token later, swap this for a
    // getComputedStyle read on documentElement.
    const FADE_MS = 500;
    // Phase 1 (sync, pre-paint): instant opacity 0 with no transition.
    footer.style.transition = 'none';
    footer.style.opacity = '0';
    // Force style flush so the no-transition rule + opacity:0 land in
    // the same paint as the layout snap that triggered this effect.
    void footer.offsetWidth;
    // Phase 2 (post-paint): restore the transition and animate back to
    // 1. Two rAFs guarantee the previous frame committed before we
    // change the target value; without them the browser can collapse
    // both opacity assignments into a single paint and skip the fade.
    let rafA = 0;
    let rafB = 0;
    let cleanupTimer = 0;
    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => {
        footer.style.transition = `opacity ${FADE_MS}ms ease`;
        footer.style.opacity = '1';
        cleanupTimer = window.setTimeout(() => {
          // Strip inline styles after the transition completes so any
          // future hover / class-based opacity rules can take over
          // without competing with stale inline values.
          footer.style.transition = '';
          footer.style.opacity = '';
        }, FADE_MS + 50);
      });
    });
    return () => {
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      clearTimeout(cleanupTimer);
    };
  }, [sidebarCollapsed]);

  return (
    <div className="bento-shell-app" onContextMenu={onRootContextMenu}>
      <PinnedPanels />
      <div className="bento-shell-app__main">
        <Row gap="xs" align="center" className="bento-shell-app__header">
          <WorkspaceSwitcher />
          {!ready && (
            <Text variant="text" size="xs" color="muted">
              connecting…
            </Text>
          )}
        </Row>
        <TabList
          onActivate={onActivate}
          onClose={onClose}
          onCloseSelected={onCloseSelected}
          onCreateTab={onCreateTab}
          onCreatePanel={onCreatePanel}
          onOpenInSidePanel={onOpenInSidePanel}
          onTabContextMenu={onTabContextMenu}
          onFolderContextMenu={onFolderContextMenu}
          onReorder={onReorder}
        />
        <Row ref={footerRef} gap="2xs" align="center" className="bento-shell-app__footer">
          {/* Collapse/expand toggle. DOM order matters: this is the FIRST
              child so flex-direction:column-reverse in collapsed mode pins
              it to the bottom of the vertical stack (= same on-screen
              position as the leftmost slot of the expanded horizontal row).
              That's the explicit UX requirement — clicking expand should
              land at the same cursor position as clicking collapse. */}
          <FooterTooltip
            label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            isDisabled={sidebarCollapsed}
          >
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              onPress={toggleSidebarCollapsed}
            >
              <Icon icon={sidebarCollapsed ? PanelLeftOpen : PanelLeftClose} />
            </IconButton>
          </FooterTooltip>
          <FooterTooltip label="Open command palette" isDisabled={sidebarCollapsed}>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Open command palette (⌘⌥P)"
              onPress={openCommandPalette}
            >
              <Icon icon={Command} />
            </IconButton>
          </FooterTooltip>
          <FooterTooltip label="Color mode" isDisabled={sidebarCollapsed}>
            <ColorModeCycle
              value={uiColorMode}
              onChange={setUiColorMode}
              modes={UI_COLOR_MODE_ORDER}
              surfaceLabel="Bento UI"
            />
          </FooterTooltip>
          <FooterTooltip label="Settings" isDisabled={sidebarCollapsed}>
            <IconButton variant="ghost" size="sm" aria-label="Settings" onPress={openSettings}>
              <Icon icon={Settings} />
            </IconButton>
          </FooterTooltip>
        </Row>
      </div>
    </div>
  );
}
