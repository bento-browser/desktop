// The workspace switcher layer: the menu of workspaces, anchored to the sidebar trigger. Lifted
// out of the sidebar so the popover can render outside the sidebar's bounds, which matters when
// the rail is collapsed and an inline menu would be clipped at the frame boundary.
//
// The sidebar trigger posts its rect and the sidebar's screen position (requestWorkspaceSwitcher);
// the menu opens on an invisible trigger placed at those coordinates in this document. An item
// that opens another layer (Edit this workspace, Delete with tabs) replaces this layer in this
// document and writes the open title under this layer's name; chrome then shows the other layer
// and hides this one. Edit all workspaces opens the workspace palette, another document.

import { useRef } from 'react';
import { useShallow } from 'zustand/shallow';
import { Avatar, Menu, Text } from '@muxui/react';
import Check from 'lucide-react/dist/esm/icons/check';
import Plus from 'lucide-react/dist/esm/icons/plus';
import Pencil from 'lucide-react/dist/esm/icons/pencil';
import SlidersHorizontal from 'lucide-react/dist/esm/icons/sliders-horizontal';
import Trash2 from 'lucide-react/dist/esm/icons/trash-2';

import { getThemeScopeAttributes, useResolvedColorScheme } from '../theme/themeScope';
import { useThemeSheets } from '../theme/themeSheets';
import { dispatch, useCurrentWindowId } from '../bridge/useToolsPort';
import { layerOpenTitle, newLayerRequestId, type LayerRequestId } from '../bridge/layerRequest';
import { CONFIRM_OPEN_PREFIX } from '../bridge/useConfirm';
import { EDIT_WORKSPACE_OPEN_PREFIX } from '../bridge/useEditWorkspace';
import { WORKSPACE_PALETTE_OPEN_PREFIX } from '../bridge/useWorkspacePalette';
import {
  WORKSPACE_SWITCHER_CLOSE_PREFIX,
  notifyWorkspaceSwitcherClosed,
  type WorkspaceSwitcherOpenPayload,
} from '../bridge/useWorkspaceSwitcher';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../state/workspaces';
import { useWorkspaceIdsWithPlayingAudio, useWorkspaceTabIds } from '../state/tabs';
import { BENTO_THEMES, DEFAULT_THEME_ID } from '../theme/presets';
import { WorkspaceAudioParticles } from '../components/WorkspaceSwitcher/WorkspaceAudioParticles';
import { BentoIcon } from '../components/primitives/BentoIcon';
// Reuse the inline menu's CSS: only the trigger styles in WorkspaceSwitcher.css are unused here;
// the popover, avatar and item rules apply to this menu's DOM.
import '../components/WorkspaceSwitcher/WorkspaceSwitcher.css';
import { clearWorkspaceLayer, sendWorkspaceLayerTitle, showWorkspaceLayer } from './layers';

const NEW_WORKSPACE_KEY = '__new__';
const EDIT_ALL_WORKSPACES_KEY = '__edit_all__';
const EDIT_WORKSPACE_KEY = '__edit__';
const DELETE_WORKSPACE_KEY = '__delete__';
const SMALL_MENU_CLASS = 'bento-workspace-switcher__menu';

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

function looksLikeEmojiValue(value: string): boolean {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F]/u.test(value);
}

export function SwitcherLayer({
  requestId,
  payload: openPayload,
}: {
  requestId: LayerRequestId;
  payload: WorkspaceSwitcherOpenPayload;
}) {
  const colorScheme = useResolvedColorScheme();
  const workspaces = useWorkspacesStore(useShallow((s) => s.orderedIds.map((id) => s.byId[id]!)));
  // Each avatar renders in its own workspace's theme scope.
  useThemeSheets(workspaces.map((w) => w.themeId));
  // The chrome window that owns this document decides which workspace is the current one.
  const windowId = useCurrentWindowId();
  const activeId = useActiveWorkspaceIdForWindow(windowId);
  const active = activeId ? workspaces.find((w) => w.id === activeId) : undefined;
  const tabIdsInActive = useWorkspaceTabIds(activeId);
  const workspaceIdsWithPlayingAudio = useWorkspaceIdsWithPlayingAudio();
  const tabCount = tabIdsInActive.length;
  const canDelete = workspaces.length > 1 && active !== undefined;
  const canEdit = active !== undefined;

  const triggerRef = useRef<HTMLButtonElement>(null);
  // Set when an item action opens another layer or overlay (edit workspace, confirm, workspace
  // palette). React Aria's Menu.Item fires onAction and then closes the menu in the same tick, so
  // close() would follow the open title the action just wrote. Chrome hides this layer as part of
  // handling that open, so close() skips its CLOSE title. The layer remounts for every request
  // (main.tsx keys it by request), so the flag starts clear.
  const forwardingRef = useRef(false);

  function close() {
    // Tell the sidebar trigger to drop its open state: the sidebar's flag and chrome's host are
    // independent channels.
    notifyWorkspaceSwitcherClosed();
    // The menu goes at once, as it did in its own document; a layer that replaced it stays.
    clearWorkspaceLayer(requestId);
    if (forwardingRef.current) {
      forwardingRef.current = false;
      return;
    }
    sendWorkspaceLayerTitle(
      'workspace-switcher',
      `${WORKSPACE_SWITCHER_CLOSE_PREFIX}_${Date.now()}`,
    );
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
    const id = newLayerRequestId();
    showWorkspaceLayer({
      layer: 'edit-workspace',
      id,
      payload: {
        workspaceId: active.id,
        name: active.name,
        themeId: active.themeId,
        icon: active.icon,
      },
    });
    sendWorkspaceLayerTitle('workspace-switcher', layerOpenTitle(EDIT_WORKSPACE_OPEN_PREFIX, id));
  }
  function onRequestEditAll() {
    forwardingRef.current = true;
    sendWorkspaceLayerTitle('workspace-switcher', `${WORKSPACE_PALETTE_OPEN_PREFIX}_${Date.now()}`);
  }
  function onRequestDelete() {
    if (!canDelete || !active) return;
    if (tabCount === 0) {
      dispatch({ type: 'workspace/delete', id: active.id, closeTabs: false });
      return;
    }
    forwardingRef.current = true;
    const id = newLayerRequestId();
    showWorkspaceLayer({
      layer: 'confirm',
      id,
      payload: {
        title: `Delete "${active.name}"?`,
        description: `This will close ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'} in this workspace. This action cannot be undone.`,
        confirmLabel: 'Delete workspace',
        variant: 'danger',
        action: { type: 'workspace/delete', id: active.id, closeTabs: true },
      },
    });
    sendWorkspaceLayerTitle('workspace-switcher', layerOpenTitle(CONFIRM_OPEN_PREFIX, id));
  }

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
      open={true}
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
        tabIndex={-1}
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
      <Menu.Popup placement="bottom-start" offset={4} className="bento-workspace-switcher__popover">
        <Menu.List className={SMALL_MENU_CLASS} aria-label="Workspaces">
          {workspaces.map((w) => {
            const icon = w.icon?.trim();
            const hasEmojiIcon = !!icon && looksLikeEmojiValue(icon);
            const hasPlayingAudio = workspaceIdsWithPlayingAudio.has(w.id);
            return (
              <Menu.Item key={w.id} id={w.id} textValue={w.name} onAction={() => onActivate(w.id)}>
                <span className="bento-workspace-switcher__avatar-frame">
                  <Avatar.Root
                    size="sm"
                    className="bento-workspace-switcher__avatar"
                    {...getThemeScopeAttributes(w.themeId, colorScheme)}
                    data-bento-emoji-icon={hasEmojiIcon ? 'true' : undefined}
                  >
                    <Avatar.Fallback>{icon || workspaceInitial(w.name)}</Avatar.Fallback>
                  </Avatar.Root>
                  <WorkspaceAudioParticles active={hasPlayingAudio} variant="menu" />
                </span>
                <Text variant="body" size="sm" className="bento-workspace-switcher__item-name">
                  {w.name}
                </Text>
                {w.id === activeId ? <BentoIcon icon={Check} size="sm" label="Active" /> : null}
              </Menu.Item>
            );
          })}
          <Menu.Separator />
          <Menu.Item id={NEW_WORKSPACE_KEY} textValue="New workspace" onAction={onCreate}>
            <BentoIcon icon={Plus} size="sm" />
            <Text variant="body" size="sm" className="bento-workspace-switcher__item-name">
              New workspace
            </Text>
          </Menu.Item>
          <Menu.Item
            id={EDIT_ALL_WORKSPACES_KEY}
            textValue="Edit all workspaces"
            onAction={onRequestEditAll}
          >
            <BentoIcon icon={SlidersHorizontal} size="sm" />
            <Text variant="body" size="sm" className="bento-workspace-switcher__item-name">
              Edit all workspaces
            </Text>
          </Menu.Item>
          {canEdit ? (
            <Menu.Item
              id={EDIT_WORKSPACE_KEY}
              textValue="Edit this workspace"
              onAction={onRequestEdit}
            >
              <BentoIcon icon={Pencil} size="sm" />
              <Text variant="body" size="sm" className="bento-workspace-switcher__item-name">
                Edit this workspace
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
              <BentoIcon icon={Trash2} size="sm" />
              <Text variant="body" size="sm" className="bento-workspace-switcher__item-name">
                Delete {active!.name}
              </Text>
            </Menu.Item>
          ) : null}
        </Menu.List>
      </Menu.Popup>
    </Menu.Root>
  );
}
