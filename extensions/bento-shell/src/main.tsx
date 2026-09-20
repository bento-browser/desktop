// Shell entry point. The static skeleton in index.html is visible from first
// paint until React's first commit hides it (§6.3 cold-start).
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

// Boot mark — pairs with bento.firstCommit and bento.toolsReady so the perf
// harness (PR-5) can measure cold-start latency without needing chrome-side
// hooks. performance.mark is on globalThis in all Firefox processes.
performance.mark('bento.boot');

// Mux owns the public component selectors, tokens, and accessibility
// behavior. The Bento token and preset layers below provide the existing
// browser-specific appearance and workspace theme scopes.
import './theme/muxui.css';

import './theme/bento-tokens.css';
import './theme/presets/index.css';
import './theme/bento-fonts.css';
import './app.css';
import { App } from './App';
import { useFirefoxTheme } from './theme/useFirefoxTheme';
import { initToolsPort, enableSidePanelTitleBridge } from './bridge/useToolsPort';

// Establish the tools port immediately so the initial tab snapshot is
// already on the wire by the time React's first commit lands.
initToolsPort();

// The sidebar owns the chrome side-panel reveal/hide signal. Opt this
// entry into translating panel/show + panel/hide bus events into the
// chrome `BENTO_SIDE_PANEL:...` document.title IPC. Other shell entries
// (confirm, palette, settings) deliberately don't enable this — they'd
// stomp on their own title-IPC close signals if they did.
enableSidePanelTitleBridge();

function Shell() {
  useFirefoxTheme();
  // Hide the static skeleton + record the first-commit perf mark on the
  // initial paint. Runs once thanks to the empty dep array.
  useEffect(() => {
    performance.mark('bento.firstCommit');
    performance.measure('bento.bootToFirstCommit', 'bento.boot', 'bento.firstCommit');
    document.getElementById('bento-skeleton')?.setAttribute('hidden', '');
  }, []);
  return <App />;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('bento-shell: #root not found in chrome document');
}

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
