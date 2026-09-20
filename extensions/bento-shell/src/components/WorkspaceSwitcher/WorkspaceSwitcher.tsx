// Sidebar workspace-switcher trigger. The actual menu (workspace list,
// New / Edit / Delete actions) lives in a chrome-mounted overlay (see
// src/workspace-switcher/main.tsx) so the popover can render outside the
// sidebar's bounds — critical when the rail is collapsed and an
// inline Menu.Popover would be clipped at the iframe boundary.
//
// On click: read the trigger's bounding rect + window screen coords and
// dispatch them to the overlay via requestWorkspaceSwitcher(). The
// overlay handles all menu logic (item rendering, keyboard nav, dispatch
// of workspace/* actions, re-anchoring, etc.).

import { useEffect, useRef, useState } from 'react';
import { Avatar, Menu, Text } from '@muxui/react';
import ChevronsUpDown from 'lucide-react/dist/esm/icons/chevrons-up-down';

import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { useWorkspaceHasPlayingAudio } from '../../state/tabs';
import {
  requestWorkspaceSwitcher,
  subscribeToWorkspaceSwitcherClose,
} from '../../bridge/useWorkspaceSwitcher';
import { useCurrentWindowId } from '../../bridge/useToolsPort';
import { DEFAULT_THEME_ID } from '../../theme/presets';
import { getThemeScopeAttributes, useResolvedColorScheme } from '../../theme/themeScope';
import { BentoIcon } from '../primitives';
import { WorkspaceAudioParticles } from './WorkspaceAudioParticles';
import './WorkspaceSwitcher.css';

function workspaceInitial(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed[0]!.toUpperCase() : '?';
}

function looksLikeEmojiValue(value: string): boolean {
  return /[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F]/u.test(value);
}

export function WorkspaceSwitcher() {
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const active = useWorkspacesStore((s) =>
    activeWorkspaceId ? s.byId[activeWorkspaceId] : undefined,
  );
  // Menu.Trigger is used standalone here — the
  // popover lives in a chrome-mounted overlay rather than a Menu.Popover
  // child, so we don't need the surrounding Menu.Root (MenuTrigger)
  // context. It still forwards the native trigger ref directly.
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Mirror the overlay's open state so the trigger can paint its active
  // visual while the menu is showing. The sidebar can't observe the
  // overlay directly (separate process), so we set isOpen=true on press
  // and listen for the overlay's notifyClosed broadcast (fired on Esc /
  // click-outside / item action) to flip back to false.
  const [isOpen, setIsOpen] = useState(false);
  const colorScheme = useResolvedColorScheme();
  useEffect(() => {
    return subscribeToWorkspaceSwitcherClose(() => setIsOpen(false));
  }, []);

  const activeIcon = active?.icon?.trim();
  const hasEmojiIcon = !!activeIcon && looksLikeEmojiValue(activeIcon);
  const activeWorkspaceHasPlayingAudio = useWorkspaceHasPlayingAudio(activeWorkspaceId);

  const onActivate = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    requestWorkspaceSwitcher({
      triggerRect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      // window.screenLeft/Top is the OS-screen position of the SIDEBAR
      // frame's window. The overlay reads its own screenLeft/Top
      // (which equals the chrome window's screen position because the
      // overlay frame fills the chrome window) and diffs to find the
      // sidebar's offset within the chrome window.
      sidebarScreenX: window.screenLeft,
      sidebarScreenY: window.screenTop,
    });
    setIsOpen(true);
  };

  return (
    <Menu.Trigger
      ref={triggerRef}
      className={
        'muxui-button bento-workspace-switcher__trigger' +
        (isOpen ? ' bento-workspace-switcher__trigger--open' : '')
      }
      data-variant="neutral"
      data-size="md"
      aria-label={active ? `Workspace ${active.name} — switch workspace` : 'Switch workspace'}
      aria-expanded={isOpen}
      onActivate={onActivate}
    >
      <span className="bento-workspace-switcher__avatar-frame">
        <Avatar.Root
          size="sm"
          className="bento-workspace-switcher__avatar"
          {...getThemeScopeAttributes(active?.themeId ?? DEFAULT_THEME_ID, colorScheme)}
          data-bento-emoji-icon={hasEmojiIcon ? 'true' : undefined}
        >
          <Avatar.Fallback>{activeIcon || workspaceInitial(active?.name ?? '?')}</Avatar.Fallback>
        </Avatar.Root>
        <WorkspaceAudioParticles active={activeWorkspaceHasPlayingAudio} />
      </span>
      <Text variant="body" size="s" className="bento-workspace-switcher__trigger-name">
        {active?.name ?? 'No workspace'}
      </Text>
      <BentoIcon icon={ChevronsUpDown} size="sm" className="bento-workspace-switcher__chevron" />
    </Menu.Trigger>
  );
}
