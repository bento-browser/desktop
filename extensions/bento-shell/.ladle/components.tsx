// Ladle theme provider — wraps each story with the Bento theme layer
// so components render exactly as they would in the real shell.
import type { GlobalProvider } from '@ladle/react';

import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';

import '../src/theme/bento-tokens.css';
import '../src/theme/bento-fonts.css';
import '../src/app.css';

export const Provider: GlobalProvider = ({ children }) => {
  // The Bento sidebar pins to dark mode (matches brand bg). Ignore Ladle's
  // theme toggle so stories show what the real shell shows. M3+ may add
  // a separate light-theme variant if Bento ever gains a light sidebar.
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-color-mode', 'dark');
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.classList.add('tale-ui');
  }
  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--bento-brand-bg)',
        color: 'var(--neutral-90)',
        padding: '1rem',
      }}
    >
      {children}
    </div>
  );
};
