// Layer-3 feature helper: keyboard-shortcuts reference.
//
// Static catalogue of every Bento-bound shortcut. Sourced from:
//   - extensions/bento-shell/manifest.json (browser.commands)
//   - extensions/bento-tools/manifest.json (browser.commands)
//   - src/browser/base/content/bento-shell-mount.js (chrome-mounted listeners)
//
// When a new shortcut lands in any of those files, add a row here so it's
// discoverable via Settings → Keyboard shortcuts.

import { Dialog } from '@tale-ui/react/dialog';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Text } from '@tale-ui/react/text';
import { Button } from '@tale-ui/react/button';

import './ShortcutsDialog.css';

interface ShortcutEntry {
  combo: string;
  description: string;
}

interface ShortcutGroup {
  title: string;
  entries: ShortcutEntry[];
}

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// Use OS-appropriate symbols so the displayed combos match what's printed
// on the user's keyboard. Cmd/Alt/Shift are the cross-platform names; we
// substitute glyphs for macOS.
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';
const SHIFT = IS_MAC ? '⇧' : 'Shift';

const GROUPS: ShortcutGroup[] = [
  {
    title: 'Workspaces',
    entries: [
      // Bound by extensions/bento-tools/manifest.json as `workspace-N` →
      // Ctrl+Alt+N. WebExtensions maps `Ctrl` → Command (⌘) on macOS, so
      // the user-visible combo is ⌘⌥N on Mac, Ctrl+Alt+N elsewhere. The
      // bare ⌘N is Firefox's own tab-switch hotkey and isn't ours.
      { combo: `${MOD}${ALT}1 – ${MOD}${ALT}9`, description: 'Switch to workspace by index' },
    ],
  },
  {
    title: 'Panels',
    entries: [
      {
        combo: IS_MAC
          ? `${MOD}${SHIFT}← / ${MOD}${SHIFT}→`
          : `${MOD}+${SHIFT}+← / ${MOD}+${SHIFT}+→`,
        description: 'Cycle focus between panels',
      },
      { combo: 'Esc', description: 'Close the active overlay' },
    ],
  },
  {
    title: 'Command palette',
    entries: [
      { combo: `${MOD}${ALT}P`, description: 'Open the command palette' },
      { combo: 'Esc', description: 'Close the command palette' },
    ],
  },
  {
    title: 'Tabs',
    entries: [
      { combo: 'Middle-click on tab', description: 'Close the tab' },
      { combo: `${MOD}T`, description: 'New tab (Firefox standard)' },
      { combo: `${MOD}W`, description: 'Close current tab (Firefox standard)' },
      { combo: `${MOD}${SHIFT}T`, description: 'Reopen closed tab (Firefox standard)' },
      { combo: `${MOD}1 – ${MOD}9`, description: 'Switch to tab by index (Firefox standard)' },
    ],
  },
  {
    title: 'Developer',
    entries: [{ combo: `${ALT}${SHIFT}R`, description: 'Reload the Bento shell extension' }],
  },
];

export interface ShortcutsDialogProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShortcutsDialog({ isOpen, onOpenChange }: ShortcutsDialogProps) {
  return (
    <Dialog.Root isOpen={isOpen} onOpenChange={onOpenChange}>
      <Dialog.Backdrop>
        <Dialog.Popup className="bento-shortcuts-dialog">
          <Dialog.Close aria-label="Close" />
          <Dialog.Title>Keyboard shortcuts</Dialog.Title>
          <Dialog.Description>
            Bento-specific shortcuts. Standard Firefox shortcuts (find, navigation, history) work as
            usual.
          </Dialog.Description>
          <Column gap="m" className="bento-shortcuts-dialog__groups">
            {GROUPS.map((group) => (
              <Column key={group.title} gap="xs">
                <Text variant="heading" size="s" as="h3">
                  {group.title}
                </Text>
                <Column gap="2xs">
                  {group.entries.map((entry) => (
                    <Row
                      key={`${group.title}-${entry.combo}-${entry.description}`}
                      align="center"
                      gap="s"
                      className="bento-shortcuts-dialog__row"
                    >
                      <span className="bento-shortcuts-dialog__combo">{entry.combo}</span>
                      <Text variant="text" size="s">
                        {entry.description}
                      </Text>
                    </Row>
                  ))}
                </Column>
              </Column>
            ))}
          </Column>
          <Dialog.Actions>
            <Button variant="primary" onPress={() => onOpenChange(false)}>
              Close
            </Button>
          </Dialog.Actions>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}
