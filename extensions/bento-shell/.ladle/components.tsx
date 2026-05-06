// Ladle theme provider — wraps each story with the Bento theme layer
// so components render exactly as they would in the real shell. Mirrors
// Ladle's own light/dark toggle to <html data-color-mode> so Tale UI
// tokens flip with the toggle (Tale UI keys off data-color-mode for its
// dark-mode rules; without this, Ladle's toggle only restyles its own
// chrome and our story content stays stuck on whatever was set initially).
import { useEffect } from 'react';
import { useLadleContext, type GlobalProvider, ThemeState } from '@ladle/react';

import '@tale-ui/core';
import '@tale-ui/react-styles/_primitives';
import '@tale-ui/react-styles/button';
import '@tale-ui/react-styles/icon-button';
import '@tale-ui/react-styles/text';
import '@tale-ui/react-styles/column';
import '@tale-ui/react-styles/row';
import '@tale-ui/react-styles/icon';
import '@tale-ui/react-styles/menu';
import '@tale-ui/react-styles/avatar';
import '@tale-ui/react-styles/dialog';
import '@tale-ui/react-styles/autocomplete';
import '@tale-ui/react-styles/search-field';
import '@tale-ui/react-styles/card';
import '@tale-ui/react-styles/switch';
import '@tale-ui/react-styles/number-field';
import '@tale-ui/react-styles/text-field';

import '../src/theme/bento-tokens.css';
import '../src/theme/bento-fonts.css';
// Intentionally not importing src/app.css — its html/body/#root rules
// override Ladle's layout. Stories use their own frame to constrain.

function resolveMode(theme: ThemeState): 'light' | 'dark' {
  if (theme === ThemeState.Dark) return 'dark';
  if (theme === ThemeState.Light) return 'light';
  // ThemeState.Auto — defer to OS pref.
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const Provider: GlobalProvider = ({ children }) => {
  const { globalState } = useLadleContext();
  const theme = globalState.theme;

  useEffect(() => {
    const html = document.documentElement;
    html.classList.add('tale-ui');
    const apply = () => {
      const mode = resolveMode(theme);
      html.setAttribute('data-color-mode', mode);
      html.setAttribute('data-theme', mode);
    };
    apply();
    if (theme === ThemeState.Auto) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [theme]);

  return (
    <div
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--bento-brand-bg)',
        color: 'var(--neutral-90-fg)',
      }}
    >
      {children}
    </div>
  );
};
