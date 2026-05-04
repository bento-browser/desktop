// Shell entry point. Uses hydrateRoot so the SSR-style skeleton in
// index.html stays visible until React takes over (§6.3 cold-start).
import { StrictMode } from 'react';
import { hydrateRoot, createRoot } from 'react-dom/client';

// @tale-ui/core defines the design token system + data-color-mode rules.
// Without this loaded, tokens like --neutral-90 don't have values and
// dark-mode selectors don't apply. Per-component @tale-ui/react-styles
// imports use these tokens but don't define them.
import '@tale-ui/core';

import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';

import './theme/bento-tokens.css';
import './theme/bento-fonts.css';
import './app.css';
import { App } from './App';
import { useFirefoxTheme } from './theme/useFirefoxTheme';
import { initToolsPort } from './bridge/useToolsPort';

// Establish the tools port immediately so the initial tab snapshot is
// already on the wire by the time React's first commit lands.
initToolsPort();

function Shell() {
  useFirefoxTheme();
  return <App />;
}

const container = document.getElementById('root');
if (!container) {
  throw new Error('bento-shell: #root not found in chrome document');
}

const tree = (
  <StrictMode>
    <Shell />
  </StrictMode>
);

// hydrateRoot when the static skeleton already populated #root, otherwise
// createRoot for a clean mount (e.g. during Vite dev server).
if (container.firstChild) {
  hydrateRoot(container, tree);
} else {
  createRoot(container).render(tree);
}
