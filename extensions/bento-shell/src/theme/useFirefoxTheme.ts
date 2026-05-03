// Binds the OS prefers-color-scheme to <html data-theme="..."> so Tale UI's
// color-mode CSS picks it up automatically. Tale UI keys off both
// data-color-mode (set by the inline boot script in index.html for
// flash-of-wrong-theme prevention) and data-theme (set here for OS changes
// after boot).
import { useEffect } from 'react';

export function useFirefoxTheme(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const mode = mql.matches ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', mode);
      // Only update color-mode if the user hasn't explicitly chosen — the
      // ColorModeToggle persists its choice to localStorage.
      if (!localStorage.getItem('color-mode')) {
        document.documentElement.setAttribute('data-color-mode', mode);
      }
    };

    apply();
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, []);
}
