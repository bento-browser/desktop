// Shell entry point. Uses hydrateRoot so the SSR-style skeleton in
// index.html stays visible until React takes over (§6.3 cold-start).
import { StrictMode } from 'react';
import { hydrateRoot, createRoot } from 'react-dom/client';

import '@tale-ui/react-styles/button';

import './theme/bento-tokens.css';
import './theme/bento-fonts.css';
import { App } from './App';
import { useFirefoxTheme } from './theme/useFirefoxTheme';

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
