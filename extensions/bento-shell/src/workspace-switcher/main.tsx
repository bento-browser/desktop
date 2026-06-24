// Workspace-switcher menu overlay entry. Mirrors the inline menu logic
// from src/components/WorkspaceSwitcher/WorkspaceSwitcher.tsx but lifted
// into a chrome-mounted <browser> so the popover can render outside the
// sidebar's bounds — critical when the rail is collapsed to a 4rem-wide
// strip and the inline menu would otherwise be clipped at the iframe
// boundary.
//
// Lifecycle:
//   - Sidebar trigger button calls requestWorkspaceSwitcher({triggerRect,
//     sidebarScreenX, sidebarScreenY}) when clicked.
//   - That helper (a) broadcasts the payload on the
//     'bento-workspace-switcher-bus' BroadcastChannel and (b) sets
//     document.title = BENTO_OPEN_WORKSPACE_SWITCHER_<ts>, which chrome's
//     bento-shell-mount.js poll picks up and reveals this overlay frame.
//   - This page's BroadcastChannel listener stores the payload + opens
//     a Tale UI Menu anchored to an invisible trigger element positioned
//     at the translated chrome-window coords.
//   - On item action OR backdrop click: Menu's onOpenChange(false) fires
//     close() which clears state and signals chrome to hide.

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useShallow } from 'zustand/shallow';
import { Menu } from '@tale-ui/react/menu';
import { Avatar } from '@tale-ui/react/avatar';
import { Text } from '@tale-ui/react/text';
import { Icon } from '@tale-ui/react/icon';
import Check from 'lucide-react/dist/esm/icons/check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import SlidersHorizontal from 'lucide-react/dist/esm/icons/sliders-horizontal';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';

import '@tale-ui/core/src';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/menu';
import '@tale-ui/react-styles/avatar';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch, useCurrentWindowId } from '../bridge/useToolsPort';
import { requestConfirm } from '../bridge/useConfirm';
import { requestEditWorkspace } from '../bridge/useEditWorkspace';
import { requestWorkspacePalette } from '../bridge/useWorkspacePalette';
import {
  WORKSPACE_SWITCHER_CLOSE_PREFIX,
  subscribeToWorkspaceSwitcherRequests,
  notifyWorkspaceSwitcherClosed,
  type WorkspaceSwitcherOpenPayload,
} from '../bridge/useWorkspaceSwitcher';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useWorkspaceTabIds } from '../state/tabs';
import { BENTO_THEMES, DEFAULT_THEME_ID } from '../theme/presets';
// Reuse the inline menu's CSS — only the trigger styles in
// WorkspaceSwitcher.css are unused here; the popover/avatar/item rules
// all apply identically to this overlay's menu DOM.
import '../components/WorkspaceSwitcher/WorkspaceSwitcher.css';

initToolsPort();

const NEW_WORKSPACE_KEY = '__new__';
const EDIT_ALL_WORKSPACES_KEY = '__edit_all__';
const EDIT_WORKSPACE_KEY = '__edit__';
const DELETE_WORKSPACE_KEY = '__delete__';
const SMALL_MENU_CLASS = 'tale-menu__popup--sm';

// Themes new workspaces cycle through so each is visually distinct in the
// switcher without the user having to open Edit Workspace. Excludes the
// Default theme — that's reserved for the first workspace (which usually
// represents the user's "home base") and as the fallback for unrecognised
// themeIds. Order matters: the first New click after first-boot lands
// `teal`, then `terracotta`, then `rosewater`, then wraps.
const THEME_ROTATION = BENTO_THEMES.map((t) => t.id).filter((id) => id !== DEFAULT_THEME_ID);

/** Pick the next theme for a brand-new workspace. Prefers any rotation
 * theme not already in use; falls back to round-robin once every theme
 * has been assigned at least once. This way the first few "+ New
 * workspace" clicks always produce visually distinct rows in the
 * switcher menu — only after the user has at least one of every theme
 * do duplicates appear. */
function pickRotatedTheme(used: ReadonlySet<string | undefined>, total: number): string {
  if (THEME_ROTATION.length === 0) return DEFAULT_THEME_ID;
  const unused = THEME_ROTATION.find((id) => !used.has(id));
  if (unused) return unused;
  return THEME_ROTATION[total % THEME_ROTATION.length]!;
}

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
}

function WorkspaceSwitcherOverlayApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const workspaces = useWorkspacesStore(useShallow((s) => s.orderedIds.map((id) => s.byId[id]!)));
  // Per-window active workspace (phase A.3). The chrome window that owns
  // this overlay determines which workspace is highlighted as "current".
  const windowId = useCurrentWindowId();
  const activeId = useActiveWorkspaceIdForWindow(windowId);
  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined;
  const tabIdsInActive = useWorkspaceTabIds(activeId);
  const tabCount = tabIdsInActive.length;
  const canDelete = workspaces.length > 1 && active !== undefined;
  const canEdit = active !== undefined;

  const [openPayload, setOpenPayload] = useState<WorkspaceSwitcherOpenPayload | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set true when an item action forwards to another chrome overlay
  // (edit-workspace, confirm). In that case close() must NOT overwrite
  // document.title — react-aria's Menu.Item fires onAction then closes
  // the menu in the same JS tick, so a CLOSE title written here would
  // clobber the OPEN_EDIT_WORKSPACE / OPEN_CONFIRM title that the
  // forwarding call just set, and the chrome poll on this frame would
  // only ever see the close sentinel. Skipping the close-title in that
  // case lets the chrome poll see the forward sentinel and call the
  // matching show*() + hideWorkspaceSwitcher() pair.
  const forwardingRef = useRef(false);

  useEffect(() => {
    return subscribeToWorkspaceSwitcherRequests((payload) => {
      // Defensive reset in case a prior forward bailed before close()
      // ran (e.g. an exception in the forwarding call).
      forwardingRef.current = false;
      setOpenPayload(payload);
    });
  }, []);

  function close() {
    setOpenPayload(null);
    if (forwardingRef.current) {
      forwardingRef.current = false;
      // Sidebar trigger still needs to drop its "open" visual state;
      // chrome will hide this overlay as part of handling the forward
      // sentinel that the item action just wrote to document.title.
      notifyWorkspaceSwitcherClosed();
      return;
    }
    document.title = `${WORKSPACE_SWITCHER_CLOSE_PREFIX}_${Date.now()}`;
    // Tell the sidebar trigger to drop its "open" visual state. The
    // chrome hide is signalled by the title above; this is purely for
    // the React UI mirror — chrome IPC and the sidebar's Zustand-style
    // open flag are independent channels.
    notifyWorkspaceSwitcherClosed();
  }

  function onActivate(id: string) {
    dispatch({ type: 'workspace/activate', id });
    // Menu's onOpenChange(false) fires on Item action and triggers close()
    // automatically — no explicit close() needed here.
  }
  function onCreate() {
    const nextIndex = workspaces.length;
    const usedThemes = new Set(workspaces.map((w) => w.themeId));
    dispatch({
      type: 'workspace/create',
      name: `Workspace ${nextIndex + 1}`,
      themeId: pickRotatedTheme(usedThemes, nextIndex),
    });
  }
  function onRequestEdit() {
    if (!canEdit || !active) return;
    forwardingRef.current = true;
    requestEditWorkspace({
      workspaceId: active.id,
      name: active.name,
      themeId: active.themeId,
      icon: active.icon,
    });
  }
  function onRequestEditAll() {
    forwardingRef.current = true;
    requestWorkspacePalette();
  }
  function onRequestDelete() {
    if (!canDelete || !active) return;
    if (tabCount === 0) {
      dispatch({ type: 'workspace/delete', id: active.id, closeTabs: false });
      return;
    }
    forwardingRef.current = true;
    requestConfirm({
      title: `Delete "${active.name}"?`,
      description: `This will close ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'} in this workspace. This action cannot be undone.`,
      confirmLabel: 'Delete workspace',
      variant: 'danger',
      action: { type: 'workspace/delete', id: active.id, closeTabs: true },
    });
  }

  if (!openPayload) return null;

  // Translate sidebar-frame-local trigger coords into chrome-window coords.
  // window.screenLeft/screenTop is the OS-screen position of THIS window
  // (the overlay frame, which fills the chrome window — so its screen
  // position equals the chrome window's screen position). Diffing against
  // the sidebar's screen position (passed in the payload) gives the
  // sidebar's offset within the chrome window. Add that offset to the
  // trigger's frame-local coords and we have the trigger's chrome-window
  // coords, which are the overlay's own DOM coords (since the overlay
  // covers the entire chrome window).
  const offsetX = openPayload.sidebarScreenX - window.screenLeft;
  const offsetY = openPayload.sidebarScreenY - window.screenTop;
  const triggerX = openPayload.triggerRect.x + offsetX;
  const triggerY = openPayload.triggerRect.y + offsetY;

  return (
    <Menu.Root
      isOpen={true}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {/* Invisible anchor positioned at the trigger's chrome-window
          coords. react-aria's MenuTrigger uses the trigger element's
          getBoundingClientRect() to position the popover; an absolutely-
          positioned, opacity:0, pointer-events:none button still has a
          rect for that math. aria-hidden so screen readers don't see
          this duplicate trigger (the real button is in the sidebar). */}
      <Menu.Trigger
        ref={triggerRef}
        aria-hidden
        excludeFromTabOrder
        style={{
          position: 'fixed',
          top: triggerY,
          left: triggerX,
          width: openPayload.triggerRect.width,
          height: openPayload.triggerRect.height,
          opacity: 0,
          pointerEvents: 'none',
          border: 0,
          background: 'transparent',
          padding: 0,
          margin: 0,
        }}
      />
      <Menu.Popover
        placement="bottom start"
        offset={4}
        className="bento-workspace-switcher__popover"
      >
        <Menu.MenuList className={SMALL_MENU_CLASS} aria-label="Workspaces">
          {workspaces.map((w) => (
            <Menu.Item key={w.id} id={w.id} textValue={w.name} onAction={() => onActivate(w.id)}>
              <Avatar.Root
                size="sm"
                className="bento-workspace-switcher__avatar"
                data-bento-theme={w.themeId ?? DEFAULT_THEME_ID}
              >
                <Avatar.Fallback>{w.icon || workspaceInitial(w.name)}</Avatar.Fallback>
              </Avatar.Root>
              <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
                {w.name}
              </Text>
              {w.id === activeId ? <Icon icon={Check} size="sm" label="Active" /> : null}
            </Menu.Item>
          ))}
          <Menu.Separator />
          <Menu.Item id={NEW_WORKSPACE_KEY} textValue="New workspace" onAction={onCreate}>
            <Icon icon={Plus} size="sm" />
            <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
              New workspace
            </Text>
          </Menu.Item>
          <Menu.Item
            id={EDIT_ALL_WORKSPACES_KEY}
            textValue="Edit all workspaces"
            onAction={onRequestEditAll}
          >
            <Icon icon={SlidersHorizontal} size="sm" />
            <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
              Edit all workspaces
            </Text>
          </Menu.Item>
          {canEdit ? (
            <Menu.Item
              id={EDIT_WORKSPACE_KEY}
              textValue={`Edit ${active!.name}`}
              onAction={onRequestEdit}
            >
              <Icon icon={Pencil} size="sm" />
              <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
                Edit {active!.name}
              </Text>
            </Menu.Item>
          ) : null}
          {canDelete ? (
            <Menu.Item
              id={DELETE_WORKSPACE_KEY}
              textValue={`Delete ${active!.name}`}
              onAction={onRequestDelete}
              className="bento-workspace-switcher__delete-item"
            >
              <Icon icon={Trash2} size="sm" />
              <Text variant="text" size="s" className="bento-workspace-switcher__item-name">
                Delete {active!.name}
              </Text>
            </Menu.Item>
          ) : null}
        </Menu.MenuList>
      </Menu.Popover>
    </Menu.Root>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell workspace-switcher: #root not found');

createRoot(container).render(
  <StrictMode>
    <WorkspaceSwitcherOverlayApp />
  </StrictMode>,
);
