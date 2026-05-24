// Welcome overlay entry. Lives in its OWN Vite chunk + chrome <browser>
// frame so the modal scrim covers the entire browser window rather than
// being clipped to the sidebar's bounds. Mirrors src/confirm/main.tsx and
// src/edit-workspace/main.tsx.
//
// Lifecycle:
//   - App.tsx (sidebar) calls requestWelcome() once per session when
//     SettingsStore reports welcomeSeen=false. That sets
//     document.title = BENTO_OPEN_WELCOME_<ts> which the chrome poll
//     picks up and reveals this overlay frame.
//   - Any dismiss path (Esc / backdrop click / "Got it" button) flips
//     settings.welcomeSeen=true via the existing tools port, then signals
//     chrome to hide via document.title = BENTO_CLOSE_WELCOME_<ts>.
//   - Dialog stays mounted with isOpen=true permanently — visibility is
//     purely a chrome concern (same pattern as the other overlays). React
//     state inside this page never tracks open/closed.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Dialog } from '@tale-ui/react/dialog';
import { Button } from '@tale-ui/react/button';
import { Text } from '@tale-ui/react/text';
import { Column } from '@tale-ui/react/column';
import { Row } from '@tale-ui/react/row';
import { Icon } from '@tale-ui/react/icon';
import Sparkles from 'lucide-react/dist/esm/icons/sparkles';

import '@tale-ui/core';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/dialog';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort, dispatch } from '../bridge/useToolsPort';
import { WELCOME_CLOSE_PREFIX } from '../bridge/useWelcome';
import './welcome.css';

initToolsPort();

const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac');
// macOS-style modifier glyphs vs. spelled-out names elsewhere. Matches
// what users see printed on their keyboard.
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const ALT = IS_MAC ? '⌥' : 'Alt';

// Tip rows — kept in sync with ShortcutsDialog and the chrome bindings.
// Workspaces: bento-tools manifest binds Ctrl+Alt+N → workspace-N.
// Palette: bento-shell-mount.js binds Cmd/Ctrl+Alt+P.
const TIPS: Array<{ shortcut: string; description: string }> = [
  { shortcut: `${MOD}${ALT}1 – ${MOD}${ALT}9`, description: 'Switch workspaces' },
  { shortcut: `${MOD}${ALT}P`, description: 'Open the command palette' },
  { shortcut: 'Tab → 🔳 icon', description: 'Pin a tab as a side panel' },
  { shortcut: '← / →', description: 'Cycle between panels' },
];

function close() {
  // Persist the dismissal first so the overlay never reopens. Chrome
  // hide is the visual signal; the settings/update is the durable state.
  // Tools-side persistence is debounced 250ms but the in-memory snapshot
  // updates synchronously, so a fresh shell connection picks up
  // welcomeSeen=true immediately.
  dispatch({ type: 'settings/update', changes: { welcomeSeen: true } });
  document.title = `${WELCOME_CLOSE_PREFIX}_${Date.now()}`;
}

function WelcomeApp() {
  useFirefoxTheme();
  useWorkspaceTheme();
  return (
    <Dialog.Root
      isOpen={true}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Backdrop isDismissable>
        <Dialog.Popup className="bento-welcome">
          <Row align="center" gap="xs" className="bento-welcome__head">
            <span className="bento-welcome__icon" aria-hidden="true">
              <Icon icon={Sparkles} />
            </span>
            <Dialog.Title>Welcome to Bento</Dialog.Title>
          </Row>
          <Dialog.Description>
            A workspace-first browser built on Firefox. A few things to know before you start:
          </Dialog.Description>
          <Column gap="xs" className="bento-welcome__tips">
            {TIPS.map((tip) => (
              <Row key={tip.shortcut} align="center" gap="s" className="bento-welcome__tip">
                <span className="bento-welcome__kbd">{tip.shortcut}</span>
                <Text variant="text" size="m">
                  {tip.description}
                </Text>
              </Row>
            ))}
          </Column>
          <Dialog.Actions>
            <Button variant="primary" onPress={close}>
              Got it
            </Button>
          </Dialog.Actions>
        </Dialog.Popup>
      </Dialog.Backdrop>
    </Dialog.Root>
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell welcome: #root not found');

createRoot(container).render(
  <StrictMode>
    <WelcomeApp />
  </StrictMode>,
);
