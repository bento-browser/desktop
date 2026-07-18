// Layer-2 component: CommandPalette.
//
// Tale UI CommandPalette wrapped around Bento's command data. Default export
// so the entry chunk can React.lazy() it.
//
// Controlled by the parent via `onClose` — the parent decides when to mount
// the component (typically gated on a flag), and the component invokes
// `onClose` whenever the user dismisses (Esc, backdrop, or running a
// command). The palette page in src/palette/main.tsx wraps the close
// signal as a postMessage to the chrome process, which then hides the
// chrome overlay <browser> frame holding this page.
//
// Commands are computed from current tabs + workspaces + a static list. No
// persistence — command history is a future enhancement.

import { useCallback, useEffect, useMemo, type KeyboardEvent, type ReactNode } from 'react';
import {
  CommandPalette as TaleCommandPalette,
  useCommandPalette,
  type CommandPaletteCommand,
} from '@tale-ui/react/command-palette';
import { Icon } from '@tale-ui/react/icon';
import { useShallow } from 'zustand/shallow';

// Per-icon imports — barrel forbidden by eslint (bundle, §6.2).
import SettingsIcon from 'lucide-react/dist/esm/icons/settings';
import ShieldIcon from 'lucide-react/dist/esm/icons/shield';
import PlusIcon from 'lucide-react/dist/esm/icons/plus';
import LayersIcon from 'lucide-react/dist/esm/icons/layers';
import FileIcon from 'lucide-react/dist/esm/icons/file';
import XIcon from 'lucide-react/dist/esm/icons/x';
import RotateIcon from 'lucide-react/dist/esm/icons/rotate-cw';
import PinIcon from 'lucide-react/dist/esm/icons/pin';
import PanelRightOpenIcon from 'lucide-react/dist/esm/icons/panel-right-open';
import PanelRightCloseIcon from 'lucide-react/dist/esm/icons/panel-right-close';

import { useTabsStore } from '../../state/tabs';
import { useActiveWorkspaceIdForWindow, useWorkspacesStore } from '../../state/workspaces';
import { usePanelsStore } from '../../state/panels';
import { dispatch, useCurrentWindowId } from '../../bridge/useToolsPort';
import './CommandPalette.css';

export interface CommandPaletteProps {
  /** Invoked whenever the palette is dismissed (Esc, backdrop click, or
   * running a command). The parent decides what "dismiss" means at the
   * outer container level — for the chrome overlay version, parent will
   * postMessage to the chrome process to hide the frame. */
  onClose: () => void;
}

type CommandSection = 'Navigation' | 'Workspaces' | 'Tabs' | 'Panels' | 'Actions';

interface BentoCommand extends CommandPaletteCommand {
  id: string;
  title: string;
  subtitle: string;
  group: CommandSection;
  icon: ReactNode;
  meta?: string;
}

async function signalOpenSettings(privacy = false): Promise<void> {
  document.title = `${privacy ? 'BENTO_OPEN_SETTINGS_PRIVACY' : 'BENTO_OPEN_SETTINGS'}_${Date.now()}`;
  // The palette closes by writing another title sentinel. Keep this signal
  // visible for one chrome polling interval before that close overwrites it.
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function commandIcon(icon: typeof SettingsIcon): ReactNode {
  return <Icon icon={icon} size="sm" />;
}

function workspaceShortcut(index: number): readonly string[] | undefined {
  if (index < 0 || index > 8) return undefined;
  return ['Mod', 'Alt', String(index + 1)];
}

function commandTextValue(command: BentoCommand): string {
  return [command.title, command.subtitle, command.group, ...(command.keywords ?? [])]
    .filter(Boolean)
    .join(' ');
}

function resultLabel(count: number): string {
  return `${count} ${count === 1 ? 'result' : 'results'}`;
}

function useCommands(): BentoCommand[] {
  const workspaces = useWorkspacesStore(useShallow((s) => s.orderedIds.map((id) => s.byId[id]!)));
  const tabs = useTabsStore(
    useShallow((s) => s.orderedIds.map((id) => s.byId[id]).filter((t) => !!t)),
  );
  const panelsByWorkspace = usePanelsStore((s) => s.byWorkspace);
  const activeTabId = useTabsStore((s) => s.activeId);
  const windowId = useCurrentWindowId();
  const activeWorkspaceId = useActiveWorkspaceIdForWindow(windowId);
  const panelEntries = useMemo(
    () =>
      Array.from(panelsByWorkspace.entries()).flatMap(([workspaceId, ids]) =>
        Array.from(ids, (id) => ({ workspaceId, id })),
      ),
    [panelsByWorkspace],
  );

  return useMemo(() => {
    const cmds: BentoCommand[] = [];
    const workspaceNameById = new Map(workspaces.map((w) => [w.id, w.name]));

    // Navigation. focusExisting: Settings and Privacy are singletons —
    // re-running the command should bring the existing tab forward rather
    // than stack duplicates inside the workspace.
    cmds.push({
      id: 'nav:settings',
      title: 'Open Settings',
      subtitle: 'Manage Bento preferences.',
      group: 'Navigation',
      icon: commandIcon(SettingsIcon),
      keywords: ['preferences', 'options'],
      action: () => signalOpenSettings(),
    });
    cmds.push({
      id: 'nav:privacy',
      title: 'Open Bento Privacy Settings',
      subtitle: 'Manage Bento privacy and search settings.',
      group: 'Navigation',
      icon: commandIcon(ShieldIcon),
      keywords: ['privacy', 'dashboard', 'site controls'],
      action: () => signalOpenSettings(true),
    });

    // Workspaces
    workspaces.forEach((w, index) => {
      const isActive = w.id === activeWorkspaceId;
      cmds.push({
        id: `workspace:${w.id}`,
        title: isActive ? `Current workspace: ${w.name}` : `Switch to ${w.name}`,
        subtitle: isActive ? 'Active workspace.' : 'Activate this workspace.',
        group: 'Workspaces',
        icon: commandIcon(LayersIcon),
        keywords: ['workspace', w.name, isActive ? 'active current' : 'switch'],
        shortcut: workspaceShortcut(index),
        meta: isActive ? 'Active' : undefined,
        action: () => {
          dispatch({ type: 'workspace/activate', id: w.id });
        },
      });
    });
    cmds.push({
      id: 'workspace:new',
      title: 'New workspace',
      subtitle: `Create Workspace ${workspaces.length + 1}.`,
      group: 'Workspaces',
      icon: commandIcon(PlusIcon),
      keywords: ['workspace', 'create', 'add'],
      action: () => {
        dispatch({
          type: 'workspace/create',
          name: `Workspace ${workspaces.length + 1}`,
        });
      },
    });

    const panelWorkspaceById = new Map<number, string>();
    for (const entry of panelEntries) {
      panelWorkspaceById.set(entry.id, entry.workspaceId);
    }
    const currentWindowTabs =
      typeof windowId === 'number' ? tabs.filter((t) => t.windowId === windowId) : tabs;

    // Tabs. Panel tabs are excluded here and listed in their own Panels
    // section below; selecting a panel must focus its side slot, not
    // activate it as the main content tab.
    for (const t of currentWindowTabs) {
      if (panelWorkspaceById.has(t.id)) continue;
      const title = t.customTitle || t.title || 'Untitled';
      const workspaceName = t.workspaceId ? workspaceNameById.get(t.workspaceId) : undefined;
      const isActive = t.id === activeTabId;
      cmds.push({
        id: `tab:${t.id}`,
        title,
        subtitle: isActive
          ? 'Current tab.'
          : workspaceName
            ? `Open in ${workspaceName}.`
            : 'Open tab.',
        group: 'Tabs',
        icon: commandIcon(FileIcon),
        keywords: ['tab', title, workspaceName ?? ''],
        meta: isActive ? 'Current' : undefined,
        action: () => {
          dispatch({ type: 'tab/activate', id: t.id });
        },
      });
    }

    // Panels
    for (const entry of panelEntries) {
      const t = tabs.find((candidate) => candidate.id === entry.id);
      if (!t) continue;
      if (typeof windowId === 'number' && t.windowId !== windowId) continue;
      const title = t.customTitle || t.title || 'Untitled';
      const workspaceName = workspaceNameById.get(entry.workspaceId);
      cmds.push({
        id: `panel:${entry.workspaceId}:${entry.id}`,
        title,
        subtitle: workspaceName ? `Focus side panel in ${workspaceName}.` : 'Focus side panel.',
        group: 'Panels',
        icon: commandIcon(PanelRightOpenIcon),
        keywords: ['panel', 'side panel', title, workspaceName ?? ''],
        meta: 'Panel',
        action: () => {
          dispatch({ type: 'panel/focus', workspaceId: entry.workspaceId, id: entry.id });
        },
      });
    }

    // Actions
    cmds.push({
      id: 'action:new-tab',
      title: 'New tab',
      subtitle: 'Open a blank browser tab.',
      group: 'Actions',
      icon: commandIcon(PlusIcon),
      keywords: ['tab', 'create', 'open'],
      action: () => {
        // tab/create (no URL) sidesteps AboutNewTabRedirector startup-race
        // noise by using browser.tabs.create({active: true}) — Firefox
        // resolves the user's configured new-tab page on its own.
        dispatch({ type: 'tab/create' });
      },
    });
    if (activeTabId !== null) {
      const activeTab = tabs.find((t) => t.id === activeTabId);
      cmds.push({
        id: 'action:close-tab',
        title: 'Close current tab',
        subtitle: 'Close the active main tab or promote a remaining panel.',
        group: 'Actions',
        icon: commandIcon(XIcon),
        keywords: ['tab', 'close', 'remove'],
        action: () => {
          dispatch({ type: 'tab/close', id: activeTabId });
        },
      });
      cmds.push({
        id: 'action:reload-tab',
        title: 'Reload current tab',
        subtitle: 'Refresh the active tab.',
        group: 'Actions',
        icon: commandIcon(RotateIcon),
        keywords: ['tab', 'reload', 'refresh'],
        action: () => {
          dispatch({ type: 'tab/reload', id: activeTabId });
        },
      });
      cmds.push({
        id: 'action:toggle-pin',
        title: activeTab?.pinned ? 'Unpin current tab' : 'Pin current tab',
        subtitle: activeTab?.pinned
          ? 'Remove the active tab from pinned tabs.'
          : 'Keep the active tab pinned.',
        group: 'Actions',
        icon: commandIcon(PinIcon),
        keywords: ['tab', 'pin', 'pinned'],
        action: () => {
          dispatch({ type: 'tab/togglePin', id: activeTabId });
        },
      });
      cmds.push({
        id: 'action:open-in-side-panel',
        title: 'Add current tab to side panels',
        subtitle: 'Move the active tab into the side panel strip.',
        group: 'Actions',
        icon: commandIcon(PanelRightOpenIcon),
        keywords: ['panel', 'side panel', 'tab'],
        action: () => {
          dispatch({ type: 'panel/add', id: activeTabId });
        },
      });
    }
    cmds.push({
      id: 'action:close-side-panels',
      title: 'Close all side panels',
      subtitle: 'Remove every side panel from the active workspace.',
      group: 'Actions',
      icon: commandIcon(PanelRightCloseIcon),
      keywords: ['panel', 'side panel', 'close', 'clear'],
      action: () => {
        dispatch({ type: 'panels/clear' });
      },
    });

    return cmds;
  }, [workspaces, tabs, panelEntries, activeTabId, activeWorkspaceId, windowId]);
}

export default function CommandPalette({ onClose }: CommandPaletteProps) {
  // CommandPalette.Root is permanently open inside this component — the
  // chrome host overlay's visibility is what actually shows/hides the
  // palette. Keeping open=true means: (a) no remount on each show, so
  // opening is instant after first paint, and (b) Tale UI's enter animation
  // only runs the first time, while subsequent opens fade via the chrome
  // opacity transition. close() only signals the parent (which signals
  // chrome).
  const close = () => {
    onClose();
  };
  const commands = useCommands();
  const palette = useCommandPalette<BentoCommand>({
    commands,
    close,
  });
  const footerText = resultLabel(palette.filteredCommands.length);
  const handleInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (
        event.key !== 'Enter' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.nativeEvent.isComposing
      ) {
        return;
      }
      const command = palette.filteredCommands[0];
      if (!command) return;
      event.preventDefault();
      event.stopPropagation();
      void palette.runCommand(command);
    },
    [palette],
  );

  // Refocus the search input every time the chrome process focuses the
  // palette frame. Because the palette stays mounted between opens (no
  // reload), autoFocus only fires on first mount — without this effect
  // subsequent opens would land focus wherever it was last (often blurred
  // because the host went display:none). Selecting existing text lets the
  // user immediately type a new query to replace, Spotlight-style.
  useEffect(() => {
    const focusSearch = () => {
      const input = document.querySelector(
        '.bento-command-palette__input',
      ) as HTMLInputElement | null;
      if (!input) return;
      input.focus();
      input.select();
    };
    focusSearch();
    window.addEventListener('focus', focusSearch);
    return () => window.removeEventListener('focus', focusSearch);
  }, []);

  return (
    <TaleCommandPalette.Root
      open={true}
      size="lg"
      closeOnSelect={false}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <TaleCommandPalette.Backdrop isDismissable>
        <TaleCommandPalette.Popup
          aria-label="Command palette"
          className="bento-command-palette__dialog"
          modalProps={{ className: 'bento-command-palette__popup' }}
        >
          <TaleCommandPalette.Title className="bento-command-palette__sr-only">
            Command palette
          </TaleCommandPalette.Title>
          <TaleCommandPalette.Close aria-label="Close command palette" />
          <TaleCommandPalette.Content
            className="bento-command-palette__content"
            inputValue={palette.query}
            onInputChange={palette.setQuery}
          >
            <TaleCommandPalette.SearchField>
              <TaleCommandPalette.Input
                placeholder="Type a command, tab, or workspace…"
                className="bento-command-palette__input"
                autoFocus
                onKeyDown={handleInputKeyDown}
              />
              <TaleCommandPalette.ClearButton
                aria-label="Clear search"
                className="tale-button tale-button--ghost tale-button--sm"
              >
                Clear
              </TaleCommandPalette.ClearButton>
            </TaleCommandPalette.SearchField>
            <TaleCommandPalette.ListBox
              aria-label="Commands"
              className="bento-command-palette__listbox"
            >
              {palette.groupedCommands.map((group) => (
                <TaleCommandPalette.Section key={group.id}>
                  <TaleCommandPalette.SectionHeader>{group.title}</TaleCommandPalette.SectionHeader>
                  {group.commands.map((command) => (
                    <TaleCommandPalette.Item
                      key={command.id}
                      command={command}
                      textValue={commandTextValue(command)}
                      onAction={() => void palette.runCommand(command)}
                    >
                      <TaleCommandPalette.ItemIcon>{command.icon}</TaleCommandPalette.ItemIcon>
                      <TaleCommandPalette.ItemContent>
                        <TaleCommandPalette.ItemTitle>{command.title}</TaleCommandPalette.ItemTitle>
                        <TaleCommandPalette.ItemDescription>
                          {command.subtitle}
                        </TaleCommandPalette.ItemDescription>
                      </TaleCommandPalette.ItemContent>
                      {command.shortcut ? (
                        <TaleCommandPalette.ItemMeta>
                          <TaleCommandPalette.Shortcut keys={command.shortcut} />
                        </TaleCommandPalette.ItemMeta>
                      ) : command.meta ? (
                        <TaleCommandPalette.ItemMeta>{command.meta}</TaleCommandPalette.ItemMeta>
                      ) : null}
                    </TaleCommandPalette.Item>
                  ))}
                </TaleCommandPalette.Section>
              ))}
            </TaleCommandPalette.ListBox>
            {palette.filteredCommands.length === 0 ? (
              <TaleCommandPalette.Empty>No matching commands.</TaleCommandPalette.Empty>
            ) : null}
            <TaleCommandPalette.Footer>{footerText}</TaleCommandPalette.Footer>
          </TaleCommandPalette.Content>
        </TaleCommandPalette.Popup>
      </TaleCommandPalette.Backdrop>
    </TaleCommandPalette.Root>
  );
}
