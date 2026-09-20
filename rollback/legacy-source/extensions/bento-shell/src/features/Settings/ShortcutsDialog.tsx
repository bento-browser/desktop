// Layer-3 feature helper: keyboard-shortcuts command-palette reference.
//
// Static catalogue of every Bento-bound shortcut. Sourced from:
//   - extensions/bento-shell/manifest.json (browser.commands)
//   - extensions/bento-tools/manifest.json (browser.commands)
//   - src/browser/base/content/bento-shell-mount.js (chrome-mounted listeners)
//
// When a new shortcut lands in any of those files, add a row here so it's
// discoverable via Settings → Keyboard shortcuts.

import { useState, type ReactNode } from 'react';
import { Button, CommandPalette as MuxCommandPalette, useCommandPalette } from '@muxui/react';
import LayersIcon from 'lucide-react/dist/esm/icons/layers';
import PanelLeftCloseIcon from 'lucide-react/dist/esm/icons/panel-left-close';
import PanelRightOpenIcon from 'lucide-react/dist/esm/icons/panel-right-open';
import CommandIcon from 'lucide-react/dist/esm/icons/command';
import FileIcon from 'lucide-react/dist/esm/icons/file';
import WrenchIcon from 'lucide-react/dist/esm/icons/wrench';

import { BentoIcon } from '../../components/primitives/BentoIcon';

import './ShortcutsDialog.css';

type ShortcutCategory =
  | 'Workspaces'
  | 'Sidebar'
  | 'Panels'
  | 'Command Palette'
  | 'Tabs'
  | 'Developer';

interface ShortcutCommand {
  id: string;
  title: string;
  subtitle: string;
  group: ShortcutCategory;
  icon: ReactNode;
  shortcut: readonly string[];
  keywords?: readonly string[];
}

interface ShortcutCommandConfig {
  id: string;
  title: string;
  subtitle: string;
  group: ShortcutCategory;
  icon: ReactNode;
  shortcut: readonly string[];
  keywords?: readonly string[];
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// Use OS-appropriate symbols so the displayed combos match what's printed
// on the user's keyboard. Cmd/Alt/Shift are the cross-platform names; we
// substitute glyphs for macOS.
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';
const SHIFT = IS_MAC ? '⇧' : 'Shift';

function commandIcon(icon: typeof LayersIcon): ReactNode {
  return <BentoIcon icon={icon} size="sm" />;
}

function shortcutAliases(key: string): string[] {
  if (key === MOD) return IS_MAC ? ['command', 'cmd', 'mod'] : ['control', 'ctrl', 'mod'];
  if (key === ALT) return IS_MAC ? ['option', 'alt'] : ['alt'];
  if (key === SHIFT) return ['shift'];
  if (key === 'Esc') return ['esc', 'escape'];
  if (key === '←') return ['left', 'previous'];
  if (key === '→') return ['right', 'next'];
  if (key === '1-9') return ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'number', 'index'];
  if (key === 'Middle click') return ['middle click', 'middle-click', 'mouse'];
  return [key.toLocaleLowerCase()];
}

function shortcutCommand(config: ShortcutCommandConfig): ShortcutCommand {
  const keywords = new Set<string>(config.keywords);
  for (const key of config.shortcut) {
    for (const alias of shortcutAliases(key)) {
      keywords.add(alias);
    }
  }
  return {
    ...config,
    keywords: Array.from(keywords),
  };
}

const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  shortcutCommand({
    id: 'workspace:switch-index',
    title: 'Switch workspace by index',
    subtitle: 'Jump to workspace 1 through 9.',
    group: 'Workspaces',
    icon: commandIcon(LayersIcon),
    // Bound by extensions/bento-tools/manifest.json as `workspace-N` →
    // Ctrl+Alt+N. WebExtensions maps `Ctrl` → Command (⌘) on macOS, so
    // the user-visible combo is ⌘⌥N on Mac, Ctrl+Alt+N elsewhere. The
    // bare ⌘N is Firefox's own tab-switch hotkey and isn't ours.
    shortcut: [MOD, ALT, '1-9'],
    keywords: ['workspace', 'switch', 'jump'],
  }),
  shortcutCommand({
    id: 'sidebar:minimize',
    title: 'Minimize sidebar',
    subtitle: 'Collapse the sidebar to the rail or hide it with edge-hover access.',
    group: 'Sidebar',
    icon: commandIcon(PanelLeftCloseIcon),
    shortcut: [MOD, 'S'],
    keywords: ['sidebar', 'collapse', 'hide', 'minimize'],
  }),
  shortcutCommand({
    id: 'panel:previous',
    title: 'Focus previous panel',
    subtitle: 'Move focus to the previous side panel.',
    group: 'Panels',
    icon: commandIcon(PanelRightOpenIcon),
    shortcut: [MOD, SHIFT, '←'],
    keywords: ['panel', 'side panel', 'cycle'],
  }),
  shortcutCommand({
    id: 'panel:next',
    title: 'Focus next panel',
    subtitle: 'Move focus to the next side panel.',
    group: 'Panels',
    icon: commandIcon(PanelRightOpenIcon),
    shortcut: [MOD, SHIFT, '→'],
    keywords: ['panel', 'side panel', 'cycle'],
  }),
  shortcutCommand({
    id: 'palette:open',
    title: 'Open command palette',
    subtitle: 'Open Bento command search.',
    group: 'Command Palette',
    icon: commandIcon(CommandIcon),
    shortcut: [MOD, ALT, 'P'],
    keywords: ['palette', 'command search', 'launcher'],
  }),
  shortcutCommand({
    id: 'palette:close-overlay',
    title: 'Close active Bento overlay',
    subtitle: 'Dismiss the command palette or active Bento overlay.',
    group: 'Command Palette',
    icon: commandIcon(CommandIcon),
    shortcut: ['Esc'],
    keywords: ['palette', 'overlay', 'dismiss', 'close'],
  }),
  shortcutCommand({
    id: 'tab:middle-click-close',
    title: 'Close tab with middle click',
    subtitle: 'Close a tab from the sidebar tab list.',
    group: 'Tabs',
    icon: commandIcon(FileIcon),
    shortcut: ['Middle click'],
    keywords: ['tab', 'close', 'mouse'],
  }),
  shortcutCommand({
    id: 'tab:new',
    title: 'New tab',
    subtitle: 'Open a new Firefox tab.',
    group: 'Tabs',
    icon: commandIcon(FileIcon),
    shortcut: [MOD, 'T'],
    keywords: ['tab', 'firefox standard', 'create'],
  }),
  shortcutCommand({
    id: 'tab:close',
    title: 'Close current tab',
    subtitle: 'Close the current Firefox tab.',
    group: 'Tabs',
    icon: commandIcon(FileIcon),
    shortcut: [MOD, 'W'],
    keywords: ['tab', 'firefox standard', 'remove'],
  }),
  shortcutCommand({
    id: 'tab:reopen-closed',
    title: 'Reopen closed tab',
    subtitle: 'Restore the most recently closed Firefox tab.',
    group: 'Tabs',
    icon: commandIcon(FileIcon),
    shortcut: [MOD, SHIFT, 'T'],
    keywords: ['tab', 'firefox standard', 'restore', 'undo'],
  }),
  shortcutCommand({
    id: 'tab:switch-index',
    title: 'Switch tab by index',
    subtitle: 'Jump to Firefox tab 1 through 9.',
    group: 'Tabs',
    icon: commandIcon(FileIcon),
    shortcut: [MOD, '1-9'],
    keywords: ['tab', 'firefox standard', 'switch', 'jump'],
  }),
  shortcutCommand({
    id: 'developer:reload-shell',
    title: 'Reload Bento shell extension',
    subtitle: 'Reload Bento chrome UI during development.',
    group: 'Developer',
    icon: commandIcon(WrenchIcon),
    shortcut: [ALT, SHIFT, 'R'],
    keywords: ['developer', 'reload', 'extension'],
  }),
];

export interface ShortcutsDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

function shortcutTextValue(command: ShortcutCommand): string {
  return [
    command.title,
    command.subtitle,
    command.group,
    ...command.shortcut,
    ...(command.keywords ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

function resultLabel(count: number): string {
  return `${count} ${count === 1 ? 'shortcut' : 'shortcuts'}`;
}

export function ShortcutsDialog({ isOpen, onOpenChange }: ShortcutsDialogProps) {
  const [query, setQuery] = useState('');
  const palette = useCommandPalette<ShortcutCommand>({
    commands: SHORTCUT_COMMANDS,
    query,
    onQueryChange: setQuery,
    closeOnSelect: false,
  });

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen) setQuery('');
    onOpenChange(nextOpen);
  }

  return (
    <MuxCommandPalette.Root
      open={isOpen}
      size="lg"
      closeOnSelect={false}
      onOpenChange={handleOpenChange}
    >
      <MuxCommandPalette.Backdrop dismissable>
        <MuxCommandPalette.Popup
          aria-label="Keyboard shortcuts"
          className="bento-shortcuts-command-palette__dialog"
        >
          <MuxCommandPalette.Title className="bento-shortcuts-command-palette__sr-only">
            Keyboard shortcuts
          </MuxCommandPalette.Title>
          <MuxCommandPalette.Close aria-label="Close keyboard shortcuts" />
          <MuxCommandPalette.Content className="bento-shortcuts-command-palette__content">
            <MuxCommandPalette.SearchField>
              <MuxCommandPalette.Input
                placeholder="Search keyboard shortcuts…"
                className="bento-shortcuts-command-palette__input"
                value={palette.query}
                onChange={(event) => palette.setQuery(event.currentTarget.value)}
                autoFocus
              />
              {palette.query.length > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Clear shortcut search"
                  onActivate={() => palette.setQuery('')}
                >
                  Clear
                </Button>
              ) : null}
            </MuxCommandPalette.SearchField>
            <div
              role="list"
              aria-label="Keyboard shortcuts"
              className="muxui-command-palette__listbox muxui-command-palette__listbox--lg bento-shortcuts-command-palette__listbox"
            >
              {palette.groupedCommands.map((group) => (
                <section className="muxui-command-palette__section" key={group.id}>
                  <div className="muxui-command-palette__section-header">{group.title}</div>
                  {group.commands.map((command) => (
                    <div
                      key={command.id}
                      role="listitem"
                      aria-label={shortcutTextValue(command)}
                      className="muxui-command-palette__item bento-shortcuts-command-palette__item"
                    >
                      <MuxCommandPalette.ItemIcon>{command.icon}</MuxCommandPalette.ItemIcon>
                      <MuxCommandPalette.ItemContent>
                        <MuxCommandPalette.ItemTitle>{command.title}</MuxCommandPalette.ItemTitle>
                        <MuxCommandPalette.ItemDescription>
                          {command.subtitle}
                        </MuxCommandPalette.ItemDescription>
                      </MuxCommandPalette.ItemContent>
                      <MuxCommandPalette.ItemMeta>
                        <MuxCommandPalette.Shortcut keys={command.shortcut} />
                      </MuxCommandPalette.ItemMeta>
                    </div>
                  ))}
                </section>
              ))}
            </div>
            {palette.filteredCommands.length === 0 ? (
              <MuxCommandPalette.Empty>No matching shortcuts.</MuxCommandPalette.Empty>
            ) : null}
            <MuxCommandPalette.Footer>
              {resultLabel(palette.filteredCommands.length)}
            </MuxCommandPalette.Footer>
          </MuxCommandPalette.Content>
        </MuxCommandPalette.Popup>
      </MuxCommandPalette.Backdrop>
    </MuxCommandPalette.Root>
  );
}
