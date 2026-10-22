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
import { useShowSignal } from './useShowSignal';

initToolsPort();

const CLOSE_TITLE_PREFIX = 'BENTO_CLOSE_SETTINGS_PALETTE';

function close() {
  sendChromeTitle(`${CLOSE_TITLE_PREFIX}_${Date.now()}`);
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

function SettingsPaletteApp() {
  useFirefoxTheme({ preferStoredSystemResolution: true });
  useWorkspaceTheme();
  const view = useStore(settings.store, (state) => state.view);
  const { openToken, stages, query } = useShowSignal(settings.actions.refresh);
  // After the effect that listens for the show: chrome reveals the overlay on this announcement.
  useOverlayReadySignal('settings-palette');
  return (
    <SettingsPalette
      view={view}
      actions={settings.actions}
      onClose={close}
      initialStages={stages}
      initialQuery={query}
      openToken={openToken}
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
