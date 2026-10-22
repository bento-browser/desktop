// Settings palette page entry. Lives in its own chrome overlay <browser> frame, like the other
// palette-class overlays; chrome owns its visibility and this document asks to be hidden with a
// BENTO_CLOSE_SETTINGS_PALETTE title (see src/palette/main.tsx for why a title).
//
// Settings reach bento-tools through the BentoShellBus relay (`relayTransport.ts`), not the
// shell bus, so the palette works in private windows too. The bus (`initToolsPort`) is only
// joined for the theme mirrors.

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from 'zustand';

import '../theme/muxui.css';

import '../theme/bento-tokens.css';
import '../theme/presets/index.css';
import '../theme/bento-fonts.css';
import '../theme/document-base.css';
import SettingsPalette from '../components/SettingsPalette/SettingsPalette';
import { useFirefoxTheme } from '../theme/useFirefoxTheme';
import { useWorkspaceTheme } from '../theme/useWorkspaceTheme';
import { initToolsPort } from '../bridge/useToolsPort';
import { sendChromeTitle } from '../bridge/chromeTitle';
import { useOverlayReadySignal } from '../bridge/overlayReady';
import { createRelayTransport } from './relayTransport';
import { createSettingsClient } from './settingsClient';
import { createSettingsPaletteStore, type SettingsPaletteHost } from './settingsStore';
import { BACK_TO_PALETTE_TITLE_PREFIX, CLOSE_TITLE_PREFIX, titleFor } from './titles';
import { useShowSignal } from './useShowSignal';

initToolsPort();

function close() {
  sendChromeTitle(titleFor(CLOSE_TITLE_PREFIX));
}

/** Chrome hides Settings and shows the command palette again, with the query it had. */
function backToPalette() {
  sendChromeTitle(titleFor(BACK_TO_PALETTE_TITLE_PREFIX));
}

/** Hands the export to the user the way a web page would: a download of a Blob. */
function saveFile(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

const host: SettingsPaletteHost = {
  // Chrome opens about:preferences#search and hides this overlay.
  openFirefoxSearchSettings: () =>
    sendChromeTitle(`BENTO_OPEN_FIREFOX_SEARCH_SETTINGS_${Date.now()}`),
  openMergePalette: () => sendChromeTitle(`BENTO_OPEN_MERGE_PALETTE_${Date.now()}`),
  saveFile,
};

// One connection for the life of the document. The relay may not be attached yet; the
// transport keeps saying hello and holds requests until it answers.
const relay = createRelayTransport();
relay.connect();
const settings = createSettingsPaletteStore(createSettingsClient(relay), host);
// The document loads hidden: chrome reveals it, and sends the show, once it has announced itself.
settings.actions.setVisible(false);

function SettingsPaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const view = useStore(settings.store, (state) => state.view);
  const { openToken, hideToken, stages, query, origin } = useShowSignal(
    settings.actions.refresh,
    settings.actions.setVisible,
  );
  // After the effect that listens for the show: chrome reveals the overlay on this announcement.
  useOverlayReadySignal('settings-palette');
  return (
    <SettingsPalette
      view={view}
      actions={settings.actions}
      onClose={close}
      onBackToPalette={origin === 'palette' ? backToPalette : undefined}
      initialStages={stages}
      initialQuery={query}
      openToken={openToken}
      hideToken={hideToken}
    />
  );
}

const container = document.getElementById('root');
if (!container) throw new Error('bento-shell settings palette: #root not found');

createRoot(container).render(
  <StrictMode>
    <SettingsPaletteApp />
  </StrictMode>,
);
