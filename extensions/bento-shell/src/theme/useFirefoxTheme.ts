// Subscribes to OS color-scheme changes and reflects them on <html
// data-color-mode> (and data-theme for Tale UI). Initial mode is set by
// boot.js before any CSS loads — this hook just keeps the page in sync if
// the user toggles their OS theme while Bento is open.
//
// Honors an explicit choice persisted in localStorage by ColorModeToggle
// (Tale UI's toggle component): if the user has overridden, OS changes are
// ignored.

import { useEffect } from 'react';

const STORAGE_KEY = 'color-mode';

function applyMode(mode: 'light' | 'dark'): void {
  const html = document.documentElement;
  html.setAttribute('data-color-mode', mode);
  html.setAttribute('data-theme', mode);
}

export function useFirefoxTheme(): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handle = (e: MediaQueryListEvent | MediaQueryList) => {
      // Don't override an explicit user choice.
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'light' || stored === 'dark') return;
      applyMode(e.matches ? 'dark' : 'light');
    };
    mq.addEventListener('change', handle);
    return () => mq.removeEventListener('change', handle);
  }, []);
}
