// Ladle theme provider — wraps each story with the Bento theme layer
// so components render exactly as they would in the real shell.
import type { GlobalProvider } from '@ladle/react';

import '@tale-ui/react-styles/button';
import '../src/theme/bento-tokens.css';
import '../src/theme/bento-fonts.css';

export const Provider: GlobalProvider = ({ children, globalState }) => {
  // Sync Ladle's color-mode toggle with Tale UI's data-color-mode attribute.
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-color-mode', globalState.theme);
    document.documentElement.setAttribute('data-theme', globalState.theme);
    document.documentElement.classList.add('tale-ui');
  }
  return <>{children}</>;
};
