// Layer-2 component: CommandPalette.
//
// Tale UI Dialog + Autocomplete combined: a centered modal with a search
// input + filterable list of commands. Default export so the entry chunk can
// React.lazy() it.
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

import { useEffect, useMemo } from 'react';
import { Dialog } from '@tale-ui/react/dialog';
import { Autocomplete } from '@tale-ui/react/autocomplete';
import { Text } from '@tale-ui/react/text';
import { Icon } from '@tale-ui/react/icon';
import { useShallow } from 'zustand/shallow';

// Inline case-insensitive contains filter. react-aria's useFilter would
// give us locale-aware matching but is not re-exported by Tale UI, and
// importing from react-aria-components directly violates the layer-2
// rule (CLAUDE.md). Plain lowercase substring match is the right level
// of fanciness for a command palette anyway.
function contains(text: string, search: string): boolean {
  if (!search) return true;
  return text.toLowerCase().includes(search.toLowerCase());
}

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
import { useWorkspacesStore } from '../../state/workspaces';
import { dispatch } from '../../bridge/useToolsPort';
import './CommandPalette.css';

export interface CommandPaletteProps {
  /** Invoked whenever the palette is dismissed (Esc, backdrop click, or
   * running a command). The parent decides what "dismiss" means at the
   * outer container level — for the chrome overlay version, parent will
   * postMessage to the chrome process to hide the frame. */
  onClose: () => void;
}

interface Command {
  id: string;
  /** Searchable / displayed label. */
  label: string;
  /** Optional grouping section header. */
  section: 'Navigation' | 'Workspaces' | 'Tabs' | 'Actions';
  /** Lucide icon — typeof an imported one to inherit LucideIcon's
   * ForwardRefExoticComponent shape that Tale UI's Icon expects. */
  icon: typeof SettingsIcon;
  run: () => void;
}

function settingsUrl(): string {
  return 'about:bento-settings';
}

function privacyUrl(): string {
  return 'about:bento-privacy';
}

function useCommands(closePalette: () => void): Command[] {
  const workspaces = useWorkspacesStore(useShallow((s) => s.orderedIds.map((id) => s.byId[id]!)));
  const tabs = useTabsStore(
    useShallow((s) => s.orderedIds.map((id) => s.byId[id]).filter((t) => !!t)),
  );
  const activeTabId = useTabsStore((s) => s.activeId);
  const activeWorkspaceId = useWorkspacesStore((s) => s.activeId);

  return useMemo(() => {
    const cmds: Command[] = [];

    // Navigation
    cmds.push({
      id: 'nav:settings',
      label: 'Open Settings',
      section: 'Navigation',
      icon: SettingsIcon,
      run: () => {
        dispatch({ type: 'tab/openUrl', url: settingsUrl() });
        closePalette();
      },
    });
    cmds.push({
      id: 'nav:privacy',
      label: 'Open Privacy Dashboard',
      section: 'Navigation',
      icon: ShieldIcon,
      run: () => {
        dispatch({ type: 'tab/openUrl', url: privacyUrl() });
        closePalette();
      },
    });

    // Workspaces
    for (const w of workspaces) {
      const isActive = w.id === activeWorkspaceId;
      cmds.push({
        id: `workspace:${w.id}`,
        label: isActive ? `Workspace: ${w.name} (active)` : `Switch to: ${w.name}`,
        section: 'Workspaces',
        icon: LayersIcon,
        run: () => {
          dispatch({ type: 'workspace/activate', id: w.id });
          closePalette();
        },
      });
    }
    cmds.push({
      id: 'workspace:new',
      label: 'New workspace',
      section: 'Workspaces',
      icon: PlusIcon,
      run: () => {
        dispatch({
          type: 'workspace/create',
          name: `Workspace ${workspaces.length + 1}`,
        });
        closePalette();
      },
    });

    // Tabs
    for (const t of tabs) {
      cmds.push({
        id: `tab:${t.id}`,
        label: `Tab: ${t.title || 'Untitled'}`,
        section: 'Tabs',
        icon: FileIcon,
        run: () => {
          dispatch({ type: 'tab/activate', id: t.id });
          closePalette();
        },
      });
    }

    // Actions
    cmds.push({
      id: 'action:new-tab',
      label: 'New tab',
      section: 'Actions',
      icon: PlusIcon,
      run: () => {
        // tab/create (no URL) sidesteps AboutNewTabRedirector startup-race
        // noise by using browser.tabs.create({active: true}) — Firefox
        // resolves the user's configured new-tab page on its own.
        dispatch({ type: 'tab/create' });
        closePalette();
      },
    });
    if (activeTabId !== null) {
      const activeTab = tabs.find((t) => t!.id === activeTabId);
      cmds.push({
        id: 'action:close-tab',
        label: 'Close current tab',
        section: 'Actions',
        icon: XIcon,
        run: () => {
          dispatch({ type: 'tab/close', id: activeTabId });
          closePalette();
        },
      });
      cmds.push({
        id: 'action:reload-tab',
        label: 'Reload current tab',
        section: 'Actions',
        icon: RotateIcon,
        run: () => {
          dispatch({ type: 'tab/reload', id: activeTabId });
          closePalette();
        },
      });
      cmds.push({
        id: 'action:toggle-pin',
        label: activeTab?.pinned ? 'Unpin current tab' : 'Pin current tab',
        section: 'Actions',
        icon: PinIcon,
        run: () => {
          dispatch({ type: 'tab/togglePin', id: activeTabId });
          closePalette();
        },
      });
      cmds.push({
        id: 'action:open-in-side-panel',
        label: 'Add current tab to side panels',
        section: 'Actions',
        icon: PanelRightOpenIcon,
        run: () => {
          dispatch({ type: 'panel/add', id: activeTabId });
          closePalette();
        },
      });
    }
    cmds.push({
      id: 'action:close-side-panels',
      label: 'Close all side panels',
      section: 'Actions',
      icon: PanelRightCloseIcon,
      run: () => {
        dispatch({ type: 'panels/clear' });
        closePalette();
      },
    });

    return cmds;
  }, [workspaces, tabs, activeTabId, activeWorkspaceId, closePalette]);
}

function groupCommands(cmds: Command[]): Map<Command['section'], Command[]> {
  const grouped = new Map<Command['section'], Command[]>();
  for (const c of cmds) {
    const arr = grouped.get(c.section);
    if (arr) arr.push(c);
    else grouped.set(c.section, [c]);
  }
  return grouped;
}

export default function CommandPalette({ onClose }: CommandPaletteProps) {
  // Dialog is permanently open inside this component — the chrome host
  // overlay's visibility is what actually shows/hides the palette. Keeping
  // isOpen=true means: (a) no remount on each show, so opening is instant
  // after first paint, and (b) Tale UI's enter animation only runs the
  // first time, while subsequent opens fade via the chrome opacity
  // transition. close() only signals the parent (which signals chrome).
  const close = () => {
    onClose();
  };
  const commands = useCommands(close);
  const grouped = groupCommands(commands);

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
    <Dialog.Root
      isOpen={true}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <Dialog.Backdrop isDismissable>
        <Dialog.Popup className="bento-command-palette__popup">
          <Dialog.Title>
            <span className="bento-command-palette__sr-only">Command palette</span>
          </Dialog.Title>
          <Autocomplete.Root filter={contains}>
            <Autocomplete.SearchField aria-label="Search commands">
              <Autocomplete.Input
                placeholder="Type a command, tab, or workspace…"
                className="bento-command-palette__input"
                autoFocus
              />
            </Autocomplete.SearchField>
            <Autocomplete.ListBox aria-label="Commands" className="bento-command-palette__listbox">
              {Array.from(grouped.entries()).map(([section, cmds]) => (
                <Autocomplete.Section key={section}>
                  <Autocomplete.Header>{section}</Autocomplete.Header>
                  {cmds.map((c) => (
                    <Autocomplete.Item key={c.id} id={c.id} textValue={c.label} onAction={c.run}>
                      <Icon icon={c.icon} size="sm" />
                      <Text variant="text" size="s">
                        {c.label}
                      </Text>
                    </Autocomplete.Item>
                  ))}
                </Autocomplete.Section>
              ))}
            </Autocomplete.ListBox>
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}
