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
import { ALL_THEME_IDS, useThemeSheets } from '../src/theme/themeSheets';
// src/app.css (the shell layout) is deliberately not imported here: only the App
// stories render the shell layout, and App.stories.tsx loads it. The layer order is
// declared in muxui.css above, so where app.css loads does not change it. The page's
// html/body/#root sizing is in src/shell-document.css, which Ladle never loads.
// Stories use their own frame.

function resolveMode(theme: ThemeState): 'light' | 'dark' {
  if (theme === ThemeState.Dark) return 'dark';
  if (theme === ThemeState.Light) return 'light';
  // ThemeState.Auto — defer to OS pref.
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export const Provider: GlobalProvider = ({ children }) => {
  const { globalState } = useLadleContext();
  const theme = globalState.theme;
  // Stories preview themes (picker, workspace avatars), so load every theme sheet.
  useThemeSheets(ALL_THEME_IDS);

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
    return undefined;
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
