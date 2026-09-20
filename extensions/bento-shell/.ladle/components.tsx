// Ladle theme provider — wraps each story with the Bento theme layer
// so components render exactly as they would in the real shell. Mirrors
// Ladle's own light/dark toggle to the mode and public Mux attributes so
// story content follows the same presentation scope as the shell.
import { useEffect } from 'react';
import { useLadleContext, type GlobalProvider, ThemeState } from '@ladle/react';

import '../src/theme/muxui.css';

import '../src/theme/bento-tokens.css';
import '../src/theme/presets/index.css';
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
    const apply = () => {
      const mode = resolveMode(theme);
      html.setAttribute('data-color-mode', mode);
      html.setAttribute('data-theme', mode);
      html.setAttribute('data-bento-theme', 'default');
      html.setAttribute('data-muxui-theme', 'default');
      html.setAttribute('data-muxui-color-scheme', mode);
      html.setAttribute('data-muxui-contrast', 'standard');
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
